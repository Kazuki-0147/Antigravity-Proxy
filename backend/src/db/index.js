import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SERVER_CONFIG } from '../config.js';
import { migrateDeviceIdentityColumns } from '../services/deviceIdentity.js';
import { resolveRuntimePath } from '../runtime/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db = null;

/**
 * 初始化数据库
 * @param {Object} options - 配置选项
 * @param {string} options.dbPath - 数据库路径（可选，默认使用 SERVER_CONFIG）
 * @param {string|Object} options.nativeBinding - better-sqlite3 原生模块路径或已加载的模块
 * @param {string} options.schemaSql - 内联的 schema SQL（可选，默认从文件读取）
 */
export function initDatabase(options = {}) {
    const dbPath = resolveRuntimePath(options.dbPath || SERVER_CONFIG.db_path);
    const nativeBinding = options.nativeBinding;
    const schemaSql = options.schemaSql;

    // 构建 better-sqlite3 选项
    const sqliteOptions = {};
    if (nativeBinding !== undefined && nativeBinding !== null) {
        sqliteOptions.nativeBinding = nativeBinding;
    }

    db = new Database(dbPath, sqliteOptions);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // 执行 schema（优先使用传入的内联 SQL，否则从文件读取）
    const schema =
        typeof schemaSql === 'string' && schemaSql.length > 0
            ? schemaSql
            : readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);

    // 迁移：移除 email 的 NOT NULL 约束（SQLite 需要重建表）
    migrateEmailNullable(db);

    // 迁移：添加设备指纹字段
    migrateDeviceIdentityColumns(db);

    return db;
}

function migrateEmailNullable(db) {
    const tableInfo = db.prepare("PRAGMA table_info(accounts)").all();
    const emailCol = tableInfo.find(c => c.name === 'email');
    if (!emailCol || emailCol.notnull === 0) return;

    db.exec('PRAGMA foreign_keys = OFF');
    db.transaction(() => {
        db.exec(`
            CREATE TABLE accounts_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE,
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
            )
        `);
        db.exec(`
            INSERT INTO accounts_new SELECT * FROM accounts
        `);
        db.exec('DROP TABLE accounts');
        db.exec('ALTER TABLE accounts_new RENAME TO accounts');
        db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_quota ON accounts(quota_remaining)');
    })();
    db.exec('PRAGMA foreign_keys = ON');
}

export function getDatabase() {
    if (!db) {
        throw new Error('Database not initialized');
    }
    return db;
}

// ==================== Account 操作 ====================

export function getAllAccounts() {
    return getDatabase().prepare(`
        SELECT id, email, status, tier, quota_remaining, quota_reset_time,
               last_used_at, error_count, last_error, created_at,
               CASE WHEN token_expires_at > ? THEN 1 ELSE 0 END as token_valid
        FROM accounts ORDER BY created_at DESC
    `).all(Date.now());
}

// 管理用途：包含 refresh_token/access_token 等字段（排除 disabled）
export function getAllAccountsForRefresh() {
    return getDatabase().prepare(`
        SELECT * FROM accounts
        WHERE status != 'disabled'
        ORDER BY created_at DESC
    `).all();
}

