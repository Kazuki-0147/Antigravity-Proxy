import { v4 as uuidv4 } from 'uuid';

import { AVAILABLE_MODELS, getMappedModel, isThinkingModel, isImageGenerationModel } from '../../config.js';

import { injectClaudeToolRequiredArgPlaceholderIntoArgs, injectClaudeToolRequiredArgPlaceholderIntoSchema, needsClaudeToolRequiredArgPlaceholder, stripClaudeToolRequiredArgPlaceholderFromArgs } from './claude-tool-placeholder.js';
import { convertJsonSchema, generateSessionId, parseDataUrl } from './schema-converter.js';
import { cacheClaudeToolThinking, cacheToolThoughtSignature, getCachedClaudeToolThinking, getCachedToolThoughtSignature, logThinkingDowngrade } from './signature-cache.js';
import { extractThoughtSignatureFromCandidate, extractThoughtSignatureFromPart } from './thought-signature-extractor.js';
import { createToolOutputLimiter, limitToolOutput } from './tool-output-limiter.js';
import { buildUpstreamSystemInstruction } from './system-instruction.js';

// Defaults
const DEFAULT_THINKING_BUDGET = 4096;
const DEFAULT_TEMPERATURE = 1;
const GEMINI_THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator';

// Tool-chain: cap max_tokens when request contains tools/tool_results (disabled by default)
const MAX_OUTPUT_TOKENS_WITH_TOOLS = Number(process.env.MAX_OUTPUT_TOKENS_WITH_TOOLS ?? 0);

// OpenAI endpoint: Claude tools + thinking replay behavior
const CLAUDE_OPENAI_REPLAY_THOUGHT_TEXT = String(process.env.CLAUDE_OPENAI_REPLAY_THOUGHT_TEXT ?? 'true')
    .trim()
    .toLowerCase();
const CLAUDE_OPENAI_REPLAY_INCLUDE_TEXT = !['0', 'false', 'no', 'n', 'off'].includes(CLAUDE_OPENAI_REPLAY_THOUGHT_TEXT);

// OpenAI compatible thinking output:
// - reasoning_content (default): delta.reasoning_content / message.reasoning_content
// - tags: mix into content with <think></think>
// - both: output both (may duplicate in some clients)
const OPENAI_THINKING_OUTPUT = String(process.env.OPENAI_THINKING_OUTPUT || 'reasoning_content')
    .trim()
    .toLowerCase();
const OPENAI_THINKING_INCLUDE_REASONING =
    OPENAI_THINKING_OUTPUT === 'reasoning_content' ||
    OPENAI_THINKING_OUTPUT === 'reasoning' ||
    OPENAI_THINKING_OUTPUT === 'both';
const OPENAI_THINKING_INCLUDE_TAGS =
    OPENAI_THINKING_OUTPUT === 'tags' ||
    OPENAI_THINKING_OUTPUT === 'tag' ||
    OPENAI_THINKING_OUTPUT === 'both';

// Track whether a stream is currently inside <think>...</think>
const thinkingState = new Map();

// Stream buffer: some upstreams send tool_calls first, then thought/signature later.
// Keep pending tool_call_ids until signature arrives.
const claudeToolThinkingBuffer = new Map(); // requestId -> { signature, thoughtText, pendingToolCallIds }

/**
 * 拆分 OpenAI tool message 的多模态内容
 *
 * tool message 的 content 可能是多模态数组（包含 text + image_url 块）。
 * 如果直接 JSON.stringify()，图片会变成巨大的 base64 字符串，导致：
 * 1. 上游模型无法识别图片
 * 2. Token 消耗暴涨（约 100 倍差距）
 *
 * 本函数将内容拆分为：
 * - textParts: 纯文本内容（用换行符连接）
 * - inlineDataParts: 从 image_url 块提取的 inlineData parts
 *
 * @param {string|Array|*} content - tool message 的 content 字段
 * @returns {{ textParts: string|*, inlineDataParts: Array }}
 */
