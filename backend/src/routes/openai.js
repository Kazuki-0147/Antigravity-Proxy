import { verifyApiKey, recordApiKeyUsage } from '../middleware/auth.js';
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

export default async function openaiRoutes(fastify) {
    // POST /v1/chat/completions
    fastify.post('/v1/chat/completions', {
        preHandler: verifyApiKey
    }, async (request, reply) => {
        const startTime = Date.now();
        const openaiRequest = request.body;
        const { stream = false, model } = openaiRequest;

        let account = null;
        let usage = null;
        let status = 'success';
        let errorMessage = null;
        let modelSlotAcquired = false;
        let invokedUpstream = false;
        let responseForLog = null;
        let streamChunksForLog = null;
        let errorResponseForLog = null;

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

            // 2. 获取最优账号
            account = await accountPool.getBestAccount(model);

            // 3. 转换请求格式（传入账号的 project_id）
            const antigravityRequest = convertOpenAIToAntigravity(openaiRequest, account.project_id);
            const requestId = antigravityRequest.requestId.replace('agent-', '');

            // 4. 流式或非流式处理
            if (stream) {
                streamChunksForLog = [];
                // 设置 SSE 响应头
                reply.raw.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });

                // 处理客户端断开
                const abortController = new AbortController();
                request.raw.on('close', () => {
                    abortController.abort();
                });

                let lastUsage = null;

                invokedUpstream = true;
                await streamChat(
                    account,
                    antigravityRequest,
                    (data) => {
                        // 提取 usage 信息
                        const extractedUsage = extractUsageFromSSE(data);
                        if (extractedUsage) {
                            lastUsage = extractedUsage;
                        }

                        // 转换并发送响应（thinking 模型返回思维链）
                        const chunks = convertSSEChunk(data, requestId, model, isThinkingModel(model));
                        if (chunks) {
                            for (const chunk of chunks) {
                                streamChunksForLog.push(chunk);
                                reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                            }
                        }
                    },
                    (error) => {
                        status = 'error';
                        errorMessage = error.message;
                        const errorChunk = {
                            error: {
                                message: error.message,
                                type: 'api_error'
                            }
                        };
                        streamChunksForLog.push(errorChunk);
                        reply.raw.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                    },
                    abortController.signal
                );

                // 发送结束标志
                reply.raw.write('data: [DONE]\n\n');
                reply.raw.end();

                usage = lastUsage;
                responseForLog = { stream: true, chunks: streamChunksForLog, done: true };
            } else {
                // 非流式请求（thinking 模型返回思维链）
                invokedUpstream = true;
                const antigravityResponse = await chat(account, antigravityRequest);
                const openaiResponse = convertResponse(antigravityResponse, requestId, model, isThinkingModel(model));

                usage = {
                    promptTokens: openaiResponse.usage.prompt_tokens,
                    completionTokens: openaiResponse.usage.completion_tokens,
                    totalTokens: openaiResponse.usage.total_tokens
                };

                responseForLog = openaiResponse;
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
                // 其他错误依然标记账号错误，避免持续使用异常账号
                accountPool.markAccountError(account.id, error);
            }

            const httpStatus = isCapacityError ? 429 : 500;
            const errorCode = isCapacityError ? 'rate_limit_exceeded' : 'internal_error';

            // 返回 OpenAI 格式的错误
            errorResponseForLog = {
                error: {
                    message: error.message,
                    type: 'api_error',
                    code: errorCode
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
