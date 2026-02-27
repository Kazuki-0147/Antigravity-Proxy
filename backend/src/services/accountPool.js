import { getActiveAccounts, getAccountById, updateAccountLastUsed, updateAccountStatus, updateAccountQuota, getSetting } from '../db/index.js';
import { ensureValidToken, fetchQuotaInfo } from './tokenManager.js';
import { RETRY_CONFIG, QUOTA_GROUPS, getMappedModel, getQuotaGroup, getGroupQuotaThreshold } from '../config.js';

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const v = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
    return defaultValue;
}

const DISABLE_LOCAL_LIMITS = parseBoolean(process.env.DISABLE_LOCAL_LIMITS, false);

// 每个账号允许的最大并发请求数（默认 0 = 不限制）
const MAX_CONCURRENT_PER_ACCOUNT = Number(process.env.MAX_CONCURRENT_PER_ACCOUNT || 0);
// 容量耗尽后的默认冷却时间（毫秒），如果上游返回了具体秒数，会在此基础上调整
const CAPACITY_COOLDOWN_DEFAULT_MS = Number(process.env.CAPACITY_COOLDOWN_DEFAULT_MS || 15000);
const CAPACITY_COOLDOWN_MAX_MS = Number(process.env.CAPACITY_COOLDOWN_MAX_MS || 120000);
const MISSING_SETTING = '__AGP_MISSING__';

const GROUP_THRESHOLD_SETTING_KEY = Object.freeze({
    flash: 'flashGroupQuotaMinThreshold',
    pro: 'proGroupQuotaMinThreshold',
    claude: 'claudeGroupQuotaMinThreshold',
    image: 'imageGroupQuotaMinThreshold'
});

