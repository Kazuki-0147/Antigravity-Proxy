import { isCapacityError, parseResetAfterMs, sleep } from './route-helpers.js';
import { withCapacityRetry } from './retry-handler.js';

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
        ? accountPool.getAvailableAccountCount()
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
            accountPool.markCapacityLimited(account.id, model, error.message || '');
            accountPool.unlockAccount(account.id);
        }
    });

    if (out.account) accountPool.markCapacityRecovered(out.account.id, model);
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
        ? accountPool.getAvailableAccountCount()
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
                accountPool.markCapacityLimited(account.id, model, error.message || '');
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
