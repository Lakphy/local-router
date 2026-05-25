# 日志检索实时 WebSocket 推送技术方案

## 1. 背景与目标

日志检索页当前通过 `/api/logs/events` 拉取分页列表。后端写入日志时已经具备实时发布能力：`src/logger.ts` 的 `Logger.writeEvent()` 在 JSONL 落盘、SQLite 增量索引入队后调用 `publishLogEvent()`；`src/log-tail.ts` 维护进程内 pub/sub；`/api/logs/tail` 现在通过 SSE 订阅 `subscribeLogEvents()`，并用 `logEventMatchesQuery()` 判断新事件是否符合筛选条件。

本方案要在浏览器日志检索列表页增加“手动开启实时推送”的能力：

1. 用户先执行一次查询，前端保存这次查询的筛选条件快照。
2. 用户主动打开实时开关后，浏览器建立 WebSocket 连接。
3. 服务端只推送符合该查询快照的新日志摘要，且每条新日志单独推送。
4. 多开页面互不影响，每个页面拥有独立订阅。
5. 修改筛选项、重新查询、切换排序、离开页面时自动关闭订阅。
6. 浏览器刷新后不恢复订阅，必须重新查询并手动开启。
7. 保持写入链路轻量，不能因为页面多开或慢客户端拖慢 `Logger.writeEvent()`。

## 2. 当前代码事实

### 2.1 后端日志写入与发布

相关文件：

1. `src/logger.ts`
   - `writeEvent()` 先补充 token usage，再 append 到 `<baseDir>/events/YYYY-MM-DD.jsonl`。
   - 事件 id 使用 `encodeOffsetLogEventId(date, offset)`，详情可按 offset 定位。
   - 写入后调用 `enqueueLogEventForIndex()` 异步维护 SQLite 索引。
   - 最后调用 `publishLogEvent({ id, date, filePath, offset, event })`。

2. `src/log-tail.ts`
   - 当前是一个简单 `Set<LogTailSubscriber>`。
   - `publishLogEvent()` 同步遍历订阅者，并捕获单个订阅者异常。
   - 这条链路适合作为实时 WS hub 的上游事件源。

3. `src/log-query.ts`
   - `logEventMatchesQuery(event, query)` 已覆盖时间、level、provider、routeType、model、user、session、statusClass、hasError、q。
   - `createLogEventSummaryFromEvent(event, location)` 可直接把新写入的 `LogEvent` 转为列表页需要的 `LogEventSummary`。
   - `resolveLogQueryRange()`、`parseCommaSeparated()`、`parseBooleanFlag()`、`validateLogLevel()` 等可复用，但现在解析逻辑分散在 `/logs/events`、`/logs/export`、`/logs/tail`。

### 2.2 后端 HTTP/WS 承载方式

相关文件：

1. `src/index.ts`
   - Hono app 注册 REST API、SSE tail、admin 静态资源。
   - 网络访问控制通过 `app.use('*', createNetworkAccessMiddleware(store))` 实现。

2. `src/server.ts`
   - 真实服务由 `Bun.serve()` 承载。
   - 当前只提供 `fetch`，没有 `websocket` handler，也没有 `server.upgrade()` 分支。
   - 新增 WS 不能只写在 Hono route 里，需要在 `Bun.serve()` 层拦截 upgrade。

### 2.3 前端日志页状态

相关文件：

1. `web/src/stores/logs-store.ts`
   - 当前 `filters` 同时承担“输入中的筛选项”和“已查询条件”。
   - `fetchFirstPage()` 会按当前 store 构造请求参数。
   - 已有 `mergeUniqueById()` 可复用到实时推送的去重合并。

2. `web/src/pages/logs.tsx`
   - 页面初始化、URL search 同步、查询、重置、排序都走 zustand store。
   - 目前没有“实时开关”状态，也没有页面卸载时的订阅清理。

## 3. 方案结论

推荐新增浏览器专用 WebSocket 通道：`GET /api/logs/events/ws`。

保留现有 `/api/logs/tail` SSE 作为 CLI 和兼容能力，不用它承载日志检索页的新交互。原因：

