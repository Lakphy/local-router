# 代理路径内存优化方案（高 ROI 两组改造）

## 0. 范围与目标

- 范围：`src/routes/common.ts`、`src/proxy.ts`、`src/logger.ts`，不动 `plugin.ts` 公开协议、不动 `log-index.ts` 索引层。
- 目标：在不改变对客户端、对插件、对日志消费方的可观测行为的前提下，显著降低单请求和并发场景下的常驻 / 峰值内存。
- 两组改造：
  - **A. payload 对象贯通**：消除请求体在路由→代理→插件→日志路径上的多次 JSON.parse / JSON.stringify。
  - **B. 流式日志 tap 直写**：消除 `tee()` + 临时文件 + 全量 readFile 的内存放大，改为单遍 TransformStream 旁路落盘。
- 非目标：不改 `bodyPolicy` 默认值、不改插件协议、不改流式截断语义、不改日志事件 schema。

---

## 1. 现状证据

### 1.1 payload 多次 parse / stringify

- `src/routes/common.ts:50` `payload = await c.req.json()` —— 第 1 次 parse
- `src/routes/common.ts:68` `const body = JSON.stringify(payload)` —— 第 1 次 stringify
- `src/routes/common.ts:84` `Buffer.byteLength(body, 'utf-8')` —— 仅为统计 request_bytes 而依赖 stringify 结果
- `src/proxy.ts:165` `JSON.parse(bodyStr)` —— 插件阶段第 2 次 parse
- `src/proxy.ts:186` `JSON.stringify(result.body)` —— 插件阶段第 2 次 stringify（仅在插件改 body 时）
- `src/proxy.ts:194` `JSON.parse(options.body)` —— 日志侧第 3 次 parse（`bodyPolicy !== 'off'` 时）

> 一个含图片 base64 的请求，单次代理路径内存峰值 ≈ body 大小 × 3–5。

### 1.2 流式日志双缓冲 + 全量回读

- `src/proxy.ts:276` `const [clientStream, logStream] = upstreamRes.body.tee()`
- `src/proxy.ts:286–290` 逐 chunk 读 `logStream`，`appendFile` 写临时文件 `/tmp/local-router-stream-*.sse.raw`
- `src/proxy.ts:127–143` `flushTempCaptureToLogger`：`readFile(tempPath, 'utf-8')` 把整个流回读为字符串
- `src/logger.ts:135–144` `writeStreamFile`：再 `writeFileSync` 落到 `streams/{date}/{requestId}.sse.raw`，并在内存中做 `slice(0, maxStreamBytes)` 截断

> 默认 `maxStreamBytes = 10 MB`。N 路并发流式请求产生 N × 10 MB 的瞬时峰值，外加 `tee()` 自身在生产/消费速度不一致时不可控的双内部队列。

---

## 2. 改造 A：payload 对象贯通

### 2.1 设计

让请求 payload **以单一对象形式**从路由层贯通到代理层和插件层；只在两个端点序列化为字符串：

1. 在调用上游 `fetch` 之前。
2. 在写日志事件时（如果 `bodyPolicy === 'full'` 且需要 string 化字段，则通过对象引用，由日志层延迟序列化或直接挂对象字段；对象作为只读引用复用，不再 parse 一次）。

### 2.2 接口变更

修改 `src/proxy.ts` 内部接口（**未导出给插件**，对外契约不变）：

```ts
// proxy.ts
export interface ProxyRequestOptions {
  targetUrl: string;
  apiKey: string;
  proxy?: string;
  authType: AuthType;
  // 由 string 改为对象
  body: Record<string, unknown>;
  // 新增：路由层已经知道的字节数（content-length 或一次性 stringify 后测得）
  // 用于填充 logMeta.requestBytes，避免在 proxy 内再做一次 stringify 测长。
  // 已经包含在 logMeta 里，无需新增字段——logMeta.requestBytes 已存在。
  logMeta: LogMeta;
  plugins?: Plugin[];
  pluginConfigs?: PluginPhaseLog[];
}
```

`Plugin.onRequest` 的入参 `body: Record<string, unknown>` 已经是对象（`src/plugin.ts:37`），改造后**插件协议保持完全不变**。

### 2.3 路由层改造（`src/routes/common.ts`）

