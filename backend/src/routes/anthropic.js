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
import { searchWeb } from '../services/webSearch.js';
import { createHash } from 'crypto';

function parseResetAfterMs(message) {
    if (!message) return null;
    const m = String(message).match(/reset after (\\d+)s/i);
    if (!m) return null;
    const seconds = Number.parseInt(m[1], 10);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return (seconds + 1) * 1000;
}

function sleep(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getSystemText(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        return system.map(s => (typeof s === 'string' ? s : (s?.text || ''))).join('\n');
    }
    return '';
}

function contentToText(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(c => (typeof c === 'string' ? c : (c?.text || '')))
            .join('\n');
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
    return String(content);
}

function isClaudeCodeRequestFromSystem(system) {
    const text = getSystemText(system);
    return text.includes('You are Claude Code') || text.includes("Claude Code, Anthropic's official CLI for Claude");
}

function hasWebSearchServerTool(tools) {
    if (!Array.isArray(tools)) return false;
    return tools.some(t => typeof t?.type === 'string' && t.type.startsWith('web_search_'));
}

function extractClaudeCodeWebSearchHelperQuery(messages) {
    if (!Array.isArray(messages) || messages.length !== 1) return null;
    const msg = messages[0];
    if (msg?.role !== 'user') return null;
    const text = contentToText(msg.content).trim();
    // Claude Code WebSearch helper call format
    // e.g. "Perform a web search for the query: 今日新闻 2025年12月19日"
    const prefix = 'Perform a web search for the query:';
    if (!text.startsWith(prefix)) return null;
    const query = text.slice(prefix.length).trim();
    return query || null;
}

function makePseudoEncryptedContent(input) {
    const h = createHash('sha256').update(String(input || '')).digest('base64url');
    // keep it short-ish but non-empty
    return `E${h.slice(0, 48)}`;
}

async function handleClaudeCodeWebSearchHelperRequest(request, reply) {
    const body = request.body || {};
    const { model, stream = false } = body;

    const query = extractClaudeCodeWebSearchHelperQuery(body.messages);
    if (!query) return false;

    // Do the actual search server-side (emulating Anthropic web search tool behavior)
    let search = null;
    try {
        search = await searchWeb(query, 5);
    } catch (e) {
        search = { success: false, results: [], error: e?.message || String(e) };
    }

    const srvToolId = `srvtoolu_${createHash('sha1').update(`${Date.now()}|${Math.random()}|${query}`).digest('hex').slice(0, 24)}`;
    const results = (search?.results || []).map(r => ({
        type: 'web_search_result',
        url: r.url || '',
        title: r.title || r.url || 'Result',
        encrypted_content: makePseudoEncryptedContent(`${r.title || ''}\n${r.url || ''}\n${r.snippet || ''}`),
        page_age: ''
    })).filter(r => r.url);

    const contentBlocks = [
        {
            type: 'server_tool_use',
            id: srvToolId,
            name: 'web_search',
            input: { query }
        },
        {
            type: 'web_search_tool_result',
            tool_use_id: srvToolId,
            content: results
        }
    ];

    const usage = {
        input_tokens: 0,
        output_tokens: 0,
        server_tool_use: { web_search_requests: 1 }
    };

    if (!stream) {
        return reply.send({
            id: `msg_${srvToolId}`,
            type: 'message',
            role: 'assistant',
            model,
            content: contentBlocks,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage
        });
    }

    // Stream (SSE) response in Anthropic format
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const messageStart = {
        type: 'message_start',
        message: {
            id: `msg_${srvToolId}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 1 } }
        }
    };
    reply.raw.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);

    // 0) server_tool_use block（按文档：start 不带 input，input 通过 input_json_delta 下发）
    reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: srvToolId, name: 'web_search', input: {} }
    })}\n\n`);
    reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) }
    })}\n\n`);
    reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);

    // 1) web_search_tool_result block
    reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'web_search_tool_result', tool_use_id: srvToolId, content: results }
    })}\n\n`);
    reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`);

    reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0, server_tool_use: { web_search_requests: 1 } }
    })}\n\n`);
    reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    reply.raw.end();
    return true;
}

function looksLikeEmptyWebSearchResult(content) {
    const trimmed = contentToText(content).trim();
    if (!trimmed) return true;
    // Claude Code WebSearch 常见占位输出：只有 query + REMINDER，但没有任何来源链接
    const hasAnyLink = trimmed.includes('http://') || trimmed.includes('https://') || trimmed.includes('www.');
    if (trimmed.startsWith('Web search results for query:') && !hasAnyLink) return true;
    if (trimmed.includes('REMINDER: You MUST include the sources above') && !hasAnyLink) return true;
    return false;
}