1. 用户要求 WS 推送。
2. 浏览器页需要显式订阅、取消订阅、状态回传、按页面隔离、多开页面独立管理；WS 的双向协议更直接。
3. 现有 SSE payload 模拟 `LogEventsResponse`，会推送一批 items；新需求只需要单条新数据，协议可以更轻。
4. SSE endpoint 当前挂在 Hono 下；WS upgrade 需要在 `Bun.serve()` 层处理，单独封装更清晰。

核心设计：

```text
Logger.writeEvent()
  -> append JSONL
  -> enqueue SQLite index
  -> publishLogEvent(PublishedLogEvent)
      -> log realtime hub 只注册 1 个上游 subscriber
          -> 根据每个页面订阅的已查询条件快照做内存匹配
          -> 命中后生成 LogEventSummary
          -> 通过对应 WebSocket 推送单条 log.event
```

## 4. 后端设计

### 4.1 新增模块

新增 `src/log-realtime.ts`，负责 WS 订阅生命周期和 fanout。

建议导出：

```ts
export interface LogRealtimeWebSocketData {
  kind: 'log-realtime';
  connectionId: string;
  remoteAddress: string | null;
}

export interface LogRealtimeRuntime {
  pathname: '/api/logs/events/ws';
  upgrade: (request: Request, server: Bun.Server<LogRealtimeWebSocketData>, remoteAddress: string | null) => Response | undefined;
  websocket: Bun.WebSocketHandler<LogRealtimeWebSocketData>;
  dispose: () => void;
}

export function createLogRealtimeRuntime(options: {
  store: ConfigStore;
}): LogRealtimeRuntime;
```

`upgrade()` 职责：

1. 只接受 `/api/logs/events/ws`。
2. 复用 `decideNetworkAccess(store.get().server, remoteAddress)`，避免绕过 Hono middleware。
3. 校验 `Upgrade: websocket`，失败返回 400。
4. 调用 `server.upgrade(request, { data: { kind: 'log-realtime', connectionId, remoteAddress } })`。
5. upgrade 成功时返回 `undefined`，让 `Bun.serve()` 结束 HTTP 处理。

`websocket` handler 职责：

1. `open`：记录连接，发送 `ready`。
2. `message`：处理 `subscribe`、`unsubscribe`、`ping`。
3. `drain`：发送该连接积压队列。
4. `close`：删除连接与订阅。
5. `dispose`：关闭所有连接并取消上游 `subscribeLogEvents()`。

### 4.2 接入 `Bun.serve()`

调整 `src/server.ts`：

```ts
const server = Bun.serve<LogRealtimeWebSocketData>({
  fetch: (request, server) => {
    const remoteAddress = server.requestIP(request)?.address ?? null;

    const wsResponse = runtime.logRealtime?.upgrade(request, server, remoteAddress);
    if (wsResponse || isWebSocketUpgradePath(request)) {
      return wsResponse ?? new Response('Upgrade failed', { status: 400 });
    }

    return runtime.app.fetch(request, {
      [REMOTE_ADDRESS_ENV_KEY]: remoteAddress,
    });
  },
  websocket: runtime.logRealtime.websocket,
  hostname: options.host,
  port: options.port,
  idleTimeout,
});
```

同时扩展 `AppRuntime`：

```ts
export interface AppRuntime {
  app: Hono;
  logRealtime: LogRealtimeRuntime;
  dispose: () => void;
}
```

`createAppRuntimeFromConfigPath()` 中创建 `ConfigStore` 后，同时创建 `createLogRealtimeRuntime({ store })` 并注册 cleanup。`createApp()` 仍只负责 Hono app，方便现有 `app.request()` 测试继续工作。

### 4.3 WS 协议

客户端消息：

