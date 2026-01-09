import { OAUTH_CONFIG, ANTIGRAVITY_CONFIG, AVAILABLE_MODELS, getMappedModel } from '../config.js';
import { updateAccountToken, updateAccountQuota, updateAccountStatus, updateAccountProjectId, updateAccountTier, getAllAccountsForRefresh, upsertAccountModelQuota } from '../db/index.js';

// Token 刷新提前时间（5分钟）
const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000;

// Only consider models that this proxy actually exposes (mapped to upstream names).
const QUOTA_RELEVANT_MODELS = new Set(AVAILABLE_MODELS.map((m) => getMappedModel(m.id)));

function toQuotaFraction(value, fallback = 0) {
    if (value === null || value === undefined) return fallback;
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    // remainingFraction should be within [0, 1], clamp defensively
    return Math.max(0, Math.min(1, num));
}

/**
 * 刷新账号的 access_token
 */
export async function refreshAccessToken(account) {
    try {
        const response = await fetch(OAUTH_CONFIG.token_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Go-http-client/1.1'
            },
            body: new URLSearchParams({
                client_id: OAUTH_CONFIG.client_id,
                client_secret: OAUTH_CONFIG.client_secret,
                grant_type: 'refresh_token',
                refresh_token: account.refresh_token
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token refresh failed: ${response.status} ${error}`);
        }

        const data = await response.json();

        // 更新数据库
        updateAccountToken(account.id, data.access_token, data.expires_in);

        return {
            access_token: data.access_token,
            expires_in: data.expires_in
        };
    } catch (error) {
        updateAccountStatus(account.id, 'error', error.message);
        throw error;
    }
}

/**
 * 检查并在需要时刷新 token
 */
export async function ensureValidToken(account) {
    const now = Date.now();
    const needsRefresh = !account.access_token ||
                         !account.token_expires_at ||
                         now >= account.token_expires_at - TOKEN_REFRESH_BUFFER;

    if (needsRefresh) {
        const result = await refreshAccessToken(account);
        account.access_token = result.access_token;
        account.token_expires_at = now + (result.expires_in * 1000);
    }

    return account;
}

/**
 * 获取账号的 projectId
 */
export async function fetchProjectId(account) {
    try {
        const response = await fetch(`${ANTIGRAVITY_CONFIG.base_url}/v1internal:loadCodeAssist`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${account.access_token}`,
                'Content-Type': 'application/json',
                'User-Agent': ANTIGRAVITY_CONFIG.user_agent
            },
            body: JSON.stringify({
                metadata: { ideType: 'ANTIGRAVITY' }
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to load code assist: ${response.status}`);
        }

        const data = await response.json();
        const projectId = data.cloudaicompanionProject;
        const tier = data.currentTier?.id || 'free-tier';

        if (projectId) {
            updateAccountProjectId(account.id, projectId);
            account.project_id = projectId;
        }

        updateAccountTier(account.id, tier);
        account.tier = tier;

        return {
            projectId,
            tier
        };
    } catch (error) {
        throw error;
    }
}

/**
 * 获取账号的配额信息（所有模型）
 */
export async function fetchQuotaInfo(account, model = null) {
    try {
        const response = await fetch(`${ANTIGRAVITY_CONFIG.base_url}/v1internal:fetchAvailableModels`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${account.access_token}`,
                'Content-Type': 'application/json',
                'User-Agent': ANTIGRAVITY_CONFIG.user_agent
            },
            body: JSON.stringify({
                project: account.project_id || ''
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.status}`);
        }

        const data = await response.json();
        const models = data.models || {};

        // 计算“总体配额”：取所有模型 quotaInfo.remainingFraction 的最小值
        let minQuota = 1;
        let minQuotaResetTime = null;
        let sawQuotaSignal = false;

        const relevantEntries = Object.entries(models).filter(([modelId]) => QUOTA_RELEVANT_MODELS.has(modelId));
        const entriesToScan = relevantEntries.length > 0 ? relevantEntries : Object.entries(models);

        for (const [modelId, modelInfo] of entriesToScan) {
            if (!modelInfo) continue;

            // If the model is relevant but quotaInfo is missing, treat as 0 to avoid "phantom 100%".
            if (!modelInfo.quotaInfo) {
                if (QUOTA_RELEVANT_MODELS.has(modelId)) {
                    sawQuotaSignal = true;
                    upsertAccountModelQuota(account.id, modelId, 0, null);
                    minQuota = 0;
                    minQuotaResetTime = null;
                }
                continue;
            }

            sawQuotaSignal = true;
            const remainingFraction = toQuotaFraction(modelInfo.quotaInfo.remainingFraction, 0);
            const resetTimestamp = modelInfo.quotaInfo.resetTime ? new Date(modelInfo.quotaInfo.resetTime).getTime() : null;

            if (QUOTA_RELEVANT_MODELS.has(modelId)) {
                upsertAccountModelQuota(account.id, modelId, remainingFraction, resetTimestamp);
            }

            if (remainingFraction < minQuota) {
                minQuota = remainingFraction;
                minQuotaResetTime = resetTimestamp;
            }
        }

        // 兼容：如果调用方指定了 model 且存在 quotaInfo，则返回该模型的信息（但 DB 仍写总体配额）
        let selected = null;
        if (model) {
            const selectedInfo = models?.[model];
            if (selectedInfo?.quotaInfo) {
                selected = {
                    remainingFraction: toQuotaFraction(selectedInfo.quotaInfo.remainingFraction, 0),
                    resetTime: selectedInfo.quotaInfo.resetTime ? new Date(selectedInfo.quotaInfo.resetTime).getTime() : null
                };
            } else if (selectedInfo && QUOTA_RELEVANT_MODELS.has(model)) {
                selected = { remainingFraction: 0, resetTime: null };
            }
        }

        // 如果上游没有返回任何 quotaInfo，避免把默认值 1 误写进 DB
        if (!sawQuotaSignal) {
            minQuota = 0;
            minQuotaResetTime = null;
        }

        updateAccountQuota(account.id, minQuota, minQuotaResetTime);

        return selected || { remainingFraction: minQuota, resetTime: minQuotaResetTime };
    } catch (error) {
        throw error;
    }
}

/**
 * 获取账号的详细配额信息（所有模型）
 */
export async function fetchDetailedQuotaInfo(account) {
    try {
        // 确保有有效的 token
        await ensureValidToken(account);

        const response = await fetch(`${ANTIGRAVITY_CONFIG.base_url}/v1internal:fetchAvailableModels`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${account.access_token}`,
                'Content-Type': 'application/json',
                'User-Agent': ANTIGRAVITY_CONFIG.user_agent
            },
            body: JSON.stringify({
                project: account.project_id || ''
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.status}`);
        }

        const data = await response.json();
        const models = data.models || {};

        // 解析每个模型的配额信息
        const quotas = {};
        let minQuota = 1;
        let minQuotaResetTime = null;
        let sawQuotaSignal = false;
        const hasAnyRelevantModel = Object.keys(models).some((modelId) => QUOTA_RELEVANT_MODELS.has(modelId));

        for (const [modelId, modelInfo] of Object.entries(models)) {
            if (!modelInfo) continue;

            const isRelevant = QUOTA_RELEVANT_MODELS.has(modelId);
            const shouldAffectOverall = !hasAnyRelevantModel || isRelevant;

            if (!modelInfo.quotaInfo) {
                // For relevant models, missing quotaInfo should not be treated as "full".
                if (isRelevant) {
                    sawQuotaSignal = true;
                    upsertAccountModelQuota(account.id, modelId, 0, null);
                    quotas[modelId] = {
                        remainingFraction: 0,
                        resetTime: null,
                        displayName: modelInfo.displayName || modelId
                    };

                    if (shouldAffectOverall) {
                        minQuota = 0;
                        minQuotaResetTime = null;
                    }
                }
                continue;
            }

            sawQuotaSignal = true;
            const { remainingFraction: rawRemainingFraction, resetTime } = modelInfo.quotaInfo;
            const remainingFraction = toQuotaFraction(rawRemainingFraction, 0);
            const resetTimestamp = resetTime ? new Date(resetTime).getTime() : null;

            if (isRelevant) {
                upsertAccountModelQuota(account.id, modelId, remainingFraction, resetTimestamp);
            }

            quotas[modelId] = {
                remainingFraction,
                resetTime: resetTimestamp,
                displayName: modelInfo.displayName || modelId
            };

            // 跟踪最小配额用于更新账号总体配额
            if (shouldAffectOverall && remainingFraction < minQuota) {
                minQuota = remainingFraction;
                minQuotaResetTime = resetTimestamp;
            }
        }

        if (!sawQuotaSignal) {
            minQuota = 0;
            minQuotaResetTime = null;
        }

        // 更新账号的总体配额（使用最小值）
        updateAccountQuota(account.id, minQuota, minQuotaResetTime);

        return {
            accountId: account.id,
            email: account.email,
            quotas,
            overallQuota: minQuota,
            resetTime: minQuotaResetTime
        };
    } catch (error) {
        throw error;
    }
}

/**
 * 初始化账号（刷新 token + 获取 projectId + 获取配额）
 */
export async function initializeAccount(account) {
    // 1. 刷新 token
    await ensureValidToken(account);

    // 2. 获取 projectId（如果没有）
    if (!account.project_id || !account.tier || account.tier === 'free-tier') {
        await fetchProjectId(account);
    }

    // 3. 获取配额信息
    await fetchQuotaInfo(account);

    // 4. 标记为活跃状态
    updateAccountStatus(account.id, 'active');

    return account;
}

/**
 * 启动定时 token 刷新任务
 */
export function startTokenRefreshScheduler(intervalMs = 50 * 60 * 1000) {
    const refresh = async () => {
        try {
            const accounts = getAllAccountsForRefresh();
            const now = Date.now();

            for (const account of accounts) {
                // 检查是否需要刷新
                if (!account.token_expires_at || now >= account.token_expires_at - TOKEN_REFRESH_BUFFER) {
                    try {
                        await refreshAccessToken(account);
                    } catch (error) {
                        // 错误已在 refreshAccessToken 中处理
                    }
                }
            }
        } catch {
            // ignore (status is stored in DB)
        }
    };

    // 立即执行一次
    refresh();

    // 设置定时任务
    return setInterval(refresh, intervalMs);
}

/**
 * 启动定时配额同步任务
 */
export function startQuotaSyncScheduler(intervalMs = 10 * 60 * 1000) {
    const sync = async () => {
        try {
            const accounts = getAllAccountsForRefresh();

            for (const account of accounts) {
                try {
                    if (account.access_token) {
                        await fetchQuotaInfo(account);
                    }
                } catch (error) {
                    // 单个账号失败不影响其他账号
                }
            }
        } catch {
            // ignore (status is stored in DB)
        }
    };

    // 立即执行一次（不 await，避免阻塞启动）
    sync();

    // 设置定时任务
    return setInterval(sync, intervalMs);
}
