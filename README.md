# Antigravity Proxy

把 Antigravity封装成 **OpenAI / Anthropic/Gemini 兼容 API** 的反代网关：账号池 + Web 管理面板 + 多模型路由 + 流式/多模态/工具调用，并对claude code做了兼容

## 功能概览

- **OpenAI 兼容**：`/v1/chat/completions`、`/v1/models`（支持流式、工具调用、多模态）
- **Anthropic 兼容**：`/v1/messages`（支持流式、`tool_use/tool_result`）
- **Gemini 原生兼容（v1beta）**：`/v1beta/models`、`/v1beta/models/{model}:(generateContent|streamGenerateContent|countTokens)`（支持透传 `generationConfig.imageConfig` 等原生字段）
- **管理面板**：账号池（OAuth/手动 refresh_token）、API Keys、请求日志、模型/今日统计
- **稳定性增强**：按模型/按账号并发限制 + 上游容量错误退避/切号重试（减少 `Resource has been exhausted`）
- **Claude thinking + tools 兼容**：
  - 自动缓存/回放 `thinking.signature`（Anthropic 端点：落库持久化；OpenAI 端点：代理内缓存回放）

## 快速开始

### 方式 A：Docker（部署推荐）

1) 配置环境变量：

```bash
cp .env.example .env
# 至少修改 ADMIN_PASSWORD / JWT_SECRET / PORT
```

2) 启动：

```bash
docker compose up -d --build
```

> Docker 默认会把数据库持久化到 `./data/database.sqlite`（见 `docker-compose.yml` 的 volume）。

### 方式 B：本地（开发/快速试用）

依赖：Node.js 18+（推荐 20+）

```bash
cp .env.example .env   # 可选
npm start
```

## 管理面板：添加账号 & 创建 API Key

1) 打开管理面板：`http://127.0.0.1:${PORT:-8088}`，使用 `ADMIN_PASSWORD` 登录。

2) 添加账号（Accounts）：
- **OAuth 绑定**：`OAuth` → 浏览器授权 → 复制回调 URL 粘贴回面板 → 完成添加
- **手动添加**：填 `email` + `refresh_token`

3) 创建 API Key（API Keys）



## Claude Code 兼容性说明（thinking / tools / web search）

### 1) Anthropic extended thinking 的 signature 回放（重要）

Anthropic extended thinking 对包含 `tool_use` 的历史消息有强校验：历史 assistant 必须以 `thinking/redacted_thinking` 开头且带 `signature`。

代理的处理策略：
- 优先从 **`tool_use_id -> signature` 缓存**恢复并补齐（持久化到 SQLite，避免容器重启丢失）。
- 若某些回合上游未再次下发 signature，使用 **`user_id -> last signature`** 作为兜底，让工具链路不断档。
- 如果仍无法恢复（例如缓存过期且客户端也没回放），会把本次请求的 `thinking` 自动设置为 `disabled`，并清理无效 `thinking` 块，避免上游直接 400；同时会在日志中输出 `thinking_downgrade`。

实现位置：`backend/src/services/converter.js` → `preprocessAnthropicRequest()`。

补充说明：
- Anthropic 端点的签名缓存会写入 SQLite（`signature_cache` 表），避免容器重启丢失；但仍受 TTL 控制（默认 24h）。
- OpenAI 端点的签名回放缓存是代理进程内存 Map，容器重启会清空；同时也受 TTL 控制。

## 支持模型（`/v1/models` 返回）

- Gemini：`gemini-3-flash` / `gemini-3-flash-thinking` / `gemini-3-pro-high` / `gemini-3-pro-low` / `gemini-2.5-pro` / `gemini-2.5-flash` / `gemini-2.5-flash-thinking` / `gemini-2.5-flash-lite` / `gemini-3-pro-image` / `rev19-uic3-1p`
- Claude：`claude-opus-4-5` / `claude-opus-4-5-thinking` / `claude-sonnet-4-5` / `claude-sonnet-4-5-thinking`
- OpenAI：`gpt-oss-120b-medium`

> 说明：存在一些 alias 映射（例如 `claude-4-5-thinking` → `claude-opus-4-5-thinking`），见 `backend/src/config.js`。

## 环境变量（常用）

建议：以 `.env.example` 和 `docker-compose.yml` 的推荐值为准（代码内部也有 fallback 默认值）。

### 运行/安全

| 变量 | 示例/默认（推荐） | 说明 |
|---|---|---|
| `PORT` | `8088` | 对外端口（Docker 映射端口；`npm start` 也使用此端口） |
| `HOST` | `127.0.0.1` | `npm start` 监听地址；Docker 会强制设置为 `0.0.0.0` |
| `DB_PATH` | `../data/database.sqlite`（本地） / `/app/data/database.sqlite`（Docker） | SQLite 路径 |
| `ADMIN_PASSWORD` | `change-me` | 管理面板密码 |
| `JWT_SECRET` | `change-me-too` | 管理 JWT 密钥 |
| `ADMIN_PASSWORD_BEARER_COMPAT` | `true` | 兼容 `Authorization: Bearer <ADMIN_PASSWORD>`（生产建议关闭） |

### 出站网络