```ts
// 现在
const body = JSON.stringify(payload);
// ...
requestBytes: Buffer.byteLength(body, 'utf-8'),
// ...
return proxyRequest(c, { ..., body, ... });

// 改为
const contentLengthHeader = c.req.header('content-length');
const requestBytes = contentLengthHeader
  ? Number(contentLengthHeader) || estimateJsonBytes(payload)
  : estimateJsonBytes(payload);
// 注：当 content-length 不可信（小概率上游/中间件改写）时回退到 stringify 测量，
// 但测量本身仍然只发生一次，且仅在缺 content-length 的请求上。
return proxyRequest(c, { ..., body: payload, logMeta: { ..., requestBytes } });
```

`estimateJsonBytes` 实现选择二选一（建议方案 b）：

- a. 简单实现：`Buffer.byteLength(JSON.stringify(payload), 'utf-8')`，发生一次必要的 stringify（仅用于测长，结果丢弃）。
- b. 优先实现：保留路由层一次 stringify，**把字符串作为 `body` 传下去**，并在 proxy 层只 parse 一次（仅当有 plugin 且需要对象）—— 见 2.6 折中方案。

### 2.4 代理层改造（`src/proxy.ts`）

```ts
// 入口
const { body: payload, logMeta, plugins, pluginConfigs } = options;
const hasPlugins = plugins && plugins.length > 0;
let currentBody: Record<string, unknown> = payload; // 单一引用

// 插件请求阶段：直接把对象传进去，不再 JSON.parse(bodyStr)
if (hasPlugins) {
  const ctx: PluginContext = makeCtx(logMeta);  // 见改造 A.5
  const result = await executeRequestPlugins(plugins, ctx, targetUrl, headers, currentBody);
  if (result.url !== targetUrl) {
    targetUrl = result.url;
    pluginLogOverrides.request_url_after_plugins = targetUrl;
  }
  headers = result.headers;
  if (result.body !== currentBody) {
    pluginLogOverrides.request_body_after_plugins = result.body;
    currentBody = result.body;
  }
}

// 仅在调用 fetch 前一次 stringify
const wireBody = JSON.stringify(currentBody);

// 日志：直接挂对象引用，不再 JSON.parse(options.body)
const requestBodyForLog =
  shouldLog && logger?.bodyPolicy !== 'off' ? currentBody : undefined;
```

> 关键点：`request_body_after_plugins` 字段保存的是插件返回的对象引用。它必然 **!== payload**（插件创建了新对象）才会被写入；不会出现“同一对象被记录两次”。

### 2.5 PluginContext 复用

将 `proxy.ts:166–173 / 242–249 / 328–335` 三处的 `PluginContext` 字面量合并为入口处一次构造：

```ts
const pluginCtx: PluginContext = {
  requestId: logMeta.requestId,
  provider: logMeta.provider,
  modelIn: logMeta.modelIn,
  modelOut: logMeta.modelOut,
  routeType: logMeta.routeType,
  isStream: logMeta.isStream,
};
```

收益小但每请求都触发。

### 2.6 折中方案（如果担心一次性大改）

如果想分两步落地，可以先做**最小变更版**：

- 路由层仍然 `JSON.stringify(payload)`，把 string 传给 `proxyRequest`。
- proxy 层仅在 `hasPlugins === false` 时跳过 `JSON.parse`；仅在 `bodyPolicy !== 'off'` 时把 `payload` 对象**通过 logMeta 携带**而不是再 parse 一次：

```ts
// routes/common.ts
const body = JSON.stringify(payload);
return proxyRequest(c, {
  ...,
  body,
  // 新增：把对象引用一并下传，避免 proxy 再 parse
  bodyObject: payload,
  logMeta,
});
```

```ts
// proxy.ts
const requestBody = shouldLog && logger?.bodyPolicy !== 'off' ? options.bodyObject : undefined;
const bodyObj = hasPlugins ? options.bodyObject : undefined;  // 不再 JSON.parse(bodyStr)
```

这版改动最小，已经能消除 2 次 parse；建议作为兜底方案。**主推 2.4 完整版**。

### 2.7 性能与内存预期

