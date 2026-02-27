import { isCapacityError, isNonRetryableError, isAuthenticationError, isRefreshTokenInvalidError, isServerCapacityExhaustedError, parseResetAfterMs, sleep, buildErrorMessage } from './route-helpers.js';
import { withCapacityRetry, withFullRetry } from './retry-handler.js';
import { RETRY_CONFIG } from '../config.js';
import { forceRefreshToken } from '../services/tokenManager.js';
import { createRequestAttemptLog, updateAccountStatus } from '../db/index.js';

function createRequestScopedAccountGetter({ accountPool, model }) {
    const excludedAccountIds = new Set();

    return async () => {
        const account = await accountPool.getNextAccount(model, {
            excludeAccountIds: Array.from(excludedAccountIds)
        });
        if (account?.id) excludedAccountIds.add(account.id);
        return account;
    };
}

export function createAbortController(request) {
    const abortController = new AbortController();
    request.raw.on('close', () => abortController.abort());
    return abortController;
}

function attachAccountToError(error, account) {
    if (!error || typeof error !== 'object') return;
    if (!account) return;
    if (!Object.prototype.hasOwnProperty.call(error, 'account')) {
        Object.defineProperty(error, 'account', { value: account, enumerable: false });
    }
}

function safeCreateAttemptLog(data) {
    try {
        createRequestAttemptLog(data);
    } catch {
        // ignore logging failures
    }
}

