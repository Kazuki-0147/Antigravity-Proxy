// Antigravity OAuth 配置（从软件中提取的固定值）
export const OAUTH_CONFIG = {
    client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    client_secret: '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',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    auth_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs'
    ].join(' ')
};

// Antigravity API 配置
export const ANTIGRAVITY_CONFIG = {
    base_url: 'https://daily-cloudcode-pa.sandbox.googleapis.com',
    user_agent: 'antigravity/1.11.3 windows/amd64'
};

// Antigravity 官方系统提示词（上游可能会校验；可用 OFFICIAL_SYSTEM_PROMPT 覆盖）
export const DEFAULT_OFFICIAL_SYSTEM_PROMPT =
    'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.' +
    'You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.' +
    '**Proactiveness**';

export const OFFICIAL_SYSTEM_PROMPT = String(process.env.OFFICIAL_SYSTEM_PROMPT || DEFAULT_OFFICIAL_SYSTEM_PROMPT);

// 服务器配置
export const SERVER_CONFIG = {
    port: process.env.PORT || 3000,
    host: process.env.HOST || '127.0.0.1',
    db_path: process.env.DB_PATH || './data/database.sqlite',
    admin_password: process.env.ADMIN_PASSWORD || 'admin123',
    // 管理接口兼容：Authorization: Bearer <ADMIN_PASSWORD>
    // 默认开启；可通过环境变量关闭（0/false/no/off）
    admin_password_bearer_compat: parseBoolean(process.env.ADMIN_PASSWORD_BEARER_COMPAT, true)
};

function parseBoolean(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const v = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
    return defaultValue;
}

