import { isCapacityError, isNonRetryableError, parseResetAfterMs, sleep } from './route-helpers.js';
import { withCapacityRetry, withFullRetry } from './retry-handler.js';
import { RETRY_CONFIG } from '../config.js';

export function createAbortController(request) {
    const abortController = new AbortController();
    request.raw.on('close', () => abortController.abort());
    return abortController;
}

function attachAccountToError(error, account) {
    if (!error || typeof error !== 'object') return;
    if (!account) return;
    // internal-only: used by routes to unlock / markAccountError consistently after refactor
    if (!Object.prototype.hasOwnProperty.call(error, 'account')) {
        Object.defineProperty(error, 'account', { value: account, enumerable: false });
    }
}

export async function runChatWithCapacityRetry({
    model,
    maxRetries,
    baseRetryDelayMs,
    accountPool,
    buildRequest,
    execute
}) {
    const configuredRetries = Math.max(0, Number(maxRetries || 0));
    const availableCount = typeof accountPool?.getAvailableAccountCount === 'function'
        ? accountPool.getAvailableAccountCount(model)
        : 0;
    // 至少轮询完一遍账号池（遇到 capacity 时再放弃）
    const effectiveMaxRetries = Math.max(configuredRetries, Math.max(0, availableCount - 1));

    const out = await withCapacityRetry({
        maxRetries: effectiveMaxRetries,
        baseRetryDelayMs,
        getAccount: async () => accountPool.getNextAccount(model),
        executeRequest: async ({ account }) => {
            const antigravityRequest = buildRequest(account);
            try {
                return await execute(account, antigravityRequest);
            } catch (error) {
                if (!isCapacityError(error)) attachAccountToError(error, account);
                throw error;
            }
        },
        onCapacityError: async ({ account, error }) => {
            const cooldownMs = accountPool.markCapacityLimited(account.id, model, error.message || '');
            if (cooldownMs !== undefined && error && typeof error === 'object' && !Number.isFinite(error.retryAfterMs)) {
                error.retryAfterMs = cooldownMs;
            }
            accountPool.unlockAccount(account.id);
        }
    });

    if (out.account) accountPool.markCapacityRecovered(out.account.id, model);
    return { account: out.account, result: out.result };
}

/**
 * 带完整重试策略的非流式请求：同号重试 + 换号重试
 */
export async function runChatWithFullRetry({
    model,
    accountPool,
    buildRequest,
    execute
}) {
    const availableCount = typeof accountPool?.getAvailableAccountCount === 'function'
        ? accountPool.getAvailableAccountCount(model)
        : 0;
    // 换号次数：配置值或账号池大小-1，取较大者
    const maxAccountSwitches = Math.max(RETRY_CONFIG.maxRetries, Math.max(0, availableCount - 1));

    const out = await withFullRetry({
        sameAccountRetries: RETRY_CONFIG.sameAccountRetries,
        sameAccountRetryDelayMs: RETRY_CONFIG.sameAccountRetryDelayMs,
        maxAccountSwitches,
        accountSwitchDelayMs: RETRY_CONFIG.baseRetryDelayMs,
        totalTimeoutMs: RETRY_CONFIG.totalTimeoutMs,
        getAccount: async () => accountPool.getNextAccount(model),
        executeRequest: async ({ account }) => {
            const antigravityRequest = buildRequest(account);
            return await execute(account, antigravityRequest);
        },
        shouldRetryOnSameAccount: ({ capacity }) => {
            // 容量/配额类错误同号重试意义不大：直接切号更快
            if (capacity) return false;
            return true;
        },
        shouldSwitchAccount: ({ capacity }) => {
            // 单账号场景：不要切号重试，直接返回 429（并透传 reset after）
            if (capacity && availableCount <= 1) return false;
            return true;
        },
        onError: async ({ account, error, capacity }) => {
            if (capacity) {
                const cooldownMs = accountPool.markCapacityLimited(account.id, model, error.message || '');
                if (cooldownMs !== undefined && error && typeof error === 'object' && !Number.isFinite(error.retryAfterMs)) {
                    error.retryAfterMs = cooldownMs;
                }
            }
            accountPool.unlockAccount(account.id);
        },
        onSuccess: async ({ account }) => {
            accountPool.markCapacityRecovered(account.id, model);
            accountPool.markAccountSuccess(account.id);
        }
    });

    return { account: out.account, result: out.result };
}

