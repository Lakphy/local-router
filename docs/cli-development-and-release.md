# local-router CLI 开发与发布指南

本文面向当前仓库（Bun 开发，Bun + npm 双分发），覆盖从开发、测试到构建发布的完整流程。

## 1. 开始开发

### 1.1 环境准备

- 安装 Bun（建议 `>=1.2.0`，当前仓库声明：`packageManager: bun@1.2.0`）
- Node/npm 仅用于 `npm publish`（开发主链路仍为 Bun）

安装依赖：

```bash
bun install
```

### 1.2 CLI 代码位置

- CLI 入口：`src/cli.ts`
- 进程/daemon 管理：`src/cli/process.ts`
- 运行态文件（pid/status/log）管理：`src/cli/runtime.ts`
- Server 启停封装：`src/server.ts`
- 应用装配与生命周期：`src/index.ts`
- Bun 启动入口（服务端）：`src/entry.ts`

### 1.3 本地开发运行方式

1) 仅开发 API（推荐 CLI 相关开发时使用）：

```bash
bun run dev:api
```

1) 同时开发 API + 管理面板：

```bash
bun run dev
```

1) 直接调试 CLI（不需要先 build）：

```bash
bun run src/cli.ts --help
bun run src/cli.ts start
bun run src/cli.ts start --daemon
bun run src/cli.ts status
bun run src/cli.ts stop
```

## 2. 开发完成后如何测试

### 2.1 单元 + 集成测试

运行全部测试：

```bash
bun test
```

建议在 CLI 改动后至少额外确认：

```bash
bun test tests/unit/cli-flags.test.ts tests/integration/cli-init.test.ts
```

### 2.2 代码规范检查

```bash
bun run check
```

如果需要自动修复格式/部分规则：

```bash
bun run check:fix
```

### 2.3 手工冒烟测试（建议）

```bash
bun run src/cli.ts start --daemon
bun run src/cli.ts status
bun run src/cli.ts health
bun run src/cli.ts logs --lines 50
bun run src/cli.ts stop
```

确认点：

- 首次启动是否自动创建空配置（默认 `~/.local-router/config.json5`）
- `status` 是否正确显示 pid、地址、配置路径、运行模式
- `status --json` 是否返回 `uptimeSeconds` 与 `checkedAt`
- `stop` 后 pid/status 文件是否清理

## 3. 测试完成后如何构建

### 3.1 构建 API + CLI（最小发布必需）

```bash
bun run build:api
bun run build:cli
```

产物：

- `dist/entry.js`（服务入口）
- `dist/cli.js`（CLI 入口，含 shebang）

### 3.2 全量构建（包含 Web）

```bash
bun run build
```

说明：该命令会并行执行 `build:api`、`build:web`、`build:cli`。如果你当前只验证 CLI 发布链路，优先使用 `build:api + build:cli` 即可。

## 4. 发布到 npm 与 Bun

### 4.1 发布前检查清单

- `package.json` 版本号已更新（`version`）
- `bun test` 通过
- `bun run check` 通过
- `bun run build:api && bun run build:cli` 通过
- `bun run dist/cli.js --help` 输出正常
- `bin` 字段已指向 `dist/cli.js`

### 4.2 发布到 npm

登录（如未登录）：

```bash
npm login
```

发布：

```bash
npm publish
```

### 4.3 发布到 Bun

登录（如未登录）：

```bash
bun pm whoami
```

发布：

```bash
bun publish
```

## 5. 安装后验证（分发验收）

### 5.1 npm 全局安装验证

```bash
npm i -g local-router
local-router --help
local-router start --daemon
local-router status
local-router stop
```

### 5.2 Bun 全局安装验证

```bash
bun add -g local-router
local-router --help
```

## 6. 常见问题

### 6.1 `start --daemon` 启动失败

- 先看 `~/.local-router/logs/daemon.log`
- 再执行 `local-router status` 确认是否有僵尸 pid 被自动清理

### 6.2 配置文件不存在

- 执行 `local-router init` 手动初始化
- 或直接 `local-router start` 让它自动初始化

### 6.3 端口冲突

- 指定其他端口启动：`local-router start --port 4100`
- 或停止占用进程后重试
