import { v4 as uuidv4 } from 'uuid';
import { getMappedModel, isThinkingModel, AVAILABLE_MODELS } from '../config.js';

// 默认思考预算
const DEFAULT_THINKING_BUDGET = 4096;
const DEFAULT_TEMPERATURE = 1;

/**
 * OpenAI 请求 → Antigravity 请求转换
 * @param {Object} openaiRequest - OpenAI 格式的请求
 * @param {string} projectId - 账号的 project_id
 * @param {string} sessionId - 可选的会话 ID
 */
export function convertOpenAIToAntigravity(openaiRequest, projectId = '', sessionId = null) {
    const {
        model,
        messages,
        temperature,
        top_p,
        max_tokens,
        stream,
        tools,
        tool_choice,
        stop,
        // 扩展参数：自定义思考预算
        thinking_budget,
        budget_tokens  // 兼容另一种命名
    } = openaiRequest;

    // 提取 system 消息
    const systemMessages = messages.filter(m => m.role === 'system');
    const systemContent = systemMessages.map(m =>
        typeof m.content === 'string' ? m.content : m.content.map(c => c.text || '').join('\n')
    ).join('\n');

    // 转换对话消息（排除 system），合并连续的工具结果
    const contents = [];
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    for (let i = 0; i < nonSystemMessages.length; i++) {
        const msg = nonSystemMessages[i];

        // 如果是工具结果，收集所有连续的工具结果合并为一条消息
        if (msg.role === 'tool') {
            const toolParts = [];
            while (i < nonSystemMessages.length && nonSystemMessages[i].role === 'tool') {
                const toolMsg = nonSystemMessages[i];
                toolParts.push({
                    functionResponse: {
                        id: toolMsg.tool_call_id,
                        name: toolMsg.name || 'unknown',
                        response: {
                            output: typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content)
                        }
                    }
                });
                i++;
            }
            i--; // 回退一步，因为外层循环会 i++
            contents.push({ role: 'user', parts: toolParts });
        } else {
            contents.push(convertMessage(msg));
        }
    }

    // 获取实际模型名称
    const actualModel = getMappedModel(model);

    // 检查是否有工具定义或历史消息中有工具调用
    const hasTools = tools && tools.length > 0;
    const hasToolCallsInHistory = nonSystemMessages.some(msg =>
        msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0
    );
    const hasToolResultsInHistory = nonSystemMessages.some(msg =>
        msg.role === 'tool'
    );

    // 如果有工具相关内容，禁用 thinking（因为 thinking 块需要签名，无法伪造）
    let enableThinking = isThinkingModel(model);
    if (enableThinking && (hasTools || hasToolCallsInHistory || hasToolResultsInHistory)) {
        enableThinking = false;
    }

    // 检查是否是 Claude 模型（Claude 不支持 topP）
    const isClaudeModel = model.includes('claude');

    // 获取思考预算（优先使用 thinking_budget，其次 budget_tokens，最后默认值）
    const thinkingBudget = thinking_budget ?? budget_tokens ?? DEFAULT_THINKING_BUDGET;

    // 构建 generationConfig
    const generationConfig = {
        temperature: temperature ?? DEFAULT_TEMPERATURE,
        maxOutputTokens: max_tokens || 8192,
        candidateCount: 1
    };

    // Claude 模型不支持 topP
    if (!isClaudeModel && top_p !== undefined) {
        generationConfig.topP = top_p;
    }

    // 停止序列
    if (stop) {
        generationConfig.stopSequences = Array.isArray(stop) ? stop : [stop];
    }

    // 思维链配置
    if (enableThinking) {
        generationConfig.thinkingConfig = {
            includeThoughts: true,
            thinkingBudget: thinkingBudget
        };
        // Claude thinking 模型需要 maxOutputTokens > thinkingBudget
        if (isClaudeModel && generationConfig.maxOutputTokens <= thinkingBudget) {
            generationConfig.maxOutputTokens = thinkingBudget * 2;
        }
    } else if (isClaudeModel) {
        // Claude 非 thinking 模型设置 thinkingBudget = 0
        generationConfig.thinkingConfig = {
            includeThoughts: false,
            thinkingBudget: 0
        };
    }

    // 构建请求体
    const request = {
        project: projectId || '',
        requestId: `agent-${uuidv4()}`,
        request: {
            contents,
            generationConfig,
            sessionId: sessionId || generateSessionId()
        },
        model: actualModel,
        userAgent: 'antigravity',
        requestType: 'agent'
    };

    // 添加系统指令
    if (systemContent) {
        request.request.systemInstruction = {
            role: 'user',
            parts: [{ text: systemContent }]
        };
    }

    // 添加工具定义
    if (tools && tools.length > 0) {
        request.request.tools = [{ functionDeclarations: tools.map(convertTool) }];
        request.request.toolConfig = {
            functionCallingConfig: {
                mode: tool_choice === 'none' ? 'NONE' :
                      tool_choice === 'auto' ? 'AUTO' : 'VALIDATED'
            }
        };
    }

    return request;
}

