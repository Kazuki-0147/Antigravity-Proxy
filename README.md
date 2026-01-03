# Antigravity Proxy

把 Antigravity封装成 **OpenAI / Anthropic/Gemini 兼容 API** 的反代网关：账号池 + Web 管理面板 + 多模型路由 + 流式/多模态/工具调用，并对claude code做了兼容

## 功能概览

- **OpenAI 兼容**：`/v1/chat/completions`、`/v1/models`（支持流式、工具调用、多模态）
- **Anthropic 兼容**：`/v1/messages`（支持流式、`tool_use/tool_result`）
- **Gemini 原生兼容（v1beta）**：`/v1beta/models`、`/v1beta/models/{model}:(generateContent|streamGenerateContent|countTokens)`（支持透传 `generationConfig.imageConfig` 等原生字段）
- **管理面板**：账号池（OAuth/手动 refresh_token）、请求日志、模型/今日统计、配额查看
- **稳定性增强**：按模型/按账号并发限制 + 上游容量错误退避/切号重试（减少 `Resource has been exhausted`）
- **Claude thinking + tools 兼容**：
  - 自动缓存/回放 `thinking.signature`（Anthropic 端点：落库持久化；OpenAI 端点：代理内缓存回放）
  - tool_use 自动补齐 `thoughtSignature`，缺失时使用 `skip_thought_signature_validator` 兜底（无需空占位）
  - Claude + tools + thinking 时追加 interleaved thinking 提示，支持工具后继续输出思维链

## 快速开始

### 方式 A：Docker（部署推荐）

1) 配置环境变量：

```bash
cp .env.example .env
# 至少修改 ADMIN_PASSWORD / JWT_SECRET / PORT / API_KEY
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

## 管理面板：添加账号

1) 打开管理面板：`http://127.0.0.1:${PORT:-8088}`，使用 `ADMIN_PASSWORD` 登录。

2) 添加账号（Accounts）：
- **OAuth 绑定**：`OAuth` → 浏览器授权 → 复制回调 URL 粘贴回面板 → 完成添加
- **手动添加**：填 `email` + `refresh_token`

## API 使用

### OpenAI：对话

```bash
curl "http://localhost:8088/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

### OpenAI：工具调用（代理只透传）

说明：
- 代理不会替你执行 `tools/tool_calls`，需要客户端执行工具后用 `role:"tool"` 回传。
- 上游可能要求回放工具调用链路的 `thoughtSignature`；本代理会自动缓存并在下一轮回放补齐。
- Claude 模型在 tool_call 上会自动带 `thoughtSignature`，缺失时使用 `skip_thought_signature_validator` 兜底（不再插入空文本占位）。

示例（两轮）：

1) 第一次请求：带 `tools`

```bash
curl "http://localhost:8088/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role":"user","content":"用工具查一下北京现在几点，然后用一句话回答。"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_time",
        "description": "Get current time for a timezone",
        "parameters": {
          "type": "object",
          "properties": { "timezone": { "type": "string" } },
          "required": ["timezone"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

2) 响应会包含 `tool_calls`（示意）：

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "tool_calls": [
        {
          "id": "call_xxx",
          "type": "function",
          "function": { "name": "get_time", "arguments": "{\"timezone\":\"Asia/Shanghai\"}" }
        }
      ]
    }
  }]
}
```

3) 客户端执行工具后，把 tool result 回传（二次请求）：

```bash
curl "http://localhost:8088/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {"role":"user","content":"用工具查一下北京现在几点，然后用一句话回答。"},
      {"role":"assistant","content":null,"tool_calls":[{"id":"call_xxx","type":"function","function":{"name":"get_time","arguments":"{\"timezone\":\"Asia/Shanghai\"}"}}]},
      {"role":"tool","tool_call_id":"call_xxx","name":"get_time","content":"当前时间 (Asia/Shanghai CST): 2025-12-12 23:59:59\\nUTC偏移: +8:00"}
    ]
  }'
```

### Anthropic：对话

```bash
curl "http://localhost:8088/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -d '{"model":"claude-opus-4-5-thinking","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

