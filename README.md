## 安装依赖

```sh
bun install
```

## 开发运行

```sh
bun run dev
```

默认打开 `http://localhost:4099`。

## CLI 用法

```sh
bun run src/cli.ts --help
```

常用命令：

```sh
local-router start
local-router start --daemon
local-router status
local-router stop
local-router logs --follow
```

首次 `start` 或执行 `init` 时会自动生成空模板配置文件（默认 `~/.local-router/config.json5`）。

## 构建与分发

```sh
bun run build
```

发布到 npm：

```sh
npm publish
```

发布到 Bun：

```sh
bun publish
```
