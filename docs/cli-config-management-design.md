# local-router CLI 配置管理设计（Native 运维体验版）

> 本文是对前版“通用 JSON 路径操作”方案的升级：从“技术上可改任意字段”转为“用户按 Provider/Route 任务直接完成配置”。

## 1. 设计目标（面向真实使用场景）

用户最常见的问题不是“如何改某个 JSON path”，而是：

- 我怎么新增一个 provider？
- 我怎么看目前有哪些 provider、它们连到哪？
- 我怎么把某个入口模型路由到某个 provider/model？
- 我怎么验证路由最终会流向哪里？

因此 CLI 需要做到：

1. **任务导向（task-oriented）**：以 `provider`、`route`、`doctor` 这类业务概念为中心。
2. **强引导（discoverable）**：`--help`、`list`、`describe` 能让用户不看文档也会用。
3. **安全变更（safe-by-default）**：写入前校验、预览 diff、自动备份。
4. **脚本友好（automation-ready）**：所有查询命令支持 `--json`。

---

## 2. 命令体系重构（建议）

不再把 `config set/get/unset` 作为主入口，而是引入 `local-router config` 下的“资源化子命令”。

## 2.1 Provider 命令组

```bash
local-router config provider list
local-router config provider show <name>
local-router config provider add <name> --type <type> --base <url> --api-key <key>
local-router config provider set <name> [--base ...] [--api-key ...] [--proxy ...]
local-router config provider remove <name>

local-router config provider model list <provider>
local-router config provider model add <provider> <model> [--image-input] [--reasoning]
local-router config provider model set <provider> <model> [--image-input=<bool>] [--reasoning=<bool>]
local-router config provider model remove <provider> <model>
```

### 体验要点

- `provider list` 默认表格：`NAME | TYPE | BASE | MODELS | PROXY`。
- `provider show` 展示完整详情，并对 `apiKey` 做脱敏（`--show-secrets` 才明文）。
- `provider add` 支持交互模式（缺参数时问答补全），也支持全参数非交互模式（CI）。

## 2.2 Route 命令组

```bash
local-router config route list
local-router config route list --entry openai-completions
local-router config route show <entry>

local-router config route set <entry> <match-model> --provider <name> --model <target-model>
local-router config route remove <entry> <match-model>

local-router config route ensure-fallback <entry> --provider <name> --model <target-model>
```

### 体验要点

- `route list` 默认按入口协议分组显示：`ENTRY | MATCH | -> PROVIDER/MODEL`。
- `route set` 会检查 provider 是否存在、target model 是否在 provider.models 内。
- `route remove` 禁止删除 `*` 兜底（除非显式 `--allow-remove-fallback`）。

### TUI 选择器模式（路由配置默认体验）

你提到的关键点非常重要：在真实使用中，用户通常不想手敲 `--provider/--model`，而是希望被引导选择。

因此建议把 `route set` 设计为“双模式”：

1. **默认 TUI 选择模式（推荐）**
2. **显式参数模式（CI/脚本）**

#### 交互命令形态

```bash
# 默认进入交互选择器（不传 provider/model）
local-router config route set <entry> <match-model>

# 非交互模式（脚本）
local-router config route set <entry> <match-model> --provider <name> --model <target-model>

# 强制交互（即使传了 provider，也允许用户二次确认）
local-router config route set <entry> <match-model> --interactive
```

#### TUI 选择流程（4 步）

1. **选择 entry**（若未传 `<entry>`）
   - 候选来自 `routes` 已有 key + 系统支持协议（`openai-completions/openai-responses/anthropic-messages`）。
2. **输入/确认 match-model**
   - 可直接输入（如 `gpt-4o`），或选择 `*` 兜底规则。
3. **选择 provider**
   - 列表展示：`NAME | TYPE | BASE | MODELS(数量)`。
   - 可按关键字过滤（provider 名称、type）。
4. **选择该 provider 下的 model**
   - 仅展示所选 provider 的 `models`。
   - 附带能力标签（`image-input`/`reasoning`）辅助判断。

最终展示变更预览：

- `entry.match-model -> provider/model`
- 是否覆盖已有规则
- `*` 兜底是否仍存在

确认后才写入。

#### 交互设计细节

- 支持键盘导航：↑/↓、回车确认、`/` 搜索、`q` 退出。
- 支持 `--no-tui` 降级为文本问答模式（无 TTY 或远程环境）。
- 若检测到非 TTY 且未传 `--provider/--model`，直接报错并提示：
  - `请在非交互环境下使用 --provider 与 --model，或在 TTY 中运行以启用选择器`。

#### 安全约束（TUI 同样适用）

- provider 列表为空时，引导用户先执行 `config provider add`。
- 选定 provider 后若无可用 model，引导先执行 `config provider model add`。
- 写入前执行校验，并在失败时返回可修复建议。

## 2.3 Flow/解析命令组（你提到的“当前路由怎么流向”）

```bash
local-router config resolve --entry <entry> --model <request-model>
local-router config resolve --entry openai-completions --model gpt-4o
```

输出示例：

- 匹配规则：`openai-completions.gpt-4o`（或回落到 `*`）
- 命中 provider：`openai-main`
- 转发 model：`gpt-4o-mini`
- provider base/type：`https://... / openai-completions`

该命令是排障核心能力，应该作为 `help` 中重点推荐。

## 2.4 引导与模板命令组

```bash
local-router config guide
local-router config guide provider add
local-router config template provider --type openai-completions
local-router config template route --entry anthropic-messages
```

