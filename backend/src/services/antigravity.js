import { ANTIGRAVITY_CONFIG } from '../config.js';
import { fingerprintFetch, fingerprintStreamFetch } from '../runtime/fingerprint-requester.js';
import { refreshVersion, isVersionOutdatedText } from './versionFetcher.js';
import fs from 'fs';

const BASE_URL = ANTIGRAVITY_CONFIG.base_url;
const API_HOST = new URL(BASE_URL).host;

/**
 * 判断模型是否需要伪非流式（上游已关闭这些模型的非流式端点）
 * - Claude 系列
 * - Gemini 3 Pro 系列
 */
function needsFakeNonStreaming(model) {
    if (!model) return false;
    const m = model.toLowerCase();
    // Claude 系列
    if (m.includes('claude')) return true;
    // Gemini 3 Pro 系列
    if (m.includes('gemini-3-pro')) return true;
    return false;
}

const UPSTREAM_REQUEST_CAPTURE_ENABLED = (() => {
    const raw = process.env.UPSTREAM_REQUEST_CAPTURE;
    if (raw === undefined || raw === null || raw === '') return false;
    const v = String(raw).trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(v);
})();
const UPSTREAM_REQUEST_CAPTURE_PATH = process.env.UPSTREAM_REQUEST_CAPTURE_PATH || '/app/data/upstream_requests.log';
const UPSTREAM_SSE_CAPTURE_ENABLED = (() => {
    const raw = process.env.UPSTREAM_SSE_CAPTURE;
    if (raw === undefined || raw === null || raw === '') return false;
    const v = String(raw).trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(v);
})();
const UPSTREAM_SSE_CAPTURE_PATH = process.env.UPSTREAM_SSE_CAPTURE_PATH || '/app/data/upstream_sse.log';

function looksLikeGoogleAutomatedQueriesBlock(html) {
    const s = String(html || '');
    if (!s) return false;
    // Typical Google "Sorry..." HTML block page (bot detection / CAPTCHA required).
    return (
        s.includes('<title>Sorry...</title>') &&
        (s.includes('sending automated queries') || s.includes('support.google.com/websearch/answer/86640'))
    );
}

function captureUpstreamRequest(kind, url, request) {
    if (!UPSTREAM_REQUEST_CAPTURE_ENABLED) return;
    if (!request || typeof request !== 'object') return;
    try {
        const line = JSON.stringify({
            ts: Date.now(),
            kind: kind || null,
            url: url || null,
            requestId: request.requestId || null,
            model: request.model || null,
            requestType: request.requestType || null,
            body: request
        });
        fs.appendFile(UPSTREAM_REQUEST_CAPTURE_PATH, line + '\n', () => {});
    } catch {
        // ignore capture failures
    }
}

function captureUpstreamSse(requestId, payload) {
    if (!UPSTREAM_SSE_CAPTURE_ENABLED) return;
    if (!payload) return;
    try {
        const line = JSON.stringify({
            ts: Date.now(),
            requestId: requestId || null,
            payload: String(payload)
        });
        fs.appendFile(UPSTREAM_SSE_CAPTURE_PATH, line + '\n', () => {});
    } catch {
        // ignore capture failures
    }
}

/**
 * 流式聊天请求
 * @param {Object} account - 账号信息（包含 access_token）
 * @param {Object} request - Antigravity 格式的请求体
 * @param {Function} onData - 数据回调
 * @param {Function} onError - 错误回调
 * @param {AbortSignal} signal - 取消信号
 */
