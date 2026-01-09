-- 账号表
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    refresh_token TEXT NOT NULL,
    access_token TEXT,
    token_expires_at INTEGER,
    project_id TEXT,
    tier TEXT DEFAULT 'free-tier',
    status TEXT DEFAULT 'active',
    quota_remaining REAL DEFAULT 1.0,
    quota_reset_time INTEGER,
    last_used_at INTEGER,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- 账号-模型配额表（同一账号不同模型配额可能不同）
CREATE TABLE IF NOT EXISTS account_model_quotas (
    account_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    quota_remaining REAL,
    quota_reset_time INTEGER,
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    PRIMARY KEY (account_id, model),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- 请求日志表
CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    api_key_id INTEGER,
    model TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    thinking_tokens INTEGER,
    status TEXT,
    latency_ms INTEGER,
    error_message TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

-- 系统配置表
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- API Key 表
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT,
    status TEXT DEFAULT 'active',
    request_count INTEGER DEFAULT 0,
    token_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    last_used_at INTEGER
);

-- Signature 缓存（用于 Claude extended thinking / tool signature 回放，避免客户端不回放导致上游校验失败）
CREATE TABLE IF NOT EXISTS signature_cache (
    kind TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    signature TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (kind, cache_key)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_quota ON accounts(quota_remaining);
CREATE INDEX IF NOT EXISTS idx_account_model_quotas_model ON account_model_quotas(model);
CREATE INDEX IF NOT EXISTS idx_account_model_quotas_model_quota ON account_model_quotas(model, quota_remaining);
CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_account ON request_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);
CREATE INDEX IF NOT EXISTS idx_signature_cache_saved_at ON signature_cache(saved_at);