/**
 * 转换单条消息
 */
function convertMessage(msg) {
    const role = msg.role === 'assistant' ? 'model' : 'user';

    // 处理工具调用结果
    if (msg.role === 'tool') {
        return {
            role: 'user',
            parts: [{
                functionResponse: {
                    id: msg.tool_call_id,
                    name: msg.name || 'unknown',
                    response: {
                        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                    }
                }
            }]
        };
    }

    // 处理 assistant 的工具调用
    if (msg.role === 'assistant' && msg.tool_calls) {
        const parts = [];

        // 如果有文本内容
        if (msg.content) {
            parts.push({ text: msg.content });
        }

        // 添加工具调用
        for (const toolCall of msg.tool_calls) {
            parts.push({
                functionCall: {
                    id: toolCall.id,
                    name: toolCall.function.name,
                    args: JSON.parse(toolCall.function.arguments || '{}')
                }
            });
        }

        return { role: 'model', parts };
    }

    // 简单文本消息
    if (typeof msg.content === 'string') {
        return {
            role,
            parts: [{ text: msg.content }]
        };
    }

    // 多模态消息（数组格式）
    if (Array.isArray(msg.content)) {
        const parts = msg.content.map(item => {
            if (item.type === 'text') {
                return { text: item.text };
            }
            if (item.type === 'image_url') {
                const { mimeType, data } = parseDataUrl(item.image_url.url);
                return {
                    inlineData: {
                        mimeType,
                        data
                    }
                };
            }
            return null;
        }).filter(Boolean);

        return { role, parts };
    }

    // 默认
    return {
        role,
        parts: [{ text: String(msg.content || '') }]
    };
}

/**
 * 转换工具定义
 */
function convertTool(tool) {
    const func = tool.function || tool;

    return {
        name: func.name,
        description: func.description || '',
        parameters: convertJsonSchema(func.parameters)
    };
}

/**
 * 转换 JSON Schema（移除不支持的字段，可选转换类型为大写）
 * @param {Object} schema - JSON Schema 对象
 * @param {boolean} uppercaseTypes - 是否将类型转为大写（Gemini 需要大写，Claude 需要小写）
 */
function convertJsonSchema(schema, uppercaseTypes = true) {
    if (!schema) return undefined;

    const converted = { ...schema };

    // 移除不支持的字段
    delete converted.$schema;
    delete converted.additionalProperties;
    delete converted.default;
    delete converted.minLength;
    delete converted.maxLength;
    delete converted.minimum;
    delete converted.maximum;
    delete converted.minItems;
    delete converted.maxItems;
    delete converted.pattern;
    delete converted.format;
    delete converted.uniqueItems;
    delete converted.exclusiveMinimum;
    delete converted.exclusiveMaximum;

    if (converted.type && uppercaseTypes) {
        converted.type = converted.type.toUpperCase();
    }

    if (converted.properties) {
        converted.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            converted.properties[key] = convertJsonSchema(value, uppercaseTypes);
        }
    }

    if (converted.items) {
        converted.items = convertJsonSchema(schema.items, uppercaseTypes);
    }

    return converted;
}

/**
 * 解析 data URL
 */
function parseDataUrl(url) {
    // 支持直接的 base64 数据或 data URL
    if (url.startsWith('data:')) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
            return {
                mimeType: match[1],
                data: match[2]
            };
        }
    }

    // 假设是纯 base64 PNG
    return {
        mimeType: 'image/png',
        data: url
    };
}

/**
 * 生成 sessionId
 */
function generateSessionId() {
    return String(-Math.floor(Math.random() * 9e18));
}

// ==================== 响应转换 ====================

// 用于跟踪思维链状态的全局变量
const thinkingState = new Map();

/**
 * Antigravity 流式响应 → OpenAI 流式响应
 */
