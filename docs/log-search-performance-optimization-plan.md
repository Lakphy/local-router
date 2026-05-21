# 日志检索页面性能优化实践方案

## 0. 本次落地状态

本次已按方案完成日志列表主链路性能改造，核心变化如下：

1. 新增 SQLite 查询索引：`src/log-index.ts` 以 JSONL 为事实来源，维护 `log_events`、`log_events_fts`、`log_index_files` 等派生索引表。
2. 列表查询改为 SQLite 优先：`/api/logs/events` 正常走 keyset cursor、`LIMIT + 1` 和索引统计；索引不可用时保留 JSONL 回退路径，并通过 `meta.fallbackReason` 暴露原因。
3. 详情定位支持 offset id：新列表返回的事件 id 使用 `{ date, offset }`，详情读取可直接 seek 到 JSONL byte offset；旧 `{ date, line }` id 仍兼容。
4. 写入链路改为 JSONL 主写、SQLite 异步增量索引：`logger.writeEvent()` 先落 JSONL，再将索引任务放入有界队列，避免索引故障阻塞主日志写入。
5. 实时追踪从轮询重查改为发布订阅：`/api/logs/tail` 消费 `logger.writeEvent()` 发布的新事件，不再每 3 秒调用列表查询。
6. 导出复用索引查询路径：导出上限保持受控，避免因列表分页上限导致导出只能拿到第一页。
7. 前端刷新体验优化：请求支持 AbortController，自动刷新不清空旧列表，排序会触发重新查询，加载更多与 tail 合并按 id 去重并限制内存上限。
8. 前端表格增加窗口化渲染：只渲染可视区域附近行，降低加载多页后的 DOM 成本。
9. 存储统计纳入 SQLite 索引文件大小，便于观察索引带来的额外磁盘占用。

已验证：

1. `bun test`：82 个测试通过。
2. `bun run check`：Biome 检查通过。
3. `bun run build:api`：服务端打包通过。
4. `bun run build:web`：前端生产构建通过，仅保留既有 Vite chunk 体积提示。

## 1. 背景

当前日志检索页面在日志量变大后，刷新、分页、实时追踪都会变慢。核心原因不是前端单点问题，而是当前查询链路把 JSONL 日志文件直接当作查询引擎使用：

1. `/api/logs/events` 每次查询都会按时间窗口扫描日志文件。
2. cursor 只是 offset，下一页仍会从头扫描。
3. 自动刷新调用 `fetchFirstPage()`，会反复重查第一页。
4. `/api/logs/tail` 每 3 秒调用一次 `queryLogEvents()`，不是读取新增行。
5. 列表接口同时计算 total、错误率、平均延迟、P95，导致列表返回前必须读取大量历史日志。
6. 列表页用普通表格渲染所有已加载行，加载页数变多后 DOM 成本持续增加。

本方案目标是把日志列表体验从“扫描文件找结果”改为“走索引拿结果”，并通过前端刷新策略改善体感。

## 2. 目标

### 2.1 用户体验目标

1. 打开日志页面后，第一页列表应快速出现。
2. 点击查询、刷新、切换排序时不清空旧列表，不出现长时间空白。
3. 自动刷新只拉取新增日志，不反复扫描完整窗口。
4. 实时追踪真正消费新增日志行，不每 3 秒重扫文件。
5. 列表滚动和加载更多在数千行展示时仍保持流畅。
6. 复杂过滤、关键词检索、用户/会话检索在日志量增长后仍可用。

### 2.2 技术目标

1. 最新日志列表在无复杂过滤时尽量做到“查多少读多少附近的数据”。
2. 带 provider、model、status、user、session 等过滤时走索引，避免扫描大量 JSONL。
3. 关键词搜索走 FTS 或倒排索引，避免逐行字符串匹配。
4. 统计与列表解耦，列表接口不再为了 total/P95 阻塞。
5. 保留 JSONL 原始日志作为审计与详情来源。
6. 支持已有 JSONL 日志的增量回填，不要求用户清空日志。

## 3. 当前瓶颈定位

### 3.1 后端查询瓶颈

相关文件：

- `src/log-query.ts`
- `src/index.ts`
- `src/logger.ts`

当前行为：

1. `scanEvents()` 会列出查询窗口内的日期文件，然后逐行读取。
2. 每行都执行 `JSON.parse()`，再做时间、级别、provider、route、model、user、session、status、keyword 等过滤。
3. 命中后调用 `insertBoundedEvent()`，每插入一次都排序。
4. cursor 解码后得到 offset，下一页仍然从文件头开始扫描，只是保留 `offset + limit` 条。
5. `hasMore` 依赖完整匹配总数，导致即使只取 50 条，也需要继续统计后续匹配行。
6. 详情接口通过 `{ date, line }` 定位，然后从文件头读到目标行。

### 3.2 前端刷新瓶颈

相关文件：

- `web/src/pages/logs.tsx`
- `web/src/stores/logs-store.ts`
- `web/src/components/logs/logs-data-table.tsx`
- `web/src/lib/api.ts`

当前行为：

1. 页面初始化和筛选变化调用 `applyFilters()`，继而调用 `fetchFirstPage()`。
2. `fetchFirstPage()` 设置 `loading: true`，页面展示 skeleton，旧列表被隐藏。
3. 自动刷新每隔 3 到 30 秒调用一次 `fetchFirstPage()`。
4. 没有请求取消机制，慢请求可能覆盖新请求结果。
5. 表头排序只调用 `setSort()`，没有触发重新查询。
6. provider/model 选项从当前 `items` 推导，当前页之外的可选项不可见。
7. 表格没有虚拟滚动，加载更多页后渲染成本随行数线性增长。

### 3.3 实时追踪瓶颈

相关文件：

- `src/index.ts`
- `web/src/lib/api.ts`
- `web/src/stores/logs-store.ts`

当前行为：

1. `/api/logs/tail` 建立 SSE。
2. 后端每 3 秒调用一次 `queryLogEvents()`。
3. `lastSeenTs` 只缩小时间范围，但仍走 JSONL 扫描流程。
4. 前端收到事件后 `mergeUniqueById()`，再全量排序当前列表。

## 4. 总体架构

推荐采用三层存储：

```text
logs/
  events/
    2026-05-22.jsonl             # 原始完整事件，继续保留
  streams/
    2026-05-22/<request_id>.sse.raw
  indexes/
    log-index.sqlite             # 查询索引，列表与过滤使用
```

职责划分：

1. JSONL 原始日志：完整记录，审计、回放、详情兜底。
2. SQLite 普通表：列表、精确过滤、排序、keyset 分页。
3. SQLite FTS 表：关键词搜索。
4. 聚合缓存表：总数、错误率、P95、按 provider/model 聚合等统计。

优先选择 SQLite 的原因：

1. 本地应用部署简单，不需要额外服务。
2. Bun 可以使用内置 SQLite 能力，不必引入外部数据库进程。
3. 普通索引能解决结构化过滤。
4. FTS 能解决关键词搜索。
5. JSONL 仍保留，索引可重建，风险可控。

## 5. 能否做到“查多少读多少”

需要按查询类型区分：

1. 最新列表，无复杂过滤：可以基本做到查 50 条就读取文件尾部附近数据。做法是从当天 JSONL 文件尾部倒序读，读够 `limit` 条即停止。
2. 带结构化过滤：仅靠 JSONL 不能保证查多少读多少，因为必须跳过不匹配行。使用 SQLite 索引后，可以让数据库读取命中的索引区间，接近查多少取多少。
3. 关键词搜索：必须使用 FTS 或倒排索引。否则仍需要扫描大量行并做字符串匹配。
4. 精确 total、P95、错误率：如果要求每次查询都精确统计完整窗口，仍可能读取大量数据。正确做法是列表快速返回，统计单独缓存或异步刷新。

因此，本方案的最终目标是：列表查询路径走索引，避免扫描 JSONL；统计路径异步化，避免阻塞列表。

## 6. 分阶段落地计划

### P0 前端与现有 API 止痛

目标：不改变存储结构，先让用户体感明显变好。