```ts
type ClientMessage =
  | {
      type: 'subscribe';
      requestId: string;
      query: {
        window?: '1h' | '6h' | '24h';
        from?: string;
        to?: string;
        levels?: Array<'info' | 'error'>;
        provider?: string;
        routeType?: string;
        model?: string;
        modelIn?: string;
        modelOut?: string;
        user?: string;
        session?: string;
        statusClass?: Array<'2xx' | '4xx' | '5xx' | 'network_error'>;
        hasError?: boolean;
        q?: string;
        sort?: 'time_desc' | 'time_asc';
      };
    }
  | { type: 'unsubscribe'; subscriptionId?: string }
  | { type: 'ping'; ts?: string };
```

服务端消息：

```ts
type ServerMessage =
  | { type: 'ready'; connectionId: string; now: string }
  | { type: 'subscribed'; requestId: string; subscriptionId: string; queryHash: string; now: string }
  | { type: 'unsubscribed'; subscriptionId: string; reason?: string }
  | { type: 'log.event'; subscriptionId: string; item: LogEventSummary }
  | { type: 'overflow'; subscriptionId: string; dropped: number; message: string }
  | { type: 'pong'; ts: string }
  | { type: 'error'; requestId?: string; error: string };
```

只推送 `log.event.item`，不推送整页 `LogEventsResponse`，也不在推送里重算 stats。

### 4.4 查询解析与匹配

需要先抽一个共享解析函数，减少 REST、SSE、WS 三处重复：

```ts
export function normalizeLogQueryInputFromParams(params: {
  window?: string;
  from?: string;
  to?: string;
  levels?: string | string[];
  provider?: string | string[];
  routeType?: string | string[];
  model?: string | string[];
  modelIn?: string | string[];
  modelOut?: string | string[];
  user?: string | string[];
  session?: string | string[];
  statusClass?: string | string[];
  hasError?: string | boolean;
  q?: string;
  sort?: string;
  limit?: string | number;
  cursor?: string | null;
  nowMs?: number;
}): NormalizedLogQueryInput;
```

WS 订阅不要每次事件到来都重新 parse 字符串，而是在 `subscribe` 时编译成：

```ts
interface CompiledRealtimeQuery {
  subscriptionId: string;
  queryHash: string;
  sort: 'time_desc' | 'time_asc';
  range:
    | { type: 'window'; window: '1h' | '6h' | '24h'; windowMs: number }
    | { type: 'fixed'; fromMs: number; toMs: number };
  paramsWithoutRange: Omit<LogQueryParams, 'fromMs' | 'toMs' | 'limit' | 'cursor'>;
  matchSets: {
    levels: Set<LogLevel>;
    providers: Set<string>;
    routeTypes: Set<string>;
    models: Set<string>;
    modelIns: Set<string>;
    modelOuts: Set<string>;
    users: Set<string>;
    sessions: Set<string>;
    statusClasses: Set<StatusClass>;
  };
  hasError: boolean | null;
  qLower: string;
  matches: (facts: LogEventFacts, nowMs: number) => boolean;
}
```

新事件到来时也不要对每个订阅重复 `Date.parse()`、计算 level/status、解析 user/session、拼关键词搜索文本。第一版就应新增一次性特征提取：

```ts
interface LogEventFacts {
  event: LogEvent;
  id: string;
  date: string;
  tsMs: number;
  level: LogLevel;
  statusClass: StatusClass;
  hasError: boolean;
  provider: string;
  routeType: string;
  model: string;
  modelIn: string;
  modelOut: string;
  userIdRaw: string | null;
  userKey: string | null;
  sessionId: string | null;
  searchTextLower: string;
}
```

`LogEventFacts` 由单条 `PublishedLogEvent` 计算一次，所有订阅复用。`CompiledRealtimeQuery.matches()` 只做集合判断、时间窗口判断和 `searchTextLower.includes(qLower)`，避免订阅数增加时成倍放大重复解析成本。

时间范围规则：

1. `window` 查询且未显式 `from/to`：实时匹配使用移动窗口。新事件到达时按 `nowMs - windowMs <= event.ts <= nowMs + 5s` 判断。
2. 显式 `from/to`：严格按固定闭区间判断。若 `to` 是过去时间，新事件通常不会命中，这是符合当前查询条件的。
3. `limit`、`cursor` 不参与实时匹配。实时推送只表达“这条新数据符合当前筛选项”，不表达分页位置。