export function convertSSEChunk(antigravityData, requestId, model, includeThinking = false) {
    try {
        const data = JSON.parse(antigravityData);
        const candidate = data.response?.candidates?.[0];

        if (!candidate) {
            return null;
        }

        const chunks = [];
        const stateKey = requestId;
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];

        for (const part of parts) {
            // 处理思维链内容
            if (part.thought) {
                if (includeThinking) {
                    // 检查是否是思维链的开始
                    const wasThinking = thinkingState.get(stateKey);
                    let content = part.text;

                    if (!wasThinking) {
                        // 思维链开始，添加开始标签
                        content = '<think>' + content;
                        thinkingState.set(stateKey, true);
                    }

                    chunks.push({
                        id: `chatcmpl-${requestId}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [{
                            index: 0,
                            delta: {
                                content: content
                            },
                            finish_reason: null
                        }]
                    });
                }
                continue;
            }

            // 如果之前在思维链中，现在遇到非思维内容，添加结束标签
            if (thinkingState.get(stateKey) && (part.text !== undefined || part.functionCall || part.inlineData)) {
                chunks.push({
                    id: `chatcmpl-${requestId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        delta: {
                            content: '</think>'
                        },
                        finish_reason: null
                    }]
                });
                thinkingState.delete(stateKey);
            }

            // 处理工具调用
            if (part.functionCall) {
                chunks.push({
                    id: `chatcmpl-${requestId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: 0,
                                id: part.functionCall.id || `call_${uuidv4().slice(0, 8)}`,
                                type: 'function',
                                function: {
                                    name: part.functionCall.name,
                                    arguments: JSON.stringify(part.functionCall.args || {})
                                }
                            }]
                        },
                        finish_reason: null
                    }]
                });
                continue;
            }

            // 处理普通文本
            if (part.text !== undefined) {
                chunks.push({
                    id: `chatcmpl-${requestId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        delta: {
                            content: part.text
                        },
                        finish_reason: null
                    }]
                });
            }

            // 处理图片输出
            if (part.inlineData) {
                // 将图片作为 base64 data URL 返回
                const dataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                chunks.push({
                    id: `chatcmpl-${requestId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        delta: {
                            content: `![image](${dataUrl})`
                        },
                        finish_reason: null
                    }]
                });
            }
        }

        // 处理结束标志
        if (candidate.finishReason === 'STOP' || candidate.finishReason === 'MAX_TOKENS') {
            // 如果还在思维链中，先关闭标签
            if (thinkingState.get(stateKey)) {
                chunks.push({
                    id: `chatcmpl-${requestId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        delta: {
                            content: '</think>'
                        },
                        finish_reason: null
                    }]
                });
                thinkingState.delete(stateKey);
            }

            chunks.push({
                id: `chatcmpl-${requestId}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: candidate.finishReason === 'STOP' ? 'stop' : 'length'
                }]
            });
        }

        return chunks;
    } catch (error) {
        return null;
    }
}

/**
 * Antigravity 非流式响应 → OpenAI 响应
 */
export function convertResponse(antigravityResponse, requestId, model, includeThinking = false) {
    try {
        const data = antigravityResponse;
        const candidate = data.response?.candidates?.[0];
        const usage = data.response?.usageMetadata;

        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];

        // 提取文本内容
        let content = '';
        const toolCalls = [];

        for (const part of parts) {
            // 处理思维链
            if (part.thought) {
                if (includeThinking) {
                    content += `<think>${part.text}</think>`;
                }
                continue;
            }

            if (part.text) {
                content += part.text;
            }

            if (part.functionCall) {
                toolCalls.push({
                    id: part.functionCall.id || `call_${uuidv4().slice(0, 8)}`,
                    type: 'function',
                    function: {
                        name: part.functionCall.name,
                        arguments: JSON.stringify(part.functionCall.args || {})
                    }
                });
            }

            if (part.inlineData) {
                const dataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                content += `![image](${dataUrl})`;
            }
        }

        const message = {
            role: 'assistant',
            content: content
        };

        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }

        return {
            id: `chatcmpl-${requestId}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message,
                finish_reason: candidate.finishReason === 'STOP' ? 'stop' : 'length'
            }],
            usage: {
                prompt_tokens: usage?.promptTokenCount || 0,
                completion_tokens: usage?.candidatesTokenCount || 0,
                total_tokens: usage?.totalTokenCount || 0
            }
        };
    } catch (error) {
        throw error;
    }
}

