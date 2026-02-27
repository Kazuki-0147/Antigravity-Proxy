import { verifyApiKey } from '../middleware/auth.js';
import { accountPool } from '../services/accountPool.js';
import { acquireModelSlot, releaseModelSlot } from '../services/rateLimiter.js';
import { streamChat, chat } from '../services/antigravity.js';
import {
    convertAnthropicToAntigravity,
    convertAntigravityToAnthropic,
    convertAntigravityToAnthropicSSE,
    preprocessAnthropicRequest
} from '../services/converter.js';
import { createRequestLog } from '../db/index.js';
import { isThinkingModel, AVAILABLE_MODELS } from '../config.js';
import { logModelCall } from '../services/modelLogger.js';
import { isCapacityError, isAuthenticationError, isServerCapacityExhaustedError, parseResetAfterMs, SSE_HEADERS_ANTHROPIC, buildErrorMessage } from '../utils/route-helpers.js';
import { createAbortController, runChatWithFullRetry, runStreamChatWithFullRetry } from '../utils/request-handler.js';
import { sendTrajectoryAnalytics } from '../services/trajectory.js';
import { sendRequestMetrics } from '../services/telemetry.js';
import { touchAccountActivity } from '../services/warmup.js';

export default async function anthropicRoutes(fastify) {
    // POST /v1/messages - Anthropic 格式的聊天端点
    fastify.post('/v1/messages', {
        preHandler: verifyApiKey
    }, async (request, reply) => {
        const startTime = Date.now();
        let anthropicRequest = request.body;
        const { stream = false, model } = anthropicRequest;

        // 兼容：部分客户端不会传 metadata.user_id，但 Claude extended thinking 的 signature 回放/兜底逻辑需要一个稳定的 userKey。
        // 统一 API_KEY 模式下用固定值作为 fallback（不要把真实 key 写进缓存/日志）。
        try {
            if (anthropicRequest && typeof anthropicRequest === 'object') {
                const meta = (anthropicRequest.metadata && typeof anthropicRequest.metadata === 'object')
                    ? anthropicRequest.metadata
                    : {};
                if (!meta.user_id) {
                    anthropicRequest.metadata = { ...meta, user_id: 'api_key:static' };
                }
            }
        } catch {
            // ignore
        }

        let account = null;
        let usage = null;
        let status = 'success';
        let errorMessage = null;
        let modelSlotAcquired = false;
        let invokedUpstream = false;
        let responseForLog = null;
        let streamEventsForLog = null;
        let errorResponseForLog = null;
        let fullRequestId = null;

        try {
            // 1. 预处理请求 - 尝试补齐/回放 thinking.signature（仅在无法恢复时才会降级禁用 thinking）
            anthropicRequest = preprocessAnthropicRequest(anthropicRequest);

            // 2. 获取模型并发槽位（避免本地直接打爆上游）
            modelSlotAcquired = acquireModelSlot(model);
            if (!modelSlotAcquired) {
                status = 'error';
                errorMessage = 'Model concurrency limit reached';
                errorResponseForLog = {
                    type: 'error',
                    error: {
                        type: 'rate_limit_error',
                        message: 'Model concurrency limit reached, please retry later',
                        code: 'model_concurrency_limit'
                    }
                };
                return reply.code(429).send(errorResponseForLog);
            }

            // 3/4. 先转换请求格式（requestId 固定），project 在选择账号后再注入，便于容量错误时重试切号
            const antigravityRequestBase = convertAnthropicToAntigravity(anthropicRequest, '');
            fullRequestId = antigravityRequestBase.requestId;
            const requestId = fullRequestId.split('/')[2] || fullRequestId;

            // 5. 流式或非流式处理
            if (stream) {
                streamEventsForLog = [];
                // 设置 SSE 响应头 (Anthropic 格式)
                    reply.raw.writeHead(200, SSE_HEADERS_ANTHROPIC);

                const abortController = createAbortController(request);

                const thinkingEnabledForStream = anthropicRequest.thinking?.type === 'enabled' ||
                    anthropicRequest.thinking?.type === 'adaptive' ||
                    (anthropicRequest.thinking?.type !== 'disabled' && isThinkingModel(model));
                let sseState = {
                    thinkingEnabled: !!thinkingEnabledForStream,
                    userKey: anthropicRequest?.metadata?.user_id || null
                };
                let lastUsage = null;
                let sawAnyUpstreamEvents = false;
                let sawAnyContentBlock = false;

                try {
                    const out = await runStreamChatWithFullRetry({
                        model,
                        accountPool,
                        buildRequest: (a) => {
                            const req = structuredClone(antigravityRequestBase);
                            req.project = a.project_id || '';
                            if (a.session_id) req.request.sessionId = a.session_id;
                            return req;
                        },
                        streamChat: async (a, req, onData, onError, signal) => {
                            invokedUpstream = true;
                            return streamChat(a, req, onData, onError, signal);
                        },
                        onData: (data) => {
                            if (process.env.DEBUG_THINKING_FLOW) {
                                try {
                                    const parsed = JSON.parse(data);
                                    const parts = parsed?.response?.candidates?.[0]?.content?.parts || [];
                                    console.log(JSON.stringify({
                                        kind: 'thinking_flow_debug',
                                        requestId,
                                        thoughtPartsCount: parts.filter(p => p.thought).length,
                                        functionCallCount: parts.filter(p => p.functionCall).length,
                                        textPartsCount: parts.filter(p => p.text !== undefined && !p.thought).length,
                                        hasSignature: parts.some(p => p.thoughtSignature || p.thought_signature || p.signature),
                                        finishReason: parsed?.response?.candidates?.[0]?.finishReason
                                    }));
                                } catch { /* ignore parse errors */ }
                            }

                            const { events, state } = convertAntigravityToAnthropicSSE(
                                data, requestId, model, sseState
                            );
                            sseState = state;

                            for (const event of events) {
                                const eventType = event.type;
                                sawAnyUpstreamEvents = true;
                                if (eventType === 'content_block_start' || eventType === 'content_block_delta') {
                                    sawAnyContentBlock = true;
                                }
                                streamEventsForLog.push({ event: eventType, data: event });
                                reply.raw.write(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);

                                if (event.usage) {
                                    lastUsage = event.usage;
                                }
                            }
                        },
                        abortSignal: abortController.signal,
                        canRetry: () => !sawAnyUpstreamEvents
                    });

                    account = out.account;
                    if (out.aborted) return;
                } catch (err) {
                    if (err?.account) account = err.account;
                    status = 'error';
                    errorMessage = buildErrorMessage(err);
                    const errorEvent = {
                        type: 'error',
                        error: {
                            type: 'api_error',
                            message: err.message,
                            ...(err.upstreamStatus ? { upstream_status: err.upstreamStatus } : {}),
                            ...(err.upstreamJson ? { upstream_details: err.upstreamJson } : {})
                        }
                    };
                    streamEventsForLog.push({ event: 'error', data: errorEvent });
                    reply.raw.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
                }

                // 上游偶发会“提前结束流”而不下发最终 finish/message_stop（客户端表现为：只输出一段 thinking 就断开）。
                // 兜底策略：合成一个最终 finish chunk，尽量触发本地 converter 的 finalize 流程（flush deferred parts + message_stop）。
                if (status === 'success' && !abortController.signal.aborted && sawAnyUpstreamEvents && !sseState?.completed) {
                    try {
                        const syntheticFinalizePayload = JSON.stringify({
                            response: {
                                candidates: [{
                                    finishReason: 'OTHER',
                                    content: { parts: [] }
                                }],
                                usageMetadata: {
                                    promptTokenCount: sseState?.lastUsage?.input_tokens || lastUsage?.input_tokens || 0,
                                    candidatesTokenCount: sseState?.lastUsage?.output_tokens || lastUsage?.output_tokens || 0
                                }
                            }
                        });

                        const finalizeResult = convertAntigravityToAnthropicSSE(
                            syntheticFinalizePayload, requestId, model, sseState
                        );
                        if (finalizeResult && typeof finalizeResult === 'object') {
                            const { events: finalizeEvents = [], state: finalizeState } = finalizeResult;
                            sseState = finalizeState || sseState;

                            for (const event of finalizeEvents) {
                                const eventType = event.type;
                                if (eventType === 'content_block_start' || eventType === 'content_block_delta') {
                                    sawAnyContentBlock = true;
                                }
                                streamEventsForLog.push({ event: eventType, data: event });
                                reply.raw.write(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);

                                if (event.usage) {
                                    lastUsage = event.usage;
                                }
                            }
                        }
                    } catch {
                        // ignore synth-finalize failure, fallback to error below
                    }
                }

                // 二级兜底：若 converter finalize 仍未完成，直接补最小 message_delta/message_stop，避免客户端 hard-fail。
                if (status === 'success' && !abortController.signal.aborted && sawAnyUpstreamEvents && !sseState?.completed) {
                    try {
                        const fallbackUsage = {
                            input_tokens: sseState?.lastUsage?.input_tokens || lastUsage?.input_tokens || 0,
                            output_tokens: sseState?.lastUsage?.output_tokens || lastUsage?.output_tokens || 0
                        };
                        const fallbackStopReason = sseState?.hasToolUse ? 'tool_use' : 'end_turn';
                        const fallbackEvents = [
                            {
                                type: 'message_delta',
                                delta: {
                                    stop_reason: fallbackStopReason,
                                    stop_sequence: null
                                },
                                usage: fallbackUsage
                            },
                            { type: 'message_stop' }
                        ];

                        for (const event of fallbackEvents) {
                            streamEventsForLog.push({ event: event.type, data: event });
                            reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                        }

                        sseState = { ...sseState, completed: true, lastUsage: fallbackUsage };
                        lastUsage = fallbackUsage;
                    } catch {
                        // ignore hard-finalize failure, fallback to error below
                    }
                }

                // 仍未完成：保持原错误语义
                if (status === 'success' && !abortController.signal.aborted && sawAnyUpstreamEvents && !sseState?.completed) {
                    status = 'error';
                    errorMessage = 'Upstream stream ended unexpectedly (missing message_stop)';
                    const errorEvent = {
                        type: 'error',
                        error: {
                            type: 'api_error',
                            message: errorMessage,
                            code: 'incomplete_upstream_stream'
                        }
                    };
                    errorResponseForLog = errorEvent;
                    streamEventsForLog.push({ event: 'error', data: errorEvent });
                    try {
                        reply.raw.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
                    } catch {
                        // ignore
                    }
                }

                // 上游有时会返回“HTTP 200 + SSE 结束”但中间没有任何 events（例如安全拦截/空回复）
                if (status === 'success' && (!sawAnyUpstreamEvents || !sawAnyContentBlock)) {
                    status = 'error';
                    errorMessage = 'Upstream returned empty response (no candidates)';
                    const errorEvent = {
                        type: 'error',
                        error: {
                            type: 'api_error',
                            message: errorMessage
                        }
                    };
                    streamEventsForLog.push({ event: 'error', data: errorEvent });
                    reply.raw.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
                }

                reply.raw.end();

                if (lastUsage) {
                    usage = {
                        promptTokens: lastUsage.input_tokens || 0,
                        completionTokens: lastUsage.output_tokens || 0,
                        totalTokens: (lastUsage.input_tokens || 0) + (lastUsage.output_tokens || 0)
                    };
                }

                responseForLog = { stream: true, events: streamEventsForLog };
            } else {
                // 非流式请求
                const out = await runChatWithFullRetry({
                    model,
                    accountPool,
                    buildRequest: (a) => {
                        const req = structuredClone(antigravityRequestBase);
                        req.project = a.project_id || '';
                        if (a.session_id) req.request.sessionId = a.session_id;
                        return req;
                    },
                    execute: async (a, req) => {
                        invokedUpstream = true;
                        return chat(a, req);
                    }
                });
                account = out.account;
                const antigravityResponse = out.result;
                // 检测 thinking 模式 - 显式启用或根据模型名自动启用
                const thinkingEnabled = anthropicRequest.thinking?.type === 'enabled' ||
                    (anthropicRequest.thinking?.type !== 'disabled' && isThinkingModel(model));
                const anthropicResponse = convertAntigravityToAnthropic(
                    antigravityResponse,
                    requestId,
                    model,
                    thinkingEnabled,
                    anthropicRequest?.metadata?.user_id || null
                );

                usage = {
                    promptTokens: anthropicResponse.usage.input_tokens,
                    completionTokens: anthropicResponse.usage.output_tokens,
                    totalTokens: anthropicResponse.usage.input_tokens + anthropicResponse.usage.output_tokens,
                    thinkingTokens: antigravityResponse?.response?.usageMetadata?.thoughtsTokenCount || 0
                };

                responseForLog = anthropicResponse;
                return responseForLog;
            }
        } catch (error) {
            if (error?.account) account = error.account;
            status = 'error';
            errorMessage = buildErrorMessage(error);

            const capacity = isCapacityError(error);
            const serverCapacityExhausted = isServerCapacityExhaustedError(error);
            const authError = isAuthenticationError(error);
            const retryAfterMs = Number.isFinite(error?.retryAfterMs)
                ? error.retryAfterMs
                : parseResetAfterMs(error?.message);

            if (account && capacity && !serverCapacityExhausted) {
                accountPool.markCapacityLimited(account.id, model, error.message || '');
            } else if (account && !capacity && !authError && !error?.authHandled) {
                accountPool.markAccountError(account.id, error);
            }

            const httpStatus = capacity ? 429 : (authError ? 401 : 500);
            const errorType = capacity ? 'rate_limit_error' : (authError ? 'authentication_error' : 'api_error');

            // 返回 Anthropic 格式的错误
            if (capacity && Number.isFinite(retryAfterMs) && !reply.raw.headersSent) {
                reply.header('Retry-After', Math.max(0, Math.ceil(retryAfterMs / 1000)));
            }
            errorResponseForLog = {
                type: 'error',
                error: {
                    type: errorType,
                    message: error.message,
                    ...(capacity && Number.isFinite(retryAfterMs) ? { retry_after_ms: retryAfterMs } : {}),
                    ...(error.upstreamStatus ? { upstream_status: error.upstreamStatus } : {}),
                    ...(error.upstreamJson ? { upstream_details: error.upstreamJson } : {})
                }
            };
            return reply.code(httpStatus).send(errorResponseForLog);
        } finally {
            // 释放模型并发槽位
            if (modelSlotAcquired) {
                releaseModelSlot(model);
            }
            // 解锁账号并发
            if (account) {
                accountPool.unlockAccount(account.id);
            }

            // 记录请求日志
            const latencyMs = Date.now() - startTime;
            createRequestLog({
                accountId: account?.id,
                apiKeyId: null,
                model,
                promptTokens: usage?.promptTokens || 0,
                completionTokens: usage?.completionTokens || 0,
                totalTokens: usage?.totalTokens || 0,
                thinkingTokens: usage?.thinkingTokens || 0,
                status,
                latencyMs,
                errorMessage
            });

            // 只在「调用模型」时输出日志（Anthropic 格式：完整请求与响应）
            try {
                const thinkingEnabledForLog = anthropicRequest.thinking?.type === 'enabled' ||
                    (anthropicRequest.thinking?.type !== 'disabled' && isThinkingModel(model));

                if (invokedUpstream) {
                    logModelCall({
                        kind: 'model_call',
                        provider: 'anthropic',
                        endpoint: '/v1/messages',
                        model,
                        stream: !!stream,
                        thinkingEnabled: !!thinkingEnabledForLog,
                        status,
                        latencyMs,
                        account: account ? { id: account.id, email: account.email, tier: account.tier } : null,
                        request: anthropicRequest,
                        response: responseForLog,
                        errorResponse: errorResponseForLog
                    });
                }
            } catch {
                // ignore logging failure
            }

            // 成功调用后发送 Trajectory Analytics + 关联 Metrics（fire-and-forget）
            if (status === 'success' && account && invokedUpstream) {
                touchAccountActivity(account.id);
                sendTrajectoryAnalytics(account, model, fullRequestId).catch(() => {});
                sendRequestMetrics(account, fullRequestId).catch(() => {});
            }
        }
    });

    // POST /messages - 兼容无 /v1 前缀的请求
    fastify.post('/messages', {
        preHandler: verifyApiKey
    }, async (request, reply) => {
        // 重定向到 /v1/messages
        return fastify.inject({
            method: 'POST',
            url: '/v1/messages',
            payload: request.body,
            headers: request.headers
        }).then(response => {
            reply.code(response.statusCode).headers(response.headers).send(response.payload);
        });
    });
}