function splitOpenAIToolResultContent(content) {
    // 非数组内容保持原样处理
    if (!Array.isArray(content)) {
        return { textParts: content, inlineDataParts: [] };
    }

    const texts = [];
    const inlineDataParts = [];

    for (const item of content) {
        if (!item) continue;

        // 处理纯字符串元素
        if (typeof item === 'string') {
            if (item) texts.push(item);
            continue;
        }

        // 非对象类型 - 转为字符串保留
        if (typeof item !== 'object') {
            texts.push(String(item));
            continue;
        }

        // 处理标准 text 块
        if (item.type === 'text' && typeof item.text === 'string') {
            if (item.text) texts.push(item.text);
            continue;
        }

        // 处理 image_url 块 - 转换为 inlineData
        if (item.type === 'image_url' && typeof item.image_url?.url === 'string' && item.image_url.url) {
            const parsed = parseDataUrl(item.image_url.url);
            if (parsed?.data) {
                inlineDataParts.push({
                    inlineData: {
                        mimeType: parsed.mimeType,
                        data: parsed.data
                    }
                });
            }
            continue;
        }

        // 兜底：尝试提取非标准块中的文本
        if (typeof item.text === 'string' && item.text) {
            texts.push(item.text);
            continue;
        }
        if (typeof item.content === 'string' && item.content) {
            texts.push(item.content);
            continue;
        }

        // 最终兜底：未知块类型，序列化为 JSON 保留信息（但排除可能的大型二进制数据）
        // 避免静默丢失数据
        try {
            const itemType = item.type || 'unknown';
            // 如果块包含可能的二进制数据字段，只保留类型信息
            if (item.image_url?.url || item.data) {
                texts.push(`[${itemType}_block]`);
            } else {
                texts.push(JSON.stringify(item));
            }
        } catch {
            texts.push(`[unserializable_block]`);
        }
    }

    return {
        textParts: texts.join('\n'),
        inlineDataParts
    };
}