/**
 * 从 Antigravity 响应中提取 usage 信息
 */
export function extractUsageFromSSE(antigravityData) {
    try {
        const data = JSON.parse(antigravityData);
        const usage = data.response?.usageMetadata;

        if (usage) {
            return {
                promptTokens: usage.promptTokenCount || 0,
                completionTokens: usage.candidatesTokenCount || 0,
                totalTokens: usage.totalTokenCount || 0,
                thinkingTokens: usage.thoughtsTokenCount || 0
            };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * 获取模型列表（OpenAI 格式）
 */
export function getModelsList() {
    return {
        object: 'list',
        data: AVAILABLE_MODELS.map(m => ({
            id: m.id,
            object: 'model',
            created: 1700000000,
            owned_by: m.provider
        }))
    };
}

// ==================== Anthropic 格式转换 ====================

/**
 * Anthropic 请求 → Antigravity 请求转换
 * 这个函数保留 thinking 块信息，解决 Claude extended thinking + tools 的兼容问题
 */
export function convertAnthropicToAntigravity(anthropicRequest, projectId = '', sessionId = null) {
    const {
        model,
        messages,
        system,
        temperature,
        top_p,
        max_tokens,
        stream,
        tools,
        tool_choice,
        stop_sequences,
        thinking
    } = anthropicRequest;

    // 检测 thinking 模式 - 显式启用或根据模型名自动启用
    // 如果明确设置了 thinking.type，使用该设置；否则根据模型名判断
    const thinkingEnabled = thinking?.type === 'enabled' ||
        (thinking?.type !== 'disabled' && isThinkingModel(model));
    const thinkingBudget = thinking?.budget_tokens || DEFAULT_THINKING_BUDGET;

    // 获取实际模型名称
    const actualModel = getMappedModel(model);
    const isClaudeModel = model.includes('claude');

    // 转换消息
    const contents = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        // 处理 tool_result 消息（Anthropic 的工具返回格式）
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            const toolResults = msg.content.filter(c => c.type === 'tool_result');
            if (toolResults.length > 0) {
                const parts = toolResults.map(tr => ({
                    functionResponse: {
                        id: tr.tool_use_id,
                        name: tr.name || 'unknown',
                        response: {
                            output: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content)
                        }
                    }
                }));
                contents.push({ role: 'user', parts });
                continue;
            }
        }

        contents.push(convertAnthropicMessage(msg, thinkingEnabled));
    }

    // 构建 generationConfig
    const generationConfig = {
        temperature: temperature ?? DEFAULT_TEMPERATURE,
        maxOutputTokens: max_tokens || 8192,
        candidateCount: 1
    };

    // Claude 模型不支持 topP
    if (!isClaudeModel && top_p !== undefined) {
        generationConfig.topP = top_p;
    }

    // 停止序列
    if (stop_sequences && stop_sequences.length > 0) {
        generationConfig.stopSequences = stop_sequences;
    }

    // 思维链配置 - 始终启用（如果请求中启用了）
    if (thinkingEnabled) {
        generationConfig.thinkingConfig = {
            includeThoughts: true,
            thinkingBudget: thinkingBudget
        };
        // Claude thinking 模型需要 maxOutputTokens > thinkingBudget
        if (isClaudeModel && generationConfig.maxOutputTokens <= thinkingBudget) {
            generationConfig.maxOutputTokens = thinkingBudget * 2;
        }
    } else if (isClaudeModel) {
        generationConfig.thinkingConfig = {
            includeThoughts: false,
            thinkingBudget: 0
        };
    }

    // 构建请求体
    const request = {
        project: projectId || '',
        requestId: `agent-${uuidv4()}`,
        request: {
            contents,
            generationConfig,
            sessionId: sessionId || generateSessionId()
        },
        model: actualModel,
        userAgent: 'antigravity',
        requestType: 'agent'
    };

    // 添加系统指令
    if (system) {
        const systemContent = typeof system === 'string' ? system :
            system.map(s => s.text || '').join('\n');
        request.request.systemInstruction = {
            role: 'user',
            parts: [{ text: systemContent }]
        };
    }

    // 添加工具定义
    if (tools && tools.length > 0) {
        // 过滤掉 Anthropic 内置工具（如 web_search, computer_use 等）
        // 内置工具有 type 字段（如 "web_search_20250305"），普通函数工具有 input_schema
        const functionTools = tools.filter(t => {
            // 内置工具有 type 字段且以特定前缀开头
            if (t.type && (t.type.startsWith('web_search') ||
                          t.type.startsWith('computer') ||
                          t.type.startsWith('text_editor') ||
                          t.type.startsWith('bash'))) {
                return false;
            }
            return true;
        });

        if (functionTools.length > 0) {
            request.request.tools = [{ functionDeclarations: functionTools.map(t => convertAnthropicTool(t, isClaudeModel)) }];

            let toolMode = 'AUTO';
            if (tool_choice) {
                if (tool_choice.type === 'none' || tool_choice === 'none') {
                    toolMode = 'NONE';
                } else if (tool_choice.type === 'any' || tool_choice === 'any') {
                    toolMode = 'ANY';
                } else if (tool_choice.type === 'auto' || tool_choice === 'auto') {
                    toolMode = 'AUTO';
                }
            }

            request.request.toolConfig = {
                functionCallingConfig: { mode: toolMode }
            };
        }
    }

    return request;
}