具体匹配语义必须与 `logEventMatchesQuery()` 保持一致，但实现上建议把现有逻辑拆成可复用的小函数，例如 `extractLogEventFacts()` 与 `matchesCompiledLogQuery()`。REST/SSE 的完整查询仍可继续使用 `logEventMatchesQuery()`，WS 实时路径使用 facts，减少重复计算。

### 4.5 多页面与订阅模型

每个浏览器页签独立连接：

```text
connectionId -> WebSocket
subscriptionId -> { connectionId, compiledQuery, pendingQueue, droppedCount }
```

约束：

1. 一个连接同一时间只允许一个 active subscription。日志列表页修改筛选后会关闭旧订阅，重新查询后用户再手动开启。
2. 多开页面就是多个 connection/subscription；互不覆盖，也不共享前端状态。
3. 服务端不持久化订阅；进程重启、浏览器刷新、页面关闭后自然消失。

建议限额：

1. `MAX_REALTIME_CONNECTIONS = 64`
2. `MAX_REALTIME_SUBSCRIPTIONS = 64`
3. `MAX_PENDING_PER_SUBSCRIPTION = 500`
4. `MAX_PENDING_BYTES_PER_SUBSCRIPTION = 1 * 1024 * 1024`
5. `MAX_TOTAL_PENDING_BYTES = 32 * 1024 * 1024`
6. `MAX_CLIENT_MESSAGE_BYTES = 16 * 1024`
7. `HEARTBEAT_INTERVAL_MS = 15_000`

超限策略：

1. 连接数/订阅数超限：关闭新连接或返回 `error`，close code 使用 `1013`。
2. 单订阅积压条数或字节数超限：丢弃最旧的 pending item，累计 `dropped` 和 `droppedBytes`，下一次可发送时先发 `overflow`。
3. 全局 pending bytes 超限：优先清理 dropped 最多或最久未 drain 的订阅，必要时关闭慢客户端。
4. `ws.send()` 返回 `0`：认为这条消息被丢弃，累计 dropped。
5. `ws.send()` 返回 `-1`：进入 pending queue，等待 `drain`。
6. 连续多次 overflow 或超过慢客户端阈值时，服务端主动 close，reason 使用 `slow-client`。

心跳不要为每个连接创建一个 `setInterval`。实时 hub 使用一个全局 timer 遍历连接发送 ping/heartbeat，并在 `dispose()` 时统一清理，避免多页面场景下 timer 数量随连接数线性增长。

### 4.6 高性能 fanout

第一版不要让每个 WS 直接注册到 `log-tail.ts`。实时 hub 应该只调用一次 `subscribeLogEvents()`，然后在内部管理所有页面订阅：

```text
publishLogEvent()
  -> subscribers: [logRealtimeHub, existingSseClients...]
  -> logRealtimeHub.enqueue(published)
      -> async flush
          -> extractLogEventFacts(published)
          -> match subscriptions
          -> send or queue per connection
```

`publishLogEvent()` 当前是同步遍历 subscriber 的设计，所以 WS hub 的上游 subscriber 必须足够轻。P0 要求 subscriber 只做有界入队和调度 flush，不直接做全量匹配、JSON 序列化或 `ws.send()`。

建议的 hub 队列：

```ts
interface RealtimeEventQueue {
  items: PublishedLogEvent[];
  maxItems: 5_000;
  flushing: boolean;
}
```

入队策略：

1. `enqueue()` 只执行 `push`、溢出丢旧、设置 `flushing`。
2. flush 用 `setTimeout(flush, 0)` 或 25-50ms 短批处理触发，避免占用日志写入调用栈。
3. 队列满时丢弃最旧事件，并向所有 active subscription 记录一次全局 `overflow`，提示用户重新查询补齐。
4. 单次 flush 设置时间预算，例如 8-12ms；超过预算则让出事件循环并继续下一轮，避免长时间阻塞代理请求。

flush 流程：