| 变量 | 示例/默认 | 说明 |
|---|---|---|
| `OUTBOUND_PROXY` | `http://127.0.0.1:7890` | 让后端出站请求走代理（OAuth / 刷新 token / 搜索等） |
| `FETCH_CONNECT_TIMEOUT_MS` | `30000` | undici `fetch` connect timeout（弱网可调大） |

### 本地启动（`npm start`）

| 变量 | 示例/默认 | 说明 |
|---|---|---|
| `NPM_REGISTRY` | `https://registry.npmmirror.com` | npm 很慢时可用镜像 |
| `AGP_FORCE_BUILD` | `false` | 强制重新安装依赖并重建前端 |
| `AGP_SKIP_INSTALL` | `false` | 跳过安装依赖（已有 `node_modules` 时） |
| `AGP_SKIP_BUILD` | `false` | 跳过前端 build（已有 `frontend/dist` 时） |

### 并发/容量退避（强烈建议保守）

| 变量 | 推荐默认 | 说明 |
|---|---:|---|
| `MAX_CONCURRENT_PER_MODEL` | `2` | 单模型本地并发上限（避免把上游打爆） |
| `MAX_CONCURRENT_PER_ACCOUNT` | `1` | 单账号并发上限 |
| `UPSTREAM_CAPACITY_RETRIES` | `2` | 上游容量错误（429/Resource exhausted）切号重试次数 |
| `UPSTREAM_CAPACITY_RETRY_DELAY_MS` | `1000` | 重试基础延迟（毫秒） |
| `CAPACITY_COOLDOWN_DEFAULT_MS` | `15000` | 单账号在某模型报容量错误后的默认冷却（指数退避起点） |
| `CAPACITY_COOLDOWN_MAX_MS` | `120000` | 冷却最大值（毫秒） |

### Thinking / signature（Claude/Gemini 工具链路）

| 变量 | 代码默认 | 说明 |
|---|---:|---|
| `OPENAI_THINKING_OUTPUT` | `reasoning_content` | OpenAI SSE 思考输出：`reasoning_content` / `tags` / `both` |
| `TOOL_THOUGHT_SIGNATURE_TTL_MS` | `600000` | 通用工具 `thoughtSignature` 缓存 TTL（毫秒） |
| `TOOL_THOUGHT_SIGNATURE_MAX` | `5000` | 上述缓存最大条数 |
| `CLAUDE_THINKING_SIGNATURE_TTL_MS` | `86400000` | Anthropic 端：`tool_use_id -> signature` 缓存 TTL（毫秒，落库） |
| `CLAUDE_THINKING_SIGNATURE_MAX` | `5000` | 上述缓存最大条数 |
| `CLAUDE_LAST_SIGNATURE_TTL_MS` | `86400000` | Anthropic 端：`user_id -> last signature` TTL（毫秒，落库） |
| `CLAUDE_LAST_SIGNATURE_MAX` | `50000` | 上述缓存最大条数 |
| `CLAUDE_ASSISTANT_SIGNATURE_TTL_MS` | `21600000` | Anthropic 端：按“assistant 内容 hash”回放 signature 的 TTL（毫秒，内存） |
| `CLAUDE_ASSISTANT_SIGNATURE_MAX` | `10000` | 上述缓存最大条数 |
| `CLAUDE_OPENAI_REPLAY_THOUGHT_TEXT` | `true` | OpenAI 端：Claude tools 回放时是否附带 thoughtText（更稳但更占 token） |

### 管理面板统计

| 变量 | 推荐默认 | 说明 |
|---|---:|---|
| `DASHBOARD_TZ_OFFSET_MINUTES` | `480` | 仪表盘“今日”统计按时区偏移（分钟），中国时间为 480 |

## 常见问题（Troubleshooting）

### 1) `Resource has been exhausted (e.g. check quota).`

这通常是上游账号/模型侧的容量/速率限制，不等同于你在 Web 面板看到的“配额还有很多”。

可尝试：
- 降低并发：`MAX_CONCURRENT_PER_MODEL` / `MAX_CONCURRENT_PER_ACCOUNT`
- 增大退避：`CAPACITY_COOLDOWN_DEFAULT_MS`，并保留 `CAPACITY_COOLDOWN_MAX_MS`
- 增加账号数量，让账号池更容易切号

### 2) `thinking_downgrade` 日志

含义：某条历史 `tool_use` 的 `signature` 无法恢复（缓存过期/丢失且客户端未回放），因此本次请求被迫禁用 thinking 以避免上游报错。

## 项目结构

```text
antigravity-proxy/
├─ Dockerfile
├─ docker-compose.yml
├─ package.json
├─ scripts/start.mjs
├─ backend/
│  └─ src/
│     ├─ bootstrap.js        # undici fetch 代理/超时设置
│     ├─ index.js            # 服务入口
│     ├─ routes/             # openai / anthropic / admin / oauth / auth
│     ├─ services/           # tokenManager / accountPool / converter / antigravity / webSearch
│     └─ db/                 # sqlite schema + DAO
└─ frontend/
   └─ src/
      ├─ views/              # Dashboard / Accounts / ApiKeys / Logs / Settings
      └─ components/
```

## License

MIT