export async function streamChat(account, request, onData, onError, signal = null) {
    const url = `${BASE_URL}/v1internal:streamGenerateContent?alt=sse`;

    try {
        captureUpstreamRequest('stream', url, request);
        const response = await fingerprintStreamFetch(url, {
            method: 'POST',
            headers: {
                'Host': API_HOST,
                'User-Agent': ANTIGRAVITY_CONFIG.user_agent,
                'Transfer-Encoding': 'chunked',
                'Authorization': `Bearer ${account.access_token}`,
                'Content-Type': 'application/json',
                'Accept-Encoding': 'gzip'
            },
            body: JSON.stringify(request),
            signal
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorMessage = `API Error: ${response.status}`;
            let parsed = null;

            try {
                const errorJson = JSON.parse(errorText);
                parsed = errorJson;
                errorMessage = errorJson.error?.message || errorMessage;
            } catch {
                if (looksLikeGoogleAutomatedQueriesBlock(errorText)) {
                    errorMessage = `Upstream blocked automated requests (Google "Sorry" page). ` +
                        `This is usually triggered by your outbound IP / network being flagged or rate-limited. ` +
                        `Try waiting, reducing request rate, or configuring OUTBOUND_PROXY/HTTP_PROXY. ` +
                        `Upstream status: ${response.status}.`;
                } else {
                    errorMessage = errorText || errorMessage;
                }
            }

            const err = new Error(errorMessage);
            err.upstreamStatus = response.status;
            if (parsed) err.upstreamJson = parsed;
            err.upstreamBody = errorText;
            throw err;
        }

        // 处理 SSE 流（按 SSE 事件边界聚合 data 行，兼容多行 data / data: 前缀无空格）
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let eventDataLines = [];
        let firstChunkChecked = false;

        const handleData = (data) => {
            const payload = String(data ?? '').trim();
            if (!payload || payload === '[DONE]') return;
            captureUpstreamSse(request?.requestId, payload);

            // 上游可能在 SSE 中返回结构化错误/安全拦截信息（HTTP 200 但无 candidates）
            // 这种情况下，如果我们不处理，客户端会看到“空回复且不报错”
            try {
                const parsed = JSON.parse(payload);
                const upstreamError = parsed?.error;
                const promptFeedback = parsed?.response?.promptFeedback;
                const blockReason = promptFeedback?.blockReason || promptFeedback?.blockReasonMessage;

                if (upstreamError?.message) {
                    const err = new Error(upstreamError.message);
                    const code = Number(upstreamError?.code);
                    if (Number.isFinite(code)) err.upstreamStatus = code;
                    err.upstreamJson = parsed;
                    err.upstreamBody = payload;
                    throw err;
                }
                if (blockReason) {
                    throw new Error(`Upstream blocked request: ${blockReason}`);
                }
            } catch (e) {
                // JSON.parse 失败：忽略（走 onData）
                // JSON.parse 成功但 throw：会被外层 catch 捕获并走 onError
                if (e instanceof SyntaxError) {
                    // ignore
                } else if (e instanceof Error) {
                    throw e;
                }
            }

            try {
                onData(payload);
            } catch {
                // ignore
            }
        };

        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            const chunk = decoder.decode(value, { stream: true });

            // 首 chunk 检测版本过期（上游返回 200 OK + 纯文本提示）
            if (!firstChunkChecked) {
                firstChunkChecked = true;
                if (isVersionOutdatedText(chunk)) {
                    reader.cancel().catch(() => {});
                    await refreshVersion();
                    const err = new Error(chunk.trim());
                    err.versionOutdated = true;
                    throw err;
                }
            }

            buffer += chunk;

            // 按行处理
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (let line of lines) {
                if (line.endsWith('\r')) line = line.slice(0, -1);

                // 空行表示一个 SSE event 结束
                if (line === '') {
                    if (eventDataLines.length > 0) {
                        handleData(eventDataLines.join('\n'));
                        eventDataLines = [];
                    }
                    continue;
                }

                if (line.startsWith('data:')) {
                    eventDataLines.push(line.slice(5).trimStart());
                }
            }
        }

        // 处理剩余的 buffer（以及最后一个未被空行终止的 event）
        if (buffer) {
            const lastLine = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
            if (lastLine.startsWith('data:')) {
                eventDataLines.push(lastLine.slice(5).trimStart());
            }
        }
        if (eventDataLines.length > 0) {
            handleData(eventDataLines.join('\n'));
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            return;
        }

        if (onError) {
            onError(error);
            // 流式场景下：回调已向客户端写入错误事件/chunk，这里不再抛出，避免外层重复响应
            return;
        }
        throw error;
    }
}

/**
 * 伪非流式：通过流式端点收集数据，组装成非流式响应
 * 用于上游已关闭非流式端点的模型（Claude、Gemini 3 Pro）
 */