| 场景 | 优化前 parse/stringify 次数 | 优化后 | 说明 |
| --- | --- | --- | --- |
| 无插件、`bodyPolicy=off` | 1 parse + 1 stringify | 1 parse + 1 stringify | 持平（已是最少） |
| 无插件、`bodyPolicy=full` | 2 parse + 1 stringify | 1 parse + 1 stringify | 省 1 parse |
| 有插件、`bodyPolicy=off` | 2 parse + 2 stringify | 1 parse + 1 stringify | 省 1 parse + 1 stringify |
| 有插件、`bodyPolicy=full` | **3 parse + 2 stringify** | 1 parse + 1 stringify | 省 2 parse + 1 stringify |

含 base64 图片的 4 MB body，优化前峰值约 16–20 MB，优化后约 8 MB（一份对象 + 一份 wire string），并发 N 路按比例减少。

---

## 3. 改造 B：流式日志 tap 直写

### 3.1 设计

弃用 `tee()` + 临时文件 + readFile 三段式。改为：

1. 在路径已知的目标路径 `streams/{date}/{requestId}.sse.raw` **直接打开 fd**。
2. 用一个 `TransformStream` 作为 tap：`transform` 阶段同步 `write(fd, chunk)`，然后 `controller.enqueue(chunk)` 转发给客户端。
3. 与插件 SSE transform 串联：`upstreamRes.body → tap → pluginTransform → response`（见 3.4 顺序讨论）。
4. 累计 `streamBytes`，超过 `maxStreamBytes` 时**仅停止落盘**（写一行 `\n[TRUNCATED]`），客户端继续收到完整流。
5. 流结束（`flush`）时关闭 fd 并触发 `writeEvent`。

收益：

- 永远不把整个流体读进内存；驻留内存 = 单 chunk 大小（KB 级）。
- 节省一次磁盘写入（从 temp + final 两次降为 final 一次）。
- 不依赖 `tee()` 的隐式双缓冲。

### 3.2 logger 接口扩展

`src/logger.ts` 增加流式分段写接口（保留 `writeStreamFile` 以兼容暂不改造的调用方，最终可删除）：

```ts
// logger.ts
export interface StreamCaptureHandle {
  filePath: string | null;     // 实际落盘路径，null 表示禁用流日志
  write(chunk: Uint8Array): void;     // 同步追加；超限自动截断
  finalize(): { bytesWritten: number; truncated: boolean; filePath: string | null };
}

class Logger {
  openStreamCapture(requestId: string, dateStr: string): StreamCaptureHandle {
    if (!this._enabled || !this._streamsEnabled) {
      return makeNoopHandle();
    }
    const dir = this.ensureStreamDateDir(dateStr);
    const filePath = join(dir, `${requestId}.sse.raw`);
    const fd = openSync(filePath, 'a');
    let bytes = 0;
    let truncated = false;

    return {
      filePath,
      write: (chunk) => {
        if (truncated) return;
        if (bytes + chunk.byteLength > this.maxStreamBytes) {
          const remaining = Math.max(0, this.maxStreamBytes - bytes);
          if (remaining > 0) writeSync(fd, chunk.subarray(0, remaining));
          writeSync(fd, Buffer.from('\n[TRUNCATED]'));
          truncated = true;
          bytes = this.maxStreamBytes;
          return;
        }
        writeSync(fd, chunk);
        bytes += chunk.byteLength;
      },
      finalize: () => {
        try { closeSync(fd); } catch {}
        return { bytesWritten: bytes, truncated, filePath };
      },
    };
  }
}
```

实现要点：

- 使用 `node:fs` 同步 API（`openSync` / `writeSync` / `closeSync`），与现有 `appendFileSync` 风格一致，避免引入异步 fd 生命周期管理。
- `streamBytes`（落入日志事件的字段）按"实际写入字节，截断后停留在 maxStreamBytes"语义，与现有 `slice(0, maxStreamBytes)` 行为对齐。
- `noopHandle`：`streams.enabled === false` 或 logger 关闭时返回，使 proxy 侧调用统一。

### 3.3 proxy 层改造（`src/proxy.ts`）

替换 `proxy.ts:276–311` 的整段：

