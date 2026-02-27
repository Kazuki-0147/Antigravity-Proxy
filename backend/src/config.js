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
// 版本号由 versionFetcher 服务动态更新，支持热更新
let _agVersion = '1.19.5'; // 默认回退值

export function setAgVersion(version) {
    if (version && typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) {
        _agVersion = version;
    }
}

export function getAgVersion() {
    return _agVersion;
}

export const ANTIGRAVITY_CONFIG = {
    base_url: 'https://daily-cloudcode-pa.googleapis.com',
    get user_agent() {
        return `antigravity/${_agVersion} windows/amd64`;
    }
};

// Unleash 功能开关 Token
export const UNLEASH_TOKENS = {
    frontend: 'production.eb07600f9680e825c582db6570e7e0adf500657b3dc4802625ba4516',
    client: 'production.e44558998bfc35ea9584dc65858e4485fdaa5d7ef46903e0c67712d1'
};

// Antigravity 官方系统提示词（上游可能会校验；可用 OFFICIAL_SYSTEM_PROMPT 覆盖）
export const DEFAULT_OFFICIAL_SYSTEM_PROMPT =
    'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.' +
    'You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.' +
    '**Proactiveness**';

// 使用 getter 延迟读取，确保 .env 加载后再获取值
export const OFFICIAL_SYSTEM_PROMPT_CONFIG = Object.freeze({
    get value() {
        return String(process.env.OFFICIAL_SYSTEM_PROMPT || DEFAULT_OFFICIAL_SYSTEM_PROMPT);
    }
});

// 兼容：直接导出（运行时读取）
export function getOfficialSystemPrompt() {
    return OFFICIAL_SYSTEM_PROMPT_CONFIG.value;
}

