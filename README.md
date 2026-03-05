# local-router

`local-router` 是一个面向本地使用的 AI 请求网关。  
你把请求发给它，它会按你的配置自动转发到 OpenAI/Anthropic 兼容上游，并统一提供日志和管理界面。

## 这是什么

适合这几类场景：

- 你希望统一一个本地入口来切换不同模型/供应商
- 你不想在每个客户端里直接暴露上游 API Key
- 你需要查看请求日志、会话轨迹和基础统计

支持的协议入口：

- `openai-completions`
- `openai-responses`
- `anthropic-messages`

## 5 分钟上手

### 1) 安装依赖

```sh
bun install
```

### 2) 初始化配置

```sh
local-router init
```

默认会创建配置文件（优先当前目录 `config.json5`，否则 `~/.local-router/config.json5`）。

### 3) 启动服务

```sh
local-router start
```

默认地址：

- 服务：`http://127.0.0.1:4099`
- 管理面板：`http://127.0.0.1:4099/admin`
- API 文档：`http://127.0.0.1:4099/api/docs`

## 配置示例（最小可用）

```json5
{
  providers: {
    openai: {
      type: "openai-completions",
      base: "https://api.openai.com/v1",
      apiKey: "sk-xxxx",
      models: {
        "gpt-4o-mini": {}
      }
    }
  },
  routes: {
    "openai-completions": {
      "*": { provider: "openai", model: "gpt-4o-mini" }
    }
  }
}
```

配置要点：

- `providers` 定义上游地址、类型和密钥
- `routes` 定义“你传入的 model”映射到“实际上游 model”
- 每个入口必须有 `*` 兜底规则
- `log` 是可选配置，不写就不记录日志

完整 schema 见 `config.schema.json`。

## 如何调用

你只需要把客户端请求地址改到 local-router。

### OpenAI Chat Completions

```sh
curl -X POST "http://127.0.0.1:4099/openai-completions/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"请回复 ok"}]
  }'
```

### OpenAI Responses

```sh
curl -X POST "http://127.0.0.1:4099/openai-responses/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "input": "请回复 ok"
  }'
```

### Anthropic Messages

```sh
curl -X POST "http://127.0.0.1:4099/anthropic-messages/v1/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "max_tokens": 64,
    "messages": [{"role":"user","content":"请回复 ok"}]
  }'
```

## 常用 CLI 命令

```sh
local-router init
local-router start
local-router start --daemon
local-router status --json
local-router logs --follow
local-router stop
local-router restart --daemon
local-router health
local-router version
```

## 日志与管理面板

- 管理面板：`/admin`
- 健康检查：`GET /api/health`
- 日志查询：`GET /api/logs/events`
- 日志导出：`GET /api/logs/export?format=json|csv`
- 实时 tail：`GET /api/logs/tail`（SSE）

默认日志目录：`~/.local-router/logs`

- 事件日志：`events/YYYY-MM-DD.jsonl`
- 流式原文：`streams/YYYY-MM-DD/<request_id>.sse.raw`

## 常见问题

### Q1: 客户端还需要带上游 API Key 吗？

一般不需要。local-router 会按你在 `providers.*.apiKey` 配置的密钥进行转发鉴权。

### Q2: 为什么启动失败？

优先检查：

- 端口 `4099` 是否被占用（可改 `--port`）
- 配置中是否缺少 `routes.<type>."*"` 兜底
- `routes` 引用的 provider 是否在 `providers` 中存在

### Q3: 管理面板打不开？

如果是生产/本地打包后运行，先执行：

```sh
bun run build
```

开发态可通过 `bun run dev` 启动（包含 Web 开发服务器）。

## 运行要求

- Bun `>=1.2.0`

## 进阶文档

- `docs/cli-development-and-release.md`
- `docs/logging-architecture.md`
- `docs/react-csr-integration.md`
- `docs/application-performance-analysis.md`
- `docs/application-performance-high-risk-remediation.md`