// 兼容：按模型选择可用账号（同一账号不同模型配额可能不同）
export function getActiveAccounts(model = null, options = null) {
    const minQuotaRemaining = Math.max(0, Number(options?.minQuotaRemaining ?? 0));

    if (model) {
        const isGroupKey = String(model).startsWith('group:');
        if (isGroupKey) {
            return getDatabase().prepare(`
                SELECT
                    a.id,
                    a.email,
                    a.refresh_token,
                    a.access_token,
                    a.token_expires_at,
                    a.project_id,
                    a.tier,
                    a.status,
                    COALESCE(q.quota_remaining, 0) AS quota_remaining,
                    q.quota_reset_time AS quota_reset_time,
                    a.last_used_at,
                    a.error_count,
                    a.last_error,
                    a.created_at
                FROM accounts a
                LEFT JOIN account_model_quotas q
                    ON q.account_id = a.id AND q.model = ?
                WHERE a.status = 'active'
                    AND COALESCE(q.quota_remaining, 0) >= ?
                ORDER BY
                    COALESCE(q.quota_remaining, 0) DESC,
                    a.last_used_at ASC
            `).all(model, minQuotaRemaining);
        }

        return getDatabase().prepare(`
            SELECT
                a.id,
                a.email,
                a.refresh_token,
                a.access_token,
                a.token_expires_at,
                a.project_id,
                a.tier,
                a.status,
                COALESCE(q.quota_remaining, a.quota_remaining) AS quota_remaining,
                COALESCE(q.quota_reset_time, a.quota_reset_time) AS quota_reset_time,
                a.last_used_at,
                a.error_count,
                a.last_error,
                a.created_at
            FROM accounts a
            LEFT JOIN account_model_quotas q
                ON q.account_id = a.id AND q.model = ?
            WHERE a.status = 'active'
                AND (q.quota_remaining IS NULL OR q.quota_remaining > ?)
            ORDER BY
                CASE WHEN q.quota_remaining IS NULL THEN 1 ELSE 0 END ASC,
                COALESCE(q.quota_remaining, a.quota_remaining) DESC,
                a.last_used_at ASC
        `).all(model, minQuotaRemaining);
    }

    return getDatabase().prepare(`
        SELECT * FROM accounts
        WHERE status = 'active' AND quota_remaining > ?
        ORDER BY quota_remaining DESC, last_used_at ASC
    `).all(minQuotaRemaining);
}

export function upsertAccountModelQuota(accountId, model, quotaRemaining, quotaResetTime) {
    if (!accountId || !model) return;
    getDatabase().prepare(`
        INSERT INTO account_model_quotas (account_id, model, quota_remaining, quota_reset_time, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, model) DO UPDATE SET
            quota_remaining = excluded.quota_remaining,
            quota_reset_time = excluded.quota_reset_time,
            updated_at = excluded.updated_at
    `).run(accountId, model, quotaRemaining, quotaResetTime, Date.now());
}

