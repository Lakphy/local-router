# local-router CLI 极致优化方案

> 目标：CLI 成为 local-router 的**唯一**完整入口，Web Admin 退化为可选 GUI。
> 任何 Web 上能做的，CLI 都能做；任何 CLI 操作都有自描述、机器可读输出。

---

## 0. TL;DR

- **Spec-first 引擎**：`defineCommand({flags})` 作为单一真相源，自动生成 parser/help/校验/补全/schema。
- **闭环命令**：补齐 LAN 设置、插件管理、chat 直连、tokens/cost、prune、export 等 Web 独占能力。
- **AI 友好**：默认 Markdown + 内嵌 `<!-- json -->` frontmatter；envelope v2 加 `next` / `correlation_id`；新增 `recipes`、`examples`、`why`、`--explain` 全局 flag。
- **零摩擦**：shell 补全、did-you-mean、短别名、`config edit`、`open` 工具。
- **可观测**：所有命令 contract 测试 + golden snapshot；命令 schema 一旦发布即视为契约。

---

## 1. 现状评估（v0.5.4）

### 1.1 已经做得好的部分

| 模块 | 文件 | 现状 |
|---|---|---|
| 命令注册中心 | `src/cli/registry.ts` | 树状 matchCommand + ordered 列表 |
| 4 种输出格式 | `src/cli/output.ts` | markdown / json / ndjson / text + envelope schema + 退出码 |
| 全局 flag | `src/cli/global-flags.ts` | env fallback 完备，`--json` 别名 |
| AI cheatsheet | `agents-md` | 一站式 Markdown 导出 |
| 命令域 | 31 个 | lifecycle / config / logs / diagnose 4 大域 |
| 高级操作 | config-extra | dry-run / 备份 / rollback / JSON Patch / import |

### 1.2 对照 Web Admin 与 HTTP API 的能力缺口

| 域 | Web/API 已有 | CLI 缺失 |
|---|---|---|
| 通用设置 | `general-settings.tsx` LAN 开关 | ❌ 无 `config server *` |
| Chat 调试 | `/api/chat/proxy` + chat 页 | ❌ `try` 仅走路由，没有 chat 直连 provider |
| 插件 | `providerConfig.plugins[]` + PluginManager 热重载 | ❌ 完全无 `config provider plugin *` |
| Dashboard | `/api/metrics/logs` topProviders / statusClasses | ⚠ `logs metrics` 只展示了一半 |
| Sessions | `logs sessions` 只 dump JSON | ⚠ 无 Markdown 表格、无 detail 子命令 |
| Token usage | `src/token-usage.ts` 完整体系 | ❌ 无 `logs tokens` / `logs cost` |
| 日志清理 | `streams.retainDays` | ❌ 无 `logs gc` / `logs prune` |
| OpenAPI | `/api/openapi.json` | ❌ 无 `schema openapi` |
| Admin 入口 | 面板地址 | ❌ 无 `open admin` |

### 1.3 体验 / AI 友好性短板

1. **入口分裂**：`get-route`、`config` 在 `cli.ts` 硬编码 dispatch，没进 registry → `commands --json` 漏列，`help config xxx` 失效。
2. **命令冗长**：`config provider model add openai gpt-4o-mini` 7 段；缺短别名与模糊提示。
3. **flag 元信息 vs 解析两套**：每个 handler 重复写 `parseArgs({ options })`，与 `defineCommand({ flags })` 手动同步，已发生漂移（如 `restart` 的 `flags as never`、`logs events` 的 `multiple` 没生效）。
4. **错误回归差**：USAGE_ERROR 不输出 did-you-mean；Markdown 错误块没有"如何修复"代码示例。
5. **stdin / 管道**：`config patch`/`import` 支持 stdin，`config provider add` 不支持 `.env` 或 JSON 片段。
6. **shell 补全**：完全没有 `completion bash|zsh|fish`。
7. **状态心智**：`status` 与 `logs metrics` 各自要 fetch；缺一站式 summary。
8. **AI 友好性**：默认 Markdown 已较好；但 meta 没有 `correlation_id` / `next` 建议命令；`agents-md` 静态生成，无 `--include schemas` 模块化。
9. **交互模型**：仅 `route set` 有 readline，体验粗糙，没有箭头键 / 模糊过滤。
10. **可发现性**：缺 `examples`、`recipes <task>`、`why <error-code>` 这类 AI 友好命令。