function clampThresholdValue(value, fallback = 0.2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

/**
 * 账号池管理类
 * 实现配额优先策略，尽量先消耗高配额账号
 */
class AccountPool {
    constructor() {
        this.lastUsedAccountId = 0; // 全局跟踪上次使用的账号 ID（跨模型共享）
        this.preferredAccountBySelection = new Map(); // 每个分组/模型的粘性账号 key: selectionKey -> accountId
        this.accountLocks = new Map(); // 账号锁，防止并发问题（值为当前并发计数）
        this.capacityCooldowns = new Map(); // 账号在某个模型上的冷却期 key: `${accountId}:${model}` -> timestamp
        this.capacityErrorCounts = new Map(); // 连续容量错误计数 key: `${accountId}:${model}` -> count
        this.errorCounts = new Map(); // 账号错误计数（非容量错误）key: accountId -> count
    }

    resolveSelectionContext(model = null) {
        const mappedModel = model ? getMappedModel(model) : null;
        const quotaGroup = mappedModel ? getQuotaGroup(mappedModel) : null;
        const selectionKey = quotaGroup ? `group:${quotaGroup}` : mappedModel;
        const minQuotaThreshold = quotaGroup ? this.getDynamicGroupThreshold(quotaGroup) : 0;
        return { mappedModel, quotaGroup, selectionKey, minQuotaThreshold };
    }

    getDynamicGroupThreshold(quotaGroup) {
        if (!quotaGroup) return 0;

        const envGroupDefault = getGroupQuotaThreshold(quotaGroup);
        const envGlobalDefault = getGroupQuotaThreshold();

        const groupSettingKey = GROUP_THRESHOLD_SETTING_KEY[quotaGroup] || null;
        const globalRaw = getSetting('groupQuotaMinThreshold', MISSING_SETTING);
        const groupRaw = groupSettingKey ? getSetting(groupSettingKey, MISSING_SETTING) : MISSING_SETTING;

        if (groupRaw !== MISSING_SETTING) {
            return clampThresholdValue(groupRaw, envGroupDefault);
        }
        if (globalRaw !== MISSING_SETTING) {
            return clampThresholdValue(globalRaw, envGlobalDefault);
        }
        return clampThresholdValue(envGroupDefault, envGlobalDefault);
    }

    normalizeCapacityKey(model) {
        if (!model) return null;
        const raw = String(model);
        if (raw.startsWith('group:')) return raw;
        const mappedModel = getMappedModel(raw);
        const quotaGroup = getQuotaGroup(mappedModel);
        return quotaGroup ? `group:${quotaGroup}` : mappedModel;
    }

    getCapacityCacheKey(accountId, model) {
        const normalized = this.normalizeCapacityKey(model);
        if (!accountId || !normalized) return null;
        return `${accountId}:${normalized}`;
    }

    getThresholdRetryAfterMs(accounts) {
        let earliestReset = null;
        for (const account of accounts) {
            const resetAt = Number(account?.quota_reset_time);
            if (!Number.isFinite(resetAt) || resetAt <= Date.now()) continue;
            if (!earliestReset || resetAt < earliestReset) earliestReset = resetAt;
        }
        if (!earliestReset) return null;
        return Math.max(0, earliestReset - Date.now());
    }

    createThresholdError(quotaGroup, minQuotaThreshold, accounts) {
        const retryAfterMs = this.getThresholdRetryAfterMs(accounts);
        const thresholdPct = Math.max(0, minQuotaThreshold * 100);
        const thresholdText = Number.isInteger(thresholdPct) ? `${thresholdPct}` : thresholdPct.toFixed(1);
        const groupName = quotaGroup || 'requested model';

        let message = `No account above ${thresholdText}% quota for ${groupName}`;
        if (Number.isFinite(retryAfterMs)) {
            const seconds = Math.max(0, Math.ceil(retryAfterMs / 1000));
            const messageSeconds = Math.max(0, seconds - 1);
            message += `, reset after ${messageSeconds}s`;
        }

        const err = new Error(message);
        err.upstreamStatus = 429;
        if (Number.isFinite(retryAfterMs)) {
            err.retryAfterMs = retryAfterMs;
        }
        return err;
    }

    getGroupRoutingOverview() {
        const groups = Object.values(QUOTA_GROUPS);
        const result = [];

        for (const group of groups) {
            const selectionKey = `group:${group}`;
            const minQuotaThreshold = this.getDynamicGroupThreshold(group);
            const accounts = getActiveAccounts(selectionKey, { minQuotaRemaining: 0 });
            const eligible = accounts
                .filter((a) => Number(a?.quota_remaining) > minQuotaThreshold)
                .sort((a, b) => {
                    if (Number(b.quota_remaining) !== Number(a.quota_remaining)) {
                        return Number(b.quota_remaining) - Number(a.quota_remaining);
                    }
                    return (a.id || 0) - (b.id || 0);
                });

            const stickyRaw = Number(this.preferredAccountBySelection.get(selectionKey));
            const stickyId = Number.isFinite(stickyRaw) && stickyRaw > 0 ? stickyRaw : null;
            const stickyEligible = stickyId
                ? eligible.find((a) => Number(a?.id) === stickyId) || null
                : null;
            const stickyActive = stickyId
                ? accounts.find((a) => Number(a?.id) === stickyId) || null
                : null;

            let stickyAccount = stickyActive || null;
            if (!stickyAccount && stickyId) {
                stickyAccount = getAccountById(stickyId) || null;
            }

            const current = stickyEligible || eligible[0] || null;
            const switchRequired = !!stickyId && !stickyEligible;

            result.push({
                group,
                selectionKey,
                threshold: minQuotaThreshold,
                eligibleCount: eligible.length,
                sticky: stickyId
                    ? {
                        id: stickyId,
                        email: stickyAccount?.email || null,
                        status: stickyAccount?.status || null,
                        active: !!stickyActive,
                        eligible: !!stickyEligible,
                        switchRequired
                    }
                    : null,
                currentAccount: current
                    ? {
                        id: Number(current.id),
                        email: current.email || null,
                        quotaRemaining: Number(current.quota_remaining)
                    }
                    : null
            });
        }

        return result;
    }

    /**
     * 获取最优账号
     * 策略：
     * 1. 筛选状态为 active 且配额 > 0 的账号
     * 2. 优先选择配额剩余最多的账号
     * 3. 如果配额相同，选择最近最少使用的账号
     */
    async getBestAccount(model = null) {
        return this.getNextAccount(model);
    }

    /**
     * 获取下一个账号（按组配额优先）
     */
    async getNextAccount(model = null, options = null) {
        const { quotaGroup, selectionKey, minQuotaThreshold } = this.resolveSelectionContext(model);
        const accounts = getActiveAccounts(selectionKey, { minQuotaRemaining: 0 });

        if (accounts.length === 0) {
            if (selectionKey) this.preferredAccountBySelection.delete(selectionKey);
            throw new Error('No active accounts available');
        }

        const thresholdCandidates = accounts.filter((a) => Number(a?.quota_remaining) > minQuotaThreshold);

        if (thresholdCandidates.length === 0) {
            if (selectionKey) this.preferredAccountBySelection.delete(selectionKey);
            throw this.createThresholdError(quotaGroup, minQuotaThreshold, accounts);
        }

        const excludeIds = new Set();
        if (options && typeof options === 'object') {
            const raw = options.excludeAccountIds;
            if (Array.isArray(raw)) {
                for (const v of raw) {
                    const n = Number(v);
                    if (Number.isFinite(n) && n > 0) {
                        excludeIds.add(n);
                    }
                }
            }
        }

        let earliestCooldownUntil = null;
        let cooldownCount = 0;

        const sortedByQuota = [...thresholdCandidates].sort((a, b) => {
            if (Number(b.quota_remaining) !== Number(a.quota_remaining)) {
                return Number(b.quota_remaining) - Number(a.quota_remaining);
            }
            return (a.id || 0) - (b.id || 0);
        });

        // 粘性账号策略：同一配额分组内，优先持续使用上一次成功账号，
        // 直到它低于阈值/不可用，再切换到新的高配额账号。
        const preferredId = Number(selectionKey ? this.preferredAccountBySelection.get(selectionKey) : 0);
        const preferredAccount = Number.isFinite(preferredId) && preferredId > 0
            ? sortedByQuota.find((a) => Number(a?.id) === preferredId)
            : null;
        const ordered = preferredAccount
            ? [preferredAccount, ...sortedByQuota.filter((a) => Number(a?.id) !== preferredId)]
            : sortedByQuota;

        let consideredCount = 0;

        for (const account of ordered) {
            const candidateId = Number(account?.id);
            if (!Number.isFinite(candidateId) || candidateId <= 0) continue;
            if (excludeIds.has(candidateId)) continue;
            consideredCount += 1;

            // 检查账号并发是否已满
            if (!DISABLE_LOCAL_LIMITS && Number.isFinite(MAX_CONCURRENT_PER_ACCOUNT) && MAX_CONCURRENT_PER_ACCOUNT > 0) {
                const lockCount = this.accountLocks.get(account.id) || 0;
                if (lockCount >= MAX_CONCURRENT_PER_ACCOUNT) {
                    continue;
                }
            }

            // 检查是否处于容量冷却期
            if (!DISABLE_LOCAL_LIMITS && selectionKey && this.isAccountInCooldown(account.id, selectionKey)) {
                cooldownCount += 1;
                const cooldownKey = this.getCapacityCacheKey(account.id, selectionKey);
                const until = cooldownKey ? this.capacityCooldowns.get(cooldownKey) : null;
                if (until && (!earliestCooldownUntil || until < earliestCooldownUntil)) {
                    earliestCooldownUntil = until;
                }
                continue;
            }

            try {
                const validAccount = await ensureValidToken(account);

                // 锁定账号并发
                this.lockAccount(account.id);

                // 更新最后使用时间
                updateAccountLastUsed(account.id);
                this.lastUsedAccountId = candidateId;
                if (selectionKey) this.preferredAccountBySelection.set(selectionKey, candidateId);

                return validAccount;
            } catch (err) {
                console.error(`[ACCOUNT_POOL] ensureValidToken failed for account ${account.id} (${account.email}):`, err.message);
                if (selectionKey && preferredId === candidateId) {
                    this.preferredAccountBySelection.delete(selectionKey);
                }
                // 继续尝试下一个账号
            }
        }

        // 所有账号都在冷却期：返回 429 + reset after，便于客户端等待后重试
        if (!DISABLE_LOCAL_LIMITS && selectionKey && consideredCount > 0 && cooldownCount === consideredCount && earliestCooldownUntil) {
            const remainingMs = Math.max(0, earliestCooldownUntil - Date.now());
            const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
            const messageSeconds = Math.max(0, seconds - 1);
            const err = new Error(`No capacity available, reset after ${messageSeconds}s`);
            err.upstreamStatus = 429;
            err.retryAfterMs = remainingMs;
            throw err;
        }

        throw new Error('No available accounts with valid tokens');
    }

    /**
     * 标记账号出错 - 累计错误，达到阈值才禁用
     * @returns {boolean} 是否已禁用账号
     */
    markAccountError(accountId, error) {
        const threshold = RETRY_CONFIG.errorCountToDisable;
        const current = this.errorCounts.get(accountId) || 0;
        const next = current + 1;

        if (next >= threshold) {
            // 达到阈值，真正禁用
            updateAccountStatus(accountId, 'error', error.message || String(error));
            this.errorCounts.delete(accountId);
            return true;
        } else {
            // 未达阈值，只记录计数
            this.errorCounts.set(accountId, next);
            return false;
        }
    }

    /**
     * 请求成功后重置错误计数
     */
    markAccountSuccess(accountId) {
        this.errorCounts.delete(accountId);
    }

    /**
     * 获取账号当前错误计数
     */
    getErrorCount(accountId) {
        return this.errorCounts.get(accountId) || 0;
    }

    /**
     * 降低账号配额（请求成功后调用）
     */
    decreaseQuota(accountId, amount = 0.001) {
        // 简单的配额估算，实际配额以 API 返回为准
        const accounts = getActiveAccounts();
        const account = accounts.find(a => a.id === accountId);

        if (account) {
            const newQuota = Math.max(0, account.quota_remaining - amount);
            updateAccountQuota(accountId, newQuota, account.quota_reset_time);
        }
    }

    /**
     * 锁定账号（防止并发使用同一账号）
     */
    lockAccount(accountId) {
        if (DISABLE_LOCAL_LIMITS) return;
        if (Number.isFinite(MAX_CONCURRENT_PER_ACCOUNT) && MAX_CONCURRENT_PER_ACCOUNT <= 0) return;
        const current = this.accountLocks.get(accountId) || 0;
        this.accountLocks.set(accountId, current + 1);
    }

    /**
     * 解锁账号
     */
    unlockAccount(accountId) {
        if (DISABLE_LOCAL_LIMITS) return;
        if (Number.isFinite(MAX_CONCURRENT_PER_ACCOUNT) && MAX_CONCURRENT_PER_ACCOUNT <= 0) return;
        const current = this.accountLocks.get(accountId) || 0;
        if (current <= 1) {
            this.accountLocks.delete(accountId);
        } else {
            this.accountLocks.set(accountId, current - 1);
        }
    }

    /**
     * 标记账号在某个模型上容量耗尽，进入短暂冷却期
     */
    markCapacityLimited(accountId, model, message) {
        if (DISABLE_LOCAL_LIMITS) return;
        const cacheKey = this.getCapacityCacheKey(accountId, model);
        if (!cacheKey) return;

        let cooldownMs = CAPACITY_COOLDOWN_DEFAULT_MS;
        const prev = this.capacityErrorCounts.get(cacheKey) || 0;
        const next = prev + 1;
        this.capacityErrorCounts.set(cacheKey, next);

        // 指数退避：默认冷却 * 2^(n-1)，上限 CAPACITY_COOLDOWN_MAX_MS
        if (CAPACITY_COOLDOWN_DEFAULT_MS > 0) {
            const backoff = CAPACITY_COOLDOWN_DEFAULT_MS * (2 ** Math.max(0, next - 1));
            cooldownMs = Math.min(CAPACITY_COOLDOWN_MAX_MS, backoff);
        }

        // 尝试从错误信息中解析 reset 秒数
        if (typeof message === 'string') {
            const match = message.match(/reset after (\d+)s/i);
            if (match) {
                const seconds = parseInt(match[1], 10);
                if (!Number.isNaN(seconds) && seconds >= 0) {
                    // 稍微多加 1 秒缓冲
                    cooldownMs = (seconds + 1) * 1000;
                }
            }
        }

        const until = Date.now() + cooldownMs;
        this.capacityCooldowns.set(cacheKey, until);
        return cooldownMs;
    }

    /**
     * 成功调用后清除该模型的容量错误退避计数
     */
    markCapacityRecovered(accountId, model) {
        if (DISABLE_LOCAL_LIMITS) return;
        const cacheKey = this.getCapacityCacheKey(accountId, model);
        if (!cacheKey) return;
        this.capacityErrorCounts.delete(cacheKey);
    }

    /**
     * 检查账号在某个模型上是否处于冷却期
     */
    isAccountInCooldown(accountId, model) {
        if (DISABLE_LOCAL_LIMITS) return false;
        const cacheKey = this.getCapacityCacheKey(accountId, model);
        if (!cacheKey) return false;
        const until = this.capacityCooldowns.get(cacheKey);
        if (!until) return false;

        if (Date.now() < until) {
            return true;
        }

        // 冷却已过期，清理
        this.capacityCooldowns.delete(cacheKey);
        return false;
    }

    /**
     * 获取池状态统计
     */
    getPoolStats() {
        const accounts = getActiveAccounts();

        return {
            total: accounts.length,
            active: accounts.filter(a => a.status === 'active').length,
            avgQuota: accounts.length > 0
                ? accounts.reduce((sum, a) => sum + a.quota_remaining, 0) / accounts.length
                : 0
        };
    }

    /**
     * 获取当前可用账号数量（active 且 quota > 0）
     */
    getAvailableAccountCount(model = null) {
        const { selectionKey, minQuotaThreshold } = this.resolveSelectionContext(model);
        const accounts = getActiveAccounts(selectionKey, { minQuotaRemaining: 0 });
        return accounts.filter((a) => Number(a?.quota_remaining) > minQuotaThreshold).length;
    }

    /**
     * 刷新所有账号的配额信息
     */
    async refreshAllQuotas() {
        const accounts = getActiveAccounts();

        for (const account of accounts) {
            try {
                if (account.access_token) {
                    await fetchQuotaInfo(account);
                }
            } catch (error) {
                // ignore
            }
        }
    }
}

// 单例
export const accountPool = new AccountPool();
