import { v4 as uuidv4 } from 'uuid';

import { verifyApiKey } from '../middleware/auth.js';
import { accountPool } from '../services/accountPool.js';
import { acquireModelSlot, releaseModelSlot } from '../services/rateLimiter.js';
import { streamChat, chat, countTokens, fetchAvailableModels } from '../services/antigravity.js';
import { createRequestLog } from '../db/index.js';
import { getMappedModel, getSafetySettings } from '../config.js';
import { logModelCall } from '../services/modelLogger.js';
import { isCapacityError, isAuthenticationError, isServerCapacityExhaustedError, parseResetAfterMs, SSE_HEADERS, buildErrorMessage } from '../utils/route-helpers.js';
import { createAbortController, runChatWithFullRetry, runStreamChatWithFullRetry, runChatWithCapacityRetry, runStreamChatWithCapacityRetry } from '../utils/request-handler.js';
import { buildUpstreamSystemInstruction } from '../services/converter/system-instruction.js';
import { sendTrajectoryAnalytics } from '../services/trajectory.js';
import { sendRequestMetrics } from '../services/telemetry.js';
import { touchAccountActivity } from '../services/warmup.js';

function generateSessionId() {
    return String(-Math.floor(Math.random() * 9e18));
}

function unwrapAntigravityResponse(payload) {
    if (payload && typeof payload === 'object' && payload.response) {
        const merged = { ...payload.response };
        if (payload.traceId && !merged.traceId) merged.traceId = payload.traceId;
        return merged;
    }
    return payload;
}

function parseModelsFromFetchAvailableModels(payload) {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const models = raw.models ?? raw;

    if (Array.isArray(models)) {
        return models
            .map((m) => {
                if (typeof m === 'string') return { id: m };
                if (m && typeof m === 'object') {
                    const id = m.id || m.name || m.model;
                    return id ? { id, ...m } : null;
                }
                return null;
            })
            .filter(Boolean);
    }

    if (models && typeof models === 'object') {
        return Object.entries(models).map(([id, info]) => {
            if (info && typeof info === 'object') return { id, ...info };
            return { id };
        });
    }

    return [];
}

function normalizeGeminiModelName(id) {
    const raw = String(id || '').trim();
    if (!raw) return null;
    return raw.startsWith('models/') ? raw : `models/${raw}`;
}

function normalizeSupportedGenerationMethods(entry) {
    const methods = entry?.supportedGenerationMethods;
    if (Array.isArray(methods) && methods.length > 0) return methods;
    return ['generateContent', 'streamGenerateContent'];
}

function toGeminiModelInfo(entry) {
    const id = entry?.id || entry?.name || entry?.model;
    const name = normalizeGeminiModelName(id);
    if (!name) return null;

    const out = {
        name,
        displayName: entry?.displayName || id,
        description: entry?.description || entry?.reason || entry?.message || '',
        supportedGenerationMethods: normalizeSupportedGenerationMethods(entry)
    };

    const inputLimit = entry?.inputTokenLimit ?? entry?.maxInputTokens ?? entry?.contextWindow ?? entry?.context_window;
    if (inputLimit) out.inputTokenLimit = inputLimit;

    const outputLimit = entry?.outputTokenLimit ?? entry?.maxOutputTokens;
    if (outputLimit) out.outputTokenLimit = outputLimit;

    return out;
}

