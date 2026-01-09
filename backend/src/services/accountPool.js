import { getActiveAccounts, updateAccountLastUsed, updateAccountStatus, updateAccountQuota } from '../db/index.js';
import { ensureValidToken, fetchQuotaInfo } from './tokenManager.js';
import { RETRY_CONFIG, getMappedModel } from '../config.js';

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

/**
 * 账号池管理类
 * 实现加权轮询策略，优先使用配额多的账号
 */
class AccountPool {
    constructor() {
        this.lastAccountIndex = -1;
        this.accountLocks = new Map(); // 账号锁，防止并发问题（值为当前并发计数）
        this.capacityCooldowns = new Map(); // 账号在某个模型上的冷却期 key: `${accountId}:${model}` -> timestamp
        this.capacityErrorCounts = new Map(); // 连续容量错误计数 key: `${accountId}:${model}` -> count
        this.errorCounts = new Map(); // 账号错误计数（非容量错误）key: accountId -> count
    }

    /**
     * 获取最优账号
     * 策略：
     * 1. 筛选状态为 active 且配额 > 0 的账号
     * 2. 优先选择配额剩余最多的账号
     * 3. 如果配额相同，选择最近最少使用的账号
     */
    async getBestAccount(model = null) {
        const mappedModel = model ? getMappedModel(model) : null;
        const accounts = getActiveAccounts(mappedModel);

        if (accounts.length === 0) {
            throw new Error('No active accounts available');
        }

        let earliestCooldownUntil = null;
        let cooldownCount = 0;

        // 按配额降序、最后使用时间升序排序
        accounts.sort((a, b) => {
            // 首先按配额排序
            if (b.quota_remaining !== a.quota_remaining) {
                return b.quota_remaining - a.quota_remaining;
            }
            // 配额相同时，优先使用最久未使用的账号
            return (a.last_used_at || 0) - (b.last_used_at || 0);
        });

        // 尝试找到一个可用的账号
        for (const account of accounts) {
            // 检查账号并发是否已满
            if (!DISABLE_LOCAL_LIMITS && Number.isFinite(MAX_CONCURRENT_PER_ACCOUNT) && MAX_CONCURRENT_PER_ACCOUNT > 0) {
                const lockCount = this.accountLocks.get(account.id) || 0;
                if (lockCount >= MAX_CONCURRENT_PER_ACCOUNT) {
                    continue;
                }
            }

            // 检查是否处于容量冷却期
            if (!DISABLE_LOCAL_LIMITS && mappedModel && this.isAccountInCooldown(account.id, mappedModel)) {
                cooldownCount += 1;
                const until = this.capacityCooldowns.get(`${account.id}:${mappedModel}`);
                if (until && (!earliestCooldownUntil || until < earliestCooldownUntil)) {
                    earliestCooldownUntil = until;
                }
                continue;
            }

            try {
                // 确保 token 有效
                const validAccount = await ensureValidToken(account);

                // 锁定账号并发
                this.lockAccount(account.id);

                // 更新最后使用时间
                updateAccountLastUsed(account.id);

                return validAccount;
            } catch (error) {
                // 继续尝试下一个账号
            }
        }

        // 所有账号都在冷却期：返回 429 + reset after，便于客户端等待后重试
        if (!DISABLE_LOCAL_LIMITS && mappedModel && cooldownCount === accounts.length && earliestCooldownUntil) {
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
     * 轮询获取账号（简单轮询，不考虑配额）
     */
    async getNextAccount(model = null) {
        const mappedModel = model ? getMappedModel(model) : null;
        const accounts = getActiveAccounts(mappedModel);

        if (accounts.length === 0) {
            throw new Error('No active accounts available');
        }

        let earliestCooldownUntil = null;
        let cooldownCount = 0;

        // 严格轮询：稳定顺序（按 id），依次选择下一个可用账号
        const ordered = [...accounts].sort((a, b) => (a.id || 0) - (b.id || 0));
        const total = ordered.length;
        let idx = (this.lastAccountIndex + 1) % total;

        for (let i = 0; i < total; i++) {
            const account = ordered[idx];

            // 检查账号并发是否已满
            if (!DISABLE_LOCAL_LIMITS && Number.isFinite(MAX_CONCURRENT_PER_ACCOUNT) && MAX_CONCURRENT_PER_ACCOUNT > 0) {
                const lockCount = this.accountLocks.get(account.id) || 0;
                if (lockCount >= MAX_CONCURRENT_PER_ACCOUNT) {
                    idx = (idx + 1) % total;
                    continue;
                }
            }

            // 检查是否处于容量冷却期
            if (!DISABLE_LOCAL_LIMITS && mappedModel && this.isAccountInCooldown(account.id, mappedModel)) {
                cooldownCount += 1;
                const until = this.capacityCooldowns.get(`${account.id}:${mappedModel}`);
                if (until && (!earliestCooldownUntil || until < earliestCooldownUntil)) {
                    earliestCooldownUntil = until;
                }
                idx = (idx + 1) % total;
                continue;
            }

            try {
                const validAccount = await ensureValidToken(account);

                // 锁定账号并发
                this.lockAccount(account.id);

                // 更新最后使用时间
                updateAccountLastUsed(account.id);

                this.lastAccountIndex = idx;
                return validAccount;
            } catch {
                // 继续尝试下一个账号
            }

            idx = (idx + 1) % total;
        }

        // 所有账号都在冷却期：返回 429 + reset after，便于客户端等待后重试
        if (!DISABLE_LOCAL_LIMITS && mappedModel && cooldownCount === total && earliestCooldownUntil) {
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
        const mappedModel = model ? getMappedModel(model) : null;
        if (!accountId || !mappedModel) return;

        let cooldownMs = CAPACITY_COOLDOWN_DEFAULT_MS;
        const key = `${accountId}:${mappedModel}`;
        const prev = this.capacityErrorCounts.get(key) || 0;
        const next = prev + 1;
        this.capacityErrorCounts.set(key, next);

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
        this.capacityCooldowns.set(key, until);
        return cooldownMs;
    }

    /**
     * 成功调用后清除该模型的容量错误退避计数
     */
    markCapacityRecovered(accountId, model) {
        if (DISABLE_LOCAL_LIMITS) return;
        const mappedModel = model ? getMappedModel(model) : null;
        if (!accountId || !mappedModel) return;
        const key = `${accountId}:${mappedModel}`;
        this.capacityErrorCounts.delete(key);
    }

    /**
     * 检查账号在某个模型上是否处于冷却期
     */
    isAccountInCooldown(accountId, model) {
        if (DISABLE_LOCAL_LIMITS) return false;
        const mappedModel = model ? getMappedModel(model) : null;
        if (!accountId || !mappedModel) return false;
        const key = `${accountId}:${mappedModel}`;
        const until = this.capacityCooldowns.get(key);
        if (!until) return false;

        if (Date.now() < until) {
            return true;
        }

        // 冷却已过期，清理
        this.capacityCooldowns.delete(key);
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
        const mappedModel = model ? getMappedModel(model) : null;
        const accounts = getActiveAccounts(mappedModel);
        return accounts.length;
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
