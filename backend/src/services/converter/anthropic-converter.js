import { v4 as uuidv4 } from 'uuid';

import { getMappedModel, isThinkingModel } from '../../config.js';

import { injectClaudeToolRequiredArgPlaceholderIntoArgs, injectClaudeToolRequiredArgPlaceholderIntoSchema, needsClaudeToolRequiredArgPlaceholder, stripClaudeToolRequiredArgPlaceholderFromArgs } from './claude-tool-placeholder.js';
import { convertJsonSchema, generateSessionId } from './schema-converter.js';
import { cacheClaudeAssistantSignature, cacheClaudeLastThinkingSignature, cacheClaudeThinkingSignature, getCachedClaudeAssistantSignature, getCachedClaudeLastThinkingSignature, getCachedClaudeThinkingSignature, logThinkingDowngrade } from './signature-cache.js';
import { extractThoughtSignatureFromCandidate, extractThoughtSignatureFromPart } from './thought-signature-extractor.js';
import { createToolOutputLimiter, limitToolOutput } from './tool-output-limiter.js';

// Defaults
const DEFAULT_THINKING_BUDGET = 4096;
const DEFAULT_TEMPERATURE = 1;
const CLAUDE_TOOL_SIGNATURE_SENTINEL = 'skip_thought_signature_validator';