### Anthropic：工具调用（`tool_use/tool_result`）

```bash
curl "http://localhost:8088/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -d '{
    "model": "claude-opus-4-5-thinking",
    "max_tokens": 256,
    "messages": [{"role":"user","content":"用工具查一下北京时间，然后用一句话回答。"}],
    "tools": [{
      "name": "get_time",
      "description": "Get current time for a timezone",
      "input_schema": {
        "type": "object",
        "properties": { "timezone": { "type": "string" } },
        "required": ["timezone"]
      }
    }],
    "tool_choice": { "type": "auto" }
  }'
```

响应会包含 `tool_use`（示意）：

```json
{
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_xxx",
      "name": "get_time",
      "input": { "timezone": "Asia/Shanghai" }
    }
  ]
}
```

客户端执行工具后回传（二次请求）：

```bash
curl "http://localhost:8088/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -d '{
    "model": "claude-opus-4-5-thinking",
    "max_tokens": 256,
    "messages": [
      {"role":"user","content":"用工具查一下北京时间，然后用一句话回答。"},
      {"role":"assistant","content":[{"type":"tool_use","id":"toolu_xxx","name":"get_time","input":{"timezone":"Asia/Shanghai"}}]},
      {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_xxx","content":"当前时间 (Asia/Shanghai CST): 2025-12-12 23:59:59\\nUTC偏移: +8:00"}]}
    ]
  }'
```

### 模型列表

```bash
curl "http://localhost:8088/v1/models" -H "Authorization: Bearer ${API_KEY}"
```

## Gemini 原生端点（v1beta，主要用于 Image 生成）

本项目额外提供了一个 **Gemini 原生**兼容端点（最小实现），用于 `gemini-3-pro-image` 等场景透传 `generationConfig.imageConfig`，也可用于其它 Gemini 模型的原生调用。

- 鉴权：支持 `x-goog-api-key` / `x-api-key` / `Authorization: Bearer`，也兼容 Gemini 官方的 `?key=...`
- `:streamGenerateContent`：
  - `?alt=sse`（或 `Accept: text/event-stream`）时返回 SSE，并在结束时输出 `data: [DONE]`
  - 否则返回 JSON 数组（每个元素是一次流式 chunk 的 payload）
- `:countTokens`：已支持（透传到上游 `v1internal:countTokens`）

### Image 生成（`gemini-3-pro-image`）

```bash
curl "http://localhost:8088/v1beta/models/gemini-3-pro-image:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: ${API_KEY}" \
  -d '{
    "contents":[{"role":"user","parts":[{"text":"生成一张 1:1 的猫咪照片风格图片"}]}],
    "generationConfig":{
      "candidateCount": 1,
      "imageConfig": { "aspectRatio": "1:1", "imageSize": "4K" }
    }
  }'
```

## 多模态（图片输入）

- OpenAI：`messages[].content` 支持 `[{ "type":"text" }, { "type":"image_url" }]`；`image_url.url` 可用 `data:<mime>;base64,...` 或纯 base64（默认按 png）。
- Anthropic：`messages[].content` 支持 `type:"image"` 且 `source.type:"base64"`。

## Claude Code 兼容性说明（thinking / tools / web search）

### 1) Anthropic extended thinking 的 signature 回放（重要）

Anthropic extended thinking 对包含 `tool_use` 的历史消息有强校验：历史 assistant 必须以 `thinking/redacted_thinking` 开头且带 `signature`。

代理的处理策略：
- 优先从 **`tool_use_id -> signature` 缓存**恢复并补齐（持久化到 SQLite，避免容器重启丢失）。
- 若某些回合上游未再次下发 signature，使用 **`user_id -> last signature`** 作为兜底，让工具链路不断档。
- 若本回合仍无法拿到签名，`tool_use` 会自动附带 `skip_thought_signature_validator` 兜底（避免工具链路中断）。
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

含义：某条历史 `tool_use` 的 `signature` 无法恢复（缓存过期/丢失且客户端未回放），因此 Anthropic 端点本次请求被迫禁用 thinking 以避免上游报错。

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