```ts
if (logMeta.isStream && upstreamRes.body) {
  // 1. 插件 SSE transform（不变）
  let sseStatus = upstreamRes.status;
  let sseHeaders = responseHeaders;
  let pluginTransform: TransformStream<Uint8Array, Uint8Array> | null = null;
  if (hasPlugins) {
    const sseResult = await createSSEPluginTransform(plugins, pluginCtx, upstreamRes.status, responseHeaders);
    sseStatus = sseResult.status;
    sseHeaders = sseResult.headers;
    pluginTransform = sseResult.transform;
    if (pluginConfigs) pluginLogOverrides.plugins_response = pluginConfigs;
  }

  // 2. 无日志：原样透传
  if (!shouldLog) {
    const out = pluginTransform ? upstreamRes.body.pipeThrough(pluginTransform) : upstreamRes.body;
    return new Response(out, { status: sseStatus, headers: sseHeaders });
  }

  // 3. 有日志：构造 tap，单次遍历同时落盘 + 转发
  const capture = logger!.openStreamCapture(logMeta.requestId, dateStr);
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      capture.write(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      const result = capture.finalize();
      logger!.writeEvent(buildLogEvent(logMeta, targetUrl, proxy, Date.now(), {
        upstream_status: sseStatus,
        content_type_res: contentTypeRes,
        response_headers: sseHeaders,
        stream_bytes: result.bytesWritten,
        provider_request_id: providerRequestId,
        ...(result.filePath != null && { stream_file: result.filePath }),
        ...(requestBodyForLog !== undefined && { request_body: requestBodyForLog }),
        ...pluginLogOverrides,
      }));
    },
  });

  let stream: ReadableStream<Uint8Array> = upstreamRes.body.pipeThrough(tap);
  if (pluginTransform) stream = stream.pipeThrough(pluginTransform);

  return new Response(stream, { status: sseStatus, headers: sseHeaders });
}
```

### 3.4 顺序讨论：tap 在插件 transform 之前

选择 **upstream → tap → plugin → client** 而不是 tap 在插件之后：

- 流式日志面向**问题排查**，当前代码在 `tee` 之后还会经过插件 transform 才到客户端，但日志侧的 `logStream` 没经过插件（参见 `proxy.ts:276` tee → `proxy.ts:313` 客户端流再 pipeThrough 插件 transform）。**新方案保持原语义**：日志记录的是上游原始 SSE 字节，不含插件改写后的内容。
- 这一点关系到现有日志消费方的预期，**不能改变**。如未来需要落盘"插件后"的视图，再加一个二级 tap。

### 3.5 截断与错误处理

- `tap.flush` 在客户端断连或上游异常时同样会被调用一次（标准流语义）；`capture.finalize` 关闭 fd 幂等。
- 若 `capture.write` 内部 IO 抛错（如磁盘满），不应中断转发：用 try/catch 吞掉并打 `console.error('[logger] 流式落盘失败', err)`，client 流不受影响。
- `closeSync` 包 try/catch 防止重复关闭。

### 3.6 `writeStreamFile` 与临时文件函数的处置

本次 commit 一并删除的私有函数：

- `proxy.ts:119–121` `createTempStreamCapturePath`
- `proxy.ts:123–125` `appendTempStreamCapture`
- `proxy.ts:127–143` `flushTempCaptureToLogger`
- `logger.ts:135–150` `writeStreamFile`（确认无外部消费方）

### 3.7 性能与内存预期

| 维度 | 优化前 | 优化后 |
| --- | --- | --- |
| 流式响应单请求驻留内存 | tee 双缓冲 + tempPath 累积 + readFile 全量字符串（≤10 MB） | 单 chunk（KB 级） |
| 磁盘写入 | temp 写 + final 写 = 2× 流体大小 | final 写 = 1× 流体大小 |
| 客户端首字节延迟 | 不变（透传，无须等待） | 不变 |
| 流结束到日志落盘延迟 | tempPath → readFile → writeFileSync（O(N) 内存 + 同步 IO） | flush 内一次 closeSync + 1 次 writeEvent | 

---

## 4. 实施方式

**单 commit 一次性落地**，包含以下变更内容（顺序仅指代码组织，不再拆 commit）：