1. 如果 active subscription 数低于阈值（如 32），直接遍历所有订阅并执行编译 matcher。
2. 超过阈值后启用候选集预筛选：
   - 为 provider、routeType、model、modelIn、modelOut、level、statusClass、hasError、user、session 维护 value -> Set<subscriptionId>。
   - 每个维度另有 wildcard set，表示该订阅没有设置该维度过滤。
   - 新事件到来时，从若干维度中选择候选集合最小的 `wildcard ∪ matchedValueSet` 作为初始 candidates。
   - 对 candidates 再执行完整 matcher，保证 `q`、时间窗口、user raw/userKey 双匹配等复杂规则正确。
3. 每条事件先计算一次 `LogEventFacts`，所有候选订阅复用。
4. 对同一个 published event，summary 最多构造一次，然后复用发送给多个订阅。
5. `JSON.stringify()` 的结果也可以按 event 缓存一次；只有 subscriptionId 不同的字段单独包一层轻量对象。

候选集索引可以在 P1 再做；但异步有界队列、facts 单次提取、pending bytes 上限必须在 P0 落地。这三个点直接决定写入链路是否会被慢客户端和多订阅拖慢。

### 4.7 内存预算

实时推送新增内存主要来自连接对象、订阅快照、hub 输入队列和每订阅 pending queue。实现时按字节计量，而不是只按条数计量：

```text
estimatedMemory =
  activeConnections * connectionOverhead
  + activeSubscriptions * compiledQueryOverhead
  + realtimeEventQueueBytes
  + totalPendingBytes
```

建议 P0 控制目标：

1. `activeSubscriptions <= 64`
2. `realtimeEventQueueBytes <= 16MB`
3. `totalPendingBytes <= 32MB`
4. 单连接 pending bytes <= 1MB

达到任一上限时优先丢弃旧实时事件并发送 `overflow`，而不是扩容。实时推送只是一种“增量提示和插入”能力，不承担完整审计职责；完整数据仍由 JSONL、SQLite 索引和用户重新查询保证。

无 active subscription 时，hub 应只维护空连接集合和上游 subscriber，不构造 `LogEventFacts`、不构造 `LogEventSummary`、不序列化 WS 消息，确保关闭实时开关的用户不会给写入链路增加可感知成本。

## 5. 前端设计

### 5.1 区分草稿条件与已查询条件

`web/src/stores/logs-store.ts` 需要新增“已成功查询快照”：

```ts
interface AppliedLogQuery {
  filters: LogFilters;
  sort: 'time_desc' | 'time_asc';
  params: FetchLogEventsParams;
  queryKey: string;
  queriedAt: string;
}

interface LogsState {
  filters: LogFilters;              // 表单草稿
  sort: 'time_desc' | 'time_asc';
  appliedQuery: AppliedLogQuery | null;
  realtime: {
    enabled: boolean;
    status: 'idle' | 'connecting' | 'connected' | 'closed' | 'error';
    subscriptionId: string | null;
    queryKey: string | null;
    newCount: number;
    dropped: number;
    error: string | null;
  };
}
```

`fetchFirstPage()` 成功后：

1. 用实际请求参数生成 `appliedQuery`。
2. 关闭已有实时订阅。
3. `realtime.enabled = false`。
4. 这样满足“用户查询后需要主动点开开关”。

`setFilter()`、`setSort()`、`resetFilters()`：

1. 如果实时订阅存在，立即 `stopRealtime('queryChanged')`。
2. 将 `realtime` 重置到 idle。
3. 标记当前草稿与 `appliedQuery` 不一致，实时开关置灰，直到下一次查询成功。

### 5.2 实时开关交互

页面顶部查询按钮附近新增一个开关：

1. 默认关闭。
2. 没有 `appliedQuery` 时禁用。
3. 当前草稿条件与 `appliedQuery.queryKey` 不一致时禁用。
4. `sort !== 'time_desc'` 时建议禁用第一版实时插入。原因是升序分页通常展示最旧结果，新事件位于完整结果集尾部，直接插入当前已加载列表会破坏分页连续性。后续可做“新结果提示但不插入”。
5. 用户打开后调用 `startRealtime()`.
6. 用户关闭后调用 `stopRealtime('userDisabled')`.