// 服务器配置（使用 getter 延迟读取，确保 .env 加载后再获取值）
export const SERVER_CONFIG = Object.freeze({
    get port() {
        return process.env.PORT || 8088;
    },
    get host() {
        return process.env.HOST || '127.0.0.1';
    },
    get db_path() {
        return process.env.DB_PATH || './data/database.sqlite';
    },
    get admin_password() {
        return process.env.ADMIN_PASSWORD || 'admin123';
    },
    // 管理接口兼容：Authorization: Bearer <ADMIN_PASSWORD>
    // 默认开启；可通过环境变量关闭（0/false/no/off）
    get admin_password_bearer_compat() {
        return parseBoolean(process.env.ADMIN_PASSWORD_BEARER_COMPAT, true);
    }
});

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
    { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-flash-thinking', displayName: 'Gemini 2.5 Flash (Thinking)', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite', provider: 'google', supportsImages: false, supportsThinking: false, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3.1-pro-low', displayName: 'Gemini 3.1 Pro (Low)', provider: 'google', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', provider: 'google', supportsImages: true, supportsThinking: true },
    { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', provider: 'anthropic', supportsImages: true, supportsThinking: false, maxTokens: 200000, maxOutputTokens: 64000 },
    { id: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 (Thinking)', provider: 'anthropic', supportsImages: true, supportsThinking: true, maxTokens: 200000, maxOutputTokens: 64000 },
    { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', provider: 'anthropic', supportsImages: true, supportsThinking: false, maxTokens: 200000, maxOutputTokens: 64000 },
    { id: 'claude-sonnet-4-6-thinking', displayName: 'Claude Sonnet 4.6 (Thinking)', provider: 'anthropic', supportsImages: true, supportsThinking: true, maxTokens: 200000, maxOutputTokens: 64000 },
];

// 模型名称映射（用户请求的模型 -> 实际发送的模型）
export const MODEL_MAPPING = {
    'claude-opus-4-6': 'claude-opus-4-6-thinking',
    'claude-4-6-thinking': 'claude-opus-4-6-thinking',
    'claude-4-6': 'claude-opus-4-6-thinking',
    'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
    // 废弃模型兼容映射
    'claude-opus-4-5': 'claude-opus-4-6-thinking',
    'claude-opus-4-5-thinking': 'claude-opus-4-6-thinking',
    'claude-4-5-thinking': 'claude-opus-4-6-thinking',
    'claude-4-5': 'claude-opus-4-6-thinking',
    'claude-sonnet-4-5': 'claude-sonnet-4-6',
    'claude-sonnet-4-5-thinking': 'claude-sonnet-4-6',
    // Claude Haiku 不存在，映射到 Opus 4.6
    'claude-haiku-4-5-20251001': 'claude-opus-4-6',
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

export const QUOTA_GROUPS = Object.freeze({
    FLASH: 'flash',
    PRO: 'pro',
    CLAUDE: 'claude',
    IMAGE: 'image'
});

// 默认启用思维链的模型
export const THINKING_MODELS = [
    'gemini-2.5-pro',
    'gemini-2.5-flash-thinking',
    'gemini-3-flash-thinking',
    'gemini-3.1-pro-high',
    'gemini-3.1-pro-low',
    'gemini-3.1-flash-image',
    'claude-opus-4-6-thinking',
    'claude-sonnet-4-6-thinking'
];

// 判断模型是否启用思维链
export function isThinkingModel(model) {
    const m = String(model || '');
    return THINKING_MODELS.includes(m) || m.endsWith('-thinking');
}

// 判断模型是否是图像生成模型（不支持系统提示词，但支持思维链）
export function isImageGenerationModel(model) {
    const m = String(model || '');
    return m === 'gemini-3.1-flash-image' || m.includes('-image');
}

// 获取实际发送的模型名称
export function getMappedModel(model) {
    return MODEL_MAPPING[model] || model;
}

export function getQuotaGroup(model) {
    const mapped = String(getMappedModel(model) || '').trim().toLowerCase();
    if (!mapped) return null;

    if (mapped.includes('image')) return QUOTA_GROUPS.IMAGE;
    if (mapped.includes('claude')) return QUOTA_GROUPS.CLAUDE;
    if (mapped.includes('gemini') && mapped.includes('pro')) return QUOTA_GROUPS.PRO;
    if (mapped.includes('gemini') && mapped.includes('flash')) return QUOTA_GROUPS.FLASH;
    return null;
}

function clampFraction(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

export function getGroupQuotaThreshold(group = null) {
    const globalThreshold = clampFraction(process.env.GROUP_QUOTA_MIN_THRESHOLD ?? 0.2, 0.2);
    const key = String(group || '').trim().toLowerCase();
    if (!key) return globalThreshold;

    if (key === QUOTA_GROUPS.FLASH) {
        return clampFraction(process.env.FLASH_GROUP_QUOTA_MIN_THRESHOLD ?? globalThreshold, globalThreshold);
    }
    if (key === QUOTA_GROUPS.PRO) {
        return clampFraction(process.env.PRO_GROUP_QUOTA_MIN_THRESHOLD ?? globalThreshold, globalThreshold);
    }
    if (key === QUOTA_GROUPS.CLAUDE) {
        return clampFraction(process.env.CLAUDE_GROUP_QUOTA_MIN_THRESHOLD ?? globalThreshold, globalThreshold);
    }
    if (key === QUOTA_GROUPS.IMAGE) {
        return clampFraction(process.env.IMAGE_GROUP_QUOTA_MIN_THRESHOLD ?? globalThreshold, globalThreshold);
    }
    return globalThreshold;
}

// Safety settings：完整版（11 类）和基础版（5 类）
const FULL_SAFETY_SETTINGS = [
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
];

const BASIC_SAFETY_SETTINGS = FULL_SAFETY_SETTINGS.slice(0, 4);

const BASIC_SAFETY_MODELS = new Set(['gemini-2.5-flash-lite']);

export function getSafetySettings(model) {
    if (!model || model.startsWith('claude-') || model.startsWith('gpt-')) return undefined;
    return BASIC_SAFETY_MODELS.has(model) ? BASIC_SAFETY_SETTINGS : FULL_SAFETY_SETTINGS;
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