1. `logger.ts`：新增 `openStreamCapture` 接口与 noop handle；同步删除 `writeStreamFile`（无外部消费方，无需保留兼容窗口）。
2. `proxy.ts`：流式分支切到 tap 方案；删除 `createTempStreamCapturePath` / `appendTempStreamCapture` / `flushTempCaptureToLogger` 三个私有函数。
3. `routes/common.ts` 与 `proxy.ts`：落地 payload 对象贯通（改造 A 完整版 §2.4 / §2.5）。修改 `ProxyRequestOptions.body` 类型为对象；`buildUpstreamHeaders`、`buildResponseHeaders` 等不动。
4. `PluginContext` 在 `proxy.ts` 入口处一次构造、三处复用。

> 提交信息建议：`refactor(proxy): payload 对象贯通 + 流式日志 tap 直写以降低内存峰值`。

---

## 5. 测试与验收

### 5.1 既有测试

- `tests/`（待清点）需通过：插件请求/响应、流式 SSE、日志事件 schema。
- `bun test` 全绿。

### 5.2 新增 / 强化用例

| 用例 | 关注点 |
| --- | --- |
| 非流式 + 无插件 + bodyPolicy=off | 无 parse/stringify 逃逸；客户端响应字节与上游一致 |
| 非流式 + 插件改 body + bodyPolicy=full | `request_body` 与 `request_body_after_plugins` 引用关系；JSON 一致性 |
| 流式 + 插件 SSE transform + bodyPolicy=off | tap 不阻塞插件输出；`stream_file` 文件存在；`stream_bytes` == 落盘字节 |
| 流式响应被客户端中途断开 | `flush` 仍触发一次 `writeEvent`；fd 已关闭；无 fd 泄漏 |
| 流式响应超过 `maxStreamBytes` | 落盘文件以 `\n[TRUNCATED]` 结尾；客户端仍收到完整流；`stream_bytes == maxStreamBytes` |
| 日志写盘失败 | `console.error` 一次；客户端响应不受影响 |

### 5.3 内存基准

新增脚本 `scripts/bench-proxy-mem.ts`（不入 publish）：

- 启动本地 mock 上游（Bun 内置 `Bun.serve` 返回 4 MB messages 含 base64 图片，或返回 5 MB SSE 流）。
- 50 路并发持续 30 s，期间每 500 ms 采样 `process.memoryUsage().heapUsed / rss`。
- 比较改造前后：
  - 非流式重 body 场景：`heapUsed` 峰值。
  - 流式场景：`rss` 平均稳态值。

预期：非流式 heapUsed 峰值下降 ≥ 50%；流式 rss 稳态下降 ≥ 60%。

---

## 6. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 插件依赖 `body` 是字符串（违反协议） | 协议本来就是 `Record<string, unknown>`（`plugin.ts:37`），现状已是对象；无回归。 |
| `request_body` 在日志中现在是对象引用，可能被异步修改 | 现状即如此（`JSON.parse(options.body)` 解出的对象也会在 enqueue 后被插件…等等修改路径访问）。改造后在 enqueue 时已固定 `currentBody`，且插件请求阶段已结束，无并发改写。 |
| `tap.flush` 在异常关闭路径时未被调用 | Web Streams 规范保证 `cancel`/`close` 都会触发 flush；额外用 `pipeTo(...).catch(...)` 捕获兜底，再调用一次 `capture.finalize()`（幂等）。 |
| `writeSync` 在主事件循环阻塞 | 现状 `appendFileSync`、`writeFileSync` 已经是同步；新方案 chunk 粒度更小，单次阻塞时间更短，不退化。 |
| `streams.enabled=false` 时性能 | noop handle 无 fd 操作，`tap` 仅过 chunk 引用，几乎零开销。 |

回滚策略：单 commit 整体 revert。改动集中在 `src/routes/common.ts`、`src/proxy.ts`、`src/logger.ts` 三个文件，回滚成本可控。

---

## 7. 不在本方案的工作（已识别但延后）

- 日志索引队列瘦身（`log-index.ts:159` MAX_INDEX_QUEUE 持有完整 LogEvent）—— 单独方案。
- `collectHeaders` 全量拷贝 + 白名单化 —— 与安全联动，单独方案。
- `openAPISpec` 序列化缓存 —— 微优化。
- 非流式响应 `arrayBuffer` 化 / 直传 —— 待 A、B 落地后再评估。