/**
 * OpenAI request -> Antigravity request
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
        // extended params: thinking budget
        thinking_budget,
        budget_tokens // alias
    } = openaiRequest;

    const requestId = `agent-${uuidv4()}`;
    const toolOutputLimiter = createToolOutputLimiter({
        provider: 'openai',
        route: '/v1/chat/completions',
        model: model || null,
        request_id: requestId
    });

    // Extract system messages
    const systemMessages = messages.filter((m) => m.role === 'system');
    let systemContent = systemMessages
        .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((c) => c.text || '').join('\n')))
        .join('\n');

    // Convert chat messages (exclude system); merge consecutive tool results
    const contents = [];
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    // Actual model name
    const actualModel = getMappedModel(model);

    // Tools or tool history?
    const hasTools = tools && tools.length > 0;
    const hasToolCallsInHistory = nonSystemMessages.some((msg) => msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0);
    const hasToolResultsInHistory = nonSystemMessages.some((msg) => msg.role === 'tool');

    // Claude: no topP, and extended thinking requires signature replay on tool chain
    const isClaudeModel = String(model || '').includes('claude');
    // Some upstream "revision" models don't include "gemini" in the name (e.g. rev19-uic3-1p)
    const isGeminiModel =
        String(model || '').includes('gemini') ||
        String(actualModel || '').includes('gemini') ||
        String(model || '').startsWith('rev') ||
        String(actualModel || '').startsWith('rev');

    // Check if this is an image generation model (no system prompt, no thinking)
    const isImageModel = isImageGenerationModel(model);

    const looksLikeClaudeToolId = (id) => typeof id === 'string' && id.startsWith('toolu_');

    // OpenAI side: Claude tool chain needs signature replay (only for Claude-generated tool_call_id)
    // If history contains Claude tool_calls/tool results but cache missing -> downgrade thinking to avoid upstream error
    // Enable thinking: by model default OR by explicit thinking_budget/budget_tokens parameter
    let enableThinking = isThinkingModel(model) || thinking_budget !== undefined || budget_tokens !== undefined;
    if (enableThinking && isClaudeModel && (hasToolCallsInHistory || hasToolResultsInHistory)) {
        const ids = new Set();
        for (const msg of nonSystemMessages) {
            if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    if (tc?.id && looksLikeClaudeToolId(tc.id)) ids.add(tc.id);
                }
            }
            if (msg.role === 'tool' && msg.tool_call_id) {
                if (looksLikeClaudeToolId(msg.tool_call_id)) ids.add(msg.tool_call_id);
            }
        }
        const missingIds = [];
        for (const id of ids) {
            const cachedClaude = getCachedClaudeToolThinking(id);
            if (!cachedClaude?.signature) missingIds.push(id);
        }

        // Tolerate partial missing: signature is often shared per turn/message.
        // If any id has signature, fill others to avoid unnecessary downgrade.
        if (missingIds.length > 0) {
            let fallback = null;
            let fallbackThoughtText = '';
            for (const id of ids) {
                const cachedClaude = getCachedClaudeToolThinking(id);
                if (cachedClaude?.signature) {
                    fallback = cachedClaude.signature;
                    fallbackThoughtText = cachedClaude.thoughtText || '';
                    break;
                }
            }
            if (fallback) {
                for (const id of missingIds) {
                    cacheClaudeToolThinking(id, fallback, fallbackThoughtText);
                }
                missingIds.length = 0;
            }
        }

        if (missingIds.length > 0) {
            logThinkingDowngrade({
                provider: 'openai',
                route: '/v1/chat/completions',
                model: model || null,
                user_id: openaiRequest?.user || openaiRequest?.metadata?.user_id || null,
                reason: 'missing_thinking_signature_for_tool_use_history',
                missing_tool_use_ids: missingIds.slice(0, 50),
                missing_count: missingIds.length,
                request_id: requestId,
                note: 'using sentinel thoughtSignature for missing tool_call signatures'
            });
        }
    }

    // Claude thinking: if tool schema has no required, upstream may output only thinking then end (no tool_call)
    // Track tool names needing internal required placeholder.
    const claudeToolsNeedingRequiredPlaceholder = new Set();
    if (isClaudeModel && enableThinking && Array.isArray(tools)) {
        for (const t of tools) {
            const func = t?.function || t;
            const name = func?.name;
            if (!name) continue;
            const params = func?.parameters;
            if (needsClaudeToolRequiredArgPlaceholder(params)) {
                claudeToolsNeedingRequiredPlaceholder.add(String(name));
            }
        }
    }

    for (let i = 0; i < nonSystemMessages.length; i++) {
        const msg = nonSystemMessages[i];

        // Merge consecutive tool results into one user message
        // 支持多模态内容：将 base64 图片提取为 inlineData，避免 JSON.stringify 导致的 token 暴涨
        if (msg.role === 'tool') {
            const toolParts = [];
            while (i < nonSystemMessages.length && nonSystemMessages[i].role === 'tool') {
                const toolMsg = nonSystemMessages[i];

                // 拆分多模态内容：文本 vs 图片
                const { textParts, inlineDataParts } = splitOpenAIToolResultContent(toolMsg.content);

                // Cross-model history: if current is Claude but tool_call_id isn't Claude-style (toolu_), degrade to text context
                if (isClaudeModel && toolMsg.tool_call_id && !looksLikeClaudeToolId(toolMsg.tool_call_id)) {
                    const name = toolMsg.name || 'unknown';
                    const output = limitToolOutput(textParts, toolOutputLimiter, {
                        provider: 'openai',
                        route: '/v1/chat/completions',
                        model: model || null,
                        tool_name: name,
                        tool_call_id: toolMsg.tool_call_id
                    });
                    toolParts.push({ text: `[tool:${name}] ${output}` });

                    // 添加提取的 inlineData parts（图片）
                    if (inlineDataParts.length > 0) {
                        toolParts.push(...inlineDataParts);
                    }
                } else {
                    const output = limitToolOutput(textParts, toolOutputLimiter, {
                        provider: 'openai',
                        route: '/v1/chat/completions',
                        model: model || null,
                        tool_name: toolMsg.name || 'unknown',
                        tool_call_id: toolMsg.tool_call_id
                    });
                    toolParts.push({
                        functionResponse: {
                            id: toolMsg.tool_call_id,
                            name: toolMsg.name || 'unknown',
                            response: { output }
                        }
                    });

                    // 添加提取的 inlineData parts（图片）
                    if (inlineDataParts.length > 0) {
                        toolParts.push(...inlineDataParts);
                    }
                }
                i++;
            }
            i--; // outer loop will i++
            contents.push({ role: 'user', parts: toolParts });
        } else {
            // Cross-model history: if current is Claude but a historical assistant.tool_calls isn't Claude-style, skip it.
            if (isClaudeModel && msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.some((tc) => tc?.id && !looksLikeClaudeToolId(tc.id))) {
                const parts = [];
                if (typeof msg.content === 'string' && msg.content) {
                    parts.push({ text: msg.content });
                } else if (Array.isArray(msg.content) && msg.content.length > 0) {
                    for (const item of msg.content) {
                        if (item?.type === 'text' && typeof item.text === 'string' && item.text) {
                            parts.push({ text: item.text });
                        }
                    }
                }

                if (parts.length > 0) {
                    contents.push({ role: 'model', parts });
                }
                continue;
            }
            contents.push(convertMessage(msg, { isClaudeModel, isGeminiModel, enableThinking, claudeToolsNeedingRequiredPlaceholder }));
        }
    }

    if (isClaudeModel && enableThinking && hasTools) {
        const interleavedHint = 'Interleaved thinking is enabled. When tools are present, always emit a brief (non-empty) thinking block before any tool call and again after each tool result, before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.';
        if (!systemContent.includes(interleavedHint)) {
            systemContent = systemContent ? `${systemContent}\n\n${interleavedHint}` : interleavedHint;
        }
    }

    // Thinking budget: thinking_budget -> budget_tokens -> default
    const thinkingBudget = thinking_budget ?? budget_tokens ?? DEFAULT_THINKING_BUDGET;

    // generationConfig
    const generationConfig = {
        temperature: temperature ?? DEFAULT_TEMPERATURE,
        maxOutputTokens: max_tokens || 8192,
        candidateCount: 1
    };

    // Tool-chain: cap overly large max_tokens to reduce "Prompt is too long"
    const shouldCapOutputTokens =
        Number.isFinite(MAX_OUTPUT_TOKENS_WITH_TOOLS) &&
        MAX_OUTPUT_TOKENS_WITH_TOOLS > 0 &&
        (hasTools || hasToolCallsInHistory || hasToolResultsInHistory);
    if (shouldCapOutputTokens && generationConfig.maxOutputTokens > MAX_OUTPUT_TOKENS_WITH_TOOLS) {
        const minRequired = isClaudeModel && enableThinking ? thinkingBudget * 2 : 0;
        const effectiveCap = Math.max(MAX_OUTPUT_TOKENS_WITH_TOOLS, minRequired);
        generationConfig.maxOutputTokens = Math.min(generationConfig.maxOutputTokens, effectiveCap);
    }

    // Claude doesn't support topP
    if (!isClaudeModel && top_p !== undefined) {
        generationConfig.topP = top_p;
    }

    // stop sequences
    if (stop) {
        generationConfig.stopSequences = Array.isArray(stop) ? stop : [stop];
    }

    // thinking config
    if (enableThinking) {
        generationConfig.thinkingConfig = {
            includeThoughts: true,
            thinkingBudget: thinkingBudget
        };
        // Claude thinking requires maxOutputTokens > thinkingBudget
        if (isClaudeModel && generationConfig.maxOutputTokens <= thinkingBudget) {
            generationConfig.maxOutputTokens = thinkingBudget * 2;
        }
    } else if (isClaudeModel) {
        generationConfig.thinkingConfig = {
            includeThoughts: false,
            thinkingBudget: 0
        };
    }

    const request = {
        project: projectId || '',
        requestId,
        request: {
            contents,
            generationConfig,
            sessionId: sessionId || generateSessionId(),
            // 禁用 Gemini 安全过滤，避免 "no candidates" 错误
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_UNSPECIFIED', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_IMAGE_HATE', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_IMAGE_HARASSMENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_JAILBREAK', threshold: 'BLOCK_NONE' }
            ]
        },
        model: actualModel,
        userAgent: 'antigravity',
        requestType: isImageModel ? 'image_gen' : 'agent'
    };

    // systemInstruction: always prepend official prompt (upstream may validate it)
    // Skip for image generation models (they don't support system instructions)
    if (!isImageModel) {
        const upstreamSystemInstruction = buildUpstreamSystemInstruction(systemContent);
        if (upstreamSystemInstruction) {
            request.request.systemInstruction = upstreamSystemInstruction;
        }
    }

    // tools
    if (tools && tools.length > 0) {
        // Gemini tools require uppercase types; Claude/OpenAI require standard JSON Schema (lowercase types)
        const uppercaseTypes = isGeminiModel;
        const declarations = tools.map(t => {
            const func = t.function || t;
            return {
                name: func.name,
                description: func.description || '',
                parameters: convertJsonSchema(func.parameters, uppercaseTypes)
            };
        });
        if (isClaudeModel && enableThinking && claudeToolsNeedingRequiredPlaceholder.size > 0) {
            for (const d of declarations) {
                if (d && typeof d === 'object' && d.name && claudeToolsNeedingRequiredPlaceholder.has(d.name)) {
                    d.parameters = injectClaudeToolRequiredArgPlaceholderIntoSchema(d.parameters);
                }
            }
        }
        request.request.tools = [{ functionDeclarations: declarations }];
        request.request.toolConfig = {
            functionCallingConfig: {
                mode: tool_choice === 'none' ? 'NONE' : tool_choice === 'auto' ? 'AUTO' : 'VALIDATED'
            }
        };
    }

    return request;
}

function convertMessage(msg, ctx = {}) {
    const {
        isClaudeModel = false,
        isGeminiModel = false,
        enableThinking = false,
        claudeToolsNeedingRequiredPlaceholder = null
    } = ctx;
    const role = msg.role === 'assistant' ? 'model' : 'user';

    // tool result - 支持多模态内容
    if (msg.role === 'tool') {
        const { textParts, inlineDataParts } = splitOpenAIToolResultContent(msg.content);
        const output = typeof textParts === 'string' ? textParts : JSON.stringify(textParts);

        const parts = [{
            functionResponse: {
                id: msg.tool_call_id,
                name: msg.name || 'unknown',
                response: { output }
            }
        }];

        // 添加提取的 inlineData parts（图片）
        if (inlineDataParts.length > 0) {
            parts.push(...inlineDataParts);
        }

        return { role: 'user', parts };
    }

    // assistant tool_calls
    if (msg.role === 'assistant' && msg.tool_calls) {
        const parts = [];
        let replayClaudeSignature = null;

        // OpenAI endpoint: replay Claude tools signature from proxy cache
        if (isClaudeModel && enableThinking) {
            const firstToolCallId = msg.tool_calls?.[0]?.id;
            const replayClaude = firstToolCallId ? getCachedClaudeToolThinking(firstToolCallId) : null;
            if (replayClaude?.signature) {
                replayClaudeSignature = replayClaude.signature;
                let replayText = CLAUDE_OPENAI_REPLAY_INCLUDE_TEXT ? (replayClaude.thoughtText || '') : '';
                if (typeof replayText !== 'string') replayText = '';
                if (replayText === '') replayText = ' ';
                parts.push({
                    thought: true,
                    text: replayText,
                    thoughtSignature: replayClaude.signature
                });
            }
        }

        // text / multimodal content (must be after thinking to avoid Claude tool_use validation errors)
        if (typeof msg.content === 'string' && msg.content) {
            parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
            for (const item of msg.content) {
                if (item?.type === 'text' && typeof item.text === 'string' && item.text) {
                    parts.push({ text: item.text });
                }
                if (item?.type === 'image_url' && item.image_url?.url) {
                    const parsed = parseDataUrl(item.image_url.url);
                    if (parsed) {
                        parts.push({
                            inlineData: {
                                mimeType: parsed.mimeType,
                                data: parsed.data
                            }
                        });
                    }
                }
            }
        }

        // tool_calls
        for (const toolCall of msg.tool_calls) {
            const toolCallId = toolCall.id || `call_${uuidv4().slice(0, 8)}`;
            let thoughtSignature = getCachedToolThoughtSignature(toolCallId);
            let args = {};
            try {
                args = JSON.parse(toolCall.function.arguments || '{}');
            } catch {
                args = {};
            }
            if (
                isClaudeModel &&
                enableThinking &&
                claudeToolsNeedingRequiredPlaceholder &&
                toolCall?.function?.name &&
                claudeToolsNeedingRequiredPlaceholder.has(toolCall.function.name)
            ) {
                args = injectClaudeToolRequiredArgPlaceholderIntoArgs(args || {});
            }
            if (!thoughtSignature && isClaudeModel && enableThinking) {
                thoughtSignature = replayClaudeSignature || null;
            }
            // Gemini tools require thought_signature on functionCall parts
            // regardless of whether thinking mode is enabled or disabled
            if (!thoughtSignature && isGeminiModel) {
                thoughtSignature = GEMINI_THOUGHT_SIGNATURE_SENTINEL;
            }
            parts.push({
                ...(thoughtSignature ? { thoughtSignature } : {}),
                functionCall: {
                    id: toolCallId,
                    name: toolCall.function.name,
                    args
                }
            });
        }

        return { role: 'model', parts };
    }

    // plain text
    if (typeof msg.content === 'string') {
        return { role, parts: [{ text: msg.content }] };
    }

    // multimodal array
    if (Array.isArray(msg.content)) {
        const parts = msg.content
            .map((item) => {
                if (item.type === 'text') return { text: item.text };
                if (item.type === 'image_url') {
                    const { mimeType, data } = parseDataUrl(item.image_url.url);
                    return { inlineData: { mimeType, data } };
                }
                return null;
            })
            .filter(Boolean);
        return { role, parts };
    }

    return { role, parts: [{ text: String(msg.content || '') }] };
}

/**
 * Antigravity stream -> OpenAI stream chunks
 */