function formatSearchResultsMarkdown(query, results) {
    if (!results?.length) {
        return `Web search results for query: "${query}"\n\n(No results found.)`;
    }

    const lines = [];
    lines.push(`Web search results for query: "${query}"`);
    lines.push('');
    for (const r of results) {
        const title = r.title || r.url || 'Result';
        const url = r.url || '';
        const snippet = r.snippet ? ` — ${r.snippet}` : '';
        if (url) lines.push(`- [${title}](${url})${snippet}`);
    }
    return lines.join('\n');
}

async function patchClaudeCodeEmptyWebSearchToolResults(request) {
    if (!isClaudeCodeRequestFromSystem(request?.system)) return request;
    if (!Array.isArray(request?.messages)) return request;

    const toolUseMap = new Map(); // tool_use_id -> { name, input }
    for (const msg of request.messages) {
        if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            if (block?.type === 'tool_use' && block.id) {
                toolUseMap.set(block.id, { name: block.name, input: block.input });
            }
        }
    }

    let mutated = false;
    const patchedMessages = request.messages.map(msg => {
        if (msg?.role !== 'user' || !Array.isArray(msg.content)) return msg;

        const patchedContent = msg.content.map(block => {
            if (block?.type !== 'tool_result' || !block.tool_use_id) return block;
            const toolUse = toolUseMap.get(block.tool_use_id);
            const toolName = toolUse?.name;
            if (!toolName) return block;

            const normalizedToolName = String(toolName).toLowerCase().replace(/[^a-z0-9]/g, '');
            const isWebSearchTool = normalizedToolName === 'websearch';
            if (!isWebSearchTool) return block;

            if (!looksLikeEmptyWebSearchResult(block.content)) return block;

            const query =
                (toolUse?.input && typeof toolUse.input.query === 'string' && toolUse.input.query.trim())
                    ? toolUse.input.query.trim()
                    : (toolUse?.input && typeof toolUse.input.q === 'string' && toolUse.input.q.trim())
                        ? toolUse.input.q.trim()
                        : (toolUse?.input && typeof toolUse.input.search_query === 'string' && toolUse.input.search_query.trim())
                            ? toolUse.input.search_query.trim()
                            : (toolUse?.input && typeof toolUse.input.keyword === 'string' && toolUse.input.keyword.trim())
                                ? toolUse.input.keyword.trim()
                    : (() => {
                        const m = contentToText(block.content || '').match(/query:\s*\"([^\"]+)\"/i);
                        return m?.[1] || 'web search';
                    })();

            mutated = true;
            return { ...block, _needs_web_search_patch: true, _web_search_query: query };
        });

        return mutated ? { ...msg, content: patchedContent } : msg;
    });

    if (!mutated) return request;

    for (const msg of patchedMessages) {
        if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            if (!block?._needs_web_search_patch) continue;
            const query = block._web_search_query || 'web search';
            try {
                const search = await searchWeb(query, 5);
                block.content = formatSearchResultsMarkdown(query, search?.results || []);
            } catch (e) {
                block.content = `Web search results for query: "${query}"\n\n(Search failed: ${e?.message || String(e)})`;
            }
            delete block._needs_web_search_patch;
            delete block._web_search_query;
        }
    }

    return { ...request, messages: patchedMessages };
}

