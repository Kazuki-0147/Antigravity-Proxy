import { isCapacityError, isNonRetryableError, parseResetAfterMs, sleep } from './route-helpers.js';

/**
 * 完整重试策略：同号重试 + 换号重试
 *
 * 策略：
 * 1. 不可重试错误（安全拦截、请求太长等）：直接返回，不重试
 * 2. 非容量错误：先在当前账号重试 sameAccountRetries 次
 * 3. 容量错误：等待冷却时间后重试（同号或换号）
 * 4. 如果同号重试用尽，换下一个账号继续
 * 5. 总超时：超过 totalTimeoutMs 后停止重试
 */
export async function withFullRetry({
    sameAccountRetries = 2,       // 同号重试次数
    sameAccountRetryDelayMs = 500,
    maxAccountSwitches = 2,       // 最大换号次数
    accountSwitchDelayMs = 1000,
    totalTimeoutMs = 0,           // 总超时时间（0 表示不限制）
    getAccount,
    executeRequest,
    onError,                      // 每次错误时调用
    onSuccess,                    // 成功时调用
    shouldRetryOnSameAccount,     // 可选：判断是否应该同号重试
    shouldSwitchAccount           // 可选：判断是否应该换号
}) {
    let accountAttempt = 0;
    const maxSwitches = Math.max(0, Number(maxAccountSwitches || 0));
    const sameRetryMax = Math.max(0, Number(sameAccountRetries || 0));
    const sameDelay = Math.max(0, Number(sameAccountRetryDelayMs || 0));
    const switchDelay = Math.max(0, Number(accountSwitchDelayMs || 0));
    const timeout = Math.max(0, Number(totalTimeoutMs || 0));
    const startTime = Date.now();

    // 检查是否超时
    const isTimedOut = () => timeout > 0 && (Date.now() - startTime) >= timeout;

    while (accountAttempt <= maxSwitches) {
        // 超时检查
        if (isTimedOut()) {
            throw new Error(`Retry timeout exceeded (${timeout}ms)`);
        }

        accountAttempt++;
        let account;
        try {
            account = getAccount ? await getAccount({ attempt: accountAttempt }) : null;
        } catch (err) {
            // 无法获取账号，直接抛出
            throw err;
        }

        // 同号重试循环
        for (let sameRetry = 0; sameRetry <= sameRetryMax; sameRetry++) {
            // 超时检查
            if (isTimedOut()) {
                throw new Error(`Retry timeout exceeded (${timeout}ms)`);
            }

            try {
                const result = await executeRequest({ account, sameRetry, accountAttempt });
                // 成功
                if (onSuccess && account) {
                    await onSuccess({ account, sameRetry, accountAttempt });
                }
                return { result, account, sameRetry, accountAttempt };
            } catch (error) {
                const capacity = isCapacityError(error);
                const nonRetryable = isNonRetryableError(error);

                // 通知错误
                if (onError) {
                    await onError({ account, error, sameRetry, accountAttempt, capacity, nonRetryable });
                }

                // 不可重试错误：直接抛出，不再尝试
                if (nonRetryable) {
                    throw error;
                }

                // 超时检查
                if (isTimedOut()) {
                    throw error;
                }

                // 判断是否继续同号重试
                const canRetrySame = sameRetry < sameRetryMax;
                let shouldRetrySame;
                if (shouldRetryOnSameAccount) {
                    shouldRetrySame = shouldRetryOnSameAccount({ error, sameRetry, capacity });
                } else {
                    // 默认：所有错误都可以同号重试（包括429）
                    shouldRetrySame = true;
                }

                if (canRetrySame && shouldRetrySame) {
                    // 容量错误使用上游返回的冷却时间，其他错误用固定延迟
                    let delay = capacity
                        ? (parseResetAfterMs(error?.message) ?? sameDelay * (sameRetry + 1))
                        : sameDelay * (sameRetry + 1);
                    // 限制延迟不超过剩余超时时间
                    if (timeout > 0) {
                        const remaining = timeout - (Date.now() - startTime);
                        delay = Math.min(delay, Math.max(0, remaining));
                    }
                    await sleep(delay);
                    continue;
                }

                // 判断是否换号重试
                const canSwitch = accountAttempt < maxSwitches + 1;
                const shouldSwitch = shouldSwitchAccount
                    ? shouldSwitchAccount({ error, accountAttempt, capacity })
                    : true;

                if (canSwitch && shouldSwitch) {
                    // 切号时不需要等待当前账号的 reset 时间：直接换号更快（冷却由 accountPool 负责）
                    let delay = switchDelay;
                    // 限制延迟不超过剩余超时时间
                    if (timeout > 0) {
                        const remaining = timeout - (Date.now() - startTime);
                        delay = Math.min(delay, Math.max(0, remaining));
                    }
                    await sleep(delay);
                    break; // 跳出同号重试循环，进入下一个账号
                }

                // 不能再重试了，抛出错误
                throw error;
            }
        }
    }

    throw new Error('All retry attempts exhausted');
}

export async function withCapacityRetry({
    maxRetries = 0,
    baseRetryDelayMs = 0,
    getAccount,
    executeRequest,
    onCapacityError,
    canRetry,
    reuseSameAccountOnRetry
}) {
    const max = Math.max(0, Number(maxRetries || 0));
    const baseDelay = Math.max(0, Number(baseRetryDelayMs || 0));

    let attempt = 0;
    let currentAccount = null;

    while (true) {
        attempt += 1;
        const account = currentAccount || (getAccount ? await getAccount({ attempt }) : null);

        try {
            const result = await executeRequest({ attempt, account });
            return { result, account, attempt };
        } catch (error) {
            const capacity = isCapacityError(error);

            if (capacity && account && onCapacityError) {
                await onCapacityError({ attempt, account, error });
            }

            // Keep existing route semantics: retry while attempt <= (maxRetries + 1)
            // (attempt starts at 1, so max total attempts becomes maxRetries + 2)
            const allowedByCount = attempt <= max + 1;
            const allowedByHook = typeof canRetry === 'function'
                ? !!canRetry({ attempt, maxRetries: max, account, error, capacity })
                : true;
            const shouldRetry = capacity && allowedByCount && allowedByHook;

            if (!shouldRetry) throw error;

            const shouldReuseSameAccount = capacity && typeof reuseSameAccountOnRetry === 'function'
                ? !!reuseSameAccountOnRetry({ attempt, maxRetries: max, account, error, capacity })
                : false;
            currentAccount = shouldReuseSameAccount ? account : null;

            const resetMs = parseResetAfterMs(error?.message);
            const delay = resetMs ?? (baseDelay * attempt);
            await sleep(delay);
        }
    }
}