---

## 2. 设计原则

1. **闭环**：Web 能做的 CLI 都能做；CLI 操作都有结构化输出。
2. **声明 = 实现**：`defineCommand({flags})` 单一真相源，运行时生成 parser / help / 校验 / 补全 / JSON schema。
3. **Markdown-first，machine-second**：默认 Markdown 直读；`-o json` 全字段稳定 schema、版本化。
4. **零摩擦发现**：从 0 到完成任务最多 3 个命令（`doctor` → `examples` → 执行）。

---

## 3. 命令体系全景图（v0.6 目标）

```
local-router
├── 生命周期
│   ├── start [--daemon] [--port] [--host] [--idle-timeout] [--wait-healthy] [--print json|url|state]
│   ├── stop [--wait] [--force]
│   ├── restart [...]
│   ├── status [--wait-running|--wait-stopped] [--watch]      ← 新增 --watch
│   ├── health [--retry]
│   └── version [--check-update]                              ← 新增 npm registry 比对
│
├── 配置（资源化 + 直读/直写两种心智）
│   ├── init [--force] [--template openai|anthropic|both]     ← 新增模板
│   ├── config show [--show-secrets] [--path <jsonpath>]      ← 新增 jsonpath 子查询
│   ├── config edit                                            ← 新增 $EDITOR 打开
│   ├── config validate
│   ├── config apply [--wait] [--no-restart-required-warn]
│   ├── config diff [--against backup-id|path|HEAD]
│   ├── config backups list|prune|export
│   ├── config rollback <id>
│   ├── config import / patch (已有)
│   ├── config export [--mask-secrets] [--format json|json5|yaml]   ← 新增
│   ├── config provider list|show|add|set|remove
│   │   ├── plugin list|add|remove|set                         ← 新增
│   │   └── model list|add|set|remove
│   ├── config route list|show|set|remove|plan
│   ├── config resolve --entry --model
│   └── config server lan enable|disable|status                ← 新增
│
├── 诊断 / 调试
│   ├── doctor [--fix]                                         ← 新增 --fix
│   ├── ping <provider> [--deep]                               ← --deep 发一次 1-token 试探
│   ├── try --entry --model [--prompt] [--stream] [--save-as <name>]
│   ├── chat --provider --model [--prompt|--file -]            ← 新增直连，绕路由
│   ├── explain route --entry --model
│   └── trace <event-id>                                       ← logs replay 友好别名
│
├── 日志
│   ├── logs events / event / last-error / metrics / storage / tail / export / replay (已有)
│   ├── logs sessions [list|show <id>]                         ← 拆细
│   ├── logs tokens  [--window] [--by provider|model|session]  ← 新增
│   ├── logs cost    [--window] [--rate-table <path>]          ← 新增
│   ├── logs prune   [--older-than 7d] [--dry-run]             ← 新增
│   ├── logs daemon  [--follow] [--lines]
│   └── logs watch <pattern>                                   ← 新增长连接 + jq-like 过滤
│
├── 自描述（AI 入口）
│   ├── commands [--all] [--grep] [--tag] [--mutates] [--needs-running]   ← 加过滤
│   ├── capabilities
│   ├── schema config|cli|errors|openapi                       ← 新增 openapi
│   ├── help [<cmd>] [--examples-only]
│   ├── docs errors [<code>]
│   ├── agents-md [--include schemas,examples,recipes]         ← 模块化
│   ├── recipes [<task>]                                       ← 新增任务库
│   ├── examples [<cmd>]                                       ← 新增 cookbook
│   └── why <error-code>                                       ← 别名 docs errors，AI 友好
│
├── 工具
│   ├── completion bash|zsh|fish|pwsh                          ← 新增
│   ├── open admin|docs|logs-dir|config                        ← 新增
│   ├── env [--export]                                          ← 打印 env vars
│   └── repl                                                    ← 新增交互 shell（可选）
│
└── 内部
    └── __run-server (已有 hidden)
```

---

## 4. 关键架构改造（按 PR 顺序）

### PR-1 · Spec-first 命令引擎

**问题**：`defineCommand({flags})` 与 handler 内 `parseArgs` 重复，漂移频繁。

