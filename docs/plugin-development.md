# 插件开发指南

本文档介绍如何为 local-router 开发插件。

## 快速开始

### 1. 创建插件文件

```typescript
// my-plugin.ts
// 仓库内开发时可用相对路径引入类型
import type { PluginDefinition, Plugin } from '../src/plugin';
// 外部插件可直接定义接口，无需引入类型依赖（参见下方"类型定义"小节）

const definition: PluginDefinition = {
  name: 'my-plugin',
  version: '1.0.0',

  create(params) {
    return {
      async onRequest({ ctx, url, headers, body }) {
        // 修改请求
        headers.set('x-custom-header', 'value');
        return { headers };
      },

      async onResponse({ ctx, status, headers, body }) {
        // 修改响应
        return { body: body.replace('old', 'new') };
      },
    };
  },
};

export default definition;
```

### 2. 在配置中引用

插件支持三种加载方式：本地路径、远程 URL、npm 包名。

```json5
{
  providers: {
    "my-provider": {
      // ...
      plugins: [
        // 本地文件路径（支持 .js / .ts）
        { "package": "./my-plugin.ts", "params": { "key": "value" } },
        // 远程 URL（支持 .js / .ts）
        { "package": "https://example.com/plugins/my-plugin.js" },
        // npm 包名
        { "package": "local-router-plugin-audit", "params": { "level": "info" } }
      ]
    }
  }
}
```

### 3. 应用配置

调用 `POST /api/config/apply` 或重启服务。

### 类型说明

插件接口非常简单，外部插件**无需依赖 `local-router` 包**即可开发。只需导出一个符合以下结构的对象：

```typescript
// 外部插件只需满足此结构即可，无需安装 local-router
export default {
  name: 'my-plugin',
  version: '1.0.0',
  create(params: Record<string, unknown>) {
    return {
      async onRequest({ ctx, url, headers, body }) { /* ... */ },
      async onResponse({ ctx, status, headers, body }) { /* ... */ },
    };
  },
};
```

如果你在 local-router 仓库内开发插件，可以直接用相对路径引入类型：

```typescript
import type { PluginDefinition, Plugin } from '../src/plugin';
```

## 插件接口参考

### PluginDefinition

插件模块必须导出（default export 或命名导出）一个符合 `PluginDefinition` 接口的对象：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | 是 | 插件名称，用于日志标识 |
| `version` | `string` | 否 | 插件版本号 |
| `create` | `function` | 是 | 工厂方法，接收 params 返回 Plugin 实例 |

### Plugin 实例方法

#### `onRequest`

在请求发往上游 Provider **之前**调用，正序执行。

```typescript
onRequest(args: {
  ctx: PluginContext;    // 只读上下文
  url: string;           // 目标 URL
  headers: Headers;      // 请求头（可修改）
  body: Record<string, unknown>;  // 请求体（已解析 JSON）
}): Promise<{ url?: string; headers?: Headers; body?: Record<string, unknown> } | void>
```

返回值中存在的字段会覆盖对应值；返回 `void` 或 `undefined` 表示不修改。

#### `onResponse`

在收到上游 **非流式** JSON 响应后调用，逆序执行。

```typescript
onResponse(args: {
  ctx: PluginContext;
  status: number;
  headers: Record<string, string>;
  body: string;          // 原始响应文本
}): Promise<{ status?: number; headers?: Record<string, string>; body?: string } | void>
```

#### `onSSEResponse`

在收到上游 **流式** SSE 响应后调用，逆序执行。返回 `TransformStream` 实现逐 chunk 处理。

```typescript
onSSEResponse(args: {
  ctx: PluginContext;
  status: number;
  headers: Record<string, string>;
}): Promise<{
  status?: number;
  headers?: Record<string, string>;
  transform?: TransformStream<Uint8Array, Uint8Array>;
} | void>
```

#### `onError`

当该插件的 handler 抛出异常时调用。

```typescript
onError(args: {
  ctx: PluginContext;
  phase: 'request' | 'response';
  error: Error;
}): Promise<void>
```

#### `dispose`

插件被卸载时调用（热重载或服务关闭），用于清理资源。

```typescript
dispose(): void | Promise<void>
```

## 生命周期

```
服务启动 / config apply
  ↓
import(package) / fetch(url) → PluginDefinition
  ↓
definition.create(params) → Plugin 实例
  ↓
每次请求：onRequest → [Provider] → onResponse / onSSEResponse
  ↓
config apply / 服务关闭：dispose()
```

## 洋葱模型说明

```
用户请求 → Plugin A.onRequest → Plugin B.onRequest → Provider
Provider  → Plugin B.onResponse → Plugin A.onResponse → 用户响应
```

请求阶段正序（A → B），响应阶段逆序（B → A），与 Express/Koa/Hono 中间件一致。

## SSE TransformStream 开发指南

流式响应使用 `TransformStream` 实现逐 chunk 处理，不缓冲整个流：

```typescript
async onSSEResponse({ ctx }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      // 处理文本...
      controller.enqueue(encoder.encode(text));
    },
    flush(controller) {
      // 流结束时的清理逻辑
    },
  });

  return { transform };
}
```

多个插件的 TransformStream 会通过 `pipeThrough` 自动串联。

## 错误处理最佳实践

- **优雅降级**：插件异常不会中断请求转发，仅触发 `onError` 回调
- **在 onError 中记录日志**：便于排查插件问题
- **避免在 onError 中抛异常**：`onError` 本身的异常会被静默忽略
- **加载失败不阻断**：单个插件加载失败只打印 console.error，不影响其他插件和 Provider

## 远程 URL 插件

支持通过 HTTP/HTTPS URL 加载远程插件，适用于团队共享插件、CDN 分发等场景。

### 配置示例

```json5
{
  plugins: [
    { "package": "https://example.com/plugins/audit.js" },
    { "package": "https://raw.githubusercontent.com/user/repo/main/plugin.ts" }
  ]
}
```

### 加载流程

1. 通过 `fetch()` 下载远程文件
2. 根据 URL 路径扩展名（`.ts`/`.js`/`.mjs`）推断文件类型
3. 写入临时目录后通过 `import()` 加载（Bun 原生转译 TypeScript）
4. 服务关闭或全量 dispose 时自动清理临时文件

### 注意事项

- **网络依赖**：服务启动和热重载时需要网络可达，下载失败视为加载失败（不影响其他插件）
- **安全性**：请仅从可信来源加载远程插件，远程代码会在服务进程中执行
- **热重载**：每次 reload 都会重新下载最新版本，不缓存旧内容
- **TypeScript 支持**：远程 `.ts` 文件由 Bun 原生转译，无需预编译

## 热重载注意事项

- 调用 `/api/config/apply` 会原子替换插件：先加载所有新插件，成功后一次性替换旧 map，旧实例延迟销毁
- 如果新插件加载失败，apply 接口会在响应中返回 `pluginWarnings` 字段列出失败详情
- 本地文件插件会追加时间戳参数绕过模块缓存
- 远程 URL 插件每次 reload 都会重新下载，确保获取最新版本；旧临时文件在全部插件销毁时清理
- **有状态插件**：在 `dispose` 中清理计时器、连接等资源
- 热重载期间的 in-flight 请求使用旧插件实例，旧实例会延迟 5 秒后销毁以保护在途请求

## 调试技巧

1. 在管理面板日志详情页查看「插件管线」区块
2. 日志 JSON 中 `plugins_request` / `plugins_response` 记录了经过的插件列表
3. 如果请求 body 被修改，`request_body_after_plugins` 会记录修改后的值
4. 使用 `console.log` 在插件中输出调试信息（会显示在服务终端）