async function streamChatCollect(account, request) {
    const chunks = [];
    let streamError = null;

    await streamChat(
        account,
        request,
        (data) => {
            try {
                const parsed = JSON.parse(data);
                chunks.push(parsed);
            } catch {
                // ignore parse errors
            }
        },
        (error) => {
            streamError = error;
        }
    );

    if (streamError) {
        throw streamError;
    }

    if (chunks.length === 0) {
        throw new Error('Upstream returned empty response (no chunks)');
    }

    // 合并所有 chunks 成一个完整的非流式响应
    // 上游 SSE 格式: { response: { candidates: [...], usageMetadata: {...} } }
    // part 格式: { thought: true/false, text: "content" } 或 { text: "content" } 或 { functionCall: {...} }
    const mergedParts = [];
    let finalUsageMetadata = null;
    let finalFinishReason = null;
    let finalCandidate = null;

    const extractSig = (part) => {
        if (!part || typeof part !== 'object') return null;
        const sig = part.thoughtSignature || part.thought_signature || part.signature;
        return typeof sig === 'string' && sig ? sig : null;
    };

    for (const chunk of chunks) {
        const candidate = chunk?.response?.candidates?.[0];
        if (candidate) {
            finalCandidate = candidate;
            const parts = candidate?.content?.parts;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    const isThinking = !!part.thought;

                    if (part.text !== undefined) {
                        // 查找同类型的 part（thinking 或非 thinking）来追加
                        const lastPart = mergedParts[mergedParts.length - 1];
                        const lastIsThinking = lastPart && !!lastPart.thought;

                        if (lastPart && lastPart.text !== undefined && isThinking === lastIsThinking) {
                            // 同类型，追加文本
                            lastPart.text += part.text;
                            // Preserve/refresh thoughtSignature if it arrives late in the stream.
                            const sig = extractSig(part);
                            if (sig) {
                                if ('thoughtSignature' in lastPart) lastPart.thoughtSignature = sig;
                                else if ('thought_signature' in lastPart) lastPart.thought_signature = sig;
                                else if ('signature' in lastPart) lastPart.signature = sig;
                                else lastPart.thoughtSignature = sig;
                            }
                        } else {
                            // 不同类型或第一个，创建新 part
                            mergedParts.push({ ...part });
                        }
                    } else if (part.functionCall) {
                        // functionCall 直接添加
                        mergedParts.push({ ...part });
                    } else if (part.inlineData) {
                        // inlineData 直接添加
                        mergedParts.push({ ...part });
                    }
                }
            }
            if (candidate.finishReason) {
                finalFinishReason = candidate.finishReason;
            }
        }
        // 使用最后一个 chunk 的 usageMetadata
        if (chunk?.response?.usageMetadata) {
            finalUsageMetadata = chunk.response.usageMetadata;
        }
    }

    // 过滤掉空的 text parts（保留有内容的 text、thought、functionCall 等）
    const filteredParts = mergedParts.filter(p => {
        // 保留非 text 类型的 parts
        if (p.functionCall || p.inlineData) return true;
        // 保留 thinking parts（即使 text 为空）
        if (p.thought) return true;
        // 只保留有内容的 text parts
        if (p.text !== undefined) return p.text !== '';
        return true;
    });

    // 组装成与原生非流式响应相同的格式
    return {
        response: {
            candidates: [{
                content: {
                    parts: filteredParts.length > 0 ? filteredParts : mergedParts,
                    role: finalCandidate?.content?.role || 'model'
                },
                finishReason: finalFinishReason || 'STOP',
                ...(finalCandidate?.groundingMetadata && { groundingMetadata: finalCandidate.groundingMetadata })
            }],
            usageMetadata: finalUsageMetadata || {},
            modelVersion: chunks[0]?.response?.modelVersion
        }
    };
}

/**
 * 非流式聊天请求
 * 对于上游已关闭非流式端点的模型（Claude、Gemini 3 Pro），自动使用伪非流式
 */