### 体验要点

- `guide` 输出“常见任务菜单”：新增 provider、添加模型、配置兜底路由、验证流向。
- `template` 直接打印可复制命令或最小可用配置片段。

---

## 3. 帮助系统设计（Discoverability）

必须做到“用户通过帮助命令就知道怎么做”。建议：

1. `local-router config --help`：展示 Provider/Route/Resolve 三大主流程。
2. 每个子命令都提供：
   - 场景说明（什么时候用）
   - 最小示例（1 条）
   - 进阶示例（2~3 条）
3. 增加 `--examples`：打印更多真实案例。
4. 错误信息附带修复建议，例如：
   - `provider not found: openai-x` -> `运行 local-router config provider list 查看可用 provider`。

---

## 4. 推荐用户流程（CLI 新手到熟练）

## 4.1 新建 provider（OpenAI 兼容）

```bash
local-router config provider add openai-main \
  --type openai-completions \
  --base https://api.openai.com/v1 \
  --api-key $OPENAI_API_KEY

local-router config provider model add openai-main gpt-4o --image-input
local-router config provider model add openai-main gpt-4o-mini
```

## 4.2 指定路由

```bash
# 交互选择 provider/model
local-router config route set openai-completions gpt-4o

# 配置兜底（交互选择）
local-router config route set openai-completions '*'

# CI/脚本场景可显式传参
local-router config route set openai-completions '*' \
  --provider openai-main --model gpt-4o-mini
```

## 4.3 验证流向

```bash
local-router config resolve --entry openai-completions --model gpt-4o
local-router config resolve --entry openai-completions --model unknown-model
```

## 4.4 应用与校验

```bash
local-router config validate
local-router config apply
```

---

## 5. 仍保留“底层 JSON path 能力”，但降级为高级工具

保留：

```bash
local-router config get <path>
local-router config set <path> --json <value>
local-router config unset <path>
```

但定位为：

- `config advanced ...` 或文档中的“高级模式”；
- 主要服务非常规字段和紧急修复；
- 日常操作优先走 provider/route 原生命令。

---

## 6. 技术实现建议（与现有代码对齐）

## 6.1 CLI 结构

建议在 `src/cli.ts` 中新增 `config` 一级分发，再拆分文件：

- `src/cli/config/index.ts`：总路由
- `src/cli/config/provider.ts`
- `src/cli/config/provider-model.ts`
- `src/cli/config/route.ts`
- `src/cli/config/resolve.ts`
- `src/cli/config/guide.ts`
- `src/cli/config/io.ts`（读写、备份、原子写入）
- `src/cli/config/format.ts`（table/json 渲染）

## 6.2 校验链路

写操作统一走：

1. 读取配置文件（`resolveConfigPath/loadConfig`）
2. 应用业务变更（provider/route 语义层）
3. 运行 `ConfigStore.validate`
4. 运行 Schema 校验（建议抽共享模块）
5. 写入 + 备份
6. 可选 `--apply`

## 6.3 输出风格

- 默认人类友好（table + 彩色高亮）
- `--json` 给脚本
- `--quiet` 仅错误输出

---

## 7. 安全与可恢复性

1. 原子写入：`tmp -> rename`。
2. 自动备份：每次写前保存一份，支持 `config history` / `config rollback`（后续）。
3. 防误删：删除 provider 前检查是否被 routes 引用，除非 `--force`。
4. 敏感信息保护：默认脱敏输出，日志中不打印明文 `apiKey`。

---

## 8. 分阶段落地

## Phase 1（先满足你提出的核心诉求）

- `provider list/show/add/set/remove`
- `provider model list/add/set/remove`
- `route list/show/set/remove`
- `resolve`
- `validate/apply`
- 帮助系统 + 示例

## Phase 2（运维增强）

- `guide/template`
- `doctor`（配置自检，如未配置兜底、引用不存在 provider）
- `history/rollback`

## Phase 3（高级能力）

- 自动补全（bash/zsh/fish）
- 全屏配置向导（Wizard 模式，区别于 route set 的轻量选择器）
- 批量 patch

---

## 9. 验收标准（native 体验版）

1. 用户仅看 `--help` 就能完成“新增 provider + 添加路由 + 验证流向”。
2. 不需要理解 JSON path，也能完成 90% 日常配置任务。
3. `resolve` 能清晰解释请求模型最终命中的 provider/model。
4. 删除/修改类命令有防呆和回滚能力。
5. 查询命令都支持 `--json` 便于自动化。

---

## 10. 示例：最终希望达到的 CLI 体验

```bash
# 看看现在有哪些 provider
local-router config provider list

# 新增一个 provider
local-router config provider add claude-main \
  --type anthropic-messages \
  --base https://api.anthropic.com \
  --api-key $ANTHROPIC_API_KEY

# 给 provider 增加模型能力
local-router config provider model add claude-main claude-sonnet-4-5 --reasoning --image-input

# 配置路由规则
# 日常推荐：交互选择 provider/model
local-router config route set anthropic-messages sonnet
local-router config route set anthropic-messages '*'

# 自动化场景：显式参数
local-router config route set anthropic-messages sonnet \
  --provider claude-main --model claude-sonnet-4-5

# 验证当前请求会怎么走
local-router config resolve --entry anthropic-messages --model sonnet

# 校验并应用
local-router config validate
local-router config apply
```

以上命令集比“裸 JSON path 操作”更符合你的目标：让用户通过 CLI 原生任务完成配置，而不是先理解配置文件内部结构。
