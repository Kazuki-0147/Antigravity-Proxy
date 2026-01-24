import { OAUTH_CONFIG } from '../config.js';
import { createAccount, getAccountByEmail, getAccountById, updateAccountToken, deleteAccount } from '../db/index.js';
import { initializeAccount } from '../services/tokenManager.js';
import { verifyAdmin } from '../middleware/auth.js';

export default async function oauthRoutes(fastify) {
    // POST /oauth/exchange - 用授权码交换 token（前端传入 code 和 port）
    fastify.post('/oauth/exchange', { preHandler: verifyAdmin }, async (request, reply) => {
        const { code, port } = request.body;

        if (!code || !port) {
            return reply.code(400).send({
                success: false,
                message: 'code和port必填'
            });
        }

        try {
            const redirectUri = `http://localhost:${port}/oauth-callback`;

            // 用 code 换取 tokens
            const tokenResponse = await fetch(OAUTH_CONFIG.token_endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    client_id: OAUTH_CONFIG.client_id,
                    client_secret: OAUTH_CONFIG.client_secret,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: redirectUri
                })
            });

            const tokenData = await tokenResponse.json();

            if (!tokenData.access_token) {
                return reply.code(400).send({
                    success: false,
                    message: 'Token交换失败: ' + (tokenData.error_description || tokenData.error || '未知错误')
                });
            }

            const { access_token, refresh_token, expires_in } = tokenData;

            if (!refresh_token) {
                return reply.code(400).send({
                    success: false,
                    message: '未获取到refresh_token，请确保已授权离线访问'
                });
            }

            // 获取用户信息
            let email = null;
            try {
                const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: {
                        'Authorization': `Bearer ${access_token}`
                    }
                });
                const userInfo = await userInfoResponse.json();
                email = userInfo.email || null;
            } catch (emailError) {
                // ignore
            }

            // 检查账号是否已存在
            let account = email ? getAccountByEmail(email) : null;

            if (account) {
                // 账号已存在，返回错误
                return reply.code(400).send({
                    success: false,
                    message: `账号 ${email} 已存在`
                });
            }

            // 创建新账号
            const accountId = createAccount(email || `oauth_${Date.now()}`, refresh_token);

            // 立即保存 token 到数据库，避免 initializeAccount 触发不必要的刷新
            const expiresInSec = Number(expires_in);
            if (Number.isFinite(expiresInSec) && expiresInSec > 0) {
                updateAccountToken(accountId, access_token, expiresInSec);
            }

            // 从数据库重新读取账号（包含完整信息）
            account = getAccountById(accountId);
            if (!account) {
                // 清理可能存在的幽灵账号
                try { deleteAccount(accountId); } catch { /* ignore */ }
                return reply.code(400).send({
                    success: false,
                    message: '账号创建后丢失'
                });
            }

            // 初始化账号
            try {
                await initializeAccount(account);
            } catch (initError) {
                // 检查账号是否被删除（重复账号情况）
                const stillExists = getAccountById(account.id);
                if (!stillExists) {
                    return reply.code(400).send({
                        success: false,
                        message: initError.message
                    });
                }
                // 与 /admin/accounts 行为保持一致：初始化失败删除账号并返回错误
                deleteAccount(account.id);
                return reply.code(400).send({
                    success: false,
                    message: initError.message || '账号初始化失败'
                });
            }

            // Read back the latest account data (project_id might have been updated during initialization).
            const latestAccount = getAccountById(account.id);
            if (!latestAccount) {
                return reply.code(400).send({
                    success: false,
                    message: '账号创建后丢失'
                });
            }
            const project_id = latestAccount?.project_id || account.project_id || null;
            const tier = latestAccount?.tier || account.tier || null;

            return {
                success: true,
                data: {
                    email,
                    access_token,
                    refresh_token,
                    expires_in,
                    project_id,
                    tier
                }
            };
        } catch (error) {
            return reply.code(500).send({
                success: false,
                message: error.message
            });
        }
    });

    // GET /oauth/config - 获取前端需要的 OAuth 配置
    fastify.get('/oauth/config', { preHandler: verifyAdmin }, async () => {
        return {
            client_id: OAUTH_CONFIG.client_id,
            scope: OAUTH_CONFIG.scope,
            auth_endpoint: OAUTH_CONFIG.auth_endpoint
        };
    });
}