export default async function anthropicRoutes(fastify) {
    // POST /v1/messages - Anthropic 格式的聊天端点
    fastify.post('/v1/messages', {
        preHandler: verifyApiKey
    }, async (request, reply) => {
        const startTime = Date.now();
        let anthropicRequest = request.body;
        const { stream = false, model } = anthropicRequest;

        // 兼容：部分客户端不会传 metadata.user_id，但 Claude extended thinking 的 signature 回放/兜底逻辑需要一个稳定的 userKey。
        // 这里用 API Key ID 作为 fallback，显著降低“多轮工具调用后 signature 丢失 -> thinking_downgrade”的概率。
        try {
            if (anthropicRequest && typeof anthropicRequest === 'object') {
                const meta = (anthropicRequest.metadata && typeof anthropicRequest.metadata === 'object')
                    ? anthropicRequest.metadata
                    : {};
                if (!meta.user_id) {
                    anthropicRequest.metadata = { ...meta, user_id: `api_key:${request.apiKey?.id ?? 'unknown'}` };
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

        const maxRetries = Math.max(0, Number(process.env.UPSTREAM_CAPACITY_RETRIES || 2));
        const baseRetryDelayMs = Math.max(0, Number(process.env.UPSTREAM_CAPACITY_RETRY_DELAY_MS || 1000));
        const isCapacityError = (err) => {
            const msg = err?.message || '';
            return (
                msg.includes('exhausted your capacity on this model') ||
                msg.includes('Resource has been exhausted') ||
                err?.upstreamStatus === 429
            );
        };

        try {
            // Claude Code 的 WebSearch 会先发一个“web search helper call”，带上 web_search_20250305 工具。
            // 官方 Anthropic API 会在服务器侧执行搜索并返回 server_tool_use + web_search_tool_result。
            // 为了让 Claude Code 的原生 WebSearch 正常工作（不再显示 Did 0 searches），这里直接在代理侧模拟该工具响应。
            if (isClaudeCodeRequestFromSystem(anthropicRequest?.system) && hasWebSearchServerTool(anthropicRequest?.tools)) {
                const handled = await handleClaudeCodeWebSearchHelperRequest(request, reply);
                if (handled) return;
            }

            // 1. 预处理请求 - 尝试补齐/回放 thinking.signature（仅在无法恢复时才会降级禁用 thinking）
            anthropicRequest = preprocessAnthropicRequest(anthropicRequest);
            anthropicRequest = await patchClaudeCodeEmptyWebSearchToolResults(anthropicRequest);

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
            const requestId = antigravityRequestBase.requestId.replace('agent-', '');

            // 5. 流式或非流式处理
            if (stream) {
                streamEventsForLog = [];
                // 设置 SSE 响应头 (Anthropic 格式)
                reply.raw.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
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

                const thinkingEnabledForStream = anthropicRequest.thinking?.type === 'enabled' ||
                    (anthropicRequest.thinking?.type !== 'disabled' && isThinkingModel(model));
                let sseState = {
                    thinkingEnabled: !!thinkingEnabledForStream,
                    userKey: anthropicRequest?.metadata?.user_id || null
                };
                let lastUsage = null;
                let sawAnyUpstreamEvents = false;
                let sawAnyContentBlock = false;

                try {
                    let attempt = 0;
                    while (true) {
                        attempt++;
                        account = await accountPool.getBestAccount(model);

                        const antigravityRequest = structuredClone(antigravityRequestBase);
                        antigravityRequest.project = account.project_id || '';

                        invokedUpstream = true;
                        try {
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
                                        if (eventType === 'content_block_start' || eventType === 'content_block_delta') {
                                            sawAnyContentBlock = true;
                                        }
                                        streamEventsForLog.push({ event: eventType, data: event });
                                        reply.raw.write(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);

                                        // 提取 usage
                                        if (event.usage) {
                                            lastUsage = event.usage;
                                        }
                                    }
                                },
                                null,
                                abortController.signal
                            );

                            // 成功：清除退避计数
                            accountPool.markCapacityRecovered(account.id, model);
                            break;
                        } catch (err) {
                            if (abortController.signal.aborted) return;
                            if (account && isCapacityError(err)) {
                                accountPool.markCapacityLimited(account.id, model, err.message || '');
                                accountPool.unlockAccount(account.id);
                                account = null;
                                // 仅在还没产出任何事件时切号重试
                                if (!sawAnyUpstreamEvents && attempt <= maxRetries + 1) {
                                    const resetMs = parseResetAfterMs(err?.message);
                                    const delay = resetMs ?? (baseRetryDelayMs * attempt);
                                    await sleep(delay);
                                    continue;
                                }
                            }
                            throw err;
                        }
                    }
                } catch (err) {
                    status = 'error';
                    errorMessage = err.message;
                    const errorEvent = {
                        type: 'error',
                        error: {
                            type: 'api_error',
                            message: err.message
                        }
                    };
                    streamEventsForLog.push({ event: 'error', data: errorEvent });
                    reply.raw.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
                }

                // 上游偶发会“提前结束流”而不下发最终 finish/message_stop（客户端表现为：只输出一段 thinking 就断开）
                // 这类情况对客户端来说是不可恢复的半包响应，这里明确返回 error event 方便前端重试/回滚。
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
                let antigravityResponse = null;
                let attempt = 0;
                while (true) {
                    attempt++;
                    account = await accountPool.getBestAccount(model);
                    const antigravityRequest = structuredClone(antigravityRequestBase);
                    antigravityRequest.project = account.project_id || '';

                    try {
                        invokedUpstream = true;
                        antigravityResponse = await chat(account, antigravityRequest);
                        accountPool.markCapacityRecovered(account.id, model);
                        break;
                    } catch (err) {
                        if (account && isCapacityError(err)) {
                            accountPool.markCapacityLimited(account.id, model, err.message || '');
                            accountPool.unlockAccount(account.id);
                            account = null;
                            if (attempt <= maxRetries + 1) {
                                const resetMs = parseResetAfterMs(err?.message);
                                const delay = resetMs ?? (baseRetryDelayMs * attempt);
                                await sleep(delay);
                                continue;
                            }
                        }
                        throw err;
                    }
                }
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
            status = 'error';
            errorMessage = error.message;

            // 容量耗尽：不把账号标成 error，只做短暂冷却，并返回 429
            if (account && isCapacityError(error)) {
                accountPool.markCapacityLimited(account.id, model, error.message || '');
            } else if (account) {
                accountPool.markAccountError(account.id, error);
            }

            const httpStatus = isCapacityError(error) ? 429 : 500;
            const errorType = isCapacityError(error) ? 'rate_limit_error' : 'api_error';

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