页面卸载：

```ts
useEffect(() => {
  return () => {
    useLogsStore.getState().stopRealtime('pageUnmount');
  };
}, []);
```

不要使用 `localStorage`、URL 参数、sessionStorage 持久化开关，所以浏览器刷新会自动移除。

### 5.3 WS 客户端封装

新增 `web/src/lib/log-realtime-client.ts`：

```ts
export interface LogRealtimeClient {
  connect: (query: FetchLogEventsParams) => void;
  close: (reason?: string) => void;
}

export function createLogRealtimeClient(callbacks: {
  onOpen?: () => void;
  onSubscribed?: (subscriptionId: string) => void;
  onEvent: (item: LogEventSummary) => void;
  onOverflow?: (dropped: number, message: string) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}): LogRealtimeClient;
```

URL 构造：

```ts
const url = new URL('/api/logs/events/ws', window.location.href);
url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(url);
```

Vite dev proxy 需要显式支持 WS：

```ts
server: {
  proxy: {
    '/api': {
      target: 'http://localhost:4099',
      ws: true,
    },
  },
}
```

### 5.4 收到新数据后的列表处理

新增 store action：

```ts
receiveRealtimeLogEvents(items: LogEventSummary[]): void;
```

处理规则：

1. 按 id 去重。
2. 批量合并后按当前 `appliedQuery.sort` 排序。
3. 限制内存上限，复用 `MAX_ITEMS_IN_MEMORY`。
4. `time_desc` 下新日志通常插入顶部。
5. 不直接修改 `stats.total/errorRate/p95/token`，避免实时增量统计与完整查询统计混用。
6. 可显示 `实时新增 N`、`丢弃 N` 状态，用户点击“重新查询”后刷新完整 stats。

`nextCursor` 与 `hasMore` 保持原值。对于 `time_desc` keyset cursor，新插入的更新事件位于当前第一页之前，不影响继续加载更旧数据。

前端 WS client 不要每收到一条 `log.event` 就立即 `setState` 和排序。建议新增浏览器端小缓冲：

```ts
const pendingRealtimeItems: LogEventSummary[] = [];
let flushScheduled = false;

function queueRealtimeItem(item: LogEventSummary) {
  pendingRealtimeItems.push(item);
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    receiveRealtimeLogEvents(pendingRealtimeItems.splice(0));
  });
}
```

如果日志到达非常密集，可以把 `requestAnimationFrame` 改成 50-100ms 的 debounce。目标是把 React/zustand 更新频率限制在浏览器可承受范围内，避免服务端已经轻量化后，前端被逐条排序和重渲染拖慢。

## 6. 关键边界条件

### 6.1 配置变更

`POST /api/config/apply` 会重新初始化 logger/index。实时 hub 不应绑定旧 logger 实例，而是通过全局 `subscribeLogEvents()` 接收 publish。配置变更后：

1. 旧 WS 连接可继续存在。
2. 若 `log.enabled=false`，不会再有 `publishLogEvent()`。
3. 若需要更明确的用户反馈，可在 config apply 后向所有订阅广播 `error` 或 `unsubscribed: configChanged`，但第一版可以不做。

### 6.2 显式时间范围

如果用户设置了固定 `from/to`，实时订阅严格遵守这个闭区间。大多数情况下 `to` 是查询时刻或过去时刻，新日志不会命中。第一版推荐前端在固定 `to` 存在时直接禁用实时开关，减少无效订阅和用户困惑。

服务端仍要做兜底：固定区间订阅如果 `toMs < Date.now() - 5_000`，直接返回 `error` 或 `unsubscribed: expired`；如果订阅建立后时间到期，则由 hub 定期清理并发送 `unsubscribed: expired`。

### 6.3 关键词 q

实时匹配不能依赖 SQLite FTS，因为新事件还没有必要通过数据库重查。继续使用 `containsKeyword()` 同等逻辑，在内存中对新 `LogEvent` 的关键字段做包含匹配。这与当前 `/api/logs/tail` 行为一致。

