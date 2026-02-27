import { verifyApiKey } from '../middleware/auth.js';
import { accountPool } from '../services/accountPool.js';
import { acquireModelSlot, releaseModelSlot } from '../services/rateLimiter.js';
import { streamChat, chat } from '../services/antigravity.js';
import {
    convertOpenAIToAntigravity,
    convertSSEChunk,
    convertResponse,
    extractUsageFromSSE,
    getModelsList
} from '../services/converter.js';
import { createRequestLog } from '../db/index.js';
import { isThinkingModel } from '../config.js';
import { logModelCall } from '../services/modelLogger.js';
import { isCapacityError, isAuthenticationError, isServerCapacityExhaustedError, parseResetAfterMs, SSE_HEADERS, buildErrorMessage } from '../utils/route-helpers.js';
import { createAbortController, runChatWithFullRetry, runStreamChatWithFullRetry } from '../utils/request-handler.js';
import { sendTrajectoryAnalytics } from '../services/trajectory.js';
import { sendRequestMetrics } from '../services/telemetry.js';
import { touchAccountActivity } from '../services/warmup.js';

export default async function openaiRoutes(fastify) {
    // POST /v1/chat/completions
    fastify.post('/v1/chat/completions', {
        preHandler: verifyApiKey
    }, async (request, reply) => {
        const startTime = Date.now();
        const openaiRequest = request.body;
        const { stream = false, model, thinking_budget, budget_tokens } = openaiRequest;
        const thinkingType = String(openaiRequest?.thinking?.type || '').trim().toLowerCase();
        const hasExplicitThinkingBudget =
            thinking_budget !== undefined ||
            budget_tokens !== undefined ||
            openaiRequest?.thinking?.budget_tokens !== undefined ||
            openaiRequest?.thinking?.budgetTokens !== undefined;
        const hasThinkingEffort = openaiRequest?.thinking?.effort !== undefined;
        // Determine if we should include thinking output:
        // Enable if explicit thinking.type enabled/adaptive; otherwise follow model default or explicit budget/effort.
        const includeThinking =
            thinkingType === 'enabled' ||
            thinkingType === 'adaptive' ||
            (thinkingType !== 'disabled' && (isThinkingModel(model) || hasExplicitThinkingBudget || hasThinkingEffort));
        const includeUsageInStream = !!(
            stream &&
            openaiRequest &&
            typeof openaiRequest === 'object' &&
            openaiRequest.stream_options &&
            typeof openaiRequest.stream_options === 'object' &&
            openaiRequest.stream_options.include_usage === true
        );

        let account = null;
        let usage = null;
        let status = 'success';
        let errorMessage = null;
        let modelSlotAcquired = false;
        let invokedUpstream = false;
        let responseForLog = null;
        let streamChunksForLog = null;
        let errorResponseForLog = null;
        let fullRequestId = null;

        try {
            // 1. 获取模型并发槽位（避免本地直接打爆上游）
            modelSlotAcquired = acquireModelSlot(model);
            if (!modelSlotAcquired) {
                status = 'error';
                errorMessage = 'Model concurrency limit reached';
                errorResponseForLog = {
                    error: {
                        message: 'Model concurrency limit reached, please retry later',
                        type: 'rate_limit_error',
                        code: 'model_concurrency_limit'
                    }
                };
                return reply.code(429).send(errorResponseForLog);
            }

            // 2/3. 先转换请求格式（requestId 固定），project 在选择账号后再注入，便于容量错误时重试切号
            const antigravityRequestBase = convertOpenAIToAntigravity(openaiRequest, '');
            fullRequestId = antigravityRequestBase.requestId;
            const requestId = fullRequestId.split('/')[2] || fullRequestId;

            // 4. 流式或非流式处理
            if (stream) {
                streamChunksForLog = [];
                // 设置 SSE 响应头
                reply.raw.writeHead(200, SSE_HEADERS);

                const abortController = createAbortController(request);

                let lastUsage = null;

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
                            const extractedUsage = extractUsageFromSSE(data);
                            if (extractedUsage) {
                                lastUsage = extractedUsage;
                            }

                            const chunks = convertSSEChunk(data, requestId, model, includeThinking);
                            if (chunks) {
                                for (const chunk of chunks) {
                                    if (chunk?.error?.message) {
                                        status = 'error';
                                        errorMessage = chunk.error.message;
                                        errorResponseForLog = chunk;
                                    }
                                    streamChunksForLog.push(chunk);
                                    reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                                }
                            }
                        },
                        abortSignal: abortController.signal,
                        canRetry: () => streamChunksForLog.length === 0
                    });

                    account = out.account;
                    if (out.aborted) return;
                } catch (err) {
                    if (err?.account) account = err.account;
                    status = 'error';
                    errorMessage = buildErrorMessage(err);
                    const errorChunk = {
                        error: {
                            message: err.message,
                            type: 'api_error',
                            ...(err.upstreamStatus ? { upstream_status: err.upstreamStatus } : {}),
                            ...(err.upstreamJson ? { upstream_details: err.upstreamJson } : {})
                        }
                    };
                    streamChunksForLog.push(errorChunk);
                    reply.raw.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                }

                // 上游有时会返回“HTTP 200 + SSE 结束”，但没有任何有效内容（例如安全拦截/空回复）
                // 这种情况下给客户端一个明确的 error chunk，避免出现“空回复且不报错”
                const hasUsefulDelta = streamChunksForLog.some((chunk) => {
                    const delta = chunk?.choices?.[0]?.delta;
                    return !!(delta && (delta.content || delta.reasoning_content || delta.tool_calls));
                });

                if (status === 'success' && !hasUsefulDelta) {
                    status = 'error';
                    errorMessage = 'Upstream returned empty response (no candidates)';
                    const errorChunk = {
                        error: {
                            message: errorMessage,
                            type: 'api_error',
                            code: 'empty_upstream_response'
                        }
                    };
                    errorResponseForLog = errorChunk;
                    streamChunksForLog.push(errorChunk);
                    reply.raw.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                }

                // OpenAI streaming: optionally include usage as the final chunk (stream_options.include_usage)
                if (includeUsageInStream) {
                    const usageChunk = {
                        id: `chatcmpl-${requestId}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [],
                        usage: {
                            prompt_tokens: lastUsage?.promptTokens || 0,
                            completion_tokens: lastUsage?.completionTokens || 0,
                            total_tokens: lastUsage?.totalTokens || 0
                        }
                    };
                    streamChunksForLog.push(usageChunk);
                    reply.raw.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
                }

                // 发送结束标志
                reply.raw.write('data: [DONE]\n\n');
                reply.raw.end();

                usage = lastUsage;
                responseForLog = { stream: true, chunks: streamChunksForLog, done: true };
            } else {
                // 非流式请求（thinking 模型返回思维链）
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
                const openaiResponse = convertResponse(antigravityResponse, requestId, model, includeThinking);

                usage = {
                    promptTokens: openaiResponse.usage.prompt_tokens,
                    completionTokens: openaiResponse.usage.completion_tokens,
                    totalTokens: openaiResponse.usage.total_tokens,
                    thinkingTokens: antigravityResponse?.response?.usageMetadata?.thoughtsTokenCount || 0
                };

                responseForLog = openaiResponse;
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
            const errorCode = capacity ? 'rate_limit_exceeded' : (authError ? 'invalid_api_key' : 'internal_error');

            // 返回 OpenAI 格式的错误
            if (capacity && Number.isFinite(retryAfterMs) && !reply.raw.headersSent) {
                reply.header('Retry-After', Math.max(0, Math.ceil(retryAfterMs / 1000)));
            }
            errorResponseForLog = {
                error: {
                    message: error.message,
                    type: 'api_error',
                    code: errorCode,
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

            // 只在「调用模型」时输出日志（OpenAI 格式：完整请求与响应）
            try {
                if (invokedUpstream) {
                    logModelCall({
                        kind: 'model_call',
                        provider: 'openai',
                        endpoint: '/v1/chat/completions',
                        model,
                        stream: !!stream,
                        status,
                        latencyMs,
                        account: account ? { id: account.id, email: account.email, tier: account.tier } : null,
                        request: openaiRequest,
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

    // GET /v1/models
    fastify.get('/v1/models', {
        preHandler: verifyApiKey
    }, async () => {
        return getModelsList();
    });

    // GET /v1/models/:model
    fastify.get('/v1/models/:model', {
        preHandler: verifyApiKey
    }, async (request) => {
        const { model } = request.params;
        const models = getModelsList();
        const found = models.data.find(m => m.id === model);

        if (!found) {
            return {
                error: {
                    message: `Model '${model}' not found`,
                    type: 'invalid_request_error',
                    code: 'model_not_found'
                }
            };
        }

        return found;
    });

    // 健康检查（不需要认证）
    fastify.get('/health', async () => {
        const stats = accountPool.getPoolStats();
        return {
            status: 'ok',
            accounts: stats
        };
    });

    // 根路径信息
    // 单容器模式下，根路径由前端静态资源（index.html）接管
}
