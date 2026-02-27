import { OAUTH_CONFIG, ANTIGRAVITY_CONFIG, AVAILABLE_MODELS, getMappedModel, isImageGenerationModel, getQuotaGroup, QUOTA_GROUPS } from '../config.js';
import { updateAccountToken, updateAccountQuota, updateAccountStatus, updateAccountProjectId, updateAccountTier, updateAccountEmail, getAllAccountsForRefresh, upsertAccountModelQuota, getAccountByEmail, deleteAccount, cleanupOldLogs } from '../db/index.js';
import { fingerprintFetch } from '../runtime/fingerprint-requester.js';
import { ensureDeviceIdentity } from './deviceIdentity.js';
import { runWarmupSequence, startHeartbeat, updateHeartbeatAccount } from './warmup.js';
import { getDatabase } from '../db/index.js';

// Token 刷新提前时间（5分钟）
const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000;

// Singleflight: 防止同一账号并发刷新 token (key: accountId -> Promise)
const refreshInFlight = new Map();

// Only consider models that this proxy actually exposes (mapped to upstream names).
const QUOTA_RELEVANT_MODELS = new Set(AVAILABLE_MODELS.map((m) => getMappedModel(m.id)));

function toQuotaFraction(value, fallback = 0) {
    if (value === null || value === undefined) return fallback;
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    // remainingFraction should be within [0, 1], clamp defensively
    return Math.max(0, Math.min(1, num));
}

function createGroupQuotaState() {
    const groups = new Map();
    for (const group of Object.values(QUOTA_GROUPS)) {
        groups.set(group, {
            sawSignal: false,
            remainingFraction: 1,
            resetTime: null
        });
    }
    return groups;
}

function mergeGroupQuota(groups, modelId, remainingFraction, resetTime) {
    const group = getQuotaGroup(modelId);
    if (!group) return;

    const nextRemaining = toQuotaFraction(remainingFraction, 0);
    const entry = groups.get(group) || { sawSignal: false, remainingFraction: 1, resetTime: null };

    if (!entry.sawSignal || nextRemaining < entry.remainingFraction) {
        entry.remainingFraction = nextRemaining;
        entry.resetTime = resetTime ?? null;
    } else if (nextRemaining === entry.remainingFraction && entry.resetTime === null && resetTime !== null) {
        entry.resetTime = resetTime;
    }

    entry.sawSignal = true;
    groups.set(group, entry);
}