### 6.4 安全与来源

WS upgrade 绕过 Hono middleware，必须在 `upgrade()` 内显式调用 `decideNetworkAccess()`。否则在 `server.lanAccess.enabled=false` 时，非本机访问可能被 REST 拒绝但 WS 被放行。

当前管理 API 的访问模型主要依赖本机/局域网访问控制。本方案不新增鉴权语义。

## 7. 实施步骤

### P0：最小可用版本

1. 抽取日志查询参数解析函数，REST events/export/tail 继续复用。
2. 新增 `extractLogEventFacts()` 与编译查询 matcher，实时路径每条日志只计算一次事件特征。
3. 新增 `src/log-realtime.ts`，实现 WS runtime、订阅管理、单条 `log.event` 推送、全局心跳、限额、清理。
4. hub 接入 `subscribeLogEvents()` 时只做有界入队；异步批量 flush 完成匹配和发送。
5. pending queue 同时按条数和字节数限额，支持 overflow 与慢客户端关闭。
6. 扩展 `AppRuntime` 与 `src/server.ts`，在 `Bun.serve()` 层接入 `server.upgrade()` 和 `websocket` handler。
7. 前端新增 WS client 封装，并对 `log.event` 做 `requestAnimationFrame` 或 50-100ms 批量合并。
8. `logs-store` 新增 `appliedQuery`、`realtime` 状态和 `startRealtime/stopRealtime/receiveRealtimeLogEvents` actions。
9. 日志检索页新增实时开关；修改筛选、重新查询、重置、切换排序、页面卸载时自动关闭。
10. 固定 `to` 时间范围下禁用实时开关，服务端对过期固定区间订阅做兜底清理。
11. Vite dev proxy `/api` 配置 `ws: true`。
12. 保留 `/api/logs/tail` 不动，避免影响 CLI。

### P1：性能增强

1. 增加候选集预筛选索引，订阅数超过阈值时启用。
2. 缓存同一事件的 `JSON.stringify()` 结果，减少多订阅命中时的序列化重复。
3. 增加实时 hub 指标：连接数、订阅数、入队数、推送数、丢弃数、pending bytes、匹配耗时、flush 耗时。
4. 将 `/api/logs/tail` 迁移到同一个 hub 的内部 API，减少两套实时过滤逻辑。

### P2：体验增强

1. `time_asc` 下不插入列表，只展示“有新结果，点击刷新”的提示。
2. 网络异常时允许有限重连，但不跨浏览器刷新恢复。
3. 固定 `from/to` 的开关旁展示“固定时间范围不会接收范围外新日志”的状态说明。

## 8. 测试计划

### 8.1 后端单元测试

新增 `tests/unit/log-realtime.test.ts`：

1. `subscribe` 后只收到匹配 provider/model/status/user/session/q 的事件。
2. 非匹配事件不发送。
3. 多订阅各自收到自己的匹配事件。
4. `unsubscribe` 和 `close` 会清理订阅。
5. `extractLogEventFacts()` 对单条事件只调用一次，多个订阅复用 facts。
6. `subscribeLogEvents()` 回调只入队，不直接执行 `ws.send()`。
7. pending queue 条数或字节数超限会记录 dropped 并发送 `overflow`。
8. 连续 overflow 的慢客户端会被关闭。
9. malformed client message 返回 `error`，不会崩溃 hub。

### 8.2 后端集成测试

新增 `tests/integration/logs-realtime-ws.test.ts`，使用 `startServer()` 而不是 Hono `app.request()`：

1. 启动真实 Bun server。
2. 用 `new WebSocket('ws://.../api/logs/events/ws')` 连接。
3. 发送 `subscribe`。
4. 调用 `getLogger()?.writeEvent()` 写入匹配事件。
5. 断言收到单条 `log.event` 且 id 可用于 `/api/logs/events/:id`。
6. 写入不匹配事件，断言不收到。
7. 关闭 WS 后 `getLogTailSubscriberCount()` 或 hub 指标回落。

### 8.3 前端单元测试