export default async function geminiRoutes(fastify) {
    // GET /v1beta/models - Gemini models list
    fastify.get('/v1beta/models', {
        preHandler: verifyApiKey
    }, async (request, reply) => {
        let account = null;
        try {
            account = await accountPool.getNextAccount('gemini-2.5-flash');
            const payload = await fetchAvailableModels(account);
            const entries = parseModelsFromFetchAvailableModels(payload);
            const models = entries
                .filter((m) => String(m?.id || m?.name || '').toLowerCase().includes('gemini'))
                .map(toGeminiModelInfo)
                .filter(Boolean);
            return reply.code(200).send({ models });
        } catch (error) {
            return reply.code(500).send({
                error: { message: error?.message || String(error), type: 'api_error', code: 'internal_error' }
            });
        } finally {
            if (account) accountPool.unlockAccount(account.id);
        }
    });

    // GET /v1beta/models/:model - Gemini model detail
    fastify.get('/v1beta/models/:model', {
        preHandler: verifyApiKey
    }, async (request, reply) => {
        const raw = typeof request.params?.model === 'string' ? request.params.model : '';
        const target = decodeURIComponent(raw || '');
        if (!target || target.includes(':')) {
            return reply.code(404).send({
                error: { message: `Model not found: ${target}`, type: 'invalid_request_error', code: 'model_not_found' }
            });
        }

        let account = null;
        try {
            account = await accountPool.getNextAccount('gemini-2.5-flash');
            const payload = await fetchAvailableModels(account);
            const entries = parseModelsFromFetchAvailableModels(payload);
            const models = entries
                .filter((m) => String(m?.id || m?.name || '').toLowerCase().includes('gemini'))
                .map(toGeminiModelInfo)
                .filter(Boolean);

            const normalized = normalizeGeminiModelName(target);
            const hit = models.find((m) => m.name === normalized);
            if (!hit) {
                return reply.code(404).send({
                    error: { message: `Model not found: ${target}`, type: 'invalid_request_error', code: 'model_not_found' }
                });
            }
            return reply.code(200).send(hit);
        } catch (error) {
            return reply.code(500).send({
                error: { message: error?.message || String(error), type: 'api_error', code: 'internal_error' }
            });
        } finally {
            if (account) accountPool.unlockAccount(account.id);
        }
    });

    // Gemini native endpoint (minimal): /v1beta/models/<model>:(generateContent|streamGenerateContent)
    // 目前主要用于 gemini-3.1-flash-image，透传 generationConfig.imageConfig 等字段到上游。
    fastify.post('/v1beta/models/*', {
        preHandler: verifyApiKey
    }, async (request, reply) => {
            const startTime = Date.now();
            const rest = typeof request.params?.['*'] === 'string' ? request.params['*'] : '';
            const decodedRest = decodeURIComponent(rest || '');
            const sep = decodedRest.lastIndexOf(':');
            if (sep <= 0) {
                return reply.code(404).send({
                    error: { message: `Not Found: POST /v1beta/models/${decodedRest}` }
                });
            }

            const modelFromPath = decodedRest.slice(0, sep);
            const action = decodedRest.slice(sep + 1);
            if (action !== 'generateContent' && action !== 'streamGenerateContent' && action !== 'countTokens') {
                return reply.code(404).send({
                    error: { message: `Not Found: POST /v1beta/models/${decodedRest}` }
                });
            }

            const stream = action === 'streamGenerateContent';
            const isCountTokens = action === 'countTokens';
            const wantsSse =
                stream &&
                (String(request.query?.alt || '').toLowerCase() === 'sse' ||
                    String(request.headers.accept || '').toLowerCase().includes('text/event-stream'));

            const requestedModel = modelFromPath.startsWith('models/')
                ? modelFromPath.slice('models/'.length)
                : modelFromPath;
            const model = getMappedModel(requestedModel);

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
                modelSlotAcquired = acquireModelSlot(model);
                if (!modelSlotAcquired) {
                    status = 'error';
                    errorMessage = 'Model concurrency limit reached';
                    errorResponseForLog = {
                        error: { message: 'Model concurrency limit reached, please retry later', code: 'model_concurrency_limit' }
                    };
                    return reply.code(429).send(errorResponseForLog);
                }

                fullRequestId = `agent/${Date.now()}/${uuidv4()}/${Math.floor(Math.random() * 10)}`;
                const requestId = fullRequestId;

                // Gemini 端点 body：允许 {request:{...}} 或直接 {...}
                const rawBody = request.body && typeof request.body === 'object' ? request.body : {};
                const innerRequest =
                    rawBody.request && typeof rawBody.request === 'object'
                        ? structuredClone(rawBody.request)
                        : structuredClone(rawBody);

                if (isCountTokens) {
                    const countTokensBody = {
                        request: {
                            model,
                            contents: Array.isArray(innerRequest.contents) ? innerRequest.contents : []
                        }
                    };

                    const out = await runChatWithCapacityRetry({
                        model,
                        accountPool,
                        buildRequest: () => countTokensBody,
                        execute: async (a, req) => {
                            invokedUpstream = true;
                            return countTokens(a, req);
                        }
                    });

                    account = out.account;
                    responseForLog = out.result;
                    return reply.code(200).send(out.result);
                }

                // 透传 generationConfig（包括 imageConfig），仅补最小默认值
                if (!innerRequest.generationConfig || typeof innerRequest.generationConfig !== 'object') {
                    innerRequest.generationConfig = {};
                }
                if (innerRequest.generationConfig.candidateCount === undefined) {
                    innerRequest.generationConfig.candidateCount = 1;
                }

                const requestType = model === 'gemini-3.1-flash-image' ? 'image_gen' : 'agent';

                // Inject official system prompt (upstream may validate it)
                // Skip for image generation model
                if (requestType !== 'image_gen') {
                    const upstreamSystemInstruction = buildUpstreamSystemInstruction(innerRequest.systemInstruction);
                    if (upstreamSystemInstruction) {
                        innerRequest.systemInstruction = upstreamSystemInstruction;
                    } else {
                        delete innerRequest.systemInstruction;
                    }
                }

                const antigravityRequestBase = {
                    project: '',
                    requestId,
                    request: {
                        ...innerRequest,
                        sessionId: innerRequest.sessionId || generateSessionId(),
                        // 禁用 Gemini 安全过滤，避免 "no candidates" 错误
                        safetySettings: innerRequest.safetySettings || getSafetySettings(model)
                    },
                    model,
                    userAgent: 'antigravity',
                    requestType
                };

                if (stream) {
                    streamChunksForLog = [];
                    const chunksForClient = [];
                    if (wantsSse) {
                        reply.raw.writeHead(200, SSE_HEADERS);
                    }

                    const abortController = createAbortController(request);

                    let lastUsage = null;
                    let sawAnyData = false;

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
                                sawAnyData = true;
                                try {
                                    const parsed = JSON.parse(data);
                                    const unwrapped = unwrapAntigravityResponse(parsed);
                                    const usageMetadata = unwrapped?.usageMetadata;
                                    if (usageMetadata) {
                                        lastUsage = {
                                            promptTokens: usageMetadata.promptTokenCount || 0,
                                            completionTokens: usageMetadata.candidatesTokenCount || 0,
                                            totalTokens: usageMetadata.totalTokenCount || 0,
                                            thinkingTokens: usageMetadata.thoughtsTokenCount || 0
                                        };
                                    }
                                    streamChunksForLog.push(unwrapped);
                                    chunksForClient.push(unwrapped);
                                    if (wantsSse) {
                                        reply.raw.write(`data: ${JSON.stringify(unwrapped)}\n\n`);
                                    }
                                } catch {
                                    // 非 JSON chunk：忽略
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
                        const errorChunk = { error: { message: errorMessage, type: 'api_error' } };
                        errorResponseForLog = errorChunk;
                        if (wantsSse) {
                            reply.raw.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                        }
                    }

                    if (status === 'success' && !sawAnyData) {
                        status = 'error';
                        errorMessage = 'Upstream returned empty response (no events)';
                        const errorChunk = { error: { message: errorMessage, type: 'api_error', code: 'empty_upstream_response' } };
                        errorResponseForLog = errorChunk;
                        if (wantsSse) {
                            reply.raw.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                        }
                    }

                    usage = lastUsage;
                    responseForLog = { stream: true, chunks: streamChunksForLog };
                    if (wantsSse) {
                        reply.raw.write('data: [DONE]\n\n');
                        reply.raw.end();
                        return;
                    }

                    if (status === 'success') {
                        return reply.code(200).send(chunksForClient);
                    }

                    return reply.code(500).send(errorResponseForLog || { error: { message: errorMessage || 'Unknown error', type: 'api_error' } });
                }

                // 非流式
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
                const unwrapped = unwrapAntigravityResponse(out.result);
                const usageMetadata = unwrapped?.usageMetadata;
                usage = usageMetadata
                    ? {
                        promptTokens: usageMetadata.promptTokenCount || 0,
                        completionTokens: usageMetadata.candidatesTokenCount || 0,
                        totalTokens: usageMetadata.totalTokenCount || 0,
                        thinkingTokens: usageMetadata.thoughtsTokenCount || 0
                    }
                    : null;

                responseForLog = unwrapped;
                return reply.code(200).send(unwrapped);
            } catch (error) {
                if (error?.account) account = error.account;
                status = 'error';
                errorMessage = buildErrorMessage(error);

                const msg = error.message || '';
                const capacity = isCapacityError(error);
                const serverCapacityExhausted = isServerCapacityExhaustedError(error);
                const authError = isAuthenticationError(error);
                const retryAfterMs = Number.isFinite(error?.retryAfterMs)
                    ? error.retryAfterMs
                    : parseResetAfterMs(error?.message);

                if (account && capacity && !serverCapacityExhausted) {
                    accountPool.markCapacityLimited(account.id, model, msg);
                } else if (account && !capacity && !authError && !error?.authHandled) {
                    accountPool.markAccountError(account.id, error);
                }

                const httpStatus = capacity ? 429 : (authError ? 401 : 500);
                const errorCode = capacity ? 'rate_limit_exceeded' : (authError ? 'invalid_api_key' : 'internal_error');
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
                if (modelSlotAcquired) releaseModelSlot(model);
                if (account) accountPool.unlockAccount(account.id);

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

                try {
                    if (invokedUpstream) {
                        logModelCall({
                            kind: 'model_call',
                            provider: 'gemini',
                            endpoint: `/v1beta/models/${requestedModel}:${action}`,
                            model,
                            stream: !!stream,
                            status,
                            latencyMs,
                            account: account ? { id: account.id, email: account.email, tier: account.tier } : null,
                            request: request.body,
                            response: responseForLog,
                            errorResponse: errorResponseForLog
                        });
                    }
                } catch {
                    // ignore
                }

                // 成功调用后发送 Trajectory Analytics + 关联 Metrics（fire-and-forget）
                if (status === 'success' && account && invokedUpstream) {
                    touchAccountActivity(account.id);
                    sendTrajectoryAnalytics(account, model, fullRequestId).catch(() => {});
                    sendRequestMetrics(account, fullRequestId).catch(() => {});
                }
            }
    });
}
