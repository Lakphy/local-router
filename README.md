# @lakphy/local-router

`@lakphy/local-router` 是一个本地 AI CLI 网关工具。  
安装后通过 `local-router` 命令启动服务，把 OpenAI/Anthropic 风格请求统一转发到你配置的上游 provider。

## 安装（CLI 使用者）

运行要求：Bun `>=1.2.0`

全局安装（推荐）：

```sh
npm i -g @lakphy/local-router
```

或用 Bun 全局安装：

```sh
bun add -g @lakphy/local-router
```

不全局安装，临时执行：

```sh
npx @lakphy/local-router --help
# 或
bunx @lakphy/local-router --help
```

## 快速开始

### 1) 初始化配置

```sh
local-router init
```

默认配置路径：

- 优先当前目录：`./config.json5`
- 否则全局目录：`~/.local-router/config.json5`

### 2) 编辑配置文件

最小可用配置示例：

```json5
{
  providers: {
    openai: {
      type: "openai-completions",
      base: "https://api.openai.com/v1",
      apiKey: "sk-xxxx",
      proxy: "http://127.0.0.1:7890", // 可选：仅该 provider 走代理
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

### 3) 启动服务

```sh
local-router start
```

默认地址：

- 服务监听：`http://0.0.0.0:4099`
- 本机访问：`http://127.0.0.1:4099`
- 管理面板：`http://127.0.0.1:4099/admin`
- API 文档：`http://127.0.0.1:4099/api/docs`

默认只处理本机来源请求。需要让局域网内其他设备访问时，在管理面板的“通用设置”中开启局域网服务并保存应用。

## 常用命令

```sh
local-router --help
local-router init
local-router start
local-router start --daemon
local-router stop
local-router restart --daemon
local-router status
local-router status --json
local-router health
local-router logs --follow
local-router version
```

常用参数：

- `--config <path>`：指定配置文件路径
- `--host <host>`：指定监听地址
- `--port <port>`：指定监听端口
- `--daemon`：后台运行
- `--idle-timeout <sec>`：设置 Bun 连接空闲超时（默认 600 秒，设为 `0` 可关闭）

## AI 友好化（Markdown-first CLI）

local-router 的 CLI 默认输出**结构化 Markdown**（标题 / 表格 / 代码块 / 提示），让 Claude Code、Cursor 等 AI agent 不用额外解析就能消费；脚本场景用 `-o json` 切到 envelope，`-o text` 兜底到旧文案。

### 全局 flags

```
-o, --output markdown|json|ndjson|text   默认 markdown；env LOCAL_ROUTER_FORMAT
--json                                    -o json 别名
-q, --quiet
-v, --verbose
--no-color                                env NO_COLOR
--no-interactive                          env LOCAL_ROUTER_NO_INTERACTIVE
--yes
--config <path>                           env LOCAL_ROUTER_CONFIG
LOCAL_ROUTER_RUNTIME_DIR=<dir>            隔离 daemon 状态目录（CI / 测试用）
```

### 输出契约

- **Markdown（默认）**：顶部 `## <command>` 标题 + blockquote meta + `### 数据`/`### 错误`/`### 提示` 子段，命令一旦发布 schema 即视为契约。
- **JSON**：成功 `{ ok:true, command, schema_version, data, meta }`；失败 `{ ok:false, error:{code,message,hint,doc,details}, exit_code }`。
- **NDJSON**：流式命令每行一个 `{ type:"event"|"end"|"error", ... }`。
- **退出码**：`0` ok / `2` 用法 / `3` 未运行 / `4` 状态冲突 / `5` 校验失败 / `6` 资源不存在 / `7` 超时 / `8` 健康失败 / `9` 上游不可达 / `10` 需要交互。

### 自描述与引导命令（给 AI 的入口）

```sh
local-router commands --json                      # 全部命令元信息
local-router help <cmd> --json                    # 单命令 flags + examples
local-router schema config|cli|errors --json      # schema 导出
local-router capabilities --json                  # 版本 / provider 类型 / 特性
local-router agents-md > AGENTS.md                # 给 AI 看的完整 cheatsheet
local-router doctor                               # 自检 config/端口/服务/上游
local-router docs errors PROVIDER_REFERENCED_BY_ROUTE
```

### 配置可预演（dry-run）+ 批量导入

所有写命令支持 `--dry-run`，输出 unified diff 后再决定是否写入。

```sh
local-router config provider add openai \
  --type openai-completions --base ... --api-key ... --model gpt-4o-mini \
  --dry-run --json | jq .data.diff

local-router config patch --file - --dry-run <<'EOF'
[{"op":"add","path":"/providers/demo","value":{"type":"openai-completions","base":"https://x","apiKey":"sk-1","models":{"m":{}}}}]
EOF

local-router config import --merge --file - < new-config.json5
local-router config diff --against <backup-id>
local-router config backups list
local-router config rollback <backup-id>
local-router config show          # 默认掩码；--show-secrets 看原文
```

