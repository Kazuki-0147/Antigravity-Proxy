export function parseResetAfterMs(message) {
    if (!message) return null;
    const m = String(message).match(/reset after (\d+)s/i);
    if (!m) return null;
    const seconds = Number.parseInt(m[1], 10);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return (seconds + 1) * 1000;
}

export function sleep(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isCapacityError(err) {
    const msg = err?.message || '';
    return (
        msg.includes('exhausted your capacity on this model') ||
        msg.includes('Resource has been exhausted') ||
        msg.includes('No capacity available') ||
        err?.upstreamStatus === 429 ||
        isServerCapacityExhaustedError(err)
    );
}

export function isServerCapacityExhaustedError(err) {
    const message = String(err?.message || '');
    const messageLower = message.toLowerCase();

    const hasServerCapacityMessage =
        messageLower.includes('no capacity available for model') &&
        messageLower.includes('on the server');

    const upstreamJson = err?.upstreamJson;
    const upstreamError = upstreamJson?.error && typeof upstreamJson.error === 'object'
        ? upstreamJson.error
        : upstreamJson;

    const upstreamStatus = Number(err?.upstreamStatus);
    const upstreamCode = Number(upstreamError?.code);
    const upstreamStatusText = String(upstreamError?.status || '').toUpperCase();

    const detailReason = Array.isArray(upstreamError?.details)
        ? upstreamError.details.some((d) => String(d?.reason || '').toUpperCase() === 'MODEL_CAPACITY_EXHAUSTED')
        : false;

    const bodyLower = String(err?.upstreamBody || '').toLowerCase();
    const bodyReason = bodyLower.includes('model_capacity_exhausted');
    const bodyServerCapacityMessage =
        bodyLower.includes('no capacity available for model') &&
        bodyLower.includes('on the server');

    if (detailReason || bodyReason) return true;

    if (hasServerCapacityMessage || bodyServerCapacityMessage) {
        if (
            upstreamStatus === 503 ||
            upstreamCode === 503 ||
            upstreamStatusText === 'UNAVAILABLE' ||
            messageLower.includes('unavailable') ||
            bodyLower.includes('"status":"unavailable"')
        ) {
            return true;
        }
        // Some upstream paths only surface the message without structured status fields.
        return true;
    }

    return false;
}

/**
 * 判断是否为认证失败错误（账号被禁用/吊销/需要验证）
 * 这类错误应该触发 token 刷新重试，若仍失败则禁用账号
 */
export function isAuthenticationError(err) {
    const msg = err?.message || '';
    const msgLower = msg.toLowerCase();
    const status = err?.upstreamStatus;

    // HTTP 401 Unauthorized - 明确的认证失败
    if (status === 401) {
        return true;
    }

    // HTTP 403 Forbidden - 只有认证相关的 403 才算
    if (status === 403) {
        if (
            msgLower.includes('authentication') ||
            msgLower.includes('credential') ||
            msgLower.includes('unauthorized') ||
            msgLower.includes('access denied') ||
            msgLower.includes('permission denied') ||
            msgLower.includes('account') ||
            msgLower.includes('oauth')
        ) {
            return true;
        }
    }

    // 关键词匹配 - 认证相关错误
    if (
        msgLower.includes('invalid authentication') ||
        msgLower.includes('invalid credential') ||
        msgLower.includes('invalid_grant') ||
        msgLower.includes('unauthorized_client') ||
        msgLower.includes('authentication failed') ||
        msgLower.includes('oauth 2 access token') ||
        msgLower.includes('access token') ||
        msgLower.includes('token has been expired or revoked') ||
        msgLower.includes('token revoked') ||
        msgLower.includes('refresh token') ||
        msgLower.includes('account disabled') ||
        msgLower.includes('account suspended') ||
        msgLower.includes('account banned') ||
        msgLower.includes('verification required') ||
        msgLower.includes('login required')
    ) {
        return true;
    }

    return false;
}

/**
 * 判断是否为 refresh_token 失效错误（需要立即禁用，无法自动恢复）
 */
export function isRefreshTokenInvalidError(err) {
    const msg = err?.message || '';
    const msgLower = msg.toLowerCase();

    return (
        msgLower.includes('invalid_grant') ||
        msgLower.includes('unauthorized_client') ||
        msgLower.includes('token has been expired or revoked') ||
        msgLower.includes('token revoked') ||
        msgLower.includes('refresh token') ||
        msgLower.includes('account disabled') ||
        msgLower.includes('account suspended') ||
        msgLower.includes('account banned') ||
        msgLower.includes('verification required')
    );
}

/**
 * 判断是否为不可重试的错误（这类错误换号也不会成功，应直接返回给客户端）
 * - 安全拦截 / 内容审核
 * - 请求太长 / token 超限
 * - 请求格式错误
 * - 模型不存在
 * 注意：认证错误 (401/403) 不在此列，需要单独处理（刷新 token 后重试）
 */
export function isNonRetryableError(err) {
    // 版本过期错误可重试（versionFetcher 已刷新版本，重试会使用新版本）
    if (err?.versionOutdated) return false;

    const msg = err?.message || '';
    const msgLower = msg.toLowerCase();
    const status = err?.upstreamStatus;

    // Google upstream bot-detection HTML ("Sorry..." / automated queries) should not be retried aggressively.
    // Retrying across accounts usually worsens the block (IP-level), so fail fast.
    if (
        msgLower.includes('sending automated queries') ||
        msgLower.includes('automated requests') ||
        msgLower.includes('google \"sorry\"') ||
        msgLower.includes('support.google.com/websearch/answer/86640')
    ) {
        return true;
    }

    // 认证错误需要特殊处理（刷新 token 后重试），不算"不可重试"
    if (isAuthenticationError(err)) {
        return false;
    }

    // 400 系列错误（除 429、401、403 外）通常是请求本身的问题，重试无意义
    if (status && status >= 400 && status < 500 && status !== 429 && status !== 401 && status !== 403) {
        return true;
    }

    // 安全拦截 / 内容审核
    if (
        msgLower.includes('blocked') ||
        msgLower.includes('safety') ||
        msgLower.includes('harmful') ||
        msgLower.includes('policy') ||
        msgLower.includes('content filter') ||
        msgLower.includes('moderation')
    ) {
        return true;
    }

    // Prompt / Token 超限
    if (
        msgLower.includes('too long') ||
        msgLower.includes('too many tokens') ||
        msgLower.includes('token limit') ||
        msgLower.includes('context length') ||
        msgLower.includes('maximum context') ||
        msgLower.includes('exceeds the limit') ||
        msgLower.includes('prompt is too large')
    ) {
        return true;
    }

    // 请求格式错误
    if (
        msgLower.includes('invalid request') ||
        msgLower.includes('invalid argument') ||
        msgLower.includes('malformed') ||
        msgLower.includes('bad request')
    ) {
        return true;
    }

    // 模型不存在
    if (
        msgLower.includes('model not found') ||
        msgLower.includes('not found') ||
        msgLower.includes('does not exist') ||
        msgLower.includes('unknown model')
    ) {
        return true;
    }

    return false;
}

export const SSE_HEADERS = Object.freeze({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
});

export const SSE_HEADERS_ANTHROPIC = Object.freeze({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
});

export function buildErrorMessage(err) {
    let msg = err?.message || String(err);
    if (err?.upstreamStatus) msg += ` [HTTP ${err.upstreamStatus}]`;
    if (err?.upstreamJson) {
        try { msg += ' ' + JSON.stringify(err.upstreamJson); } catch {}
    } else if (err?.upstreamBody && err.upstreamBody !== msg.split(' [HTTP')[0]) {
        msg += ' ' + String(err.upstreamBody).slice(0, 2000);
    }
    return msg;
}
