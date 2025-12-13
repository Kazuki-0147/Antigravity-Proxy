import { ANTIGRAVITY_CONFIG } from '../config.js';

const BASE_URL = ANTIGRAVITY_CONFIG.base_url;
const USER_AGENT = ANTIGRAVITY_CONFIG.user_agent;

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
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${account.access_token}`,
                'Content-Type': 'application/json',
                'User-Agent': USER_AGENT,
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify(request),
            signal
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorMessage = `API Error: ${response.status}`;

            try {
                const errorJson = JSON.parse(errorText);
                errorMessage = errorJson.error?.message || errorMessage;
            } catch {
                errorMessage = errorText || errorMessage;
            }

            throw new Error(errorMessage);
        }

        // 处理 SSE 流
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            // 按行处理
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data && data !== '[DONE]') {
                        // 上游可能在 SSE 中返回结构化错误/安全拦截信息（HTTP 200 但无 candidates）
                        // 这种情况下，如果我们不处理，客户端会看到“空回复且不报错”
                        try {
                            const parsed = JSON.parse(data);
                            const upstreamError = parsed?.error;
                            const promptFeedback = parsed?.response?.promptFeedback;
                            const blockReason = promptFeedback?.blockReason || promptFeedback?.blockReasonMessage;

                            if (upstreamError?.message) {
                                throw new Error(upstreamError.message);
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
                            onData(data);
                        } catch {
                            // ignore
                        }
                    }
                }
            }
        }

        // 处理剩余的 buffer
        if (buffer.startsWith('data: ')) {
            const data = buffer.slice(6).trim();
            if (data && data !== '[DONE]') {
                onData(data);
            }
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
 * 非流式聊天请求
 */
export async function chat(account, request) {
    const url = `${BASE_URL}/v1internal:generateContent`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT
        },
        body: JSON.stringify(request)
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `API Error: ${response.status}`;

        try {
            const errorJson = JSON.parse(errorText);
            errorMessage = errorJson.error?.message || errorMessage;
        } catch {
            errorMessage = errorText || errorMessage;
        }

        throw new Error(errorMessage);
    }

    return response.json();
}

/**
 * 获取可用模型列表
 */
export async function fetchAvailableModels(account) {
    const url = `${BASE_URL}/v1internal:fetchAvailableModels`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT
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

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT
        },
        body: JSON.stringify({
            metadata: { ideType: 'ANTIGRAVITY' }
        })
    });

    if (!response.ok) {
        throw new Error(`Failed to load code assist: ${response.status}`);
    }

    return response.json();
}