// Tool-chain: cap overly large max_tokens when tools/tool_results exist (disabled by default)
const MAX_OUTPUT_TOKENS_WITH_TOOLS = Number(process.env.MAX_OUTPUT_TOKENS_WITH_TOOLS ?? 0);

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

    const toolOutputLimiter = createToolOutputLimiter({
        provider: 'anthropic',
        route: '/v1/messages',
        model: model || null
    });

    // 检测 thinking 模式 - 显式启用或根据模型名自动启用
    // 如果明确设置了 thinking.type，使用该设置；否则根据模型名判断
    const thinkingEnabled = thinking?.type === 'enabled' ||
        (thinking?.type !== 'disabled' && isThinkingModel(model));
    const thinkingBudget = thinking?.budget_tokens || DEFAULT_THINKING_BUDGET;

    const hasWebSearchTool = hasAnthropicWebSearchTool(tools);
    const userKey = anthropicRequest?.metadata?.user_id || null;

    // 获取实际模型名称
    let actualModel = getMappedModel(model);
    if (hasWebSearchTool) {
        // Web search requests should use Gemini's built-in search behavior
        actualModel = 'gemini-2.5-flash';
    }
    const isClaudeModel = model.includes('claude');

    // Claude thinking：当工具 schema 没有 required 字段时，上游偶发不下发 tool_use/tool_call（只输出 thinking 然后结束）
    const claudeToolsNeedingRequiredPlaceholder = new Set();
    if (isClaudeModel && thinkingEnabled && Array.isArray(tools)) {
        for (const t of tools) {
            const name = t?.name;
            if (!name) continue;
            const schema = t?.input_schema;
            if (needsClaudeToolRequiredArgPlaceholder(schema)) {
                claudeToolsNeedingRequiredPlaceholder.add(String(name));
            }
        }
    }

    // 转换消息
    const contents = [];

    // tool_result 在 Anthropic 协议里通常不带 name 字段，只给 tool_use_id。
    // Antigravity 的 functionResponse 需要 name 才能正确匹配/消费工具输出。
    // 因此这里提前扫描 assistant 的 tool_use 块，建立 tool_use_id -> name 的映射。
    const toolUseNameById = new Map();
    for (const m of messages || []) {
        if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
        for (const block of m.content) {
            if (block?.type === 'tool_use' && block?.id && typeof block?.name === 'string' && block.name.trim()) {
                toolUseNameById.set(block.id, block.name.trim());
            }
        }
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        // 处理 tool_result 消息（Anthropic 的工具返回格式）
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            const toolResults = msg.content.filter(c => c.type === 'tool_result');
            if (toolResults.length > 0) {
                const parts = toolResults.map(tr => {
                    const toolName = tr.name || toolUseNameById.get(tr.tool_use_id) || 'unknown';
                    const output = limitToolOutput(tr.content, toolOutputLimiter, {
                        provider: 'anthropic',
                        route: '/v1/messages',
                        model: model || null,
                        tool_name: toolName,
                        tool_use_id: tr.tool_use_id
                    });
                    return {
                        functionResponse: {
                            id: tr.tool_use_id,
                            name: toolName,
                            response: { output }
                        }
                    };
                });
                contents.push({ role: 'user', parts });
                continue;
            }
        }

        contents.push(convertAnthropicMessage(msg, thinkingEnabled, { isClaudeModel, thinkingEnabled, claudeToolsNeedingRequiredPlaceholder, userKey }));
    }

    // 构建 generationConfig
    let maxOutputTokens = max_tokens || 8192;
    const hasToolsInRequest = Array.isArray(tools) && tools.length > 0;
    const hasToolResultsInHistory =
        Array.isArray(messages) &&
        messages.some(m =>
            m?.role === 'user' &&
            Array.isArray(m.content) &&
            m.content.some(b => b && b.type === 'tool_result')
        );
    const shouldCapOutputTokens =
        Number.isFinite(MAX_OUTPUT_TOKENS_WITH_TOOLS) &&
        MAX_OUTPUT_TOKENS_WITH_TOOLS > 0 &&
        (hasToolsInRequest || hasToolResultsInHistory);
    if (shouldCapOutputTokens && maxOutputTokens > MAX_OUTPUT_TOKENS_WITH_TOOLS) {
        const minRequired = isClaudeModel && thinkingEnabled ? (thinkingBudget * 2) : 0;
        const effectiveCap = Math.max(MAX_OUTPUT_TOKENS_WITH_TOOLS, minRequired);
        maxOutputTokens = Math.min(maxOutputTokens, effectiveCap);
    }

    const generationConfig = {
        temperature: temperature ?? DEFAULT_TEMPERATURE,
        maxOutputTokens,
        candidateCount: 1
    };

    // Claude 模型不支持 topP（web_search 会被映射到 Gemini，可透传 topP）
    if ((!isClaudeModel || hasWebSearchTool) && top_p !== undefined) {
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
        requestType: hasWebSearchTool ? 'web_search' : 'agent'
    };

    // 添加系统指令
    const shouldAddInterleavedHint = isClaudeModel && thinkingEnabled && Array.isArray(tools) && tools.length > 0;
    const interleavedHint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.';
    if (system || shouldAddInterleavedHint) {
        let systemContent = typeof system === 'string'
            ? system
            : Array.isArray(system)
                ? system.map(s => s.text || '').join('\n')
                : '';
        if (shouldAddInterleavedHint && !systemContent.includes(interleavedHint)) {
            systemContent = systemContent ? `${systemContent}\n\n${interleavedHint}` : interleavedHint;
        }
        request.request.systemInstruction = {
            role: 'user',
            parts: [{ text: systemContent }]
        };
    }

    // 添加工具定义
    if (tools && tools.length > 0) {
        if (hasWebSearchTool) {
            request.request.tools = [{
                googleSearch: {
                    enhancedContent: {
                        imageSearch: {
                            maxResultCount: 5
                        }
                    }
                }
            }];
            return request;
        }
        // Anthropic 兼容：支持 Claude Code/Anthropic 内置工具（web_search/computer_use/text_editor/bash）
        // 这些工具在 Anthropic 协议中通常以 {type:"bash_YYYYMMDD"} 这种形式出现（没有 name/input_schema）。
        // Antigravity 侧只支持 functionDeclarations，因此这里把它们“降维”成普通函数工具：
        // - 让模型可以正常发出 tool_use
        // - 由客户端（如 Claude Code/Cherry Studio）执行并回传 tool_result
        const normalizedTools = tools
            .map(t => normalizeAnthropicTool(t, isClaudeModel))
            .filter(Boolean);

	        if (normalizedTools.length > 0) {
	            const declarations = normalizedTools.map(t => convertAnthropicTool(t, isClaudeModel));
                if (isClaudeModel && thinkingEnabled && claudeToolsNeedingRequiredPlaceholder.size > 0) {
                    for (const d of declarations) {
                        if (d && typeof d === 'object' && d.name && claudeToolsNeedingRequiredPlaceholder.has(d.name)) {
                            d.parameters = injectClaudeToolRequiredArgPlaceholderIntoSchema(d.parameters);
                        }
                    }
                }
	            request.request.tools = [{ functionDeclarations: declarations }];

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

function hasAnthropicWebSearchTool(tools) {
    if (!Array.isArray(tools)) return false;
    return tools.some(tool => {
        if (!tool || typeof tool !== 'object') return false;
        if (typeof tool.name === 'string' && tool.name.toLowerCase() === 'web_search') return true;
        const type = typeof tool.type === 'string' ? tool.type : '';
        return type === 'web_search' || type.startsWith('web_search_');
    });
}

function normalizeAnthropicTool(tool, isClaudeModel = false) {
    if (!tool) return null;

    // 普通函数工具（Anthropic 兼容：name + input_schema）
    if (tool.name && tool.input_schema) return tool;

    const type = typeof tool.type === 'string' ? tool.type : '';
    if (!type) return null;

    // Anthropic 内置工具：type 中带版本后缀（例如 bash_20241022 / web_search_20250305）
    const startsWith = (prefix) => type === prefix || type.startsWith(prefix + '_') || type.startsWith(prefix);

    let name = null;
    if (startsWith('web_search')) name = 'web_search';
    else if (startsWith('computer_use')) name = 'computer_use';
    else if (startsWith('computer')) name = 'computer';
    else if (startsWith('text_editor')) name = 'text_editor';
    else if (startsWith('bash')) name = 'bash';
    else return null;

    const descParts = [];
    if (typeof tool.description === 'string' && tool.description.trim()) descParts.push(tool.description.trim());
    else descParts.push(`Built-in tool: ${name}`);

    // computer/computer_use 工具通常会在 tool definition 上携带屏幕信息（给模型参考）
    const w = tool.display_width_px ?? tool.displayWidthPx;
    const h = tool.display_height_px ?? tool.displayHeightPx;
    if ((name === 'computer' || name === 'computer_use') && Number.isFinite(w) && Number.isFinite(h)) {
        descParts.push(`Display: ${w}x${h}px`);
    }

    const input_schema = getBuiltinAnthropicToolSchema(name);

    return {
        name,
        description: descParts.join(' | '),
        input_schema
    };
}

function getBuiltinAnthropicToolSchema(name) {
    // 说明：这里的 schema 主要用于让上游 function calling 可用，并尽量贴近 Anthropic 的常见入参。
    // 由于不同客户端/版本可能扩展字段，我们把 required 控制在最小集合，并尽量覆盖常用字段。
    if (name === 'bash') {
        return {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to run' },
                timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds' }
            },
            required: ['command']
        };
    }

    if (name === 'text_editor') {
        return {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Editor command (view/create/replace/insert/undo/...)' },
                path: { type: 'string', description: 'File path' },
                file_text: { type: 'string', description: 'Full file contents (for create)' },
                old_str: { type: 'string', description: 'String to replace' },
                new_str: { type: 'string', description: 'Replacement string' },
                insert_line: { type: 'integer', description: 'Line number to insert at (1-based)' },
                text: { type: 'string', description: 'Text to insert' },
                view_range: {
                    type: 'array',
                    items: { type: 'integer' },
                    description: 'Optional line range, e.g. [start, end]'
                }
            },
            required: ['command']
        };
    }

    if (name === 'web_search') {
        return {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                max_results: { type: 'integer', description: 'Max results' },
                locale: { type: 'string', description: 'Optional locale/region' },
                time_range: { type: 'string', description: 'Optional time range filter (day/week/month/year)' }
            },
            required: ['query']
        };
    }

    if (name === 'computer' || name === 'computer_use') {
        return {
            type: 'object',
            properties: {
                action: { type: 'string', description: 'Action name (screenshot/mouse_move/click/type/key/scroll/...)' },
                x: { type: 'integer', description: 'X coordinate' },
                y: { type: 'integer', description: 'Y coordinate' },
                coordinates: {
                    type: 'array',
                    items: { type: 'integer' },
                    description: 'Optional [x, y] coordinate pair'
                },
                text: { type: 'string', description: 'Text to type' },
                key: { type: 'string', description: 'Key to press' },
                button: { type: 'string', description: 'Mouse button' },
                clicks: { type: 'integer', description: 'Click count' },
                scroll_amount: { type: 'integer', description: 'Scroll amount' },
                direction: { type: 'string', description: 'Scroll direction' }
            },
            required: ['action']
        };
    }

    return { type: 'object', properties: {} };
}