#### P0.1 保留旧列表刷新

修改 `web/src/stores/logs-store.ts`：

1. 区分 `loadingInitial`、`refreshing`、`loadingMore`。
2. 首次加载无数据时才展示 skeleton。
3. 已有数据时刷新只展示小型刷新状态，不隐藏表格。
4. 查询按钮、自动刷新、排序刷新都复用同一个刷新状态。

建议状态：

```ts
interface LogsState {
  items: LogEventSummary[];
  loadingInitial: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  lastUpdatedAt: string | null;
}
```

页面表现：

1. 结果卡片标题区域显示“刷新中...”。
2. 旧数据继续可读可点。
3. 刷新失败时保留旧数据并显示错误提示。

#### P0.2 请求取消与过期响应保护

修改 `web/src/lib/api.ts`：

```ts
export async function fetchLogEvents(
  params: FetchLogEventsParams = {},
  options?: { signal?: AbortSignal }
): Promise<LogEventsResponse> {
  const query = buildLogQueryString(params);
  const res = await fetch(`/api/logs/events${query ? `?${query}` : ''}`, {
    signal: options?.signal,
  });
  // ...
}
```

修改 `web/src/stores/logs-store.ts`：

1. store 模块级维护 `currentFetchController`。
2. 新查询开始时 abort 旧请求。
3. 维护 `requestSeq`，只有最新请求允许写入 store。
4. 自动刷新发现当前仍在刷新时跳过本轮。

验收：

1. 连续快速切换筛选条件，不会出现旧结果覆盖新结果。
2. 慢查询期间再次点击查询，不会叠加多个后端扫描。

#### P0.3 排序触发重新查询

当前 `LogsDataTable` 表头点击只调用 `setSort()`。应改为：

```ts
setSortAndFetch(nextSort)
```

修改 `web/src/stores/logs-store.ts`：

1. 新增 `setSortAndFetch`。
2. 设置 sort 后清 cursor，并调用 `fetchFirstPage()`。

验收：

1. 点击“时间”列后，列表顺序与服务端排序一致。
2. URL 或保存视图中的 sort 与结果一致。

#### P0.4 自动刷新增量化

新增后端参数：

```text
GET /api/logs/events?afterTs=<iso>&afterId=<id>&limit=100&sort=time_desc
```

前端维护：

1. `newestTs`
2. `newestId`

自动刷新调用：

```ts
fetchLogEvents({
  ...filters,
  sort: 'time_desc',
  limit: 100,
  afterTs: newestTs,
  afterId: newestId,
})
```

返回后：

1. 只 prepend 新数据。
2. 去重。
3. 如果用户滚动在顶部，自动插入。
4. 如果用户不在顶部，显示“有 N 条新日志”按钮，点击后插入并回到顶部。

注意：

1. 在 P2 索引落地前，后端 `afterTs` 仍可能扫描，但时间窗口会大幅缩小。
2. P2 后该接口走 `(ts_ms DESC, id DESC)` 索引。

#### P0.5 前端列表虚拟滚动

修改 `web/src/components/logs/logs-data-table.tsx`：

1. 使用 `@tanstack/react-virtual`。
2. 表格容器设置固定或最大高度，例如 `calc(100vh - 360px)`。
3. `useReactTable` 设置 `getRowId: row => row.id`。
4. 只渲染可视区域行。

建议：

1. 默认仍每页 50 或 100。
2. 加载更多后即使累计 5000 条，DOM 也只渲染几十行。

#### P0.6 限制 tail 前端合并成本

修改 `mergeUniqueById()`：

1. 不要每次 `Array.from(map.values()).sort(...)` 全量排序。
2. 因为服务端返回已按时间排序，新数据只需 prepend 后按 id 去重。
3. 设置最大保留条数，例如 2000 或 5000。

建议实现：

```ts
const MAX_TAIL_ITEMS = 2000;
```

超过上限时裁掉尾部旧数据。

### P1 查询算法改造

目标：在不立即引入 SQLite 的情况下，降低 JSONL 读取成本，并为 P2 接口语义打基础。

#### P1.1 keyset cursor 替代 offset cursor

当前 cursor：

```ts
interface CursorData {
  offset: number;
}
```

改为：

```ts
interface CursorData {
  sort: 'time_desc' | 'time_asc';
  tsMs: number;
  id: string;
  date: string;
  line: number;
}
```

分页规则：

1. `time_desc`: 下一页返回 `tsMs < cursor.tsMs`，同毫秒用 `id` 或 `{date,line}` 兜底。
2. `time_asc`: 下一页返回 `tsMs > cursor.tsMs`，同毫秒用 `id` 或 `{date,line}` 兜底。

收益：

1. cursor 表示“从哪里继续”，不是“跳过多少条”。
2. 后续迁移 SQLite 时可以直接映射到 keyset SQL。

#### P1.2 默认 time_desc 从文件尾部读取

新增文件读取工具：

```ts
async function* readLinesReverse(filePath: string): AsyncGenerator<{
  line: string;
  lineNumber: number;
}> {}
```

实现策略：

1. 使用 `fs.open`。
2. 从文件末尾按固定块大小读取，例如 64KB。
3. 拼接残留 partial line。
4. 反向切分 `\n`。
5. 产出行内容和行号。

查询策略：

1. `time_desc` 且无 `from/to` 跨多天时，从日期倒序扫描。
2. 每个文件从尾部倒序读取。
3. 收集到 `limit + 1` 条匹配后即可停止。
4. `limit + 1` 用于判断 `hasMore`，不再需要完整 total。

限制：

1. 如果请求同时要求精确 stats，则仍需完整扫描。
2. 所以 P1 必须配合“列表与统计拆分”。

#### P1.3 列表与统计拆分

调整 `/api/logs/events` 响应：

```ts
interface LogEventsResponse {
  items: LogEventSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  meta: {
    scannedFiles: number;
    scannedLines: number;
    parseErrors: number;
    truncated: boolean;
    statsMode: 'none' | 'cached' | 'partial' | 'exact';
  };
  stats?: LogQueryStats;
}
```

新增接口：

```text
GET /api/logs/events/stats
```

统计接口职责：

1. 可慢一些。
2. 支持缓存。
3. 支持后台刷新。
4. 前端独立显示统计卡片 loading 状态。

前端策略：

1. 列表查询先返回。
2. 统计卡片显示上次缓存结果或“统计刷新中”。
3. 统计更新后再替换卡片。

#### P1.4 关键词过滤短路化

当前 `containsKeyword()` 会创建 `haystack` 大字符串。改为逐字段判断：

```ts
function includesKeyword(value: unknown, keyword: string): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(keyword);
}
```

判断顺序：

1. request_id
2. path
3. provider
4. model_in
5. model_out
6. route_type
7. userKey
8. sessionId
9. error_type
10. error_message

命中立即返回。

#### P1.5 详情定位优化

当前 event id 是 `{ d, l }`，详情需要从文件头扫到第 `l` 行。

P1 可新增轻量 sidecar offset 文件：

```text
logs/events/2026-05-22.offsets
```

每行记录：

```json
{"line":12345,"offset":9876543}
```

或者在 P2 中直接由 SQLite 保存：

```text
event_date
event_line
file_offset
line_bytes
```

详情读取：

1. 从索引查 offset。
2. `fs.read` 指定范围。
3. `JSON.parse` 单行。

### P2 SQLite 查询索引

目标：从根上解决列表检索扫描大量行的问题。

#### P2.1 新增索引模块

新增文件：

```text
src/log-index.ts
src/log-index-schema.ts
src/log-index-backfill.ts
```

职责：

1. 初始化 SQLite。
2. 写入日志事件 summary。
3. 查询列表。
4. 查询 facets。
5. 查询统计缓存。
6. 回填旧 JSONL。
7. 校验索引健康状态。

索引文件路径：

```text
<log.baseDir>/indexes/log-index.sqlite
```

#### P2.2 表结构

主表：