function persistGroupQuotaState(accountId, groups) {
    for (const [group, entry] of groups.entries()) {
        upsertAccountModelQuota(
            accountId,
            `group:${group}`,
            entry.sawSignal ? entry.remainingFraction : 0,
            entry.sawSignal ? entry.resetTime : null
        );
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 刷新账号的 access_token
 */
export async function refreshAccessToken(account) {
    try {
        const response = await fetch(OAUTH_CONFIG.token_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
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

        // 同步更新 heartbeat 中的 account 引用
        account.access_token = data.access_token;
        updateHeartbeatAccount(account);

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
 * 强制刷新 token（用于 401 认证错误后的恢复尝试）
 * 使用 singleflight 模式防止并发刷新
 * @returns {Promise<{access_token, expires_in} | null>} 成功返回新 token，失败返回 null
 */
export async function forceRefreshToken(account) {
    if (!account?.id || !account?.refresh_token) {
        return null;
    }

    const accountId = account.id;
    const existing = refreshInFlight.get(accountId);
    if (existing) {
        return existing;
    }

    const refreshPromise = (async () => {
        try {
            const result = await refreshAccessToken(account);
            account.access_token = result.access_token;
            account.token_expires_at = Date.now() + (result.expires_in * 1000);
            return result;
        } catch (error) {
            return null;
        } finally {
            refreshInFlight.delete(accountId);
        }
    })();

    refreshInFlight.set(accountId, refreshPromise);
    return refreshPromise;
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
 * 通过 onboardUser 端点注册用户并获取 projectId（适用于从未登录过 Antigravity 的用户）
 * 会先尝试 standard-tier，失败后尝试 free-tier
 * onboardUser 是异步操作，需要轮询等待 done: true
 */
async function onboardUser(account) {
    const tiers = ['standard-tier', 'free-tier'];
    const maxAttempts = 8; // 增加到 8 次，总等待时间约 16 秒
    const pollDelayMs = 2000;
    let lastError = null;

    for (const tierId of tiers) {
        let noProjectIdRetries = 0; // done=true 但无 projectId 的重试计数

        // 对每个 tier 进行轮询重试
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await fingerprintFetch(`${ANTIGRAVITY_CONFIG.base_url}/v1internal:onboardUser`, {
                    method: 'POST',
                    headers: {
                        'Host': new URL(ANTIGRAVITY_CONFIG.base_url).host,
                        'User-Agent': ANTIGRAVITY_CONFIG.user_agent,
                        'Authorization': `Bearer ${account.access_token}`,
                        'Content-Type': 'application/json',
                        'Accept-Encoding': 'gzip'
                    },
                    body: JSON.stringify({
                        tierId: tierId,
                        metadata: {
                            ideType: 'ANTIGRAVITY',
                            platform: 'PLATFORM_UNSPECIFIED',
                            pluginType: 'GEMINI'
                        }
                    })
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    lastError = new Error(errorData.error?.message || `Failed to onboard user: ${response.status}`);
                    // 429、408、409、5xx 错误：等待后重试当前 tier
                    if (response.status === 429 || response.status === 408 || response.status === 409 || response.status >= 500) {
                        await sleep(pollDelayMs);
                        continue;
                    }
                    // 其他错误：尝试下一个 tier
                    break;
                }

                const data = await response.json();

                // onboardUser 是异步操作，done: false 表示操作进行中，需要等待后重试
                if (!data.done) {
                    lastError = new Error('Onboard operation not completed');
                    await sleep(pollDelayMs);
                    continue;
                }

                // 提取 projectId（兼容字符串或对象格式）
                const projectInfo = data.response?.cloudaicompanionProject;
                const projectId = typeof projectInfo === 'string' ? projectInfo : projectInfo?.id;
                if (!projectId) {
                    // done=true 但无 projectId，可能是上游短暂一致性问题，重试 2 次
                    noProjectIdRetries++;
                    if (noProjectIdRetries <= 2) {
                        lastError = new Error('No project ID in onboard response (retrying)');
                        await sleep(pollDelayMs);
                        continue;
                    }
                    lastError = new Error('No project ID in onboard response');
                    break; // 重试次数用完，尝试下一个 tier
                }

                return {
                    projectId,
                    projectName: typeof projectInfo === 'object' ? projectInfo.name : null,
                    projectNumber: typeof projectInfo === 'object' ? projectInfo.projectNumber : null,
                    tierId: tierId
                };
            } catch (error) {
                lastError = error;
                await sleep(pollDelayMs);
                continue;
            }
        }
    }

    // 所有 tier 都失败了
    throw lastError || new Error('Failed to onboard user with all tiers');
}

/**
 * 获取账号的 projectId
 * 1. 先尝试 loadCodeAssist（适用于已登录过的用户）
 * 2. 如果失败或没有 projectId，调用 onboardUser 注册用户
 * 3. 注册成功后再调用 loadCodeAssist 获取 tier
 */
export async function fetchProjectId(account) {
    let projectId = null;
    let tier = 'free-tier';

    // 1. 先尝试 loadCodeAssist
    try {
        const response = await fingerprintFetch(`${ANTIGRAVITY_CONFIG.base_url}/v1internal:loadCodeAssist`, {
            method: 'POST',
            headers: {
                'Host': new URL(ANTIGRAVITY_CONFIG.base_url).host,
                'User-Agent': ANTIGRAVITY_CONFIG.user_agent,
                'Authorization': `Bearer ${account.access_token}`,
                'Content-Type': 'application/json',
                'Accept-Encoding': 'gzip'
            },
            body: JSON.stringify({
                metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
            })
        });

        if (response.ok) {
            const data = await response.json();
            projectId = data.cloudaicompanionProject;
            tier = data.currentTier?.id || 'free-tier';
        }
    } catch {
        // loadCodeAssist 失败，继续尝试 onboardUser
    }

    // 2. 如果没有获取到 projectId，尝试 onboardUser 初始化
    if (!projectId) {
        try {
            const onboardResult = await onboardUser(account);
            projectId = onboardResult.projectId;

            // 3. onboardUser 成功后，再调用 loadCodeAssist 获取 tier
            try {
                const response = await fingerprintFetch('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
                    method: 'POST',
                    headers: {
                        'Host': 'daily-cloudcode-pa.googleapis.com',
                        'User-Agent': ANTIGRAVITY_CONFIG.user_agent,
                        'Authorization': `Bearer ${account.access_token}`,
                        'Content-Type': 'application/json',
                        'Accept-Encoding': 'gzip'
                    },
                    body: JSON.stringify({
                        metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    tier = data.currentTier?.id || 'standard-tier';
                }
            } catch {
                // 获取 tier 失败，使用默认值
                tier = 'standard-tier';
            }
        } catch (onboardError) {
            throw new Error(`无法获取 project_id: ${onboardError.message}`);
        }
    }

    // 4. 保存结果
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
}

/**
 * 获取账号的配额信息（所有模型）
 */
export async function fetchQuotaInfo(account, model = null) {
    try {
        const response = await fingerprintFetch(`${ANTIGRAVITY_CONFIG.base_url}/v1internal:fetchAvailableModels`, {
            method: 'POST',
            headers: {
                'Host': new URL(ANTIGRAVITY_CONFIG.base_url).host,
                'User-Agent': ANTIGRAVITY_CONFIG.user_agent,
                'Authorization': `Bearer ${account.access_token}`,
                'Content-Type': 'application/json',
                'Accept-Encoding': 'gzip'
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
        const groupQuotaState = createGroupQuotaState();

        const relevantEntries = Object.entries(models).filter(([modelId]) => QUOTA_RELEVANT_MODELS.has(modelId));
        const entriesToScan = relevantEntries.length > 0 ? relevantEntries : Object.entries(models);

        for (const [modelId, modelInfo] of entriesToScan) {
            if (!modelInfo) continue;

            const isRelevant = QUOTA_RELEVANT_MODELS.has(modelId);
            // 图像生成模型不参与总体配额计算（它们有独立的配额池）
            const isImageModel = isImageGenerationModel(modelId);
            const shouldAffectOverall = isRelevant && !isImageModel;

            // If the model is relevant but quotaInfo is missing, treat as 0 to avoid "phantom 100%".
            if (!modelInfo.quotaInfo) {
                if (isRelevant) {
                    sawQuotaSignal = true;
                    upsertAccountModelQuota(account.id, modelId, 0, null);
                    mergeGroupQuota(groupQuotaState, modelId, 0, null);
                    if (shouldAffectOverall) {
                        minQuota = 0;
                        minQuotaResetTime = null;
                    }
                }
                continue;
            }

            sawQuotaSignal = true;
            const remainingFraction = toQuotaFraction(modelInfo.quotaInfo.remainingFraction, 0);
            const resetTimestamp = modelInfo.quotaInfo.resetTime ? new Date(modelInfo.quotaInfo.resetTime).getTime() : null;

            if (isRelevant) {
                upsertAccountModelQuota(account.id, modelId, remainingFraction, resetTimestamp);
                mergeGroupQuota(groupQuotaState, modelId, remainingFraction, resetTimestamp);
            }

            if (shouldAffectOverall && remainingFraction < minQuota) {
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

        persistGroupQuotaState(account.id, groupQuotaState);
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

        const response = await fingerprintFetch(`${ANTIGRAVITY_CONFIG.base_url}/v1internal:fetchAvailableModels`, {
            method: 'POST',
            headers: {
                'Host': new URL(ANTIGRAVITY_CONFIG.base_url).host,
                'User-Agent': ANTIGRAVITY_CONFIG.user_agent,
                'Authorization': `Bearer ${account.access_token}`,
                'Content-Type': 'application/json',
                'Accept-Encoding': 'gzip'
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
        const groupQuotaState = createGroupQuotaState();
        const hasAnyRelevantModel = Object.keys(models).some((modelId) => QUOTA_RELEVANT_MODELS.has(modelId));

        for (const [modelId, modelInfo] of Object.entries(models)) {
            if (!modelInfo) continue;

            const isRelevant = QUOTA_RELEVANT_MODELS.has(modelId);
            // 图像生成模型不参与总体配额计算（它们有独立的配额池）
            const isImageModel = isImageGenerationModel(modelId);
            const shouldAffectOverall = (!hasAnyRelevantModel || isRelevant) && !isImageModel;

            if (!modelInfo.quotaInfo) {
                // For relevant models, missing quotaInfo should not be treated as "full".
                if (isRelevant) {
                    sawQuotaSignal = true;
                    upsertAccountModelQuota(account.id, modelId, 0, null);
                    mergeGroupQuota(groupQuotaState, modelId, 0, null);
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
                mergeGroupQuota(groupQuotaState, modelId, remainingFraction, resetTimestamp);
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

        persistGroupQuotaState(account.id, groupQuotaState);
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
 * 获取用户邮箱
 */
export async function fetchEmail(account) {
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            method: 'GET',
            headers: {
                'Host': 'www.googleapis.com',
                'User-Agent': 'Go-http-client/1.1',
                'Authorization': `Bearer ${account.access_token}`,
                'Accept-Encoding': 'gzip'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch email: ${response.status}`);
        }

        const data = await response.json();
        const email = data.email;

        if (email) {
            // 检查 email 是否已被其他账号使用
            const existing = getAccountByEmail(email);
            if (existing && existing.id !== account.id) {
                // 删除当前新创建的账号（它是重复的）
                deleteAccount(account.id);
                throw new Error(`账号 ${email} 已存在`);
            }
            updateAccountEmail(account.id, email);
            account.email = email;
        }

        return email;
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

    // 2. 获取 email（如果没有）
    if (!account.email) {
        try {
            await fetchEmail(account);
        } catch (emailError) {
            // 如果是账号已存在错误，需要重新抛出（账号已被删除）
            if (emailError.message && emailError.message.includes('已存在')) {
                throw emailError;
            }
            // 其他 email 获取失败不影响账号初始化
        }
    }

    // 3. 获取 projectId（如果没有）
    if (!account.project_id || !account.tier || account.tier === 'free-tier') {
        await fetchProjectId(account);
    }

    // 4. 获取配额信息
    await fetchQuotaInfo(account);

    // 5. 生成设备指纹（首次初始化时）
    try { ensureDeviceIdentity(getDatabase(), account); } catch { /* ignore */ }

    // 6. 标记为活跃状态
    updateAccountStatus(account.id, 'active');

    // 7. 执行 Warmup 启动序列并启动 Heartbeat（后台，不阻塞）
    runWarmupSequence(account).then(() => startHeartbeat(account)).catch(() => {});

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

/**
 * 启动定时日志清理任务（每小时清理 24 小时前的日志）
 */
export function startLogCleanupScheduler(intervalMs = 60 * 60 * 1000) {
    const cleanup = () => {
        try {
            const result = cleanupOldLogs();
            if (result.requestLogs > 0 || result.attemptLogs > 0) {
                console.log(`[LogCleanup] Deleted ${result.requestLogs} request logs, ${result.attemptLogs} attempt logs`);
            }
        } catch {
            // ignore
        }
    };

    // 启动时执行一次
    cleanup();

    // 设置定时任务
    return setInterval(cleanup, intervalMs);
}

/**
 * 获取所有活跃账号（供伪装服务调度器使用）
 */
export function getAllActiveAccounts() {
    return getAllAccountsForRefresh().filter(a => a.status === 'active' && a.access_token);
}