扩展 `tests/unit/logs-store.test.ts`：

1. `fetchFirstPage()` 成功后生成 `appliedQuery`，但实时状态仍关闭。
2. `startRealtime()` 使用 `appliedQuery.params`，不使用正在编辑的 `filters`。
3. `setFilter()` 会自动关闭实时订阅。
4. `resetFilters()`、`setSort()` 会自动关闭实时订阅。
5. `receiveRealtimeLogEvents()` 批量按 id 去重、按时间排序、保留 `nextCursor`。
6. 刷新不恢复开关：通过 store 初始状态断言 `realtime.enabled=false`。
7. WS client 连续收到多条 `log.event` 时只触发批量 store 更新。

### 8.4 浏览器验收

1. 打开两个日志检索页，设置不同 provider，分别查询并打开实时开关。
2. 产生一条只符合页面 A 的日志，只有 A 新增一行。
3. 修改页面 A 的筛选项，A 的开关自动关闭。
4. 刷新页面 B，B 的开关恢复关闭。
5. 在实时开关打开时连续产生多条日志，页面不卡顿，列表只增加匹配项。

## 9. 不做事项

1. 不通过 WS 推送完整日志详情；详情仍走 `/api/logs/events/:id`。
2. 不在实时推送中重算 total、P95、token 聚合；完整统计仍由查询接口负责。
3. 不持久化订阅状态；刷新后必须重新手动开启。
4. 不依赖 SQLite 判断新事件是否匹配；实时匹配直接基于刚写入的 `LogEvent`。
5. 不移除现有 SSE tail，避免影响 CLI。

## 10. 落地状态

本方案的 P0 已落地到代码：

1. 后端新增 `src/log-realtime.ts`，提供 `/api/logs/events/ws` 的 WebSocket runtime、订阅管理、单条 `log.event` 推送、全局心跳、入队限额、pending byte 限额、overflow 和慢客户端清理。
2. `src/server.ts` 与 `src/entry.ts` 已在 Bun server 层拦截 WS upgrade；`src/index.ts` 的 `AppRuntime` 已持有并释放 `logRealtime` runtime。
3. `src/log-query.ts` 已新增 `extractLogEventFacts()`、`createLogEventSummaryFromFacts()` 等复用函数，实时路径每条新日志只计算一次基础特征。
4. 前端新增 `web/src/lib/log-realtime-client.ts`，按 50ms debounce 批量把 `log.event` 合并进 store。
5. `web/src/stores/logs-store.ts` 已新增 `appliedQuery`、`realtime` 状态，以及 `startRealtime()`、`stopRealtime()`、`receiveRealtimeLogEvents()`。
6. `web/src/pages/logs.tsx` 已新增“实时”开关；查询成功后才允许开启，筛选变化、重新查询、重置、排序变化、页面卸载都会关闭订阅。
7. `web/vite.config.ts` 已为 `/api` dev proxy 开启 `ws: true`。
8. 已新增 `tests/integration/logs-realtime-ws.test.ts`，用真实 Bun server 和真实 WebSocket 验证只推送匹配当前订阅条件的新日志。
9. 已扩展 `tests/unit/logs-store.test.ts`，覆盖查询快照、筛选变化关闭实时、批量合并去重、未查询时拒绝开启。

已验证命令：

```bash
bun test
bun test tests/unit/logs-store.test.ts tests/integration/logs-realtime-ws.test.ts tests/unit/log-query.test.ts tests/unit/log-tail.test.ts
bunx biome check src/log-query.ts src/log-realtime.ts src/index.ts src/server.ts web/src/lib/log-realtime-client.ts web/src/stores/logs-store.ts web/src/pages/logs.tsx web/vite.config.ts tests/integration/logs-realtime-ws.test.ts tests/unit/logs-store.test.ts
cd web && bun run build
bun build src/entry.ts --target bun --outdir /tmp/local-router-build-check
```

全仓 `bun run check` 当前仍会被既有 `src/cli/*` 非空断言 lint 问题拦截；本次新增和修改文件的 Biome check 已单独通过。
