import { verifyApiKey, recordApiKeyUsage } from '../middleware/auth.js';
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

export default async function anthropicRoutes(fastify) {
    // POST /v1/messages - Anthropic 格式的聊天端点
    fastify.post('/v1/messages', {
        preHandler: verifyApiKey
    }, async (request, reply) => {
        const startTime = Date.now();
        let anthropicRequest = request.body;
        const { stream = false, model } = anthropicRequest;

        let account = null;
        let usage = null;
        let status = 'success';
        let errorMessage = null;
        let modelSlotAcquired = false;
        let invokedUpstream = false;
        let responseForLog = null;
        let streamEventsForLog = null;
        let errorResponseForLog = null;

        try {
            // 1. 预处理请求 - 为没有 thinking 块的 assistant 消息添加 redacted_thinking
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

            // 3. 获取最优账号
            account = await accountPool.getBestAccount(model);

            // 4. 转换请求格式
            const antigravityRequest = convertAnthropicToAntigravity(anthropicRequest, account.project_id);
            const requestId = antigravityRequest.requestId.replace('agent-', '');

            // 5. 流式或非流式处理
            if (stream) {
                streamEventsForLog = [];
                // 设置 SSE 响应头 (Anthropic 格式)
                reply.raw.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });

                // 发送 message_start 事件
                const messageStart = {
                    type: 'message_start',
                    message: {
                        id: `msg_${requestId}`,
                        type: 'message',
                        role: 'assistant',
                        model,
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: {
                            input_tokens: 0,
                            output_tokens: 0
                        }
                    }
                };
                streamEventsForLog.push({ event: 'message_start', data: messageStart });
                reply.raw.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);

                // 处理客户端断开
                const abortController = new AbortController();
                request.raw.on('close', () => {
                    abortController.abort();
                });

                let sseState = {};
                let lastUsage = null;
                let sawAnyUpstreamEvents = false;

                invokedUpstream = true;
                await streamChat(
                    account,
                    antigravityRequest,
                    (data) => {
                        // 转换 SSE 数据
                        const { events, state } = convertAntigravityToAnthropicSSE(
                            data, requestId, model, sseState
                        );
                        sseState = state;

                        // 发送所有事件
                        for (const event of events) {
                            const eventType = event.type;
                            sawAnyUpstreamEvents = true;
                            streamEventsForLog.push({ event: eventType, data: event });
                            reply.raw.write(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);

                            // 提取 usage
                            if (event.usage) {
                                lastUsage = event.usage;
                            }
                        }
                    },
                    (error) => {
                        status = 'error';
                        errorMessage = error.message;
                        const errorEvent = {
                            type: 'error',
                            error: {
                                type: 'api_error',
                                message: error.message
                            }
                        };
                        streamEventsForLog.push({ event: 'error', data: errorEvent });
                        reply.raw.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
                    },
                    abortController.signal
                );

                // 上游有时会返回“HTTP 200 + SSE 结束”但中间没有任何 events（例如安全拦截/空回复）
                if (status === 'success' && !sawAnyUpstreamEvents) {
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
                invokedUpstream = true;
                const antigravityResponse = await chat(account, antigravityRequest);
                // 检测 thinking 模式 - 显式启用或根据模型名自动启用
                const thinkingEnabled = anthropicRequest.thinking?.type === 'enabled' ||
                    (anthropicRequest.thinking?.type !== 'disabled' && isThinkingModel(model));
                const anthropicResponse = convertAntigravityToAnthropic(
                    antigravityResponse, requestId, model, thinkingEnabled
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
            status = 'error';
            errorMessage = error.message;

            const msg = error.message || '';
            const isCapacityError =
                msg.includes('exhausted your capacity on this model') ||
                msg.includes('Resource has been exhausted');

            // 容量耗尽：不把账号标成 error，只做短暂冷却，并返回 429
            if (account && isCapacityError) {
                accountPool.markCapacityLimited(account.id, model, msg);
            } else if (account) {
                accountPool.markAccountError(account.id, error);
            }

            const httpStatus = isCapacityError ? 429 : 500;
            const errorType = isCapacityError ? 'rate_limit_error' : 'api_error';

            // 返回 Anthropic 格式的错误
            errorResponseForLog = {
                type: 'error',
                error: {
                    type: errorType,
                    message: error.message
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
                apiKeyId: request.apiKey?.id,
                model,
                promptTokens: usage?.promptTokens || 0,
                completionTokens: usage?.completionTokens || 0,
                totalTokens: usage?.totalTokens || 0,
                thinkingTokens: usage?.thinkingTokens || 0,
                status,
                latencyMs,
                errorMessage
            });

            // 记录 API Key 使用量
            if (request.apiKey && usage?.totalTokens) {
                recordApiKeyUsage(request.apiKey.id, usage.totalTokens);
            }

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
