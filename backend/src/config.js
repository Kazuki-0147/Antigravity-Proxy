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
    { id: 'gemini-3-pro-high', displayName: 'Gemini 3 Pro (High)', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3-pro-low', displayName: 'Gemini 3 Pro (Low)', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-flash-thinking', displayName: 'Gemini 2.5 Flash (Thinking)', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite', provider: 'google', supportsImages: false, supportsThinking: false, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3-pro-image', displayName: 'Gemini 3 Pro Image', provider: 'google', supportsImages: true, supportsThinking: false },
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
    'claude-sonnet-4-5-thinking': 'claude-sonnet-4-5',
    // Claude Haiku 不存在，映射到 Opus
    'claude-haiku-4-5-20251001': 'claude-opus-4-5-thinking',
    'gemini-2.5-flash-thinking': 'gemini-2.5-flash',
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
    'gemini-3-pro-high',
    'gemini-3-pro-low',
    'claude-opus-4-5-thinking',
    'claude-sonnet-4-5-thinking',
    'claude-haiku-4-5-20251001',
    'gpt-oss-120b-medium'
];

// 判断模型是否启用思维链
export function isThinkingModel(model) {
    return THINKING_MODELS.includes(model) || model.endsWith('-thinking');
}

// 获取实际发送的模型名称
export function getMappedModel(model) {
    return MODEL_MAPPING[model] || model;
}
