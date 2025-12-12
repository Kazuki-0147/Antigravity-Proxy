# Antigravity Proxy

OpenAI / Anthropic 兼容的 Antigravity 反代网关（账号池 + 管理面板），支持流式与多模态。

## 快速开始

### 方式 A：`npm start`（一条命令）

```bash
cd antigravity-proxy
cat > .env <<'EOF'
PORT=8088
ADMIN_PASSWORD=change-me
JWT_SECRET=change-me-too
EOF

npm start
```

- 管理面板：`http://localhost:8088`
- API Base：`http://localhost:8088/v1`

### 方式 B：Docker部署

```bash
cd antigravity-proxy
cat > .env <<'EOF'
PORT=8088
ADMIN_PASSWORD=change-me
JWT_SECRET=change-me-too
EOF

docker compose up -d --build
```

## 添加账号（跑起来后先做这个）

1) 打开管理面板：`http://localhost:8088`（端口以 `.env` 为准）  
2) 使用 `ADMIN_PASSWORD` 登录  
3) 进入 `Accounts`：
   - **OAuth 绑定**：点 `OAuth` → 在新窗口授权 → 复制回调 URL 粘贴回面板完成添加
   - **手动添加**：点 `添加` → 填 `email` + `refresh_token` 保存
4) 可选：点一次“刷新所有 Token 及配额”，让状态/等级/配额同步到最新

## 能力概览

- OpenAI：`POST /v1/chat/completions`、`GET /v1/models`
- Anthropic：`POST /v1/messages`、`POST /messages`
- 流式：SSE（OpenAI chunk / Anthropic events）
- 多模态：图片输入（OpenAI `image_url` / Anthropic `image` base64）
- 工具调用：透传 `tools/tool_calls`
- 账号池：多账号轮询、自动刷新 token、同步配额
- 管理面板：账号 / API Key / 日志 / 统计；支持“一次刷新所有账号 Token 及配额”

## 支持模型（`/v1/models`）

- `gemini-3-pro-high`
- `gemini-3-pro-low`
- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-thinking`
- `gemini-2.5-flash-lite`
- `gemini-3-pro-image`
- `claude-opus-4-5`
- `claude-opus-4-5-thinking`
- `claude-sonnet-4-5`
- `claude-sonnet-4-5-thinking`
- `gpt-oss-120b-medium`

## 多模态（图片）

- OpenAI 输入：`messages[].content` 支持 `[{type:"text"}, {type:"image_url"}]`；`image_url.url` 可用 `data:<mime>;base64,...` 或纯 base64（默认按 png）。
- Anthropic 输入：`messages[].content` 支持 `type: "image"` 且 `source.type: "base64"`。

## Anthropic thinking 处理

Anthropic extended thinking 要求历史 `thinking` 块带 `signature`。由于上游返回的 thinking 不包含 signature：
- 若历史消息不满足签名要求，服务端会自动把本次请求的 `thinking` 设为 `disabled`，并清理历史中的 `thinking/redacted_thinking`，避免 Anthropic 端报错。
- 相关实现：`backend/src/services/converter.js` 的 `preprocessAnthropicRequest()`。

## API 示例

创建 API Key：打开管理面板 → `API Key` 页面生成 `sk-...`。

OpenAI：

```bash
curl http://localhost:8088/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

Anthropic：

```bash
curl http://localhost:8088/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-your-api-key" \
  -d '{"model":"claude-opus-4-5-thinking","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

模型列表：

```bash
curl http://localhost:8088/v1/models -H "Authorization: Bearer sk-your-api-key"
```

## 环境变量（常用）

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PORT` | `3000` | 监听端口（`npm start` 直连 / Docker 对外映射） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `./data/database.sqlite` | SQLite 路径（`npm start` 默认 `../data/database.sqlite`；Docker 默认 `/app/data/database.sqlite`） |
| `ADMIN_PASSWORD` | `admin123` | 管理面板密码 |
| `JWT_SECRET` | `antigravity-proxy-secret-key-2024` | 管理 JWT 密钥 |
| `ADMIN_PASSWORD_BEARER_COMPAT` | `true` | 兼容 `Authorization: Bearer <ADMIN_PASSWORD>`（建议生产关闭） |
| `MAX_CONCURRENT_PER_ACCOUNT` | `1` | 单账号并发 |
| `MAX_CONCURRENT_PER_MODEL` | `3` | 单模型并发 |

## License

MIT