/**
 * 转换 Anthropic 格式的单条消息
 */
function convertAnthropicMessage(msg, thinkingEnabled = false) {
    const role = msg.role === 'assistant' ? 'model' : 'user';

    // 简单文本消息
    if (typeof msg.content === 'string') {
        return {
            role,
            parts: [{ text: msg.content }]
        };
    }

    // 复杂消息（数组格式）
    if (Array.isArray(msg.content)) {
        const regularParts = [];
        const functionCallParts = [];

        for (const item of msg.content) {
            // 处理 thinking 块 - 保留为 thought 部分
            if (item.type === 'thinking') {
                regularParts.push({
                    text: item.thinking,
                    thought: true
                });
                continue;
            }

            // 处理 redacted_thinking 块 - 直接跳过，不发送给 Antigravity
            // 原因：Antigravity 会把 thought:true 的部分转换为 thinking 块发送给 Claude，
            // 但 Claude API 要求 thinking 块必须有 signature，而我们无法提供
            if (item.type === 'redacted_thinking') {
                // 跳过 redacted_thinking，不添加到 parts 中
                continue;
            }

            // 处理文本
            if (item.type === 'text') {
                regularParts.push({ text: item.text });
                continue;
            }

            // 处理工具调用 - 放到单独的数组，最后添加
            if (item.type === 'tool_use') {
                functionCallParts.push({
                    functionCall: {
                        id: item.id,
                        name: item.name,
                        args: item.input || {}
                    }
                });
                continue;
            }

            // 处理工具结果
            if (item.type === 'tool_result') {
                regularParts.push({
                    functionResponse: {
                        id: item.tool_use_id,
                        name: item.name || 'unknown',
                        response: {
                            output: typeof item.content === 'string' ? item.content : JSON.stringify(item.content)
                        }
                    }
                });
                continue;
            }

            // 处理图片
            if (item.type === 'image') {
                if (item.source?.type === 'base64') {
                    regularParts.push({
                        inlineData: {
                            mimeType: item.source.media_type,
                            data: item.source.data
                        }
                    });
                }
                continue;
            }
        }

        // 注意：不再添加 thought:true 占位符，因为这会导致 Antigravity 创建 thinking 块
        // 而 Claude API 要求 thinking 块必须有 signature

        // functionCall 必须放在消息的最后，否则会导致 tool_use/tool_result 验证失败
        const parts = [...regularParts, ...functionCallParts];

        return { role, parts };
    }

    // 默认
    return {
        role,
        parts: [{ text: String(msg.content || '') }]
    };
}

/**
 * 转换 Anthropic 工具定义
 * @param {Object} tool - Anthropic 格式的工具定义
 * @param {boolean} isClaudeModel - 是否是 Claude 模型
 */
function convertAnthropicTool(tool, isClaudeModel = false) {
    return {
        name: tool.name,
        description: tool.description || '',
        // Claude 模型不需要大写类型，Gemini 需要
        parameters: convertJsonSchema(tool.input_schema, !isClaudeModel)
    };
}

/**
 * Antigravity 响应 → Anthropic 响应转换
 */