export function convertSSEChunk(antigravityData, requestId, model, includeThinking = false) {
    try {
        const data = JSON.parse(antigravityData);
        const candidate = data.response?.candidates?.[0];

        if (!candidate) return null;

        const chunks = [];
        const stateKey = requestId;
        const isClaudeModel = String(model || '').includes('claude');
        const isGeminiModel = String(model || '').includes('gemini');
        const claudeBuf = claudeToolThinkingBuffer.get(stateKey) || { signature: null, thoughtText: '', pendingToolCallIds: [] };
        if (!Array.isArray(claudeBuf.pendingToolCallIds)) claudeBuf.pendingToolCallIds = [];
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];

        const flushClaudePendingToolCalls = () => {
            if (!isClaudeModel) return;
            const signature = claudeBuf.signature;
            if (!signature) return;
            const pending = claudeBuf.pendingToolCallIds;
            if (!Array.isArray(pending) || pending.length === 0) return;
            for (const id of pending) {
                cacheClaudeToolThinking(id, signature, claudeBuf.thoughtText);
            }
            claudeBuf.pendingToolCallIds = [];
        };

        // fallback: signature may appear at candidate/response level
        if (isClaudeModel) {
            const preSig = extractThoughtSignatureFromCandidate(candidate, data);
            if (preSig && !claudeBuf.signature) {
                claudeBuf.signature = preSig;
            }
            flushClaudePendingToolCalls();
        }

        for (const part of parts) {
            // thought
            if (part.thought) {
                if (isClaudeModel) {
                    const sig = extractThoughtSignatureFromPart(part);
                    if (sig) claudeBuf.signature = sig;
                    if (part.text) claudeBuf.thoughtText += part.text;
                    claudeToolThinkingBuffer.set(stateKey, claudeBuf);
                    flushClaudePendingToolCalls();
                }
                if (!includeThinking) continue;

                const thoughtText = part.text ?? '';

                if (OPENAI_THINKING_INCLUDE_REASONING && thoughtText) {
                    chunks.push({
                        id: `chatcmpl-${requestId}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [{
                            index: 0,
                            delta: { reasoning_content: thoughtText },
                            finish_reason: null
                        }]
                    });
                }

                if (OPENAI_THINKING_INCLUDE_TAGS && thoughtText) {
                    const wasThinking = thinkingState.get(stateKey);
                    let content = thoughtText;
                    if (!wasThinking) {
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
                            delta: { content },
                            finish_reason: null
                        }]
                    });
                }
                continue;
            }

            // close </think> when leaving thinking mode
            if (OPENAI_THINKING_INCLUDE_TAGS && thinkingState.get(stateKey) && (part.text !== undefined || part.functionCall || part.inlineData)) {
                chunks.push({
                    id: `chatcmpl-${requestId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        delta: { content: '</think>' },
                        finish_reason: null
                    }]
                });
                thinkingState.delete(stateKey);
            }

            // tool_call
            if (part.functionCall) {
                const callId = part.functionCall.id || `call_${uuidv4().slice(0, 8)}`;
                const cleanedArgs = stripClaudeToolRequiredArgPlaceholderFromArgs(part.functionCall.args || {});
                const sig = extractThoughtSignatureFromPart(part);
                // 仅 Gemini 模型需要写入 toolThoughtSignatureCache
                if (sig && isGeminiModel) {
                    cacheToolThoughtSignature(callId, sig);
                }
                if (isClaudeModel) {
                    const signature = claudeBuf.signature || sig;
                    if (signature) {
                        if (!claudeBuf.signature) claudeBuf.signature = signature;
                        cacheClaudeToolThinking(callId, signature, claudeBuf.thoughtText);
                        flushClaudePendingToolCalls();
                    } else {
                        claudeBuf.pendingToolCallIds.push(callId);
                        claudeToolThinkingBuffer.set(stateKey, claudeBuf);
                    }
                }
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
                                id: callId,
                                type: 'function',
                                function: {
                                    name: part.functionCall.name,
                                    arguments: JSON.stringify(cleanedArgs || {})
                                }
                            }]
                        },
                        finish_reason: null
                    }]
                });
                continue;
            }

            // text
            if (part.text !== undefined) {
                chunks.push({
                    id: `chatcmpl-${requestId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        delta: { content: part.text },
                        finish_reason: null
                    }]
                });
            }

            // image output
            if (part.inlineData) {
                const dataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                chunks.push({
                    id: `chatcmpl-${requestId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        delta: { content: `![image](${dataUrl})` },
                        finish_reason: null
                    }]
                });
            }
        }

        // finish
        if (candidate.finishReason === 'STOP' || candidate.finishReason === 'MAX_TOKENS') {
            flushClaudePendingToolCalls();
            claudeToolThinkingBuffer.delete(stateKey);
            if (OPENAI_THINKING_INCLUDE_TAGS && thinkingState.get(stateKey)) {
                chunks.push({
                    id: `chatcmpl-${requestId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        delta: { content: '</think>' },
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
    } catch {
        return null;
    }
}

/**
 * Antigravity non-stream -> OpenAI response
 */
export function convertResponse(antigravityResponse, requestId, model, includeThinking = false) {
    try {
        const data = antigravityResponse;
        const upstreamError = data?.error || data?.response?.error;
        if (upstreamError) {
            const message = upstreamError?.message || upstreamError?.error?.message || JSON.stringify(upstreamError);
            throw new Error(message || 'Upstream returned an error');
        }
        const candidate = data.response?.candidates?.[0];
        const usage = data.response?.usageMetadata;

        if (!candidate) {
            const promptFeedback = data.response?.promptFeedback;
            const blockReason = promptFeedback?.blockReason || promptFeedback?.blockReasonMessage;
            if (blockReason) {
                throw new Error(`Upstream blocked request: ${blockReason}`);
            }
            // 包含更多上游响应信息帮助排查
            const finishReason = data.response?.candidates?.[0]?.finishReason;
            const safetyRatings = promptFeedback?.safetyRatings;
            let detail = 'Upstream returned no candidates';
            if (finishReason) detail += ` (finishReason: ${finishReason})`;
            if (safetyRatings) detail += ` (safetyRatings: ${JSON.stringify(safetyRatings)})`;
            if (!finishReason && !safetyRatings && data.response) {
                detail += ` (response: ${JSON.stringify(data.response).slice(0, 500)})`;
            }
            throw new Error(detail);
        }

        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];

        let content = '';
        let reasoningContent = '';
        const toolCalls = [];
        const isClaudeModel = String(model || '').includes('claude');
        const isGeminiModel = String(model || '').includes('gemini');
        let claudeThoughtText = '';
        let claudeSignature = extractThoughtSignatureFromCandidate(candidate, data);
        const claudeToolCallIds = [];
        const claudeSignatureByToolCallId = new Map();

        for (const part of parts) {
            if (part.thought) {
                const thoughtText = part.text ?? '';
                if (isClaudeModel) {
                    if (thoughtText) claudeThoughtText += thoughtText;
                    const sig = extractThoughtSignatureFromPart(part);
                    if (sig) claudeSignature = sig;
                }
                if (!includeThinking) continue;

                if (OPENAI_THINKING_INCLUDE_REASONING && thoughtText) {
                    reasoningContent += thoughtText;
                }
                if (OPENAI_THINKING_INCLUDE_TAGS && thoughtText) {
                    content += `<think>${thoughtText}</think>`;
                }
                continue;
            }

            if (part.text) {
                content += part.text;
            }

            if (part.functionCall) {
                const callId = part.functionCall.id || `call_${uuidv4().slice(0, 8)}`;
                const cleanedArgs = stripClaudeToolRequiredArgPlaceholderFromArgs(part.functionCall.args || {});
                const sig = extractThoughtSignatureFromPart(part);
                // 仅 Gemini 模型需要写入 toolThoughtSignatureCache
                if (sig && isGeminiModel) {
                    cacheToolThoughtSignature(callId, sig);
                }
                if (isClaudeModel) {
                    if (sig) {
                        claudeSignatureByToolCallId.set(callId, sig);
                        if (!claudeSignature) claudeSignature = sig;
                    }
                    claudeToolCallIds.push(callId);
                }
                toolCalls.push({
                    id: callId,
                    type: 'function',
                    function: {
                        name: part.functionCall.name,
                        arguments: JSON.stringify(cleanedArgs || {})
                    }
                });
            }

            if (part.inlineData) {
                const dataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                content += `![image](${dataUrl})`;
            }
        }

        // Claude (OpenAI endpoint): some upstreams send thought/signature after functionCall.
        if (isClaudeModel && claudeToolCallIds.length > 0) {
            for (const id of claudeToolCallIds) {
                const sig = claudeSignatureByToolCallId.get(id) || claudeSignature;
                if (sig) {
                    cacheClaudeToolThinking(id, sig, claudeThoughtText);
                }
            }
        }

        const message = { role: 'assistant', content };

        if (OPENAI_THINKING_INCLUDE_REASONING && reasoningContent) {
            message.reasoning_content = reasoningContent;
        }

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

export function getModelsList() {
    return {
        object: 'list',
        data: AVAILABLE_MODELS.map((m) => ({
            id: m.id,
            object: 'model',
            created: 1700000000,
            owned_by: m.provider
        }))
    };
}