export function getAccountById(id) {
    return getDatabase().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function getAccountByEmail(email) {
    return getDatabase().prepare('SELECT * FROM accounts WHERE email = ?').get(email);
}

export function createAccount(email, refreshToken, projectId = null) {
    const stmt = getDatabase().prepare(`
        INSERT INTO accounts (email, refresh_token, project_id, created_at)
        VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(email, refreshToken, projectId, Date.now());
    return result.lastInsertRowid;
}

export function updateAccountToken(id, accessToken, expiresIn) {
    const expiresAt = Date.now() + (expiresIn * 1000);
    getDatabase().prepare(`
        UPDATE accounts SET access_token = ?, token_expires_at = ? WHERE id = ?
    `).run(accessToken, expiresAt, id);
}

export function updateAccountQuota(id, quotaRemaining, quotaResetTime) {
    getDatabase().prepare(`
        UPDATE accounts SET quota_remaining = ?, quota_reset_time = ? WHERE id = ?
    `).run(quotaRemaining, quotaResetTime, id);
}

export function updateAccountStatus(id, status, error = null) {
    if (error) {
        getDatabase().prepare(`
            UPDATE accounts SET status = ?, last_error = ?, error_count = error_count + 1 WHERE id = ?
        `).run(status, error, id);
    } else {
        getDatabase().prepare(`
            UPDATE accounts SET status = ?, error_count = 0, last_error = NULL WHERE id = ?
        `).run(status, id);
    }
}

export function updateAccountLastUsed(id) {
    getDatabase().prepare('UPDATE accounts SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
}

export function updateAccountProjectId(id, projectId) {
    getDatabase().prepare('UPDATE accounts SET project_id = ? WHERE id = ?').run(projectId, id);
}

export function updateAccountTier(id, tier) {
    getDatabase().prepare('UPDATE accounts SET tier = ? WHERE id = ?').run(tier, id);
}

export function updateAccountEmail(id, email) {
    getDatabase().prepare('UPDATE accounts SET email = ? WHERE id = ?').run(email, id);
}

export function deleteAccount(id) {
    const db = getDatabase();
    // 先将关联的日志记录的 account_id 设为 NULL
    db.prepare('UPDATE request_logs SET account_id = NULL WHERE account_id = ?').run(id);
    db.prepare('UPDATE request_attempt_logs SET account_id = NULL WHERE account_id = ?').run(id);
    // 删除账号-模型配额记录
    db.prepare('DELETE FROM account_model_quotas WHERE account_id = ?').run(id);
    // 然后删除账号
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

// ==================== Request Log 操作 ====================

/**
 * 清理过期日志（保留最近 24 小时）
 */
export function cleanupOldLogs() {
    const db = getDatabase();
    const cutoffTime = Date.now() - 24 * 60 * 60 * 1000; // 24 小时前

    const result1 = db.prepare('DELETE FROM request_logs WHERE created_at < ?').run(cutoffTime);
    const result2 = db.prepare('DELETE FROM request_attempt_logs WHERE created_at < ?').run(cutoffTime);

    return {
        requestLogs: result1.changes,
        attemptLogs: result2.changes
    };
}

export function createRequestLog(data) {
    const stmt = getDatabase().prepare(`
        INSERT INTO request_logs (account_id, api_key_id, model, prompt_tokens, completion_tokens,
                                  total_tokens, thinking_tokens, status, latency_ms, error_message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
        data.accountId,
        data.apiKeyId,
        data.model,
        data.promptTokens || 0,
        data.completionTokens || 0,
        data.totalTokens || 0,
        data.thinkingTokens || 0,
        data.status,
        data.latencyMs || 0,
        data.errorMessage || null,
        Date.now()
    );
}

export function createRequestAttemptLog(data) {
    const stmt = getDatabase().prepare(`
        INSERT INTO request_attempt_logs (
            request_id, account_id, api_key_id, model,
            attempt_no, account_attempt, same_retry,
            status, latency_ms, error_message,
            started_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        data.requestId || null,
        data.accountId,
        data.apiKeyId,
        data.model,
        data.attemptNo || 0,
        data.accountAttempt ?? null,
        data.sameRetry ?? null,
        data.status,
        data.latencyMs || 0,
        data.errorMessage || null,
        data.startedAt ?? null,
        data.createdAt || Date.now()
    );
}

export function getRequestAttemptLogs(limit = 100, offset = 0, filters = {}) {
    let sql = `
        SELECT l.*, a.email as account_email, k.name as api_key_name
        FROM request_attempt_logs l
        LEFT JOIN accounts a ON l.account_id = a.id
        LEFT JOIN api_keys k ON l.api_key_id = k.id
        WHERE 1=1
    `;
    const params = [];

    if (filters.requestId) {
        sql += ' AND l.request_id = ?';
        params.push(filters.requestId);
    }
    if (filters.model) {
        sql += ' AND l.model = ?';
        params.push(filters.model);
    }
    if (filters.accountId) {
        sql += ' AND l.account_id = ?';
        params.push(filters.accountId);
    }
    if (filters.status) {
        sql += ' AND l.status = ?';
        params.push(filters.status);
    }
    if (filters.startTime) {
        sql += ' AND l.created_at >= ?';
        params.push(filters.startTime);
    }
    if (filters.endTime) {
        sql += ' AND l.created_at <= ?';
        params.push(filters.endTime);
    }

    sql += ' ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return getDatabase().prepare(sql).all(...params);
}

export function getRequestAttemptLogsTotal(filters = {}) {
    let sql = `
        SELECT COUNT(*) as total
        FROM request_attempt_logs l
        WHERE 1=1
    `;
    const params = [];

    if (filters.requestId) {
        sql += ' AND l.request_id = ?';
        params.push(filters.requestId);
    }
    if (filters.model) {
        sql += ' AND l.model = ?';
        params.push(filters.model);
    }
    if (filters.accountId) {
        sql += ' AND l.account_id = ?';
        params.push(filters.accountId);
    }
    if (filters.status) {
        sql += ' AND l.status = ?';
        params.push(filters.status);
    }
    if (filters.startTime) {
        sql += ' AND l.created_at >= ?';
        params.push(filters.startTime);
    }
    if (filters.endTime) {
        sql += ' AND l.created_at <= ?';
        params.push(filters.endTime);
    }

    const row = getDatabase().prepare(sql).get(...params);
    return row?.total || 0;
}

export function getRequestLogs(limit = 100, offset = 0, filters = {}) {
    let sql = `
        SELECT l.*, a.email as account_email, k.name as api_key_name
        FROM request_logs l
        LEFT JOIN accounts a ON l.account_id = a.id
        LEFT JOIN api_keys k ON l.api_key_id = k.id
        WHERE 1=1
    `;
    const params = [];

    if (filters.model) {
        sql += ' AND l.model = ?';
        params.push(filters.model);
    }
    if (filters.accountId) {
        sql += ' AND l.account_id = ?';
        params.push(filters.accountId);
    }
    if (filters.status) {
        sql += ' AND l.status = ?';
        params.push(filters.status);
    }
    if (filters.startTime) {
        sql += ' AND l.created_at >= ?';
        params.push(filters.startTime);
    }
    if (filters.endTime) {
        sql += ' AND l.created_at <= ?';
        params.push(filters.endTime);
    }

    sql += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return getDatabase().prepare(sql).all(...params);
}

export function getRequestLogsTotal(filters = {}) {
    let sql = `
        SELECT COUNT(*) as total
        FROM request_logs l
        WHERE 1=1
    `;
    const params = [];

    if (filters.model) {
        sql += ' AND l.model = ?';
        params.push(filters.model);
    }
    if (filters.accountId) {
        sql += ' AND l.account_id = ?';
        params.push(filters.accountId);
    }
    if (filters.status) {
        sql += ' AND l.status = ?';
        params.push(filters.status);
    }
    if (filters.startTime) {
        sql += ' AND l.created_at >= ?';
        params.push(filters.startTime);
    }
    if (filters.endTime) {
        sql += ' AND l.created_at <= ?';
        params.push(filters.endTime);
    }

    const row = getDatabase().prepare(sql).get(...params);
    return row?.total || 0;
}

export function getRequestStats(startTime, endTime) {
    return getDatabase().prepare(`
        SELECT
            COUNT(*) as total_requests,
            SUM(prompt_tokens) as total_prompt_tokens,
            SUM(completion_tokens) as total_completion_tokens,
            SUM(total_tokens) as total_tokens,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
            AVG(latency_ms) as avg_latency
        FROM request_logs
        WHERE created_at >= ? AND created_at <= ?
    `).get(startTime, endTime);
}

export function getRequestAttemptStats(startTime, endTime) {
    return getDatabase().prepare(`
        SELECT
            COUNT(*) as total_requests,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
            AVG(latency_ms) as avg_latency
        FROM request_attempt_logs
        WHERE created_at >= ? AND created_at <= ?
    `).get(startTime, endTime);
}

export function getModelUsageStats(startTime, endTime) {
    return getDatabase().prepare(`
        SELECT model, COUNT(*) as count, SUM(total_tokens) as tokens
        FROM request_logs
        WHERE created_at >= ? AND created_at <= ?
        GROUP BY model
        ORDER BY count DESC
    `).all(startTime, endTime);
}

export function getModelAttemptUsageStats(startTime, endTime) {
    return getDatabase().prepare(`
        SELECT model, COUNT(*) as count
        FROM request_attempt_logs
        WHERE created_at >= ? AND created_at <= ?
        GROUP BY model
        ORDER BY count DESC
    `).all(startTime, endTime);
}

// ==================== Settings 操作 ====================

export function getSetting(key, defaultValue = null) {
    const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : defaultValue;
}

export function setSetting(key, value) {
    getDatabase().prepare(`
        INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    `).run(key, JSON.stringify(value), Date.now());
}