export function convertAntigravityToAnthropic(antigravityResponse, requestId, model, thinkingEnabled = false) {
    try {
        const data = antigravityResponse;
        const candidate = data.response?.candidates?.[0];
        const usage = data.response?.usageMetadata;

        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];

        const content = [];
        let thinkingText = '';
        let hasThinking = false;

        for (const part of parts) {
            // 收集思维链内容
            if (part.thought) {
                hasThinking = true;
                thinkingText += part.text;
                continue;
            }

            // 如果之前有思维链内容，先输出
            if (thinkingText) {
                content.push({
                    type: 'thinking',
                    thinking: thinkingText,
                    // 注意：这里没有 signature，因为 Antigravity 没有保留它
                    // 客户端需要处理这种情况，或者使用 redacted_thinking
                });
                thinkingText = '';
            }

            // 处理文本
            if (part.text !== undefined) {
                content.push({
                    type: 'text',
                    text: part.text
                });
            }

            // 处理工具调用
            if (part.functionCall) {
                content.push({
                    type: 'tool_use',
                    id: part.functionCall.id || `toolu_${uuidv4().slice(0, 8)}`,
                    name: part.functionCall.name,
                    input: part.functionCall.args || {}
                });
            }

            // 处理图片
            if (part.inlineData) {
                content.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: part.inlineData.mimeType,
                        data: part.inlineData.data
                    }
                });
            }
        }

        // 处理剩余的思维链内容
        if (thinkingText) {
            content.unshift({
                type: 'thinking',
                thinking: thinkingText
            });
        }

        // 确定 stop_reason
        let stopReason = 'end_turn';
        const hasToolUse = content.some(c => c.type === 'tool_use');

        if (hasToolUse) {
            // 有工具调用时，stop_reason 应该是 tool_use
            stopReason = 'tool_use';
        } else if (candidate.finishReason === 'MAX_TOKENS') {
            stopReason = 'max_tokens';
        } else if (candidate.finishReason === 'STOP' || candidate.finishReason === 'OTHER') {
            stopReason = 'end_turn';
        }

        return {
            id: `msg_${requestId}`,
            type: 'message',
            role: 'assistant',
            model,
            content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
                input_tokens: usage?.promptTokenCount || 0,
                output_tokens: usage?.candidatesTokenCount || 0
            }
        };
    } catch (error) {
        throw error;
    }
}

/**
 * Antigravity 流式响应 → Anthropic 流式响应
 */
export function convertAntigravityToAnthropicSSE(antigravityData, requestId, model, state = {}) {
    try {
        const data = JSON.parse(antigravityData);
        const candidate = data.response?.candidates?.[0];
        const usage = data.response?.usageMetadata;

        if (!candidate) {
            return { events: [], state };
        }

        const events = [];
        let newState = { ...state };

        // 先分离 thinking 和非 thinking 的 parts
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        const thinkingParts = parts.filter(p => p.thought);
        const otherParts = parts.filter(p => !p.thought);

        // 先处理 thinking（确保 thinking 在前，index 0）
        for (const part of thinkingParts) {
            if (!newState.inThinking) {
                // thinking 始终是 index 0
                newState.thinkingIndex = 0;
                if (!newState.hasThinking) {
                    newState.hasThinking = true;
                    newState.nextIndex = 1; // 下一个块从 1 开始
                }
                newState.inThinking = true;

                events.push({
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                        type: 'thinking',
                        thinking: ''
                    }
                });
            }

            events.push({
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'thinking_delta',
                    thinking: part.text
                }
            });
        }

        // 处理其他 parts（text 和 functionCall）
        for (const part of otherParts) {
            // 如果之前在 thinking 中，现在不是了，关闭 thinking 块
            if (newState.inThinking) {
                events.push({
                    type: 'content_block_stop',
                    index: 0
                });
                newState.inThinking = false;
            }

            // 处理文本（跳过空文本）
            if (part.text !== undefined && part.text !== '') {
                if (!newState.inText) {
                    // text 的 index：如果有 thinking 则是 1，否则是 0
                    newState.textIndex = newState.hasThinking ? 1 : 0;
                    newState.nextIndex = newState.textIndex + 1;
                    newState.inText = true;

                    events.push({
                        type: 'content_block_start',
                        index: newState.textIndex,
                        content_block: {
                            type: 'text',
                            text: ''
                        }
                    });
                }

                events.push({
                    type: 'content_block_delta',
                    index: newState.textIndex,
                    delta: {
                        type: 'text_delta',
                        text: part.text
                    }
                });
            }

            // 处理工具调用
            if (part.functionCall) {
                newState.hasToolUse = true;
                const toolIndex = newState.nextIndex || (newState.hasThinking ? 1 : 0);
                newState.nextIndex = toolIndex + 1;

                events.push({
                    type: 'content_block_start',
                    index: toolIndex,
                    content_block: {
                        type: 'tool_use',
                        id: part.functionCall.id || `toolu_${uuidv4().slice(0, 8)}`,
                        name: part.functionCall.name,
                        input: {}
                    }
                });

                events.push({
                    type: 'content_block_delta',
                    index: toolIndex,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: JSON.stringify(part.functionCall.args || {})
                    }
                });

                events.push({
                    type: 'content_block_stop',
                    index: toolIndex
                });
            }
        }

        // 处理结束
        if (candidate.finishReason === 'STOP' || candidate.finishReason === 'MAX_TOKENS') {
            // 关闭所有打开的块
            if (newState.inThinking) {
                events.push({
                    type: 'content_block_stop',
                    index: 0
                });
            }
            if (newState.inText) {
                events.push({
                    type: 'content_block_stop',
                    index: newState.textIndex
                });
            }

            // 发送 message_delta - 根据是否有工具调用决定 stop_reason
            events.push({
                type: 'message_delta',
                delta: {
                    stop_reason: newState.hasToolUse ? 'tool_use' : 'end_turn',
                    stop_sequence: null
                },
                usage: {
                    output_tokens: usage?.candidatesTokenCount || 0
                }
            });

            events.push({ type: 'message_stop' });
        }

        return { events, state: newState };
    } catch (error) {
        return { events: [], state };
    }
}