// 可用模型列表
export const AVAILABLE_MODELS = [
    { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536 },
    // 兼容：通过模型名显式启用 thinking（映射到 gemini-3-flash）
    { id: 'gemini-3-flash-thinking', displayName: 'Gemini 3 Flash (Thinking)', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536 },
    { id: 'gemini-3-pro-high', displayName: 'Gemini 3 Pro (High)', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3-pro-low', displayName: 'Gemini 3 Pro (Low)', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-flash-thinking', displayName: 'Gemini 2.5 Flash (Thinking)', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite', provider: 'google', supportsImages: false, supportsThinking: false, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3-pro-image', displayName: 'Gemini 3 Pro Image', provider: 'google', supportsImages: true, supportsThinking: true },
    // 上游内部 revision 模型：可以调用，但小 max_tokens 可能只输出思考 token 而无文本 parts
    { id: 'rev19-uic3-1p', displayName: 'rev19-uic3-1p', provider: 'google', supportsImages: false, supportsThinking: false },
    { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', provider: 'anthropic', supportsImages: true, supportsThinking: false, maxTokens: 200000, maxOutputTokens: 64000 },
    { id: 'claude-opus-4-5-thinking', displayName: 'Claude Opus 4.5 (Thinking)', provider: 'anthropic', supportsImages: true, supportsThinking: true, maxTokens: 200000, maxOutputTokens: 64000 },
    { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', provider: 'anthropic', supportsImages: true, supportsThinking: false, maxTokens: 200000, maxOutputTokens: 64000 },
    { id: 'claude-sonnet-4-5-thinking', displayName: 'Claude Sonnet 4.5 (Thinking)', provider: 'anthropic', supportsImages: true, supportsThinking: true, maxTokens: 200000, maxOutputTokens: 64000 },
    { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)', provider: 'openai', supportsImages: false, supportsThinking: true, maxTokens: 131072, maxOutputTokens: 32768 }
];

// 模型名称映射（用户请求的模型 -> 实际发送的模型）
export const MODEL_MAPPING = {
    'claude-opus-4-5': 'claude-opus-4-5-thinking',
    // Claude Code 常用简写模型名（避免上游报 Requested entity was not found）
    'claude-4-5-thinking': 'claude-opus-4-5-thinking',
    'claude-4-5': 'claude-opus-4-5-thinking',
    // thinking 版本在上游是独立模型：不要降级到非 thinking，否则会导致工具调用场景无思维链输出
    'claude-sonnet-4-5-thinking': 'claude-sonnet-4-5-thinking',
    // Claude Haiku 不存在，映射到 Opus
    'claude-haiku-4-5-20251001': 'claude-opus-4-5-thinking',
    'gemini-2.5-flash-thinking': 'gemini-2.5-flash',
    'gemini-3-flash-thinking': 'gemini-3-flash',
    // 兼容旧版模型名称
    'gemini-2.0-flash': 'gemini-2.5-flash',
    'gemini-2.0-flash-thinking': 'gemini-2.5-flash',
    'gemini-2.0-pro': 'gemini-2.5-pro',
    'gemini-1.5-flash': 'gemini-2.5-flash',
    'gemini-1.5-pro': 'gemini-2.5-pro',
    'gemini-flash': 'gemini-2.5-flash',
    'gemini-pro': 'gemini-2.5-pro'
};

// 默认启用思维链的模型
export const THINKING_MODELS = [
    'gemini-2.5-pro',
    'gemini-2.5-flash-thinking',
    'gemini-3-flash-thinking',
    'gemini-3-pro-high',
    'gemini-3-pro-low',
    'gemini-3-pro-image',
    'claude-opus-4-5-thinking',
    'claude-sonnet-4-5-thinking',
    'claude-haiku-4-5-20251001',
    'gpt-oss-120b-medium'
];

// 判断模型是否启用思维链
export function isThinkingModel(model) {
    return THINKING_MODELS.includes(model) || model.endsWith('-thinking');
}

// 判断模型是否是图像生成模型（不支持系统提示词，但支持思维链）
export function isImageGenerationModel(model) {
    return model === 'gemini-3-pro-image' || model.includes('-image');
}

// 获取实际发送的模型名称
export function getMappedModel(model) {
    return MODEL_MAPPING[model] || model;
}

// ========= 集中配置（供 routes / converter 共用） =========

// 注意：部分配置此前是在请求处理时读取 env（支持运行期调整）。
// 为保持行为一致，这里使用 getter 读取 process.env。
export const RETRY_CONFIG = Object.freeze({
    // countTokens 请求的切号重试次数（硬编码，无需配置）
    maxRetries: 2,
    get baseRetryDelayMs() {
        return Math.max(0, Number(process.env.UPSTREAM_CAPACITY_RETRY_DELAY_MS || 1000));
    },
    // 同号重试次数（在换号前先重试几次）
    get sameAccountRetries() {
        return Math.max(0, Number(process.env.SAME_ACCOUNT_RETRIES || 2));
    },
    // 同号重试延迟 (ms)
    get sameAccountRetryDelayMs() {
        return Math.max(0, Number(process.env.SAME_ACCOUNT_RETRY_DELAY_MS || 500));
    },
    // 连续失败多少次才禁用账号
    get errorCountToDisable() {
        return Math.max(1, Number(process.env.ERROR_COUNT_TO_DISABLE || 3));
    },
    // 重试总超时时间 (ms)，默认 30 秒，避免客户端长时间等待
    get totalTimeoutMs() {
        return Math.max(0, Number(process.env.RETRY_TOTAL_TIMEOUT_MS || 30000));
    }
});

export const CONVERTER_CONFIG = Object.freeze({
    DEFAULT_THINKING_BUDGET: 4096,
    DEFAULT_TEMPERATURE: 1,
    // tool_result budget controls (applies only to tool_result forwarded upstream)
    get TOOL_RESULT_MAX_CHARS() {
        return Number(process.env.TOOL_RESULT_MAX_CHARS ?? 0);
    },
    get TOOL_RESULT_TOTAL_MAX_CHARS() {
        return Number(process.env.TOOL_RESULT_TOTAL_MAX_CHARS ?? 0);
    },
    get TOOL_RESULT_TAIL_CHARS() {
        return Number(process.env.TOOL_RESULT_TAIL_CHARS || 1200);
    },
    get TOOL_RESULT_TRUNCATE_LOG() {
        return parseBoolean(process.env.TOOL_RESULT_TRUNCATE_LOG, true);
    },
    // cap max_tokens when request contains tools/tool_results
    get MAX_OUTPUT_TOKENS_WITH_TOOLS() {
        return Number(process.env.MAX_OUTPUT_TOKENS_WITH_TOOLS ?? 0);
    }
});

export const SIGNATURE_CACHE_CONFIG = Object.freeze({
    // Anthropic thinking.signature cache TTL (ms)
    get CLAUDE_THINKING_SIGNATURE_TTL_MS() {
        return Number(process.env.CLAUDE_THINKING_SIGNATURE_TTL_MS || 24 * 60 * 60 * 1000);
    },
    // userKey -> last signature TTL (ms)
    get CLAUDE_LAST_SIGNATURE_TTL_MS() {
        return Number(process.env.CLAUDE_LAST_SIGNATURE_TTL_MS || 24 * 60 * 60 * 1000);
    }
});