/**
 * 转换 Anthropic 格式的单条消息
 */
function convertAnthropicMessage(msg, thinkingEnabled = false, ctx = {}) {
    const { isClaudeModel = false, claudeToolsNeedingRequiredPlaceholder = null, userKey = null } = ctx;
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
        let currentMessageThinkingSignature = null;

	    for (const item of msg.content) {
	            // 处理 thinking 块 - 保留为 thought 部分
	            if (item.type === 'thinking') {
                    const rawThinking =
                        typeof item.thinking === 'string'
                            ? item.thinking
                            : (item.thinking && typeof item.thinking.thinking === 'string' ? item.thinking.thinking : '');
                    const rawSignature =
                        item.signature ||
                        (item.thinking && typeof item.thinking.signature === 'string' ? item.thinking.signature : undefined);

                    // 兼容 Vertex/部分中间层：如果带 signature 但 thinking 为空字符串，
                    // 可能在上游序列化时被当作“未设置”导致校验失败；用空格占位保证字段存在。
                    const thinkingText = (rawSignature && rawThinking === '') ? ' ' : rawThinking;
                    if (rawSignature) currentMessageThinkingSignature = rawSignature;

	                regularParts.push({
	                    text: thinkingText,
	                    thought: true,
	                    ...(rawSignature ? { thoughtSignature: rawSignature } : {})
	                });
	                continue;
	            }

            // 处理 redacted_thinking 块
            // - 若包含 signature：可安全透传为 thought part（text 为空即可）
            // - 若缺少 signature：不透传（否则会触发上游校验失败），交给 preprocess 做降级/清洗
            if (item.type === 'redacted_thinking') {
                const sig =
                    item.signature ||
                    (item.redacted_thinking && typeof item.redacted_thinking.signature === 'string' ? item.redacted_thinking.signature : undefined);
                if (sig) {
                    currentMessageThinkingSignature = sig;
	                regularParts.push({
	                    text: ' ',
	                    thought: true,
	                        thoughtSignature: sig
	                    });
	                }
	                continue;
	            }

            // 处理文本
            if (item.type === 'text') {
                regularParts.push({ text: item.text });
                continue;
            }

            // 处理工具调用 - 放到单独的数组，最后添加
            if (item.type === 'tool_use') {
                let args = item.input || {};
                if (
                    isClaudeModel &&
                    thinkingEnabled &&
                    claudeToolsNeedingRequiredPlaceholder &&
                    item?.name &&
                    claudeToolsNeedingRequiredPlaceholder.has(item.name)
                ) {
                    args = injectClaudeToolRequiredArgPlaceholderIntoArgs(args || {});
                }
                let thoughtSignature = null;
                if (isClaudeModel) {
                    if (currentMessageThinkingSignature) {
                        thoughtSignature = currentMessageThinkingSignature;
                    } else if (item?.id) {
                        thoughtSignature = getCachedClaudeThinkingSignature(item.id);
                    }
                    if (!thoughtSignature && userKey) {
                        thoughtSignature = getCachedClaudeLastThinkingSignature(userKey);
                        if (thoughtSignature && item?.id) {
                            cacheClaudeThinkingSignature(item.id, thoughtSignature);
                        }
                    }
                    if (!thoughtSignature) {
                        thoughtSignature = CLAUDE_TOOL_SIGNATURE_SENTINEL;
                    }
                }
                functionCallParts.push({
                    ...(thoughtSignature ? { thoughtSignature } : {}),
                    functionCall: {
                        id: item.id,
                        name: item.name,
                        args
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
export function convertAntigravityToAnthropic(antigravityResponse, requestId, model, thinkingEnabled = false, userKey = null) {
    try {
        const data = antigravityResponse;
        const candidate = data.response?.candidates?.[0];
        const usage = data.response?.usageMetadata;

        if (!candidate) {
            const promptFeedback = data.response?.promptFeedback;
            const blockReason = promptFeedback?.blockReason || promptFeedback?.blockReasonMessage;
            if (blockReason) {
                throw new Error(`Upstream blocked request: ${blockReason}`);
            }
            throw new Error('Upstream returned no candidates');
        }

        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        const thinkingParts = parts.filter(p => p.thought);
        const otherParts = parts.filter(p => !p.thought);

        const content = [];
        let thinkingText = '';
        let messageThinkingSignature = extractThoughtSignatureFromCandidate(candidate, data);
        const toolUseIds = [];

        // 先收集 thinking（以及 signature）
        if (thinkingEnabled) {
            for (const part of thinkingParts) {
                thinkingText += (part.text || '');
                const sig = extractThoughtSignatureFromPart(part);
                if (sig) messageThinkingSignature = sig;
            }
        }

        // 再处理其他 blocks（text / tool_use / image）
        for (const part of otherParts) {
            // 有些上游会把 Claude 的签名放在非 thought part 上（例如 functionCall part），这里也兜底采集
            const sig = extractThoughtSignatureFromPart(part);
            if (sig) messageThinkingSignature = sig;

            if (part.text !== undefined) {
                content.push({ type: 'text', text: part.text });
            }

	            if (part.functionCall) {
	                const toolUseId = part.functionCall.id || `toolu_${uuidv4().slice(0, 8)}`;
                    const cleanedArgs = stripClaudeToolRequiredArgPlaceholderFromArgs(part.functionCall.args || {});
	                toolUseIds.push(toolUseId);
	                content.push({
	                    type: 'tool_use',
	                    id: toolUseId,
	                    name: part.functionCall.name,
	                    input: cleanedArgs || {}
	                });
	            }

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

        // 若本回合没有下发 signature，但我们有“上一回合的 signature”，则复用它：
        // - 让 tool_use 也能拥有 signature 以便下一轮回放
        // - 让响应以 thinking/redacted_thinking 开头（Claude Code / 上游校验需要）
        if (thinkingEnabled && !messageThinkingSignature && userKey) {
            const recovered = getCachedClaudeLastThinkingSignature(userKey);
            if (recovered) messageThinkingSignature = recovered;
        }

        if (thinkingEnabled && (thinkingText || messageThinkingSignature)) {
            // 兼容：部分客户端还不支持 redacted_thinking（会直接报错/中断工具链路）。
            // 这里始终输出 thinking 块；当 thinking 为空且存在 signature 时，后续请求回放阶段会在 preprocess 中转换为 redacted_thinking 再发往上游。
            content.unshift({
                type: 'thinking',
                thinking: thinkingText || '',
                ...(messageThinkingSignature ? { signature: messageThinkingSignature } : {})
            });
        }

        // 更新 last-signature（用于后续 signature 缺失的回合兜底）
        if (messageThinkingSignature && userKey) {
            cacheClaudeLastThinkingSignature(userKey, messageThinkingSignature);
        }

        // 缓存 signature：用于客户端不回放 thinking 块时，下一轮自动补齐
        if (messageThinkingSignature && userKey) {
            const contentWithoutThinking = content.filter(b => b && b.type !== 'thinking' && b.type !== 'redacted_thinking');
            cacheClaudeAssistantSignature(userKey, contentWithoutThinking, messageThinkingSignature);
        }

        if (messageThinkingSignature && toolUseIds.length > 0) {
            for (const id of toolUseIds) cacheClaudeThinkingSignature(id, messageThinkingSignature);
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
            if (!('messageStarted' in newState)) newState.messageStarted = false;
            if (!('messageId' in newState)) newState.messageId = `msg_${requestId}`;
            if (!('lastUsage' in newState)) newState.lastUsage = null;
            if (!('thinkingEnabled' in newState)) newState.thinkingEnabled = null;
            if (!('userKey' in newState)) newState.userKey = null;
	        if (!('lastThinkingSignature' in newState)) newState.lastThinkingSignature = null;
            if (!('lastUserThinkingSignature' in newState)) {
                newState.lastUserThinkingSignature = newState.userKey ? getCachedClaudeLastThinkingSignature(newState.userKey) : null;
            }
	        if (!Array.isArray(newState.pendingToolUseIds)) newState.pendingToolUseIds = [];
            if (!('thinkingStopped' in newState)) newState.thinkingStopped = false;
            if (!('completed' in newState)) newState.completed = false;

            const thinkingEnabledForResponse =
                newState.thinkingEnabled === null || newState.thinkingEnabled === undefined
                    ? isThinkingModel(model)
                    : !!newState.thinkingEnabled;

            // Track latest usage so we can emit stable token counts even if usageMetadata appears late in the stream.
            if (usage && typeof usage === 'object') {
                newState.lastUsage = {
                    input_tokens: usage.promptTokenCount || 0,
                    output_tokens: usage.candidatesTokenCount || 0
                };
            }

            // Anthropic SSE always starts with message_start (many clients rely on it for token accounting).
            if (!newState.messageStarted) {
                const inputTokens = newState.lastUsage?.input_tokens || usage?.promptTokenCount || 0;
                events.push({
                    type: 'message_start',
                    message: {
                        id: newState.messageId,
                        type: 'message',
                        role: 'assistant',
                        model,
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: inputTokens, output_tokens: 0 }
                    }
                });
                newState.messageStarted = true;
            }

	        // 先分离 thinking 和非 thinking 的 parts
	        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
	        const thinkingParts = parts.filter(p => p.thought);
	        const otherParts = parts.filter(p => !p.thought);

            // 兜底：有些上游会把签名放在 candidate 级别或 functionCall 内部
            const preSig =
                extractThoughtSignatureFromCandidate(candidate, data) ||
                parts.map(extractThoughtSignatureFromPart).find(Boolean) ||
                null;
            if (preSig) {
                newState.lastThinkingSignature = preSig;
                if (newState.userKey) {
                    cacheClaudeLastThinkingSignature(newState.userKey, preSig);
                    newState.lastUserThinkingSignature = preSig;
                }
                if (newState.pendingToolUseIds.length > 0) {
                    for (const id of newState.pendingToolUseIds) cacheClaudeThinkingSignature(id, preSig);
                    newState.pendingToolUseIds = [];
                }
            }

            const ensureLeadingThinkingBlock = () => {
                if (!thinkingEnabledForResponse) return;
                if (newState.hasThinking) return;

                const sig = newState.lastThinkingSignature || newState.lastUserThinkingSignature || null;
                events.push({
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'thinking', thinking: '', ...(sig ? { signature: sig } : {}) }
                });
                events.push({ type: 'content_block_stop', index: 0 });

                newState.hasThinking = true;
                newState.thinkingIndex = 0;
                newState.thinkingStopped = true;
                newState.nextIndex = 1;
            };

	        // 先处理 thinking（确保 thinking 在前，index 0）
	        for (const part of thinkingParts) {
	            const sig = extractThoughtSignatureFromPart(part);
	            if (sig) {
	                newState.lastThinkingSignature = sig;
                    if (newState.userKey) {
                        cacheClaudeLastThinkingSignature(newState.userKey, sig);
                        newState.lastUserThinkingSignature = sig;
                    }
	                if (newState.pendingToolUseIds.length > 0) {
	                    for (const id of newState.pendingToolUseIds) cacheClaudeThinkingSignature(id, sig);
	                    newState.pendingToolUseIds = [];
	                }
	            }
                if (newState.thinkingStopped) continue;
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
	                        thinking: '',
	                        ...(newState.lastThinkingSignature ? { signature: newState.lastThinkingSignature } : {})
	                    }
	                });
	            }

	            events.push({
	                type: 'content_block_delta',
	                index: 0,
	                delta: {
	                    type: 'thinking_delta',
	                    thinking: part.text || ''
	                }
	            });
	        }

	        // 处理其他 parts（text 和 functionCall）
	        for (const part of otherParts) {
	            // 兜底：部分上游会把签名放在非 thought part 上（例如 functionCall part）
	            const sig = extractThoughtSignatureFromPart(part);
	            if (sig) {
	                newState.lastThinkingSignature = sig;
                    if (newState.userKey) {
                        cacheClaudeLastThinkingSignature(newState.userKey, sig);
                        newState.lastUserThinkingSignature = sig;
                    }
	                if (newState.pendingToolUseIds.length > 0) {
	                    for (const id of newState.pendingToolUseIds) cacheClaudeThinkingSignature(id, sig);
	                    newState.pendingToolUseIds = [];
	                }
	            }

	            // 如果之前在 thinking 中，现在不是了，关闭 thinking 块
	            if (newState.inThinking) {
	                events.push({
	                    type: 'content_block_stop',
                    index: 0
                });
                newState.inThinking = false;
                newState.thinkingStopped = true;
            }

            // thinking 启用时，确保响应的第一个块是 thinking/redacted_thinking（Claude Code/上游校验需要）
            // 注意：上游可能会先发一个“空 text”占位 chunk（text: ""），随后才开始下发 thought parts。
            // 这种情况下不能提前插入占位 thinking，否则会把后续真实 thinking_delta 全部吃掉。
            const willEmitNonThinkingContent =
                (part.text !== undefined && part.text !== '') ||
                !!part.functionCall ||
                !!part.inlineData;
            if (thinkingEnabledForResponse && willEmitNonThinkingContent) {
                ensureLeadingThinkingBlock();
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
	                const toolUseId = part.functionCall.id || `toolu_${uuidv4().slice(0, 8)}`;
                    const fallbackSig = newState.lastThinkingSignature || newState.lastUserThinkingSignature || null;
	                if (fallbackSig) {
                        // 上游有时不会在该回合再次下发 signature：复用 last-signature 让工具链路不断档
	                    cacheClaudeThinkingSignature(toolUseId, fallbackSig);
                        if (!newState.lastThinkingSignature) newState.lastThinkingSignature = fallbackSig;
	                } else {
	                    newState.pendingToolUseIds.push(toolUseId);
	                }

	                events.push({
	                    type: 'content_block_start',
	                    index: toolIndex,
	                    content_block: {
	                        type: 'tool_use',
	                        id: toolUseId,
	                        name: part.functionCall.name,
	                        input: {}
	                    }
	                });

	                events.push({
	                    type: 'content_block_delta',
	                    index: toolIndex,
	                    delta: {
	                        type: 'input_json_delta',
	                        partial_json: JSON.stringify(stripClaudeToolRequiredArgPlaceholderFromArgs(part.functionCall.args || {}) || {})
	                    }
	                });

                events.push({
                    type: 'content_block_stop',
                    index: toolIndex
                });
            }
        }

        // 处理结束：不同上游的 finishReason 取值可能不同（例如 STOP / MAX_TOKENS / SAFETY / OTHER ...）
        const finishReasonRaw = candidate.finishReason ?? candidate.finish_reason ?? null;
        const finishReason = typeof finishReasonRaw === 'string' ? finishReasonRaw.toUpperCase() : '';
        const isFinalFinish =
            !!finishReason &&
            finishReason !== 'FINISH_REASON_UNSPECIFIED' &&
            finishReason !== 'UNSPECIFIED';

        if (isFinalFinish) {
            // 关闭所有打开的块
            if (newState.inThinking) {
                events.push({
                    type: 'content_block_stop',
                    index: 0
                });
                newState.thinkingStopped = true;
                newState.inThinking = false;
            }
            if (newState.inText) {
                events.push({
                    type: 'content_block_stop',
                    index: newState.textIndex
                });
                newState.inText = false;
            }

            // 发送 message_delta - 根据是否有工具调用决定 stop_reason
            let stopReason = 'end_turn';
            if (newState.hasToolUse) stopReason = 'tool_use';
            else if (finishReason === 'MAX_TOKENS') stopReason = 'max_tokens';
            else if (finishReason === 'STOP_SEQUENCE') stopReason = 'stop_sequence';

            events.push({
                type: 'message_delta',
                delta: {
                    stop_reason: stopReason,
                    stop_sequence: null
                },
                usage: {
                    input_tokens: newState.lastUsage?.input_tokens || usage?.promptTokenCount || 0,
                    output_tokens: newState.lastUsage?.output_tokens || usage?.candidatesTokenCount || 0
                }
            });

	            events.push({ type: 'message_stop' });
                newState.completed = true;
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
 * 由于部分客户端不会回放/持久化 thinking.signature，代理会优先从本地缓存（tool_use_id -> signature）
 * 尝试恢复并补齐历史消息；只有在“含 tool_use 的历史消息”无法恢复 signature 时，才会降级禁用 thinking，
 * 以避免上游直接报错。
 */
export function preprocessAnthropicRequest(request) {
    if (!request?.messages) return request;

    // 预清洗：移除空 text 块（部分上游会把 text:"" 当作“未设置”，从而报 Field required）
    // 典型复现：OpenAI 端点 tool_calls 的 assistant.content 为 ""/[]，客户端换用 Anthropic 端点回放时会生成 {type:"text",text:""}。
    let didMutate = false;
    const sanitizedMessages = request.messages.map((msg) => {
        if (!msg || !Array.isArray(msg.content)) return msg;

        const filtered = [];
        for (const block of msg.content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text') {
                if (typeof block.text !== 'string' || block.text === '') {
                    didMutate = true;
                    continue;
                }
            }
            filtered.push(block);
        }

        // 避免空 content：用无语义空格占位（不会触发 Field required）
        if (filtered.length === 0) {
            didMutate = true;
            filtered.push({ type: 'text', text: ' ' });
        }

        return { ...msg, content: filtered };
    });

    // 检测 thinking 模式 - 显式启用或根据模型名自动启用
    const thinkingEnabled = request.thinking?.type === 'enabled' ||
        (request.thinking?.type !== 'disabled' && isThinkingModel(request.model));

    if (!thinkingEnabled) {
        return didMutate ? { ...request, messages: sanitizedMessages } : request;
    }

    const extractSystemText = (sys) => {
        const texts = [];
        if (typeof sys === 'string') {
            texts.push(sys);
        } else if (Array.isArray(sys)) {
            for (const s of sys) {
                if (typeof s === 'string') texts.push(s);
                else if (s && typeof s.text === 'string') texts.push(s.text);
            }
        }
        return texts.join('\n');
    };

    const systemText = extractSystemText(request.system);
    const isClaudeCodeRequest =
        systemText.includes('You are Claude Code') ||
        systemText.includes("Claude Code, Anthropic's official CLI for Claude");
    const userKey = request?.metadata?.user_id || null;

    // 兼容问题：部分客户端在回放历史时不会保留 thinking 块 / signature（尤其在 tool_use 场景）。
    // Claude extended thinking 对“包含 tool_use 的 assistant 历史消息”有强校验：
    // - 必须以 thinking/redacted_thinking 块开头
    // - 必须携带有效 signature
    //
    // 代理策略：
    // 1) 优先从本地缓存（tool_use_id -> signature）恢复并“补齐/插入” thinking 块，避免降级。
    // 2) 对无 tool_use 的 assistant 历史消息：若存在无 signature 的 thinking 块，直接清洗掉（不必全局降级）。
    // 3) 仅当“包含 tool_use 的历史消息”无法恢复 signature 时，才降级禁用 thinking（避免上游报错）。

    let mustDisableThinking = false;
    const missingToolUseIdsForSignature = [];

    let workingMessages = sanitizedMessages;
    let workingSystem = request.system;

    // Claude Code（以及类似“用 assistant '{' 作为 JSON 前缀”的调用）兼容：
    // 这类请求在 messages 里塞一个最后的 assistant 文本块 "{"，用于强制模型输出 JSON。
    // 但 extended thinking 开启时，上游会要求“最后的 assistant 消息”必须以 thinking/redacted_thinking 开头，
    // 这个前缀会直接触发 invalid_request_error。
    // 由于我们无法为“人为注入的 assistant 前缀”生成合法 signature，这里选择删除该前缀，
    // 并补一条 system 提示要求输出以 '{' 开头，尽量保持原语义。
    const looksLikeJsonOnlyInstruction =
        systemText.includes('ONLY generate the JSON object') ||
        systemText.includes('Only include these fields') ||
        systemText.includes('Format your response as a JSON object') ||
        systemText.includes('ONLY generate the JSON object, no other text');

    const isAssistantJsonPrefix = (msg) => {
        if (!msg || msg.role !== 'assistant') return false;
        if (!Array.isArray(msg.content) || msg.content.length !== 1) return false;
        const b = msg.content[0];
        if (!b || b.type !== 'text') return false;
        return String(b.text || '').trim() === '{';
    };

    if (looksLikeJsonOnlyInstruction) {
        const filtered = [];
        let droppedPrefix = false;
        for (const m of workingMessages) {
            if (isAssistantJsonPrefix(m)) {
                droppedPrefix = true;
                didMutate = true;
                continue;
            }
            filtered.push(m);
        }
        if (droppedPrefix) {
            workingMessages = filtered;

            const hint = "Return only a single JSON object and start your response with '{'.";
            if (!systemText.includes(hint)) {
                if (Array.isArray(workingSystem)) {
                    workingSystem = [...workingSystem, { type: 'text', text: hint }];
                } else if (typeof workingSystem === 'string') {
                    workingSystem = `${workingSystem}\n\n${hint}`;
                } else if (workingSystem == null) {
                    workingSystem = hint;
                } else {
                    // unknown shape, keep as-is
                }
                didMutate = true;
            }
        }
    }

    const normalizedMessages = workingMessages.map(msg => {
        if (msg?.role !== 'assistant') return msg;
        if (!Array.isArray(msg.content)) return msg; // 字符串/其它格式：不强制要求 thinking（除非包含 tool_use，但此时也不可能）

        let localMutate = false;
        const blocks = msg.content.slice();

        // 若历史里已带 signature，更新 last-signature 缓存（为后续“本回合不再下发 signature”的 tool_use 做兜底）
        if (userKey) {
            const sigBlock = blocks.find(b => b && (b.type === 'thinking' || b.type === 'redacted_thinking') && b.signature);
            if (sigBlock?.signature) cacheClaudeLastThinkingSignature(userKey, sigBlock.signature);
        }

        const toolUseIds = blocks
            .filter(b => b && b.type === 'tool_use' && b.id)
            .map(b => b.id);
        const hasToolUse = toolUseIds.length > 0;

        const findAnyThinkingIndex = () => blocks.findIndex(b => b && (b.type === 'thinking' || b.type === 'redacted_thinking'));
        const firstThinkingIndex = findAnyThinkingIndex();
        const firstBlock = blocks[0];
        const startsWithThinking = firstBlock && (firstBlock.type === 'thinking' || firstBlock.type === 'redacted_thinking');

        // helper：从缓存恢复 signature（优先使用该条消息内的 tool_use_id）
        const recoverSignature = () => {
            for (const id of toolUseIds) {
                const recovered = getCachedClaudeThinkingSignature(id);
                if (recovered) return recovered;
            }
            // 某些回合上游不会再次下发 thoughtSignature：用 last-signature 兜底
            if (userKey) {
                const lastSig = getCachedClaudeLastThinkingSignature(userKey);
                if (lastSig) {
                    for (const id of toolUseIds) cacheClaudeThinkingSignature(id, lastSig);
                    return lastSig;
                }
            }
            return null;
        };

        // 1) 含 tool_use：必须有“开头 thinking + signature”
        if (hasToolUse) {
            let signature = null;

            // 1.1) 优先使用消息内已有 signature（thinking/redacted_thinking 任意位置）
            if (firstThinkingIndex >= 0) {
                const sig = blocks[firstThinkingIndex]?.signature;
                if (sig) signature = sig;
            }

            // 1.2) 其次从缓存恢复
            if (!signature) {
                signature = recoverSignature();
            }

            if (!signature) {
                mustDisableThinking = true;
                for (const id of toolUseIds) {
                    if (id) missingToolUseIdsForSignature.push(String(id));
                }
                return msg;
            }

            // 1.3) 确保开头是 thinking/redacted_thinking 且带 signature
            if (startsWithThinking) {
                if (!blocks[0].signature) {
                    blocks[0] = { ...blocks[0], signature };
                    localMutate = true;
                }
                // 若客户端丢失 thinking 文本：不要伪造 thinking 内容（可能导致 signature 校验不一致），改用 redacted_thinking
                if (blocks[0].type === 'thinking' && (blocks[0].thinking === '' || blocks[0].thinking === undefined)) {
                    blocks[0] = { type: 'redacted_thinking', signature };
                    localMutate = true;
                }
            } else if (firstThinkingIndex >= 0) {
                // 有 thinking 但不在开头：移动到开头
                const [thinkingBlock] = blocks.splice(firstThinkingIndex, 1);
                const patchedThinkingBlock = thinkingBlock?.signature ? thinkingBlock : { ...thinkingBlock, signature };
                const ensuredThinkingBlock =
                    patchedThinkingBlock?.type === 'thinking' &&
                    (patchedThinkingBlock.thinking === '' || patchedThinkingBlock.thinking === undefined)
                        ? { type: 'redacted_thinking', signature }
                        : patchedThinkingBlock;
                blocks.unshift(ensuredThinkingBlock);
                localMutate = true;
            } else {
                // 没有 thinking：插入一个 redacted_thinking 块（不伪造 thinking 文本）
                blocks.unshift({ type: 'redacted_thinking', signature });
                localMutate = true;
            }

            if (localMutate) didMutate = true;
            return localMutate ? { ...msg, content: blocks } : msg;
        }

        // Claude Code 兼容：如果客户端没回放 thinking 块，但我们曾经对“同内容的 assistant 消息”缓存过 signature，
        // 则在这里自动补一个空 thinking 块（携带 signature）以满足 extended thinking 的历史校验。
        if (isClaudeCodeRequest && !startsWithThinking) {
            const contentWithoutThinking = blocks.filter(b => b && b.type !== 'thinking' && b.type !== 'redacted_thinking');
            const recoveredSig = getCachedClaudeAssistantSignature(userKey, contentWithoutThinking);
            if (recoveredSig) {
                blocks.unshift({ type: 'redacted_thinking', signature: recoveredSig });
                localMutate = true;
            }
        }

        // 2) 不含 tool_use：清洗掉缺少 signature 的 thinking/redacted_thinking（避免上游校验失败）
        if (firstThinkingIndex >= 0) {
            const hasInvalidThinking = blocks.some(b =>
                b && (b.type === 'thinking' || b.type === 'redacted_thinking') && !b.signature
            );
            if (hasInvalidThinking) {
                const filtered = blocks.filter(b =>
                    !(b && (b.type === 'thinking' || b.type === 'redacted_thinking') && !b.signature)
                );
                if (filtered.length === 0) filtered.push({ type: 'text', text: ' ' });
                didMutate = true;
                return { ...msg, content: filtered };
            }
        }

        if (localMutate) didMutate = true;
        return localMutate ? { ...msg, content: blocks } : msg;
    });

    if (!mustDisableThinking) {
        if (!didMutate) return request;
        const out = { ...request, messages: normalizedMessages };
        if (workingSystem !== request.system) out.system = workingSystem;
        return out;
    }

    // 降级：禁用 thinking，并移除历史中所有 thinking/redacted_thinking 块（否则会触发校验失败）
    const uniqueMissing = Array.from(new Set(missingToolUseIdsForSignature)).slice(0, 50);
    logThinkingDowngrade({
        provider: 'anthropic',
        route: '/v1/messages',
        model: request?.model || null,
        user_id: request?.metadata?.user_id || null,
        reason: 'missing_thinking_signature_for_tool_use_history',
        missing_tool_use_ids: uniqueMissing,
        missing_count: missingToolUseIdsForSignature.length
    });

    const cleanedMessages = normalizedMessages.map(msg => {
        if (msg?.role !== 'assistant') return msg;
        if (!Array.isArray(msg.content)) return msg;

        const filteredContent = msg.content.filter(block =>
            block.type !== 'thinking' && block.type !== 'redacted_thinking'
        );
        if (filteredContent.length === 0) filteredContent.push({ type: 'text', text: ' ' });
        return { ...msg, content: filteredContent };
    });

    const out = { ...request, thinking: { type: 'disabled' }, messages: cleanedMessages };
    if (workingSystem !== request.system) out.system = workingSystem;
    return out;
}
