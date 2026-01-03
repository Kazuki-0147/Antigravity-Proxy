import { v4 as uuidv4 } from 'uuid';

import { AVAILABLE_MODELS, getMappedModel, isThinkingModel } from '../../config.js';

import { injectClaudeToolRequiredArgPlaceholderIntoArgs, injectClaudeToolRequiredArgPlaceholderIntoSchema, needsClaudeToolRequiredArgPlaceholder, stripClaudeToolRequiredArgPlaceholderFromArgs } from './claude-tool-placeholder.js';
import { convertTool, generateSessionId, parseDataUrl } from './schema-converter.js';
import { cacheClaudeToolThinking, cacheToolThoughtSignature, getCachedClaudeToolThinking, getCachedToolThoughtSignature, logThinkingDowngrade } from './signature-cache.js';
import { extractThoughtSignatureFromCandidate, extractThoughtSignatureFromPart } from './thought-signature-extractor.js';
import { createToolOutputLimiter, limitToolOutput } from './tool-output-limiter.js';

// Defaults
const DEFAULT_THINKING_BUDGET = 4096;
const DEFAULT_TEMPERATURE = 1;
const CLAUDE_TOOL_SIGNATURE_SENTINEL = 'skip_thought_signature_validator';

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
    const isClaudeModel = model.includes('claude');

    const looksLikeClaudeToolId = (id) => typeof id === 'string' && id.startsWith('toolu_');

    // OpenAI side: Claude tool chain needs signature replay (only for Claude-generated tool_call_id)
    // If history contains Claude tool_calls/tool results but cache missing -> downgrade thinking to avoid upstream error
    let enableThinking = isThinkingModel(model);
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
        if (msg.role === 'tool') {
            const toolParts = [];
            while (i < nonSystemMessages.length && nonSystemMessages[i].role === 'tool') {
                const toolMsg = nonSystemMessages[i];
                // Cross-model history: if current is Claude but tool_call_id isn't Claude-style (toolu_), degrade to text context
                if (isClaudeModel && toolMsg.tool_call_id && !looksLikeClaudeToolId(toolMsg.tool_call_id)) {
                    const name = toolMsg.name || 'unknown';
                    const output = limitToolOutput(toolMsg.content, toolOutputLimiter, {
                        provider: 'openai',
                        route: '/v1/chat/completions',
                        model: model || null,
                        tool_name: name,
                        tool_call_id: toolMsg.tool_call_id
                    });
                    toolParts.push({ text: `[tool:${name}] ${output}` });
                } else {
                    const output = limitToolOutput(toolMsg.content, toolOutputLimiter, {
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
            contents.push(convertMessage(msg, { isClaudeModel, enableThinking, claudeToolsNeedingRequiredPlaceholder }));
        }
    }

    if (isClaudeModel && enableThinking && hasTools) {
        const interleavedHint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.';
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
            sessionId: sessionId || generateSessionId()
        },
        model: actualModel,
        userAgent: 'antigravity',
        requestType: 'agent'
    };

    // systemInstruction
    if (systemContent) {
        request.request.systemInstruction = {
            role: 'user',
            parts: [{ text: systemContent }]
        };
    }

    // tools
    if (tools && tools.length > 0) {
        const declarations = tools.map(convertTool);
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
        enableThinking = false,
        claudeToolsNeedingRequiredPlaceholder = null
    } = ctx;
    const role = msg.role === 'assistant' ? 'model' : 'user';

    // tool result
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

    // assistant tool_calls
    if (msg.role === 'assistant' && msg.tool_calls) {
        const parts = [];

        // OpenAI endpoint: replay Claude tools signature from proxy cache
        if (isClaudeModel && enableThinking) {
            const firstToolCallId = msg.tool_calls?.[0]?.id;
            const replayClaude = firstToolCallId ? getCachedClaudeToolThinking(firstToolCallId) : null;
            if (replayClaude?.signature) {
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
                thoughtSignature = CLAUDE_TOOL_SIGNATURE_SENTINEL;
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
                if (sig) {
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

        let content = '';
        let reasoningContent = '';
        const toolCalls = [];
        const isClaudeModel = String(model || '').includes('claude');
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
                if (sig) {
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
