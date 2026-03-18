# local-router 插件体系

## 概述

local-router 支持通过插件扩展请求/响应的处理流程。插件基于 **AOP 洋葱模型**：

- **请求阶段**：正序执行（Plugin A → Plugin B → Provider）
- **响应阶段**：逆序执行（Provider → Plugin B → Plugin A）

## 配置方式

在 `config.json5` 的 provider 中添加 `plugins` 数组：

```json5
{
  providers: {
    "openai": {
      type: "openai-completions",
      base: "https://api.openai.com/v1",
      apiKey: "sk-xxx",
      plugins: [
        { "package": "local-router-plugin-audit", "params": { "level": "info" } },
        { "package": "./plugins/content-filter.ts", "params": { "keywords": ["blocked"] } },
        { "package": "https://example.com/plugins/my-plugin.js" }
      ],
      models: { "gpt-4o": {} }
    }
  }
}
```

### 加载策略

- `package` 以 `http://` 或 `https://` 开头：视为远程 URL，运行时下载到临时目录后加载
- `package` 以 `./`、`../`、`/` 开头：视为本地文件路径（相对于配置文件目录解析）
- 其他值：作为 npm 包名通过 `import()` 加载

> 本地路径和远程 URL 均支持 `.js` 和 `.ts` 文件（Bun 原生转译 TypeScript）。

### 执行顺序

数组顺序 = 洋葱模型外→内层级：
- 请求阶段：`plugins[0].onRequest` → `plugins[1].onRequest` → ... → 发往 Provider
- 响应阶段：... → `plugins[1].onResponse` → `plugins[0].onResponse` → 返回用户

## 插件接口

### PluginDefinition（模块导出）

```typescript
interface PluginDefinition {
  name: string;
  version?: string;
  create(params: Record<string, unknown>): Plugin | Promise<Plugin>;
}
```

### Plugin（实例接口）

```typescript
interface Plugin {
  onRequest?(args: { ctx, url, headers, body }): Promise<{ url?, headers?, body? } | void>;
  onResponse?(args: { ctx, status, headers, body }): Promise<{ status?, headers?, body? } | void>;
  onSSEResponse?(args: { ctx, status, headers }): Promise<{ status?, headers?, transform? } | void>;
  onError?(args: { ctx, phase, error }): Promise<void>;
  dispose?(): void | Promise<void>;
}
```

### PluginContext（只读上下文）

```typescript
interface PluginContext {
  requestId: string;
  provider: string;
  modelIn: string;
  modelOut: string;
  routeType: string;
  isStream: boolean;
}
```

## 错误处理

- 插件 handler 抛异常时：catch 后调用该插件的 `onError`，然后继续后续插件（优雅降级）
- 单个插件加载失败仅打印警告，不影响 provider 正常工作
- 远程 URL 插件下载失败（网络错误、HTTP 非 200）视为加载失败，同样仅打印警告

## 热重载

调用 `/api/config/apply` 时会自动 dispose 所有旧插件实例并重新加载。

## 日志

插件执行记录会写入日志的 `plugins_request`/`plugins_response` 字段，可在管理面板日志详情中查看。

## 示例插件

参见 `packages/plugin-example/`。