```sql
CREATE TABLE IF NOT EXISTS log_events (
  id TEXT PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  ts_iso TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_line INTEGER NOT NULL,
  file_offset INTEGER,
  line_bytes INTEGER,

  level TEXT NOT NULL,
  provider TEXT NOT NULL,
  route_type TEXT NOT NULL,
  model TEXT NOT NULL,
  model_in TEXT NOT NULL,
  model_out TEXT NOT NULL,
  path TEXT NOT NULL,
  request_id TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  upstream_status INTEGER NOT NULL,
  status_class TEXT NOT NULL,
  has_error INTEGER NOT NULL,
  message TEXT NOT NULL,
  error_type TEXT,

  has_metadata INTEGER NOT NULL,
  user_id_raw TEXT,
  user_key TEXT,
  session_id TEXT,

  created_at_ms INTEGER NOT NULL
);
```

普通索引：

```sql
CREATE INDEX IF NOT EXISTS idx_log_events_ts_desc
  ON log_events (ts_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_log_events_provider_ts
  ON log_events (provider, ts_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_log_events_route_type_ts
  ON log_events (route_type, ts_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_log_events_model_in_ts
  ON log_events (model_in, ts_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_log_events_model_out_ts
  ON log_events (model_out, ts_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_log_events_status_ts
  ON log_events (status_class, ts_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_log_events_error_ts
  ON log_events (has_error, ts_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_log_events_user_ts
  ON log_events (user_key, ts_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_log_events_session_ts
  ON log_events (session_id, ts_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_log_events_request_id
  ON log_events (request_id);
```

FTS 表：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS log_events_fts
USING fts5(
  id UNINDEXED,
  request_id,
  path,
  provider,
  route_type,
  model_in,
  model_out,
  user_key,
  session_id,
  message,
  error_type
);
```

写入约束：

1. `log_events.id` 是主键，重复写入使用 `INSERT OR REPLACE` 或 `INSERT OR IGNORE`。
2. FTS 与主表在同一事务写入。
3. 回填旧日志时批量事务提交，每 500 或 1000 条提交一次。

#### P2.3 写入索引

当前日志写入在 `src/logger.ts`：

```ts
writeEvent(event: LogEvent): void
```

修改策略：

1. 继续 append JSONL，保证原始日志不丢。
2. append 成功后，将事件转换为 summary 写入 SQLite。
3. SQLite 写入失败只记录内部错误，不影响代理请求。
4. 写入使用队列，避免请求线程同步阻塞。

推荐队列：

```ts
interface LogIndexTask {
  event: LogEvent;
  eventDate: string;
  eventLine?: number;
  fileOffset?: number;
  lineBytes?: number;
}
```

注意：

1. 为了详情 offset，`writeEvent()` 最好记录 append 前文件 size。
2. 当前使用 `appendFileSync()`，可以先用 `statSync(filePath).size` 获取 offset，再写入。
3. 长期可改成单 writer 队列，减少同步 I/O。

#### P2.4 列表查询 SQL

无关键词：

```sql
SELECT *
FROM log_events
WHERE ts_ms BETWEEN ? AND ?
  AND (? IS NULL OR provider = ?)
  AND (? IS NULL OR route_type = ?)
  AND (? IS NULL OR model_in = ?)
  AND (? IS NULL OR model_out = ?)
  AND (? IS NULL OR user_key = ? OR user_id_raw = ?)
  AND (? IS NULL OR session_id = ?)
  AND (? IS NULL OR has_error = ?)
  AND (? IS NULL OR status_class IN (...))
  AND (
    ? IS NULL
    OR ts_ms < ?
    OR (ts_ms = ? AND id < ?)
  )
ORDER BY ts_ms DESC, id DESC
LIMIT ?;
```

有关键词：

```sql
SELECT e.*
FROM log_events_fts f
JOIN log_events e ON e.id = f.id
WHERE log_events_fts MATCH ?
  AND e.ts_ms BETWEEN ? AND ?
  -- 其他结构化过滤