### 端到端调试

```sh
local-router status --wait-running --timeout 10 --json
local-router explain route --entry openai-completions --model gpt-4o-mini --json
local-router try --entry openai-completions --model gpt-4o-mini --prompt ping --json
local-router try ... --stream --output ndjson | jq .       # 流式
local-router ping openai
```

### 日志（HTTP API → CLI 投影）

```sh
local-router logs events --window 1h --has-error --limit 5
local-router logs event <id> --include-stream
local-router logs last-error --json                # 最近一条错误（AI 调试金钥匙）
local-router logs metrics
local-router logs tail --output ndjson              # 实时事件流
local-router logs replay <event-id> --dry-run       # 用同样参数复发一次
local-router logs export --format jsonl --window 24h > out.jsonl
```

### 兼容回退

旧脚本若硬编码旧文案，加 `--output text` 或 `LOCAL_ROUTER_FORMAT=text` 完整还原行为。`--json` 现在是 envelope 形式（`.data` 取数据），相比 v0.4 是 breaking change。

## 请求入口（给你的应用调用）

把应用的 base URL 指向 local-router 后，使用以下入口：

- `POST /openai-completions/v1/chat/completions`
- `POST /openai-responses/v1/responses`
- `POST /anthropic-messages/v1/messages`

示例（OpenAI Chat Completions）：

```sh
curl -X POST "http://127.0.0.1:4099/openai-completions/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"请回复 ok"}]
  }'
```

## 配置规则（必须知道）

- `providers`：定义上游服务（类型、地址、密钥、模型）
- `providers.*.proxy`：可选，provider 级代理 URL（仅该 provider 生效）
- `routes`：定义路由映射（传入 model -> 目标 provider/model）
- 每个入口都必须有 `*` 兜底规则
- `routes` 里引用的 `provider` 必须在 `providers` 中存在
- `log` 是可选，不配置就不记录日志

完整 schema：`config.schema.json`

### Provider 级代理示例

```json5
{
  providers: {
    openai: {
      type: "openai-completions",
      base: "https://api.openai.com/v1",
      apiKey: "sk-openai",
      proxy: "http://127.0.0.1:7890",
      models: { "gpt-4o-mini": {} }
    },
    anthropic: {
      type: "anthropic-messages",
      base: "https://api.anthropic.com",
      apiKey: "sk-ant",
      // 省略或空字符串表示直连
      proxy: "",
      models: { "claude-sonnet-4-5": {} }
    }
  },
  routes: {
    "openai-completions": {
      "*": { provider: "openai", model: "gpt-4o-mini" }
    },
    "anthropic-messages": {
      "*": { provider: "anthropic", model: "claude-sonnet-4-5" }
    }
  }
}
```

说明：
- `proxy` 仅影响当前 provider，不会影响其他 provider。
- 当前版本代理来源仅 `providers.*.proxy`，不会读取 `HTTP_PROXY/HTTPS_PROXY` 环境变量。

## 日志与管理面板

- 面板地址：`/admin`
- 健康检查：`GET /api/health`
- 日志列表：`GET /api/logs/events`
- 日志详情：`GET /api/logs/events/:id`
- 日志导出：`GET /api/logs/export?format=json|csv`
- 实时 tail：`GET /api/logs/tail`（SSE）

默认日志目录：`~/.local-router/logs`

- 事件日志：`events/YYYY-MM-DD.jsonl`
- 流式原文：`streams/YYYY-MM-DD/<request_id>.sse.raw`

## 常见问题

### 客户端还需要带上游 API Key 吗？

一般不需要。local-router 会使用你在配置文件 `providers.*.apiKey` 中设置的密钥转发。

### 启动失败怎么办？

先检查：

- 端口 `4099` 是否已占用（可用 `--port` 修改）
- `routes.<type>` 是否缺少 `*` 规则
- `routes` 引用的 provider 是否存在
- 配置文件是否是合法 JSON5


### 运行较久请求出现 `[Bun.serve]: request timed out after 10 seconds` 怎么办？

这是 Bun 服务端连接空闲超时触发导致的（常见于长流式响应或慢速上游）。

可在启动时放宽超时：

```sh
local-router start --idle-timeout 600
# 或彻底关闭空闲超时
local-router start --idle-timeout 0
```

也支持环境变量：

```sh
LOCAL_ROUTER_IDLE_TIMEOUT=600 local-router start
```

### 如何升级？

```sh
npm i -g @lakphy/local-router@latest
# 或
bun add -g @lakphy/local-router@latest
```

### 如何卸载？

```sh
npm rm -g @lakphy/local-router
# 或
bun remove -g @lakphy/local-router
```