export async function chat(account, request) {
    // 检查是否需要伪非流式
    const model = request?.request?.model || request?.model || '';
    if (needsFakeNonStreaming(model)) {
        return streamChatCollect(account, request);
    }

    // 原生非流式请求
    const url = `${BASE_URL}/v1internal:generateContent`;

    captureUpstreamRequest('chat', url, request);
    const response = await fingerprintFetch(url, {
        method: 'POST',
        headers: {
            'Host': API_HOST,
            'User-Agent': ANTIGRAVITY_CONFIG.user_agent,
            'Authorization': `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip'
        },
        body: JSON.stringify(request)
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `API Error: ${response.status}`;
        let parsed = null;

        try {
            const errorJson = JSON.parse(errorText);
            parsed = errorJson;
            errorMessage = errorJson.error?.message || errorMessage;
        } catch {
            if (looksLikeGoogleAutomatedQueriesBlock(errorText)) {
                errorMessage = `Upstream blocked automated requests (Google "Sorry" page). ` +
                    `This is usually triggered by your outbound IP / network being flagged or rate-limited. ` +
                    `Try waiting, reducing request rate, or configuring OUTBOUND_PROXY/HTTP_PROXY. ` +
                    `Upstream status: ${response.status}.`;
            } else {
                errorMessage = errorText || errorMessage;
            }
        }

        const err = new Error(errorMessage);
        err.upstreamStatus = response.status;
        if (parsed) err.upstreamJson = parsed;
        err.upstreamBody = errorText;
        throw err;
    }

    const text = await response.text();

    // 检测版本过期（上游返回 200 OK + 纯文本提示）
    if (isVersionOutdatedText(text)) {
        await refreshVersion();
        const err = new Error(text.trim());
        err.versionOutdated = true;
        throw err;
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`Unexpected response format: ${text.slice(0, 200)}`);
    }

    const upstreamError = data?.error || data?.response?.error;
    if (upstreamError) {
        const message = upstreamError?.message || upstreamError?.error?.message || JSON.stringify(upstreamError);
        const err = new Error(message || 'Upstream returned an error');
        err.upstreamStatus = response.status;
        err.upstreamJson = upstreamError;
        err.upstreamBody = text;
        throw err;
    }
    return data;
}

/**
 * 计算 tokens（v1internal:countTokens）
 * @param {Object} account - 账号信息（包含 access_token）
 * @param {Object} request - countTokens 请求体（通常为 { request: { model, contents } }）
 */
export async function countTokens(account, request) {
    const url = `${BASE_URL}/v1internal:countTokens`;

    captureUpstreamRequest('countTokens', url, request);
    const response = await fingerprintFetch(url, {
        method: 'POST',
        headers: {
            'Host': API_HOST,
            'User-Agent': ANTIGRAVITY_CONFIG.user_agent,
            'Authorization': `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip'
        },
        body: JSON.stringify(request)
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `API Error: ${response.status}`;
        let parsed = null;

        try {
            const errorJson = JSON.parse(errorText);
            parsed = errorJson;
            errorMessage = errorJson.error?.message || errorMessage;
        } catch {
            if (looksLikeGoogleAutomatedQueriesBlock(errorText)) {
                errorMessage = `Upstream blocked automated requests (Google "Sorry" page). ` +
                    `This is usually triggered by your outbound IP / network being flagged or rate-limited. ` +
                    `Try waiting, reducing request rate, or configuring OUTBOUND_PROXY/HTTP_PROXY. ` +
                    `Upstream status: ${response.status}.`;
            } else {
                errorMessage = errorText || errorMessage;
            }
        }

        const err = new Error(errorMessage);
        err.upstreamStatus = response.status;
        if (parsed) err.upstreamJson = parsed;
        err.upstreamBody = errorText;
        throw err;
    }

    return response.json();
}

/**
 * 获取可用模型列表
 */
export async function fetchAvailableModels(account) {
    const url = `${BASE_URL}/v1internal:fetchAvailableModels`;

    const response = await fingerprintFetch(url, {
        method: 'POST',
        headers: {
            'Host': API_HOST,
            'User-Agent': ANTIGRAVITY_CONFIG.user_agent,
            'Authorization': `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip'
        },
        body: JSON.stringify({
            project: account.project_id || ''
        })
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
    }

    return response.json();
}

/**
 * 加载 Code Assist 信息（获取 projectId）
 */
export async function loadCodeAssist(account) {
    const url = `${BASE_URL}/v1internal:loadCodeAssist`;

    const response = await fingerprintFetch(url, {
        method: 'POST',
        headers: {
            'Host': API_HOST,
            'User-Agent': ANTIGRAVITY_CONFIG.user_agent,
            'Authorization': `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip'
        },
        body: JSON.stringify({
            metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
        })
    });

    if (!response.ok) {
        throw new Error(`Failed to load code assist: ${response.status}`);
    }

    return response.json();
}