ORDER BY e.ts_ms DESC, e.id DESC
LIMIT ?;
```

建议：

1. `LIMIT` 使用 `limit + 1`，多取 1 条判断 `hasMore`。
2. 返回给前端时只返回前 `limit` 条。
3. `nextCursor` 使用最后一条的 `{ tsMs, id }`。

#### P2.5 查询 API 兼容

保留现有接口：

```text
GET /api/logs/events
```

新增参数：

```text
afterTs
afterId
includeStats=0|1
statsMode=none|cached|exact
```

默认行为：

1. `includeStats=0`
2. `statsMode=none`
3. 列表优先快速返回

前端需要 stats 时调用：

```text
GET /api/logs/events/stats
```

#### P2.6 facets 接口

新增：

```text
GET /api/logs/facets?window=24h
```

返回：

```ts
interface LogFacetsResponse {
  providers: string[];
  routeTypes: string[];
  modelIns: string[];
  modelOuts: string[];
  users?: string[];
  sessions?: string[];
}
```

SQL：

```sql
SELECT DISTINCT provider FROM log_events WHERE ts_ms BETWEEN ? AND ? ORDER BY provider;
```

前端修改：

1. provider/model/route 下拉选项不再从当前 `items` 推导。
2. 查询窗口变化时刷新 facets。
3. facets 可缓存 10 到 30 秒。

#### P2.7 统计聚合

新增聚合表：

```sql
CREATE TABLE IF NOT EXISTS log_metric_buckets (
  bucket_start_ms INTEGER NOT NULL,
  bucket_size_ms INTEGER NOT NULL,
  provider TEXT,
  route_type TEXT,
  model_in TEXT,
  model_out TEXT,
  status_class TEXT,
  has_error INTEGER,
  requests INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  latency_sum INTEGER NOT NULL,
  latency_p95_estimate INTEGER,
  PRIMARY KEY (
    bucket_start_ms,
    bucket_size_ms,
    provider,
    route_type,
    model_in,
    model_out,
    status_class,
    has_error
  )
);
```

阶段策略：

1. 先实现列表与索引，不强制一次完成聚合。
2. stats 接口先用 SQLite 主表计算，比 JSONL 扫描快。
3. 后续将 1min 或 5min bucket 后台聚合，进一步加速统计。

统计体验：

1. 列表不等统计。
2. 卡片显示 cached stats。
3. 用户点击“刷新统计”时允许精确计算。

#### P2.8 旧日志回填

新增 CLI 或启动后台任务：

```text
local-router logs index rebuild
local-router logs index status
```

回填流程：

1. 遍历 `<baseDir>/events/*.jsonl`。
2. 逐行读取，记录 date、line、offset、lineBytes。
3. 解析 LogEvent，生成 summary。
4. 批量写入 SQLite。
5. 写入 `index_meta` 记录文件 size、mtime、indexedLines。

元数据表：

```sql
CREATE TABLE IF NOT EXISTS log_index_files (
  file_path TEXT PRIMARY KEY,
  event_date TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  indexed_lines INTEGER NOT NULL,
  indexed_at_ms INTEGER NOT NULL
);
```

增量回填：

1. 启动时检查当天文件 size 是否大于已索引 size。
2. 从上次 offset 继续读取。
3. 只补新增行。

#### P2.9 详情读取走 offset

新增详情读取路径：

1. 先从 SQLite 查 `event_date`, `file_offset`, `line_bytes`。
2. 如果有 offset，直接读取单行。
3. 如果没有 offset，回退到当前按 line 扫描。

这样可以兼容：

1. 新日志：快速 offset 读取。
2. 旧日志且未完成回填：继续可查。

### P3 实时追踪重做

目标：tail 从轮询查询变成读取新增日志。

#### P3.1 后端 tail 读取新增字节

当前 `/logs/tail` 每 3 秒执行 `queryLogEvents()`。改造后：

1. 建立 SSE 连接时确定当前日期文件。
2. 记录当前 file offset，默认从文件末尾开始。
3. 使用 `fs.watch` 监听当天文件变化。
4. 文件变化时读取新增字节。
5. 按行切分，解析完整新行。
6. 用同一套 filter 判断是否推送。

兜底：

1. `fs.watch` 不可靠时，保留低频 polling。
2. polling 只读新增 byte range，不调用列表查询。
3. 跨天时切换到新日期文件。

#### P3.2 tail 与索引联动

新增日志到达时：

1. JSONL append。
2. SQLite index 写入。
3. tail 读取新增行并推送。

如果 tail 直接挂在 logger 写入队列上，也可以减少文件监听复杂度：

1. Logger 成功写入事件后发布内存事件。
2. SSE 订阅内存事件。
3. 进程重启后重新连接只从当前尾部开始，历史补齐由列表接口完成。

推荐优先级：

1. 单进程应用优先内存 pub/sub，最简单。
2. 需要跨进程或更强恢复能力时，再加文件 watch。

#### P3.3 前端新日志提示

前端策略：

1. 用户在顶部：自动插入新日志。
2. 用户不在顶部：累计 pending items，显示“有 N 条新日志”。
3. 点击提示后插入并滚动到顶部。
4. tail 和 auto refresh 不要同时开启；开启 tail 时自动关闭 auto refresh。

### P4 导出优化

目标：导出不拖慢列表，不制造大内存峰值。

当前导出已经使用 `ReadableStream` 输出，但数据来源仍是 `queryLogEvents()`，最多取 `MAX_EXPORT_ROWS`，仍要先完成查询。

改造：

1. 导出走 SQLite cursor。
2. 每批读取 500 或 1000 条。
3. CSV/JSON 边查边写。
4. 导出不复用列表接口。
5. 大导出返回任务 ID，前端轮询进度。

接口：

```text
POST /api/logs/export-jobs
GET /api/logs/export-jobs/:id
GET /api/logs/export-jobs/:id/download
```

可以先保留现有同步导出，P4 后再做任务化。

## 7. 推荐实施顺序

### 第 1 个 PR：前端刷新止痛

范围：

1. `web/src/lib/api.ts`
2. `web/src/stores/logs-store.ts`
3. `web/src/pages/logs.tsx`

内容：

1. fetch 支持 AbortSignal。
2. store 加 request sequence 和 AbortController。
3. 保留旧列表刷新。
4. 排序触发重新查询。
5. 自动刷新跳过并发请求。

验收：

1. 刷新时列表不闪空。
2. 慢查询不会覆盖新查询。
3. 排序点击实际生效。

### 第 2 个 PR：后端列表快路径

范围：

1. `src/log-query.ts`
2. `src/index.ts`
3. tests

内容：

1. 新增 keyset cursor。
2. 默认不返回精确 stats。
3. 支持 `limit + 1` 判断 hasMore。
4. `time_desc` 支持倒序日期扫描。
5. 可选实现文件尾倒读。

验收：

1. 第一页不再为了 total 扫完整窗口。
2. 下一页不再使用 offset 语义。
3. 老 cursor 非法时返回明确错误。

### 第 3 个 PR：SQLite 索引基础

范围：

1. `src/log-index.ts`
2. `src/log-index-schema.ts`
3. `src/logger.ts`
4. `src/log-query.ts`
5. `src/index.ts`
6. tests

内容：

1. 初始化 SQLite。
2. 新日志写入主表和 FTS。
3. `/api/logs/events` 优先走索引。
4. 索引不可用时回退 JSONL。

验收：

1. 新日志写入后立刻可查。
2. provider/model/status/user/session 过滤走 SQLite。
3. 关键词搜索走 FTS。
4. 删除索引文件后应用能重建或回退。

### 第 4 个 PR：旧日志回填和详情 offset

范围：

1. `src/log-index-backfill.ts`
2. `src/cli.ts`
3. `src/log-query.ts`
4. tests

内容：

1. `local-router logs index rebuild`
2. `local-router logs index status`
3. 回填 file offset。
4. 详情读取优先走 offset。

验收：

1. 旧 JSONL 可回填。
2. 回填中断后可继续。
3. 详情读取不再从文件头扫到指定行。

### 第 5 个 PR：tail 真增量

范围：

1. `src/index.ts`
2. `src/logger.ts`
3. `web/src/stores/logs-store.ts`
4. `web/src/pages/logs.tsx`

内容：

1. 后端 SSE 订阅新增日志事件。
2. 停止 tail 的 `queryLogEvents()` 轮询。
3. 前端新日志提示。
4. tail 开启时自动关闭 auto refresh。

验收：

1. tail 空闲时不扫描历史日志。
2. 新日志延迟推送。
3. 断开连接清理 listener。

### 第 6 个 PR：虚拟滚动与 facets

范围：

1. `web/src/components/logs/logs-data-table.tsx`
2. `web/src/pages/logs.tsx`
3. `web/src/lib/api.ts`
4. `src/index.ts`
5. `src/log-index.ts`

内容：

1. 表格虚拟滚动。
2. `/api/logs/facets`。
3. 下拉选项从 facets 获取。
4. 保存视图持久化 localStorage。

验收：

1. 加载 5000 条后滚动流畅。
2. 下拉选项不依赖当前页。
3. 刷新页面后保存视图仍存在。

## 8. 测试计划

### 8.1 单元测试

新增或扩展：

1. `tests/unit/log-query.test.ts`
2. `tests/unit/log-index.test.ts`
3. `tests/unit/log-index-backfill.test.ts`

测试点：

1. keyset cursor 编解码。
2. `time_desc` 和 `time_asc` 分页稳定性。
3. 同毫秒多条日志排序稳定性。
4. provider/model/status/user/session 过滤。
5. FTS 关键词搜索。
6. SQLite 不可用时回退 JSONL。
7. 回填重复执行不产生重复记录。
8. offset 详情读取与旧 line 读取结果一致。

### 8.2 集成测试

新增：

1. 生成 10000 条日志。
2. 查询第一页，确认返回 50 条。
3. 连续翻页，确认无重复、无遗漏。
4. 写入新日志后增量刷新能拿到。
5. tail 连接后写入新日志，SSE 收到新事件。

### 8.3 性能回归测试

建议新增脚本：

```text
scripts/bench-log-search.ts
```

场景：

1. 1 万条日志。
2. 10 万条日志。
3. 100 万条日志。
4. 无过滤第一页。
5. provider 过滤第一页。
6. user/session 过滤第一页。
7. 关键词搜索第一页。
8. 翻到第 20 页。

指标：

1. API latency p50/p95。
2. scannedLines。
3. SQLite rows read 或 query plan。
4. heap delta。
5. response size。

目标：

1. 列表第一页不随 JSONL 总行数线性增长。
2. provider/model/status/user/session 查询走索引。
3. 关键词搜索走 FTS。
4. 自动刷新不触发完整窗口扫描。

## 9. API 兼容与迁移

### 9.1 兼容策略

1. 保留 `/api/logs/events` 路径。
2. 保留现有 query 参数。
3. 新 cursor 格式与旧 cursor 不兼容时，返回 400 并提示刷新页面。
4. stats 从必返改为可选时，前端需要兼容 `stats` 为空。

### 9.2 索引可用性

新增健康状态：

```text
GET /api/logs/index/status
```

返回：

```ts
interface LogIndexStatus {
  enabled: boolean;
  ready: boolean;
  dbPath: string | null;
  indexedEvents: number;
  pendingFiles: number;
  lastIndexedAt: string | null;
  fallbackReason: string | null;
}
```

前端可以在日志设置页显示索引状态。

### 9.3 回退策略

如果 SQLite 初始化失败：

1. 日志写入 JSONL 不受影响。
2. 列表查询回退当前 JSONL 扫描。
3. API `meta` 返回 `indexUsed: false` 和 fallback reason。
4. 前端显示低调提示，不阻塞使用。

## 10. 配置建议

扩展 `LogConfig`：

```ts
export interface LogConfig {
  enabled?: boolean;
  baseDir?: string;
  events?: {
    retainDays?: number;
  };
  streams?: {
    enabled?: boolean;
    retainDays?: number;
    maxBytesPerRequest?: number;
  };
  bodyPolicy?: 'off' | 'masked' | 'full';
  index?: {
    enabled?: boolean;
    backend?: 'sqlite';
    autoBackfill?: boolean;
    backfillBatchSize?: number;
  };
}
```

默认：

```json5
{
  log: {
    enabled: true,
    bodyPolicy: "off",
    index: {
      enabled: true,
      backend: "sqlite",
      autoBackfill: true,
      backfillBatchSize: 1000,
    },
  },
}
```

## 11. 风险与处理

本节是对整套方案的专项风险 review。结论：方案可行，但风险集中在“数据正确性、索引一致性、并发写入、cursor 稳定性、tail 背压、迁移回退、统计语义变化”这几类。实现时必须把这些风险当作验收项，而不是上线后再补救。

风险等级定义：

1. High：可能导致日志丢失、查询结果错误、无法恢复、主链路受影响。
2. Medium：可能导致性能退化、体验异常、统计不准、索引落后。
3. Low：主要影响诊断、可观测性或边缘场景体验。

### 11.1 High：JSONL 与 SQLite 双写不一致

风险：

1. JSONL 写入成功，但 SQLite 索引写入失败。
2. SQLite 写入成功，但 FTS 写入失败。
3. backfill 与实时写入并发，导致重复、覆盖或 FTS 残留。

影响：

1. 列表查不到已存在的原始日志。
2. 关键词搜索结果和普通过滤结果不一致。
3. 详情页通过列表进入失败。

处理：

1. JSONL 是唯一事实来源，SQLite/FTS 都是派生索引。
2. JSONL 写入成功后才 enqueue 索引任务。
3. 主表和 FTS 必须同一事务写入。
4. 索引任务必须幂等，以 `id` 去重。
5. `log_index_files` 记录文件 size、mtime、indexed offset。
6. 索引失败时标记 `index_degraded_reason`，查询响应返回 `meta.indexFresh=false`。
7. 提供 `logs index rebuild` 和增量 backfill 修复。

验收：

1. 模拟 SQLite 写入失败，JSONL 仍成功写入。
2. 恢复 SQLite 后执行 backfill，缺失日志能补齐。
3. 重复 backfill 不产生重复列表项。
4. 主表与 FTS 对同一 id 的存在性一致。

### 11.2 High：索引错误导致查询结果不正确

风险：

1. 过滤字段从 `LogEvent` 映射到 summary 时出错。
2. user/session 从 request body 提取逻辑与旧查询不一致。
3. statusClass、hasError、model 字段语义与现有列表不一致。

影响：

1. 用户以为没有日志，实际 JSONL 中存在。
2. 错误日志、用户会话、模型过滤出现漏查或误查。

处理：

1. 复用现有 `getStatusClass()`、`getLevel()`、`resolveLogSessionIdentity()` 等逻辑，避免复制分叉。
2. 为 `LogEvent -> LogEventSummary` 建单独纯函数，并被 JSONL 查询和 SQLite 索引共用。
3. 回填测试必须用同一批 JSONL 比较“旧查询结果”和“索引查询结果”。
4. 字段语义变化必须写 migration notes。

验收：

1. provider、routeType、modelIn、modelOut、user、session、statusClass、hasError 全部有对照测试。
2. 1000 条混合日志下，旧 JSONL 查询和 SQLite 查询结果 id 顺序一致。
3. 关键词为空时，FTS 不参与查询，普通过滤结果稳定。

### 11.3 High：cursor 翻页重复、遗漏或错页

风险：

1. 继续使用 offset cursor，会导致页数越深越慢。
2. 查询条件变化后误用旧 cursor。
3. 多条日志同毫秒，仅按 timestamp 排序不稳定。
4. 新日志插入后，用户翻页出现重复或遗漏。

影响：

1. 用户看不到部分日志。
2. 加载更多出现重复项。
3. 性能退回深分页扫描。

处理：

1. 使用 keyset cursor：`{ v, sort, tsMs, id, queryHash }`。
2. 排序固定为 `(ts_ms, id)`。
3. cursor 必须校验 sort 和 queryHash。
4. 每次查询使用 `LIMIT limit + 1` 判断 `hasMore`。
5. 前端以 id 去重，但不能用去重掩盖后端分页错误。

验收：

1. 同毫秒 100 条日志，连续翻页无重复无遗漏。
2. 切换筛选后使用旧 cursor 返回 400。
3. 翻页过程中插入新日志，不影响当前 cursor 继续向旧数据翻页。
4. `time_desc` 和 `time_asc` 都覆盖。

### 11.4 High：SQLite schema migration 失败

风险：

1. 新版本 schema 与旧 db 不兼容。
2. migration 执行一半失败。
3. db 文件损坏或 WAL 文件异常。

影响：

1. 日志页面不可用。
2. 应用启动失败。
3. 用户无法恢复索引。

处理：

1. `log_index_meta.schema_version` 管理版本。
2. migration 在事务内执行。
3. migration 前备份旧 db 或至少保留 JSONL fallback。
4. migration 失败时不阻断应用启动，禁用索引并返回 fallback reason。
5. 提供删除索引并 rebuild 的自动恢复路径。

验收：

1. 构造旧 schema db，升级成功。
2. 构造损坏 db，应用不崩溃并回退 JSONL。
3. migration 中途抛错后不会留下半升级状态。

### 11.5 High：索引写入影响代理主链路

风险：

1. 请求完成时同步写 SQLite，导致代理延迟变高。
2. SQLite locked 导致请求阻塞。
3. backfill 占用 I/O，影响正常日志写入。

影响：

1. local-router 转发体验变差。
2. 日志系统故障放大到核心代理链路。

处理：

1. 请求主链路只保证 JSONL 写入，不同步等待重型索引操作。
2. 索引写入走有界队列和批量事务。
3. backfill 限速，优先级低于实时写入。
4. 队列超限时标记 stale，通过 backfill 补齐，不阻塞请求。
5. SQLite 设置 `busy_timeout`，失败后进入 retry。

验收：

1. SQLite locked 时，代理请求仍成功返回。
2. 大量 backfill 时，新请求日志仍能写 JSONL。
3. 索引队列超过上限时不会无限占内存。

### 11.6 High：tail 背压和连接生命周期泄漏

风险：

1. SSE 客户端消费慢，服务端队列堆积。
2. 页面反复进入退出，subscriber/timer/listener 未清理。
3. tail 空闲时仍扫描历史日志。
4. 服务端推送丢事件后客户端无感知。

影响：

1. 内存增长。
2. 后端 CPU 持续消耗。
3. 用户以为实时追踪正常，实际漏日志。

处理：

1. tail 使用有界 subscriber 队列。
2. 队列溢出发送 `resync_required` 并关闭连接。
3. abort/cancel 必须清理 subscriber、timer、listener。
4. tail 空闲时不调用 `queryLogEvents()`。
5. heartbeat 独立于事件推送。
6. tail 开启时前端关闭 auto refresh，避免重复刷新路径。

验收：

1. 断开 SSE 后 subscriber 数归零。
2. 慢客户端触发 `resync_required`。
3. tail 空闲 1 分钟内不会扫描 JSONL 历史文件。
4. 服务端重启后前端能重新同步第一页。

### 11.7 High：FTS 输入与查询语义风险

风险：

1. 用户输入特殊字符导致 FTS MATCH 语法错误。
2. 直接暴露 FTS 语法，产生难以理解的搜索结果。
3. FTS token 过多或过长导致查询变慢。

影响：

1. 搜索接口 500。
2. 用户搜索结果不符合直觉。
3. 恶意或异常输入造成 CPU 开销。

处理：

1. 默认搜索框只支持普通文本搜索，不开放高级 FTS 语法。
2. `normalizeFtsQuery()` 统一 trim、限长、去控制字符、tokenize、quote escape。
3. token 数和总长度有上限。
4. FTS 错误返回 400，不返回 500。
5. request_id 这类精确值优先走普通索引。

验收：

1. 各类特殊字符输入不会 500。
2. 超长关键词返回明确 400。
3. request_id 搜索能稳定命中。
4. FTS 查询有性能测试覆盖。

### 11.8 Medium：统计语义变化导致用户误解

风险：

1. 列表不再同步返回精确 total/P95。
2. stats 使用缓存或异步计算。
3. 列表和统计生成时间不同。

影响：

1. 用户看到列表已更新，但统计仍是旧值。
2. 错误率、P95 与当前筛选短时间不一致。

处理：

1. `statsMode` 明确返回 `none | cached | exact | partial`。
2. stats 返回 `generatedAt`。
3. UI 标注“统计刷新中”或“缓存统计”。
4. 提供手动刷新精确统计。
5. 列表体验优先，不让 stats 阻塞列表。

验收：

1. stats 缓存时 UI 有明确状态。
2. stats 接口失败不影响列表查询。
3. 精确统计路径有超时和取消保护。

### 11.9 Medium：JSONL fallback 退化为旧性能

风险：

1. 索引不可用时回退 JSONL，性能又变慢。
2. 用户不知道当前处于 fallback。
3. fallback 被长期使用，问题隐藏。

影响：

1. 大日志量下页面仍慢。
2. 性能问题难诊断。

处理：

1. API `meta.indexUsed=false` 和 `fallbackReason` 必须返回。
2. 日志设置页显示索引状态。
3. fallback 计数进入可观测指标。
4. fallback 只作为可用性兜底，不作为长期正常路径。

验收：

1. 禁用索引后 UI 可看到状态。
2. fallback 查询仍有扫描上限。
3. fallback 触发时不会影响主链路。

### 11.10 Medium：backfill 长时间运行与资源竞争

风险：

1. 大量旧日志回填占用 CPU、I/O。
2. backfill 和实时写入争抢 SQLite 写锁。
3. backfill 中断后状态不准确。

影响：

1. 查询变慢。
2. 新日志索引延迟增加。
3. 需要用户手动清理。

处理：

1. backfill 分批事务。
2. 实时写入优先于 backfill。
3. backfill 记录文件级 offset 和 indexedLines。
4. 支持暂停、继续、重建。
5. 启动自动 backfill 低优先级运行。

验收：

1. 回填 10 万行时 API 仍可查询。
2. 中断后继续不会重复或漏索引。
3. backfill 进度可见。

### 11.11 Medium：文件 offset 读取详情不可靠

风险：

1. offset 基于 string length 而不是 byte length。
2. JSONL 被外部编辑，offset 失效。
3. 日志轮转、清理后详情文件不存在。

影响：

1. 详情页打开失败。
2. 读取到错误行。

处理：

1. offset 必须基于 Buffer byte offset。
2. `log_index_files` 用 size/mtime 判断 offset 是否可信。
3. offset 不可信时回退 line scan。
4. 文件不存在时返回明确“日志文件已清理”。

验收：

1. 包含中文、多字节字符的日志 offset 读取正确。
2. 修改 JSONL 后 indexFresh=false。
3. 文件缺失时详情错误可理解。

### 11.12 Medium：前端状态竞争与体验倒退

风险：

1. 慢请求覆盖新请求。
2. 自动刷新与 tail 同时更新列表。
3. 用户正在阅读旧日志时，新日志插入导致滚动跳动。
4. 刷新时旧列表被清空。

影响：

1. 用户误判查询结果。
2. 页面跳动，阅读体验差。
3. 交互卡顿。

处理：

1. fetch 使用 AbortController 和 requestSeq。
2. tail 开启时关闭 auto refresh。
3. 使用 `draftFilters` 和 `committedFilters`。
4. 用户不在顶部时只显示“有 N 条新日志”，不自动插入。
5. loading 状态区分 initial、refreshing、loadingMore。

验收：

1. 快速切换筛选不会被旧响应覆盖。
2. 刷新时旧列表保留。
3. 不在顶部时新日志不改变滚动位置。

### 11.13 Medium：内存与缓存无界增长

风险：

1. stats/facets 缓存按 queryHash 无限增长。
2. tail subscriber 队列无限增长。
3. 前端列表无限追加。
4. 索引写入队列无限堆积。

影响：

1. 长时间运行后内存升高。
2. 浏览器页面卡顿。
3. 后端 GC 压力增大。

处理：

1. 所有缓存设置 max entries 和 TTL。
2. tail 队列设置 max length。
3. 前端虚拟滚动并限制 tail 保留条数。
4. 索引队列设置上限，超限标记 stale。

验收：

1. 长时间 tail 和 auto refresh 后内存不持续增长。
2. 加载 5000 条后页面仍可交互。
3. 缓存条目数可观测。

### 11.14 Low：可观测性不足导致问题难定位

风险：

1. 查询慢但不知道是否走索引。
2. 索引落后但用户无感知。
3. backfill 失败没有状态。

影响：

1. 性能问题难排查。
2. 用户只能感知“慢”，无法定位原因。

处理：

1. API meta 返回 `indexUsed`、`indexFresh`、`usesFts`、`queryMs`、`fallbackReason`。
2. `logs index status` 显示 indexedEvents、pendingFiles、lastError。
3. debug 日志记录 slow query 和 JSONL fallback。
4. 前端日志设置页显示索引健康状态。

验收：

1. 每次列表响应能看出是否走索引。
2. 索引异常时 UI 有明确状态。
3. backfill 进度可查看。

### 11.15 风险审查结论

必须优先控制的 High 风险：

1. JSONL 与 SQLite/FTS 不一致。
2. 索引查询结果与旧 JSONL 查询语义不一致。
3. cursor 翻页重复、遗漏或错页。
4. schema migration 失败导致日志页面不可用。
5. 索引写入影响代理主链路。
6. tail 背压或连接清理不完整。
7. FTS 输入导致查询错误或资源消耗异常。

这些风险的共同处理原则：

1. JSONL 保持事实来源。
2. 索引全部可重建。
3. 查询全部可回退。
4. 写入全部有边界。
5. cursor 全部可校验。
6. 前端请求全部可取消。
7. 每个风险都必须有单元测试或集成测试覆盖。

## 12. 最终验收标准

功能验收：

1. 日志列表筛选结果正确。
2. 翻页无重复、无遗漏。
3. 排序切换正确。
4. 新日志自动刷新正确。
5. tail 正确推送新增日志。
6. 详情页能打开新旧日志。
7. 旧 JSONL 可回填。
8. 索引损坏后可重建。

性能验收：

1. 最新列表第一页不扫描完整 24h JSONL。
2. provider/model/status/user/session 过滤走 SQLite 索引。
3. 关键词搜索走 FTS。
4. 自动刷新只查询新增数据。
5. tail 空闲时不触发历史扫描。
6. 100000 条日志下第一页查询稳定在可接受范围。
7. 前端加载 5000 条后滚动仍流畅。

体验验收：

1. 刷新时旧列表不消失。
2. 查询慢时用户能看到刷新状态。
3. 查询失败时旧列表仍保留。
4. 新日志不会打断用户阅读旧日志。
5. 筛选下拉选项完整，不依赖当前页。

## 13. 详细工程设计补充

本节用于把前面的路线图细化成实现时必须遵守的工程约束。后续每个 PR 都应对照本节做设计评审。

### 13.1 核心架构决策

最终方案采用“原始日志 + 派生索引”的架构：

1. JSONL 是事实来源。
2. SQLite 是派生查询索引。
3. FTS 是派生关键词索引。
4. 聚合表是派生统计索引。
5. 所有派生索引都必须可删除、可重建、可增量修复。

这样设计的原因：

1. 日志写入不能因为索引失败而阻断代理主链路。
2. 用户已有 JSONL 日志不能失效。
3. 索引 bug 不能导致原始日志丢失。
4. 本地应用应避免引入外部数据库进程。

设计约束：

1. 任何查询优化都不能改变 JSONL 的原始记录语义。
2. 任何索引写入失败都只能降级查询体验，不能影响请求转发。
3. 所有列表查询都必须有明确上限，不能把无界结果集放进内存。
4. 所有 cursor 都必须是不可变查询上下文下的 keyset cursor，禁止再引入 offset cursor。
5. 所有动态 SQL 都必须参数化，禁止字符串拼接用户输入。

### 13.2 数据一致性模型

一致性采用“JSONL 强一致，索引最终一致”：

1. 请求结束时先写 JSONL。
2. JSONL 写入成功后，将索引任务加入队列。
3. 索引任务在事务中写入 `log_events` 和 `log_events_fts`。
4. 如果索引写入失败，记录失败并保留待修复状态。
5. 后台 backfill 根据 JSONL 文件 size、mtime 和 offset 补齐索引。

读取路径：

1. 索引 ready 且 fresh 时，列表、过滤、关键词、facets 优先走 SQLite。
2. 索引未 ready 时，列表可回退 JSONL 快路径。
3. 索引 stale 时，API `meta` 必须返回 `indexFresh: false`。
4. 详情读取优先用索引 offset；offset 不存在时回退 line scan。

可接受一致性：

1. 新日志写入后，列表索引可有短暂延迟，目标小于 1 秒。
2. tail 推送可以早于 SQLite 查询可见，但前端下一次刷新必须能从索引查到。
3. stats 可以是缓存结果，必须标注 `statsMode` 和 `generatedAt`。

不可接受情况：

1. JSONL 写入失败但 API 仍声称日志已记录。
2. 索引重复导致列表同一日志出现多次。
3. cursor 翻页出现重复或遗漏。
4. 索引损坏后无法恢复。

### 13.3 事件 ID 与排序稳定性

当前 ID 基于 `{ date, line }`，可继续兼容，但索引层需要更稳定的排序键。

推荐 ID 策略：

1. 保留原 `encodeEventId({ d, l })` 作为外部详情 id，兼容旧 URL。
2. SQLite 主键使用同一个 id，避免双 id 体系。
3. 排序主键使用 `(ts_ms, id)`。
4. 如果未来写入时能稳定拿到 file offset，可扩展 cursor 包含 `file_offset`，但不替代 id。

排序规则：

```text
time_desc: ORDER BY ts_ms DESC, id DESC
time_asc:  ORDER BY ts_ms ASC,  id ASC
```

cursor 必须包含：

```ts
interface LogCursorV2 {
  v: 2;
  sort: 'time_desc' | 'time_asc';
  tsMs: number;
  id: string;
  queryHash: string;
}
```

`queryHash` 由过滤条件、时间范围、排序字段、关键词归一化后计算得到。

cursor 校验：

1. cursor 版本不支持，返回 400。
2. cursor sort 与当前 sort 不一致，返回 400。
3. cursor queryHash 与当前查询不一致，返回 400。
4. cursor tsMs 非法，返回 400。

这样可以避免用户切换筛选后误用旧 cursor，导致翻页错乱。

### 13.4 查询构建器设计

新增一个专门的查询构建层，不要在 route handler 中拼 SQL。

建议模块：

```text
src/log-index-query.ts
```

职责：

1. 归一化查询参数。
2. 校验 limit、q、filter 数量。
3. 生成参数化 SQL。
4. 生成 queryHash。
5. 解析和生成 cursor。
6. 返回 query plan 调试信息。

接口示例：

```ts
interface LogIndexQuery {
  fromMs: number;
  toMs: number;
  levels: LogLevel[];
  providers: string[];
  routeTypes: string[];
  modelIns: string[];
  modelOuts: string[];
  users: string[];
  sessions: string[];
  statusClasses: StatusClass[];
  hasError: boolean | null;
  q: string;
  sort: LogSort;
  limit: number;
  cursor: LogCursorV2 | null;
}

interface BuiltLogQuery {
  sql: string;
  params: unknown[];
  queryHash: string;
  usesFts: boolean;
}
```

约束：

1. `limit` 默认 50，最大 200。
2. 多值过滤数量应有上限，例如每类最多 50 个。
3. `q` 最大 200 字符，FTS token 过多时返回 400。
4. 所有 `IN (...)` 都由占位符生成。
5. 不允许把字段名从用户输入直接放进 SQL。
6. 排序字段只允许白名单：`time_desc`、`time_asc`。

查询策略：

1. `q` 为空：走 `log_events`。
2. `q` 非空：走 `log_events_fts JOIN log_events`。
3. 如果 `q` 看起来像完整 `request_id`，可以优先走 `request_id` 普通索引，再 fallback FTS。
4. 用户和会话精确匹配走普通索引。
5. 任意查询都使用 `LIMIT limit + 1`。

### 13.5 SQLite 连接与事务设计

SQLite 应以单进程本地数据库方式使用，避免过度抽象。

初始化建议：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA busy_timeout = 3000;
PRAGMA foreign_keys = ON;
```

说明：

1. WAL 提高读写并发能力。
2. `synchronous=NORMAL` 在本地日志索引场景是合理折中；JSONL 仍是事实来源。
3. `busy_timeout` 避免短暂写锁导致查询立即失败。

连接策略：

1. 一个写连接，用于索引队列和 backfill。
2. 一个读连接，用于 API 查询。
3. 如果实现复杂度过高，第一版可以单连接串行，但要保留未来拆分空间。

事务策略：

1. 单条新日志索引写入可批量合并，最多等待 50ms 或累计 100 条。
2. 每个批次一个事务。
3. `log_events` 和 `log_events_fts` 必须在同一事务内写入。
4. backfill 每 500 到 1000 行一个事务。
5. 事务失败时整批回滚，保留 retry 机会。

DB locked 处理：

1. 短暂 busy 由 `busy_timeout` 处理。
2. 仍失败时索引任务进入 retry 队列。
3. retry 次数超过上限后标记 index degraded。
4. degraded 状态下 API 可回退 JSONL 或提示索引落后。

### 13.6 索引写入队列设计

不要在请求主链路里直接执行重型索引操作。

建议队列结构：

```ts
interface IndexQueueState {
  pending: LogIndexTask[];
  flushing: boolean;
  dropped: number;
  lastError: string | null;
  lastFlushAt: number | null;
}
```

边界：

1. 队列最大长度，例如 10000。
2. 超限时不丢 JSONL，只记录 `droppedIndexTasks`，并把索引标记为 stale。
3. 后台 backfill 根据 JSONL 补齐被丢弃的索引任务。

flush 触发：

1. 达到 batch size。
2. 达到 flush interval。
3. 进程退出前尽力 flush。

可靠性：

1. 索引任务必须幂等。
2. `INSERT OR REPLACE` 或 `INSERT ... ON CONFLICT` 需要明确 FTS 同步策略。
3. 推荐主表 `INSERT OR REPLACE` 后，先删除同 id FTS，再插入 FTS。
4. backfill 和实时写入并发时必须以 id 去重。

### 13.7 FTS 设计与安全

FTS 不应该直接暴露 SQLite 的高级查询语法给普通搜索框。

第一版搜索语义：

1. 用户输入按普通文本处理。
2. 默认做 phrase 或 AND token 搜索。
3. 特殊字符转义。
4. 输入为空不走 FTS。

建议函数：

```ts
function normalizeFtsQuery(raw: string): string
```

行为：

1. trim。
2. 限长。
3. 去除控制字符。
4. 将用户输入拆成 token。
5. 每个 token 做 quoted escaping。
6. token 数超过上限返回错误。

错误处理：

1. FTS MATCH 报错时返回 400，而不是 500。
2. API 返回“关键词包含不支持的搜索字符”。
3. 后续可以单独增加高级搜索模式。

### 13.8 Backfill 与索引修复

backfill 是整套方案鲁棒性的关键。

backfill 必须支持：

1. 首次全量构建。
2. 中断后继续。
3. 单文件增量补齐。
4. 索引损坏后重建。
5. 跳过坏 JSON 行并记录 parseErrors。

运行模式：

1. 启动后低优先级自动 backfill。
2. CLI 手动 rebuild。
3. API 查看状态。

锁设计：

1. backfill 开始时创建进程内锁，避免并发 rebuild。
2. 如果需要跨进程，使用 lock file。
3. 发现已有锁且进程不存在时允许清理 stale lock。

状态表：

```sql
CREATE TABLE IF NOT EXISTS log_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

建议 key：

```text
schema_version
index_created_at_ms
last_backfill_started_at_ms
last_backfill_finished_at_ms
last_backfill_error
index_degraded_reason
```

文件级状态用 `log_index_files` 保存。

回填 offset：

1. 读取文件时维护 byte offset。
2. 每读一行记录当前行起始 offset 和字节长度。
3. 注意 UTF-8 字符不影响 byte offset，因为 offset 基于 Buffer。
4. 不要用 string length 当 byte length。

坏行处理：

1. 单行 JSON.parse 失败不终止整个文件。
2. `parseErrors` 计数。
3. 可保存最近 N 个错误样例用于诊断。

### 13.9 tail 可靠性设计

tail 第一版建议用 logger 内存 pub/sub，文件新增读取作为兜底或后续增强。

pub/sub 设计：

```ts
interface LogTailSubscriber {
  id: string;
  filters: NormalizedLogQueryInput;
  enqueue: (event: LogEventSummary) => void;
  close: () => void;
}
```

约束：

1. 每个 subscriber 有有界队列，例如 1000 条。
2. 队列满时关闭连接并提示客户端刷新。
3. 每个连接定期 heartbeat，例如 15 秒。
4. abort 时必须清理 subscriber、timer、listener。
5. 最大连接数可配置，例如 20。

SSE event：

```text
event: ready
event: events
event: heartbeat
event: resync_required
event: error
```

`resync_required` 场景：

1. subscriber 队列溢出。
2. 索引明显落后。
3. 服务端发生重启。
4. 客户端 cursor 太旧。

前端收到 `resync_required`：

1. 停止 tail。
2. 调用一次 `fetchFirstPage()`。
3. 重新建立 tail。

### 13.10 前端状态机设计

日志页面状态不应继续用几个 boolean 随意组合，建议明确状态机。

建议状态：

```ts
type LogListStatus =
  | 'idle'
  | 'initial_loading'
  | 'refreshing'
  | 'loading_more'
  | 'error';
```

派生 UI：

1. `initial_loading` 且 items 为空：显示 skeleton。
2. `refreshing`：保留列表，显示顶部进度。
3. `loading_more`：底部按钮 loading。
4. `error` 且 items 为空：显示错误空态。
5. `error` 且 items 非空：显示非阻塞错误提示。

store 必须维护：

```ts
interface LogsState {
  committedFilters: LogFilters;
  draftFilters: LogFilters;
  sort: LogSort;
  items: LogEventSummary[];
  pendingNewItems: LogEventSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  lastUpdatedAt: string | null;
  status: LogListStatus;
  error: string | null;
}
```

为什么拆分 draft 和 committed：

1. 用户输入关键词时不应立即查询。
2. 点击“查询”后才提交筛选。
3. 自动刷新必须使用 committed filters，避免半输入状态触发刷新。

### 13.11 缓存策略

前端缓存：

1. 当前列表只缓存当前 committed query。
2. 不做复杂多 query 缓存，避免 stale 和内存膨胀。
3. saved views 持久化 localStorage。
4. facets 可按 query window 缓存 30 秒。

后端缓存：

1. stats 缓存按 queryHash。
2. facets 缓存按 time window 和 index generation。
3. 缓存必须有 max entries，例如 64。
4. 缓存 value 不保存完整 items，只保存聚合结果。

### 13.12 性能目标

建议建立明确目标，方便回归测试。

在 100000 条日志规模下：

1. 最新列表第一页 p95 小于 200ms。
2. provider/model/status 过滤第一页 p95 小于 300ms。
3. user/session 过滤第一页 p95 小于 300ms。
4. 关键词搜索第一页 p95 小于 500ms。
5. 加载下一页 p95 与第一页同级，不随页数线性增长。
6. 自动刷新无新增日志时 p95 小于 100ms。
7. tail 空闲时不触发 JSONL 历史扫描。

在 1000000 条日志规模下：

1. 最新列表第一页 p95 小于 500ms。
2. 结构化过滤第一页 p95 小于 800ms。
3. 关键词搜索第一页 p95 小于 1500ms。
4. 详情读取 p95 小于 100ms，前提是 offset 已回填。

这些目标不是第一天必须全部达成，但每个阶段都应记录基线。

### 13.13 可观测性

新增响应 meta 字段：

```ts
interface LogQueryMeta {
  indexUsed: boolean;
  indexFresh: boolean;
  usesFts: boolean;
  queryMs: number;
  rowsReturned: number;
  scannedLines?: number;
  fallbackReason?: string;
  statsMode: 'none' | 'cached' | 'exact' | 'partial';
}
```

新增内部指标：

1. index queue length。
2. index flush duration。
3. index write errors。
4. backfill progress。
5. tail subscriber count。
6. tail dropped/resync count。
7. query latency by mode。
8. JSONL fallback count。

这些指标可以先打 debug 日志，后续再暴露 API。

### 13.14 迁移与发布策略

推荐 feature flag 式发布：

1. 第一版默认启用索引，但出错自动回退。
2. 配置允许关闭 `log.index.enabled`。
3. 启动时异步 backfill，不阻塞服务启动。
4. 日志页面显示索引状态。
5. 查询响应显示是否使用索引。

发布顺序：

1. 先上线前端刷新止痛，不依赖后端索引。
2. 上线 keyset cursor 和 stats 拆分。
3. 上线 SQLite 写入新日志索引。
4. 上线 backfill。
5. 切默认查询到 SQLite。
6. 上线 tail pub/sub。
7. 上线 FTS 和 facets。

回滚策略：

1. 关闭 `log.index.enabled` 回到 JSONL 查询。
2. 删除 `indexes/log-index.sqlite` 后可自动重建。
3. SQLite schema 升级失败时保留旧 db 文件并回退 JSONL。

### 13.15 代码组织建议

建议模块职责：

```text
src/log-query.ts              # 兼容旧 JSONL 查询与详情兜底
src/log-index.ts              # SQLite 生命周期与主入口
src/log-index-schema.ts       # schema、migration、PRAGMA
src/log-index-query.ts        # 参数归一化、SQL 构建、cursor
src/log-index-writer.ts       # 写入队列、批量事务
src/log-index-backfill.ts     # 回填、修复、状态
src/log-tail.ts               # SSE 订阅、pub/sub、过滤推送
src/log-facets.ts             # facets 查询与缓存
src/log-stats.ts              # 列表统计查询与缓存
```

前端：

```text
web/src/stores/logs-store.ts
web/src/stores/log-facets-store.ts
web/src/components/logs/logs-data-table.tsx
web/src/components/logs/new-log-indicator.tsx
```

设计原则：

1. route handler 只做 HTTP 参数解析和响应，不承载查询细节。
2. 查询构建、索引写入、tail 推送分模块管理。
3. 前端 store 管理数据状态，组件只负责展示。
4. 公共类型尽量从 API 类型集中导出，避免前后端漂移。

### 13.16 代码评审检查清单

每个实现 PR 必须检查：

1. 是否仍存在 offset cursor。
2. 是否有未参数化 SQL。
3. 是否有无界数组、Map、队列或缓存。
4. 是否有列表接口为了 stats 扫完整 JSONL。
5. 是否有请求主链路同步等待重型索引操作。
6. 是否有 tail 空闲时扫描历史日志。
7. 是否有失败后无法回退的索引路径。
8. 是否有前端慢请求覆盖新请求。
9. 是否有刷新时清空旧列表。
10. 是否有测试覆盖 cursor、回填、FTS、索引失败和 tail 清理。

## 14. 结论

短期先做 P0，能明显改善“刷新痛苦”的体感。

真正解决“每次查询读大量行”的关键是 P2：新增 SQLite 索引和 FTS，让列表、过滤、关键词搜索从文件扫描变成索引查询。JSONL 继续保留为原始日志和审计来源，索引可随时重建。

最终查询路径应变成：

```text
日志列表页面
  -> /api/logs/events
  -> SQLite 普通索引或 FTS
  -> 返回 limit + 1 条
  -> keyset cursor 翻页

日志详情页面
  -> SQLite 查 file offset
  -> JSONL 单行读取
  -> 返回完整事件

实时追踪
  -> logger pub/sub 或文件新增字节读取
  -> SSE 推送新增 summary
```

这样才能在日志持续增长后，仍保持优秀的日志列表查看体验。