export async function runStreamChatWithCapacityRetry({
    model,
    maxRetries,
    baseRetryDelayMs,
    accountPool,
    buildRequest,
    streamChat,
    onData,
    abortSignal,
    canRetry
}) {
    let attempt = 0;
    const configuredRetries = Math.max(0, Number(maxRetries || 0));
    const availableCount = typeof accountPool?.getAvailableAccountCount === 'function'
        ? accountPool.getAvailableAccountCount(model)
        : 0;
    const effectiveMaxRetries = Math.max(configuredRetries, Math.max(0, availableCount - 1));

    while (true) {
        attempt++;
        const account = await accountPool.getNextAccount(model);
        const antigravityRequest = buildRequest(account);

        try {
            await streamChat(account, antigravityRequest, onData, null, abortSignal);
            accountPool.markCapacityRecovered(account.id, model);
            return { account, aborted: false };
        } catch (error) {
            if (abortSignal?.aborted) {
                return { account, aborted: true };
            }

            const capacity = isCapacityError(error);
            if (capacity) {
                const cooldownMs = accountPool.markCapacityLimited(account.id, model, error.message || '');
                if (cooldownMs !== undefined && error && typeof error === 'object' && !Number.isFinite(error.retryAfterMs)) {
                    error.retryAfterMs = cooldownMs;
                }
                accountPool.unlockAccount(account.id);

                const allowByOutput = typeof canRetry === 'function' ? !!canRetry({ attempt, error }) : true;
                if (allowByOutput && attempt <= Math.max(0, Number(effectiveMaxRetries || 0)) + 1) {
                    const resetMs = parseResetAfterMs(error?.message);
                    const delay = resetMs ?? (Math.max(0, Number(baseRetryDelayMs || 0)) * attempt);
                    await sleep(delay);
                    continue;
                }

                throw error;
            }

            attachAccountToError(error, account);
            throw error;
        }
    }
}

/**
 * 带完整重试策略的流式请求：同号重试 + 换号重试
 */
export async function runStreamChatWithFullRetry({
    model,
    accountPool,
    buildRequest,
    streamChat,
    onData,
    abortSignal,
    canRetry
}) {
    const availableCount = typeof accountPool?.getAvailableAccountCount === 'function'
        ? accountPool.getAvailableAccountCount(model)
        : 0;
    const maxAccountSwitches = Math.max(RETRY_CONFIG.maxRetries, Math.max(0, availableCount - 1));

    let lastAccount = null;
    let aborted = false;

    try {
        const out = await withFullRetry({
            sameAccountRetries: RETRY_CONFIG.sameAccountRetries,
            sameAccountRetryDelayMs: RETRY_CONFIG.sameAccountRetryDelayMs,
            maxAccountSwitches,
            accountSwitchDelayMs: RETRY_CONFIG.baseRetryDelayMs,
            totalTimeoutMs: RETRY_CONFIG.totalTimeoutMs,
            getAccount: async () => accountPool.getNextAccount(model),
            executeRequest: async ({ account }) => {
                lastAccount = account;
                const antigravityRequest = buildRequest(account);
                await streamChat(account, antigravityRequest, onData, null, abortSignal);
                return true;
            },
            onError: async ({ account, error, capacity, nonRetryable }) => {
                if (abortSignal?.aborted) {
                    aborted = true;
                    return;
                }
                if (capacity) {
                    const cooldownMs = accountPool.markCapacityLimited(account.id, model, error.message || '');
                    if (cooldownMs !== undefined && error && typeof error === 'object' && !Number.isFinite(error.retryAfterMs)) {
                        error.retryAfterMs = cooldownMs;
                    }
                }
                accountPool.unlockAccount(account.id);
            },
            onSuccess: async ({ account }) => {
                accountPool.markCapacityRecovered(account.id, model);
                accountPool.markAccountSuccess(account.id);
            },
            shouldRetryOnSameAccount: ({ error, capacity }) => {
                // 如果中止了，不重试
                if (abortSignal?.aborted) return false;
                // 不可重试错误不再同号重试（会在 withFullRetry 中直接抛出）
                if (isNonRetryableError(error)) return false;
                // 容量/配额类错误直接切号，冷却由 accountPool 负责
                if (capacity) return false;
                return true;
            },
            shouldSwitchAccount: ({ error, capacity }) => {
                if (abortSignal?.aborted) return false;
                // 不可重试错误不换号（会在 withFullRetry 中直接抛出）
                if (isNonRetryableError(error)) return false;
                // 单账号场景：不要切号重试，直接返回 429（并透传 reset after）
                if (capacity && availableCount <= 1) return false;
                if (typeof canRetry === 'function' && !canRetry({ error })) return false;
                return true;
            }
        });

        return { account: out.account, aborted: false };
    } catch (error) {
        if (abortSignal?.aborted || aborted) {
            return { account: lastAccount, aborted: true };
        }
        attachAccountToError(error, lastAccount);
        throw error;
    }
}