**方案**：在 `registry.ts` 引入 `runWithSchema()`：

- handler 签名改为 `(values: ParsedValues<TFlags>, positionals: string[], ctx: OutputContext) => …`
- registry 根据 `flags` 元数据自动生成 parseArgs 配置 + 类型校验 + required 检查 + did-you-mean
- handler 内部不再调用 `parseArgs`，每命令少写约 30 行（总 5200 行减约 1200）

**收益**：补全 / schema / 帮助 / 校验全部从同一份 spec 生成；新加 flag 只改一处。

### PR-2 · 全量并入 registry + did-you-mean

- `cli.ts` 里 `cmdConfig` / `cmdGetRoute` / `printHelpFallback` 全部 `defineCommand` 注册，去掉硬编码 dispatch。
- `matchCommand` 找不到时跑 Levenshtein 距离 ≤2，回 `USAGE_ERROR` + 候选建议。
- `logs` 不带子命令时直接报错引导（移除 backward-compat 注入）。

### PR-3 · 自动化 shell 补全

- 新增 `local-router completion <shell>` → echo 出 zsh/bash/fish 完整脚本。
- 脚本内部调用 `local-router commands --json` 并缓存（带 mtime 失效）→ 子命令、flag、enum 值全部补全。
- 文档：`eval "$(local-router completion zsh)"`。

### PR-4 · 闭环新命令（按优先级）

**P0**（直接消除 Web 独占）：

- `config server lan enable|disable|status` — 改写 `server.lanAccess.enabled`
- `config provider plugin list|add|remove|set` — 操作 `providerConfig.plugins[]`
- `chat --provider --model [--file -]` — 包装 `/api/chat/proxy`，支持 stdin 拼接
- `config export [--mask-secrets] [--format yaml]`

**P1**（运维高频）：

- `logs prune --older-than 7d [--dry-run]`
- `logs tokens [--window 24h] [--by provider]`（基于 `token-usage.ts`）
- `logs cost --rate-table cost.json` 计算费用
- `doctor --fix` 对端口冲突、缺 `*` 兜底等给出可执行修复

**P2**（开发者愉悦）：

- `config edit` 调 `$EDITOR`，关闭后 auto-validate + diff 预览 + 二次确认
- `open admin|docs|logs-dir|config` — macOS `open` / Linux `xdg-open`
- `env --export` 输出 shell `export` 行
- `version --check-update` — 异步查 npm registry

### PR-5 · AI 友好性升级（核心）

**5.1 Envelope v2**

```json
{
  "ok": true,
  "command": "config.provider.add",
  "schema_version": 2,
  "data": {...},
  "meta": {
    "elapsedMs": 12,
    "correlation_id": "01HF…",
    "next": [
      {"cmd": "local-router config apply", "why": "热加载新 provider"},
      {"cmd": "local-router try --entry openai-completions ...", "why": "端到端验证"}
    ],
    "config_path": "/Users/x/.local-router/config.json5",
    "backup_path": "..."
  },
  "warnings": []
}
```

错误时 `error.fix.steps[]` 给出可执行步骤数组，而非单一 hint 字符串。

**5.2 Markdown 内嵌结构化 frontmatter**

默认 Markdown 输出顶部加 HTML 注释 `<!-- json: {"ok":true,"command":"…"} -->`，AI 同时拿到人类可读和机器可读，无需跑两遍。

**5.3 `recipes` 任务库**

```sh
local-router recipes              # 列出所有任务
local-router recipes add-openai   # 输出从 0 到验证的完整 shell 脚本（Markdown）
local-router recipes debug-error  # 复现 + 抓 last-error + replay
```

recipe 是 `.md` 模板内嵌在二进制里，AI 直接 cat 即可执行。

**5.4 `agents-md` 模块化**

```sh
local-router agents-md                            # 完整
local-router agents-md --include schemas          # 只导出 JSON schema
local-router agents-md --include errors,examples  # 自选
local-router agents-md --emit-to AGENTS.md        # 直接落盘
```

**5.5 `--explain` 全局 flag**

任何命令加 `--explain` 不执行，只输出"这条命令会做什么、会改哪些文件、需要什么前置条件"的 Markdown。AI 拿不准时可先 `--explain` 预览。

### PR-6 · 交互体验现代化