/**
 * 预处理 Anthropic 请求
 *
 * 核心问题：Claude API 的 extended thinking 要求所有带 tool_use 的 assistant 消息
 * 必须以 thinking 块开头，且 thinking 块必须有有效的 signature。
 *
 * 由于我们无法伪造 signature，当检测到历史消息中有 tool_use 但没有 thinking 块时，
 * 自动禁用 thinking 模式以避免 API 错误。
 *
 * 注意：这意味着如果用户使用了工具，之后的对话将没有 thinking 输出。
 * 这是 Claude API 限制导致的，除非客户端完整保留带 signature 的 thinking 块。
 */
export function preprocessAnthropicRequest(request) {
    // 检测 thinking 模式 - 显式启用或根据模型名自动启用
    const thinkingEnabled = request.thinking?.type === 'enabled' ||
        (request.thinking?.type !== 'disabled' && isThinkingModel(request.model));

    if (!thinkingEnabled || !request.messages) {
        return request;
    }

    // 检查历史消息中是否有 assistant 消息没有有效的 thinking 块
    // 由于 Antigravity 不返回 Claude 的 thinking signature，我们无法在后续请求中提供有效的 signature
    // 因此当检测到这种情况时，必须禁用 thinking 模式并移除 thinking 块
    let needsDisabling = false;

    for (const msg of request.messages) {
        if (msg.role !== 'assistant') continue;

        // 字符串内容没有 thinking 块
        if (typeof msg.content === 'string') {
            needsDisabling = true;
            break;
        }

        if (!Array.isArray(msg.content)) continue;

        // 检查是否以 thinking 块开头
        const firstBlock = msg.content[0];
        const startsWithThinking = firstBlock &&
            (firstBlock.type === 'thinking' || firstBlock.type === 'redacted_thinking');

        if (!startsWithThinking) {
            needsDisabling = true;
            break;
        }

        // 检查 thinking 块是否有 signature（Claude API 要求）
        if (firstBlock.type === 'thinking' && !firstBlock.signature) {
            needsDisabling = true;
            break;
        }
    }

    if (!needsDisabling) {
        return request;
    }

    // 禁用 thinking 并从历史消息中移除所有 thinking 块
    const cleanedMessages = request.messages.map(msg => {
        if (msg.role !== 'assistant') return msg;

        // 字符串内容保持不变
        if (typeof msg.content === 'string') return msg;

        if (!Array.isArray(msg.content)) return msg;

        // 过滤掉 thinking 块
        const filteredContent = msg.content.filter(block =>
            block.type !== 'thinking' && block.type !== 'redacted_thinking'
        );

        // 如果过滤后没有内容，添加一个空文本块
        if (filteredContent.length === 0) {
            filteredContent.push({ type: 'text', text: '' });
        }

        return { ...msg, content: filteredContent };
    });

    return {
        ...request,
        thinking: { type: 'disabled' },
        messages: cleanedMessages
    };
}