async function handleAuthErrorWithRefresh(account, error, execute, antigravityRequest) {
    if (!isAuthenticationError(error)) {
        return null;
    }

    if (isRefreshTokenInvalidError(error)) {
        updateAccountStatus(account.id, 'error', `Auth permanently invalid: ${error.message}`);
        return null;
    }

    const refreshResult = await forceRefreshToken(account);
    if (!refreshResult) {
        updateAccountStatus(account.id, 'error', `Token refresh failed after auth error: ${error.message}`);
        return null;
    }

    try {
        const result = await execute(account, antigravityRequest);
        return { success: true, result };
    } catch (retryError) {
        updateAccountStatus(account.id, 'error', `Auth error persists after refresh: ${retryError.message}`);
        return { success: false, error: retryError };
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
    const availableCount = typeof accountPool?.getAvailableAccountCount === 'function'
        ? accountPool.getAvailableAccountCount(model)
        : 0;
    // withCapacityRetry 的总尝试次数 = maxRetries + 2，因此这里把 maxRetries 控制在“最多尝试 maxUniqueAccounts 次”。
    const maxUniqueAccounts = Math.max(0, availableCount);
    const maxRetriesByPool = Math.max(0, maxUniqueAccounts - 2);
    const maxRetriesByConfig = Math.max(0, Number(maxRetries ?? RETRY_CONFIG.maxRetries ?? 0));
    const effectiveMaxRetries = Math.min(maxRetriesByPool, maxRetriesByConfig);

    const getAccount = createRequestScopedAccountGetter({ accountPool, model });

    const out = await withCapacityRetry({
        maxRetries: effectiveMaxRetries,
        baseRetryDelayMs,
        getAccount,
        executeRequest: async ({ account, attempt }) => {
            const antigravityRequest = buildRequest(account);
            const startedAt = Date.now();
            try {
                const result = await execute(account, antigravityRequest);
                const endedAt = Date.now();
                safeCreateAttemptLog({
                    requestId: antigravityRequest?.requestId || null,
                    accountId: account?.id,
                    apiKeyId: null,
                    model,
                    attemptNo: attempt || 0,
                    accountAttempt: null,
                    sameRetry: null,
                    status: 'success',
                    latencyMs: Math.max(0, endedAt - startedAt),
                    errorMessage: null,
                    startedAt,
                    createdAt: endedAt
                });
                return result;
            } catch (error) {
                const endedAt = Date.now();
                safeCreateAttemptLog({
                    requestId: antigravityRequest?.requestId || null,
                    accountId: account?.id,
                    apiKeyId: null,
                    model,
                    attemptNo: attempt || 0,
                    accountAttempt: null,
                    sameRetry: null,
                    status: 'error',
                    latencyMs: Math.max(0, endedAt - startedAt),
                    errorMessage: buildErrorMessage(error),
                    startedAt,
                    createdAt: endedAt
                });
                attachAccountToError(error, account);
                throw error;
            }
        },
        onCapacityError: async ({ account, error }) => {
            const serverCapacityExhausted = isServerCapacityExhaustedError(error);
            if (!serverCapacityExhausted) {
                const cooldownMs = accountPool.markCapacityLimited(account.id, model, error.message || '');
                if (cooldownMs !== undefined && error && typeof error === 'object' && !Number.isFinite(error.retryAfterMs)) {
                    error.retryAfterMs = cooldownMs;
                }
            }
            accountPool.unlockAccount(account.id);
        },
        reuseSameAccountOnRetry: ({ error, capacity }) => {
            if (!capacity) return false;
            return isServerCapacityExhaustedError(error);
        }
    });

    if (out.account) accountPool.markCapacityRecovered(out.account.id, model);
    return { account: out.account, result: out.result };
}

/**
 * 带完整重试策略的非流式请求：同号重试 + 换号重试 + 认证错误刷新重试
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
    // Allow switching through the full eligible pool when needed.
    const maxAccountSwitches = Math.max(0, availableCount - 1);

    const getAccount = createRequestScopedAccountGetter({ accountPool, model });
    let attemptNo = 0;

    const executeAndLog = async ({ account, antigravityRequest, accountAttempt, sameRetry, executeFn }) => {
        attemptNo += 1;
        const startedAt = Date.now();
        try {
            const result = await executeFn(account, antigravityRequest);
            const endedAt = Date.now();
            safeCreateAttemptLog({
                requestId: antigravityRequest?.requestId || null,
                accountId: account?.id,
                apiKeyId: null,
                model,
                attemptNo,
                accountAttempt: accountAttempt ?? null,
                sameRetry: sameRetry ?? null,
                status: 'success',
                latencyMs: Math.max(0, endedAt - startedAt),
                errorMessage: null,
                startedAt,
                createdAt: endedAt
            });
            return result;
        } catch (error) {
            const endedAt = Date.now();
            safeCreateAttemptLog({
                requestId: antigravityRequest?.requestId || null,
                accountId: account?.id,
                apiKeyId: null,
                model,
                attemptNo,
                accountAttempt: accountAttempt ?? null,
                sameRetry: sameRetry ?? null,
                status: 'error',
                latencyMs: Math.max(0, endedAt - startedAt),
                errorMessage: buildErrorMessage(error),
                startedAt,
                createdAt: endedAt
            });
            throw error;
        }
    };

    const out = await withFullRetry({
        sameAccountRetries: RETRY_CONFIG.sameAccountRetries,
        sameAccountRetryDelayMs: RETRY_CONFIG.sameAccountRetryDelayMs,
        maxAccountSwitches,
        accountSwitchDelayMs: RETRY_CONFIG.baseRetryDelayMs,
        totalTimeoutMs: RETRY_CONFIG.totalTimeoutMs,
        getAccount,
        executeRequest: async ({ account, sameRetry, accountAttempt }) => {
            const antigravityRequest = buildRequest(account);
            try {
                return await executeAndLog({
                    account,
                    antigravityRequest,
                    accountAttempt,
                    sameRetry,
                    executeFn: execute
                });
            } catch (error) {
                if (isAuthenticationError(error)) {
                    const authRetryResult = await handleAuthErrorWithRefresh(
                        account,
                        error,
                        async (acc, req) => executeAndLog({
                            account: acc,
                            antigravityRequest: req,
                            accountAttempt,
                            sameRetry,
                            executeFn: execute
                        }),
                        antigravityRequest
                    );
                    if (authRetryResult?.success) {
                        return authRetryResult.result;
                    }
                    error.authHandled = true;
                }
                attachAccountToError(error, account);
                throw error;
            }
        },
        shouldRetryOnSameAccount: ({ error, capacity }) => {
            if (error?.authHandled) return false;
            if (capacity) return isServerCapacityExhaustedError(error);
            return true;
        },
        shouldSwitchAccount: ({ error, capacity }) => {
            if (error?.authHandled) return false;
            if (capacity && isServerCapacityExhaustedError(error)) return false;
            if (capacity && availableCount <= 1) return false;
            return true;
        },
        onError: async ({ account, error, capacity }) => {
            if (capacity) {
                const serverCapacityExhausted = isServerCapacityExhaustedError(error);
                if (!serverCapacityExhausted) {
                    const cooldownMs = accountPool.markCapacityLimited(account.id, model, error.message || '');
                    if (cooldownMs !== undefined && error && typeof error === 'object' && !Number.isFinite(error.retryAfterMs)) {
                        error.retryAfterMs = cooldownMs;
                    }
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
    const availableCount = typeof accountPool?.getAvailableAccountCount === 'function'
        ? accountPool.getAvailableAccountCount(model)
        : 0;
    // total attempts is capped by (effectiveMaxRetries + 1); keep it within one pool traversal.
    const maxUniqueAccounts = Math.max(0, availableCount);
    // Total attempts in the loop is effectively (effectiveMaxRetries + 2), so keep it within one traversal.
    const maxRetriesByPool = Math.max(0, maxUniqueAccounts - 2);
    const maxRetriesByConfig = Math.max(0, Number(maxRetries ?? RETRY_CONFIG.maxRetries ?? 0));
    const effectiveMaxRetries = Math.min(maxRetriesByPool, maxRetriesByConfig);

    const getAccount = createRequestScopedAccountGetter({ accountPool, model });

    let currentAccount = null;

    while (true) {
        attempt++;
        const account = currentAccount || await getAccount();
        const antigravityRequest = buildRequest(account);
        const startedAt = Date.now();

        try {
            await streamChat(account, antigravityRequest, onData, null, abortSignal);
            accountPool.markCapacityRecovered(account.id, model);
            const endedAt = Date.now();
            safeCreateAttemptLog({
                requestId: antigravityRequest?.requestId || null,
                accountId: account?.id,
                apiKeyId: null,
                model,
                attemptNo: attempt,
                accountAttempt: null,
                sameRetry: null,
                status: 'success',
                latencyMs: Math.max(0, endedAt - startedAt),
                errorMessage: null,
                startedAt,
                createdAt: endedAt
            });
            return { account, aborted: false };
        } catch (error) {
            const endedAt = Date.now();
            safeCreateAttemptLog({
                requestId: antigravityRequest?.requestId || null,
                accountId: account?.id,
                apiKeyId: null,
                model,
                attemptNo: attempt,
                accountAttempt: null,
                sameRetry: null,
                status: abortSignal?.aborted ? 'aborted' : 'error',
                latencyMs: Math.max(0, endedAt - startedAt),
                errorMessage: buildErrorMessage(error),
                startedAt,
                createdAt: endedAt
            });
            if (abortSignal?.aborted) {
                return { account, aborted: true };
            }

            const capacity = isCapacityError(error);
            if (capacity) {
                const serverCapacityExhausted = isServerCapacityExhaustedError(error);
                if (!serverCapacityExhausted) {
                    const cooldownMs = accountPool.markCapacityLimited(account.id, model, error.message || '');
                    if (cooldownMs !== undefined && error && typeof error === 'object' && !Number.isFinite(error.retryAfterMs)) {
                        error.retryAfterMs = cooldownMs;
                    }
                }
                accountPool.unlockAccount(account.id);

                const allowByOutput = typeof canRetry === 'function' ? !!canRetry({ attempt, error }) : true;
                if (allowByOutput && attempt <= Math.max(0, Number(effectiveMaxRetries || 0)) + 1) {
                    const resetMs = parseResetAfterMs(error?.message);
                    const delay = resetMs ?? (Math.max(0, Number(baseRetryDelayMs || 0)) * attempt);
                    currentAccount = serverCapacityExhausted ? account : null;
                    await sleep(delay);
                    continue;
                }

                attachAccountToError(error, account);
                throw error;
            }

            attachAccountToError(error, account);
            throw error;
        }
    }
}

/**
 * 带完整重试策略的流式请求：同号重试 + 换号重试 + 认证错误刷新重试
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
    const maxAccountSwitches = Math.max(0, availableCount - 1);

    const getAccount = createRequestScopedAccountGetter({ accountPool, model });
    let attemptNo = 0;

    const streamAndLog = async ({ account, antigravityRequest, accountAttempt, sameRetry, streamFn }) => {
        attemptNo += 1;
        const startedAt = Date.now();
        try {
            const result = await streamFn(account, antigravityRequest);
            const endedAt = Date.now();
            safeCreateAttemptLog({
                requestId: antigravityRequest?.requestId || null,
                accountId: account?.id,
                apiKeyId: null,
                model,
                attemptNo,
                accountAttempt: accountAttempt ?? null,
                sameRetry: sameRetry ?? null,
                status: 'success',
                latencyMs: Math.max(0, endedAt - startedAt),
                errorMessage: null,
                startedAt,
                createdAt: endedAt
            });
            return result;
        } catch (error) {
            const endedAt = Date.now();
            safeCreateAttemptLog({
                requestId: antigravityRequest?.requestId || null,
                accountId: account?.id,
                apiKeyId: null,
                model,
                attemptNo,
                accountAttempt: accountAttempt ?? null,
                sameRetry: sameRetry ?? null,
                status: abortSignal?.aborted ? 'aborted' : 'error',
                latencyMs: Math.max(0, endedAt - startedAt),
                errorMessage: buildErrorMessage(error),
                startedAt,
                createdAt: endedAt
            });
            throw error;
        }
    };

    let lastAccount = null;
    let aborted = false;

    try {
        const out = await withFullRetry({
            sameAccountRetries: RETRY_CONFIG.sameAccountRetries,
            sameAccountRetryDelayMs: RETRY_CONFIG.sameAccountRetryDelayMs,
            maxAccountSwitches,
            accountSwitchDelayMs: RETRY_CONFIG.baseRetryDelayMs,
            totalTimeoutMs: RETRY_CONFIG.totalTimeoutMs,
            getAccount,
            executeRequest: async ({ account, sameRetry, accountAttempt }) => {
                lastAccount = account;
                const antigravityRequest = buildRequest(account);
                try {
                    await streamAndLog({
                        account,
                        antigravityRequest,
                        accountAttempt,
                        sameRetry,
                        streamFn: async (a, req) => {
                            await streamChat(a, req, onData, null, abortSignal);
                            return true;
                        }
                    });
                    return true;
                } catch (error) {
                    if (isAuthenticationError(error)) {
                        const authRetryResult = await handleAuthErrorWithRefresh(
                            account,
                            error,
                            async (acc, req) => {
                                return streamAndLog({
                                    account: acc,
                                    antigravityRequest: req,
                                    accountAttempt,
                                    sameRetry,
                                    streamFn: async (a, r) => {
                                        await streamChat(a, r, onData, null, abortSignal);
                                        return true;
                                    }
                                });
                            },
                            antigravityRequest
                        );
                        if (authRetryResult?.success) {
                            return authRetryResult.result;
                        }
                        error.authHandled = true;
                    }
                    throw error;
                }
            },
            onError: async ({ account, error, capacity }) => {
                if (abortSignal?.aborted) {
                    aborted = true;
                    return;
                }
                if (capacity) {
                    const serverCapacityExhausted = isServerCapacityExhaustedError(error);
                    if (!serverCapacityExhausted) {
                        const cooldownMs = accountPool.markCapacityLimited(account.id, model, error.message || '');
                        if (cooldownMs !== undefined && error && typeof error === 'object' && !Number.isFinite(error.retryAfterMs)) {
                            error.retryAfterMs = cooldownMs;
                        }
                    }
                }
                accountPool.unlockAccount(account.id);
            },
            onSuccess: async ({ account }) => {
                accountPool.markCapacityRecovered(account.id, model);
                accountPool.markAccountSuccess(account.id);
            },
            shouldRetryOnSameAccount: ({ error, capacity }) => {
                if (abortSignal?.aborted) return false;
                if (error?.authHandled) return false;
                if (isNonRetryableError(error)) return false;
                if (capacity) return isServerCapacityExhaustedError(error);
                return true;
            },
            shouldSwitchAccount: ({ error, capacity }) => {
                if (abortSignal?.aborted) return false;
                if (error?.authHandled) return false;
                if (isNonRetryableError(error)) return false;
                if (capacity && isServerCapacityExhaustedError(error)) return false;
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