- 轻量 TUI（不引第三方，纯 ANSI）：`↑↓` 选择 + `/` 过滤 + `Enter` 确认；fallback 到当前 `selectFromList`。
- `config provider add` 全字段向导，可保存为 recipe 复用。
- `--yes` / `--no-interactive` 严格生效；`LOCAL_ROUTER_NO_INTERACTIVE=1` 时所有提示退化为校验错误并给 hint。

### PR-7 · 性能与启动速度

- `dist/cli.js` 已 minify；import 链拆 lazy：`logs/diagnose/config-extra` 全部 `await import()`。
- 目标：冷启动 `local-router --help` < 80 ms（当前约 150 ms）。

### PR-8 · 测试基线

- `tests/cli/` 增加 contract 测试：每命令跑 `--json`，校验 schema_version、data 字段稳定。
- 黄金文件：`agents-md` 输出 snapshot；`commands --json` snapshot；schema 变更需主动更新。
- e2e：`start --daemon → config provider add --dry-run → apply → try → stop` 一条龙。

---

## 5. CLI 体验设计细节

### 5.1 短别名（不破坏现有长名）

```
status   → st
config   → c       logs     → l
provider → p       route    → r       model → m
list     → ls      show     → cat     remove → rm    set → put
```

例：`local-router c p ls` ≡ `local-router config provider list`。
`commands --json` 默认列长名；`--all` 时同时列别名。

### 5.2 统一 `--from-file` / `--from-stdin`

所有 `add`/`set` 类命令接受 `--from-file <path|->`，内容为 JSON5 片段，与 schema 对应，减少长 flag 列表。

### 5.3 `local-router .` 智能默认

在 git 仓库目录下，若存在 `.local-router/config.json5`，自动使用；否则提示创建。

### 5.4 退出码（保持 v1 不变）

| code | 含义 |
|---|---|
| 0 | OK |
| 1 | 未知错误 |
| 2 | 用法错误 |
| 3 | 服务未运行 |
| 4 | 状态冲突 |
| 5 | 配置校验失败 |
| 6 | 资源不存在 |
| 7 | 超时 |
| 8 | 健康检查 / apply 失败 |
| 9 | 上游不可达 |
| 10 | 需要交互终端 |

---

## 6. 已决策项

| 决策 | 选择 | 说明 |
|---|---|---|
| 引入短别名 | ✅ 引入 | 但 `commands --json` 默认列长名，`--all` 才显示别名 |
| `chat` 命令位置 | ✅ top-level | 与 `try`（走路由）平级，形成清晰对照 |
| `recipes` 内容存放 | ✅ 内嵌 dist | 首发简单，后续可拆 `@lakphy/local-router-recipes` |
| Envelope schema_version 升 2 | ✅ 允许 breaking | 加 `--schema-version 1` flag 兜底一个 release |

---

## 7. 交付节奏

| 阶段 | 周期 | 内容 |
|---|---|---|
| W1 | PR-1 + PR-2 | 引擎统一 + did-you-mean |
| W2 | PR-3 + PR-4 P0 | 补全 + LAN/plugin/chat/export |
| W3 | PR-4 P1 + PR-5.1-5.3 | tokens/cost/prune + envelope v2 + recipes |
| W4 | PR-5.4-5.5 + PR-6 | agents-md 模块化 + TUI |
| W5 | PR-7 + PR-8 | 性能 + 测试基线 |

每个 PR 独立可发布，按 SemVer minor（0.6 → 0.7 → …）递增；schema_version 在 PR-5 升到 2，并保留 v1 兼容 1 个版本。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 引擎重构破坏现有命令 | PR-1 先迁移 1 个 handler 作样板，contract 测试通过再批量推 |
| schema_version 升级影响下游脚本 | 提供 `--schema-version 1` flag + warning 提示 |
| TUI 在非 TTY 环境异常 | 严格 `process.stdin.isTTY` 检测，无 TTY 直接报 `INTERACTIVE_REQUIRED` |
| `chat` 直连暴露密钥风险 | 复用 `/api/chat/proxy`，所有密钥仍在 daemon 内，不经过 CLI 进程 |
| 命令数量膨胀难维护 | spec-first 引擎让单命令成本降到约 20 行；`commands --json` 自动化补全降低记忆成本 |
