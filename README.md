# Antigravity Proxy


将 Antigravity 封装成 **OpenAI / Anthropic / Gemini** 标准格式，支持 Gemini、Claude等多种模型，完美兼容 Claude Code。

## 核心特性

- **三端兼容** — 同时支持 OpenAI、Anthropic、Gemini 三种 API 格式
- **账号池管理** — 多账号轮询，自动切号重试
- **配额可视化** — 实时同步各模型配额，一目了然
- **容量退避** — 429/配额耗尽自动冷却，指数退避策略
- **流式输出** — 完整 SSE 支持，包括 thinking 流式输出
- **工具调用** — OpenAI function calling / Anthropic tool_use 完整支持
- **多模态** — 图片输入、图片生成（gemini-3-pro-image）
- **Claude Code 兼容** — thinking signature 自动缓存回放

## 支持模型

| Gemini | Claude | OpenAI |
|--------|--------|--------|
| gemini-3-flash | claude-opus-4-5 | gpt-oss-120b-medium |
| gemini-3-flash-thinking | claude-opus-4-5-thinking | |
| gemini-3-pro-high/low | claude-sonnet-4-5 | |
| gemini-2.5-pro/flash | claude-sonnet-4-5-thinking | |
| gemini-3-pro-image | | |

## 快速开始

### Docker 部署（推荐）

```bash
# 1. 克隆项目
git clone https://github.com/Kazuki-0147/Antigravity-Proxy.git
cd Antigravity-Proxy

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，修改 ADMIN_PASSWORD 和 API_KEY

# 3. 启动
docker compose up -d --build
```

### 本地运行

```bash
npm start  # 需要 Node.js 18+
```

启动后访问 `http://localhost:8088`，使用 `ADMIN_PASSWORD` 登录管理面板。

## 添加账号

1. 打开管理面板 → 账号管理
2. 点击 **OAuth 添加**，按提示完成 Google 授权
3. 或手动填写 `email` + `refresh_token`

## API 使用

### OpenAI 格式

```bash
curl http://localhost:8088/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

### Anthropic 格式

```bash
curl http://localhost:8088/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-5","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'
```

### Gemini 格式

```bash
curl http://localhost:8088/v1beta/models/gemini-2.5-flash:generateContent \
  -H "x-goog-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Hello!"}]}]}'
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 8088 | 服务端口 |
| `ADMIN_PASSWORD` | - | 管理面板密码 |
| `API_KEY` | - | API 访问密钥（留空则使用 ADMIN_PASSWORD） |
| `MAX_CONCURRENT_PER_MODEL` | 0 | 单模型并发上限（0=不限制） |
| `MAX_CONCURRENT_PER_ACCOUNT` | 0 | 单账号并发上限（0=不限制） |
| `SAME_ACCOUNT_RETRIES` | 2 | 同号重试次数 |
| `ERROR_COUNT_TO_DISABLE` | 3 | 连续失败多少次才禁用账号 |
| `OUTBOUND_PROXY` | - | 出站代理（如 `http://127.0.0.1:7890`） |

完整环境变量说明见 `.env.example`。

## 项目结构

```
antigravity-proxy/
├── docker-compose.yml
├── backend/
│   ├── public/          # 前端管理面板
│   └── src/
│       ├── routes/      # API 路由 (openai/anthropic/gemini)
│       ├── services/    # 账号池/Token管理/格式转换
│       └── db/          # SQLite 数据库
└── data/                # 数据持久化目录
```

## 常见问题

**Q: 出现 `Resource has been exhausted` 错误？**

这是上游账号的速率限制，非配额问题。代理会自动等待冷却时间后重试。如果频繁出现，可以：
- 增加账号：让账号池有更多选择
- 调整重试次数：增大 `SAME_ACCOUNT_RETRIES`

**Q: Claude Code 工具调用报错？**

代理会自动处理 thinking signature 回放。如果仍有问题，检查账号配额是否充足。

## License

MIT
