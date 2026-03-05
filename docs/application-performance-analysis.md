# 应用内存性能静态分析与优化方案（后端范围）

## 1. 背景与分析边界

### 1.1 背景
用户反馈应用运行一段时间后内存可升至 500MB+（预期约 50MB），怀疑存在内存泄漏或显著内存峰值问题。

### 1.2 分析边界（严格遵循）
- 本报告**仅基于静态代码检索/阅读**。
- **未执行代码、未运行测试、未做运行时采样**（Heap Snapshot / 火焰图 / pprof 均未做）。
- **本次优化范围仅后端**（`src/**`）。
- 前端为静态资源交付，不纳入本次改造范围。
- 结论分为：
  - **静态高置信风险**：可由源码直接证明存在“潜在高内存占用机制”。
  - **运行时待验证项**：需上线前后通过监控或压测验证收益。

---

## 2. 总体结论与优先级（后端）

### 2.1 总体结论
当前后端内存风险主要来自三类叠加：
1. **长生命周期容器/任务未设容量边界或清理策略**。
2. **日志查询与导出采用“先全量扫描+全量物化再分页/导出”**。
3. **代理链路存在大字符串多副本**（parse/stringify 往返、全量 `text()`、流式累加字符串）。

### 2.2 优先级
- **P0（止血）**：无界增长 + 全量物化。
- **P1（核心链路）**：降低请求/响应链路字符串复制与拼接。
- **P2（长期治理）**：后端内存预算与评审红线。

---

## 3. 关键风险证据（文件 + 行号）

> 说明：以下均为后端源码可定位证据。

### 3.1 High

1. **加密会话容器无上限、无 TTL**
   - `src/index.ts:126` 定义 `cryptoSessions = new Map<string, CryptoSession>()`
   - `src/index.ts:144` 持续 `set(sessionId, session)`
   - 未看到对应删除/过期清理逻辑。
   - 影响：长时运行下会话对象累积，形成常驻内存增长。

2. **SSE tail 每连接一个定时轮询；关闭路径未完整解绑 listener**
   - `src/index.ts:470` `/logs/tail` SSE 入口
   - `src/index.ts:517` 每连接创建 `setInterval(..., 3000)`
   - `src/index.ts:570` `target.signal.addEventListener('abort', close)`
   - `src/index.ts:563-567` 仅清 interval + close stream，未显式移除 listener。
   - 影响：高并发/频繁连接重建时，连接对象、闭包与监听关系可能延长存活时间。

3. **日志查询全量物化：scan 后将命中项全部 push 到数组，再排序、再分页**
   - `src/log-query.ts:567` `const items: LocatedLogEvent[] = []`
   - `src/log-query.ts:640` `items.push(...)`
   - `src/log-query.ts:787` 全量排序
   - `src/log-query.ts:796` 再分页 `slice`
   - 影响：结果集越大，内存峰值越高；分页未降低前置内存开销。

4. **统计计算二次物化与排序**
   - `src/log-query.ts:688` `const latencies: number[] = []`
   - `src/log-query.ts:693` `latencies.push(latency)`
   - `src/log-query.ts:699` `latencies.sort(...)`
   - 影响：大样本下额外持有一份数值数组并排序，放大峰值。

5. **导出路径再次触发大体量序列化**
   - `src/log-query.ts:925-929` 导出调用 `queryLogEvents(... limit: MAX_EXPORT_ROWS)`
   - `src/log-query.ts:936` CSV 路径 `toCsv(data.items)`（全量拼接字符串）
   - `src/log-query.ts:945-953` JSON 路径 `JSON.stringify({...}, null, 2)`
   - 影响：导出阶段形成大字符串对象，峰值显著增加。

6. **代理流式日志将所有 chunk 累加为单字符串**
   - `src/proxy.ts:162` `let streamContent = ''`
   - `src/proxy.ts:169` `streamContent += decoder.decode(value, { stream: true })`
   - `src/proxy.ts:173` 再整体写文件
   - 影响：长流响应导致字符串反复扩容与复制，内存占用和 GC 压力高。

7. **代理非流式全量 `text()` 读取并再次构造响应**
   - `src/proxy.ts:198` `const responseText = await upstreamRes.text()`
   - `src/proxy.ts:213` `eventOverrides.response_body = responseText`
   - `src/proxy.ts:218` `return new Response(responseText, ...)`
   - 影响：响应文本在链路中产生多份引用/副本，放大峰值。

8. **路由层请求体 parse/stringify 往返形成多副本**
   - `src/routes/common.ts:45` `raw.text()` 读取完整 body
   - `src/routes/common.ts:52` `JSON.parse(rawText)`
   - `src/routes/common.ts:70` `JSON.stringify(payload)`
   - 影响：`rawText` + 解析对象 + 重新序列化字符串并存，放大请求峰值。

### 3.2 Medium

1. **日志指标缓存容器无容量控制，仅 TTL 驱动**
   - `src/log-metrics.ts:88` `metricsCache = new Map<string, CacheEntry>()`
   - `src/log-metrics.ts:206` key = `${baseDir}:${window}`
   - `src/log-metrics.ts:429` 直接 `set`，未见容量上限/主动清扫。
   - 影响：多 baseDir/多窗口场景会累积缓存项。

2. **日志指标扫描保留 latency 全量数组**
   - `src/log-metrics.ts:244` `const latencies: number[] = []`
   - `src/log-metrics.ts:317` `latencies.push(latency)`
   - `src/log-metrics.ts:372` `latencies.sort(...)`
   - 影响：统计阶段峰值上升（虽有 `MAX_LINES_SCANNED` 上限，但仍可较高）。

3. **日志存储后台任务为全局 `setInterval`，缺少 stop/cleanup 生命周期**
   - `src/log-storage.ts:148` `startLogStorageBackgroundTask(...)`
   - `src/log-storage.ts:157` `setInterval(...)`
   - 无返回句柄与清理函数。
   - 影响：在应用重建/热更新等场景可能造成重复定时任务常驻。

### 3.3 Low

1. **日志存储缓存单实例体量小，风险较低**
   - `src/log-storage.ts:19` `cachedStorage` 单对象
   - 该项本身非主要内存源，更偏生命周期治理问题。

---

## 4. 根因分类（后端机制视角）

### A. 无界增长
- `cryptoSessions` 无上限/TTL（`src/index.ts:126,144`）
- `metricsCache` 无容量控制（`src/log-metrics.ts:88,429`）

### B. 全量物化
- 查询先全量 `items.push` 再排序/分页（`src/log-query.ts:567,640,787,796`）
- 导出阶段全量字符串序列化（`src/log-query.ts:936,945-953`）
- 统计持有全量 `latencies`（`src/log-query.ts:688,699`；`src/log-metrics.ts:244,372`）

### C. 生命周期清理缺失
- 后台任务 `setInterval` 无 stop（`src/log-storage.ts:157`）
- SSE listener 未见显式解绑（`src/index.ts:570`）

### D. 高频大字符串分配
- `raw.text -> JSON.parse -> JSON.stringify`（`src/routes/common.ts:45,52,70`）
- 非流式 `upstreamRes.text()` + response body 复用（`src/proxy.ts:198,213,218`）
- 流式 `streamContent +=` 累加（`src/proxy.ts:162,169`）

---

## 5. 代码行为 -> 内存影响机制 -> 风险等级 -> 建议改法（后端映射表）

| 代码行为（证据） | 内存影响机制 | 风险 | 建议改法（落点） |
|---|---|---|---|
| `cryptoSessions.set(...)` 持续写入（`src/index.ts:126,144`） | 长生命周期 Map 无界增长 | High | 引入 TTL + size 上限 + LRU/定期清理（`src/index.ts`） |
| `/logs/tail` 每连接 `setInterval`（`src/index.ts:517`） | 连接闭包/定时器对象常驻，清理不完整时累积 | High | 统一连接注册表，abort 时移除 listener/清理句柄（`src/index.ts`） |
| `scanEvents` 全量 `items.push`（`src/log-query.ts:567,640`） | 命中结果全量驻留内存 | High | 改为流式/增量筛选，优先 top-k 或游标前推，不保留全量（`src/log-query.ts`） |
| 全量排序后再分页（`src/log-query.ts:787,796`） | 排序需要持有全量数组 | High | 改为按文件时间序增量合并，按页提前截断（`src/log-query.ts`） |
| 导出 `toCsv` / `JSON.stringify`（`src/log-query.ts:936,945`） | 构造大字符串峰值 | High | 改为分块流式导出（chunked/stream writer）（`src/log-query.ts`,`src/index.ts`） |
| 流式日志 `streamContent +=`（`src/proxy.ts:162,169`） | 字符串反复扩容复制 | High | 边读边写文件（Writer），避免聚合成单字符串（`src/proxy.ts`） |
| 非流式 `await text()`（`src/proxy.ts:198`） | 大响应一次性物化 | High | 尽量基于流转发；日志按策略截断或采样（`src/proxy.ts`） |
| 请求体 parse/stringify 往返（`src/routes/common.ts:45,52,70`） | 同一请求体多副本并存 | High | 缩短中间对象生命周期，避免不必要的完整重序列化（`src/routes/common.ts`） |
| `metricsCache` 仅 TTL（`src/log-metrics.ts:88,429`） | cache key 增长后占用累积 | Medium | 增加 max entries + eviction（`src/log-metrics.ts`） |
| 后台 `setInterval` 无 stop（`src/log-storage.ts:157`） | 生命周期难收口 | Medium | 返回 stop 函数并在 app 生命周期调用（`src/log-storage.ts`,`src/index.ts`） |

---

## 6. 分阶段优化路线图（仅后端）

## P0（止血，优先）
目标：立即抑制“无界增长 + 全量物化”导致的内存上冲。

1. **长生命周期容器加边界**
   - `cryptoSessions`：TTL（如 10~30min）+ max size（如 1k）+ 淘汰策略。
   - `metricsCache`：max entries（如 16/32）+ TTL 双控。

2. **后台任务与 SSE 生命周期可清理**
   - `startLogStorageBackgroundTask` 返回 stop handle。
   - `/logs/tail` 为每连接维护可释放资源，abort 时显式解绑 listener 与 timer。

3. **避免日志查询/导出全量物化**
   - 查询：从“全量扫描后分页”改为“边扫描边构建当前页与必要统计”。
   - 导出：改为分块写出（CSV/JSON stream），避免一次性大字符串。

## P1（核心链路）
目标：降低代理链路大对象复制与字符串峰值。

1. **请求路径减副本**
   - 优化 `raw.text -> parse -> stringify` 往返，控制对象生命周期与拷贝次数。

2. **响应路径减副本**
   - 非流式：降低 `text()` 全量物化频率，日志体采用截断或策略化落盘。
   - 流式：取消 `streamContent +=`，改为 chunk 直接落盘。

3. **关键词过滤路径优化**
   - `containsKeyword` 避免每条构建大 `haystack` 字符串（按字段短路匹配）。

## P2（长期治理）
目标：建立后端容量治理与防回归机制。

1. **内存预算与评审红线**
   - 建立模块预算：查询、导出、代理、后台任务。
   - Code Review 红线：禁止无上限容器、禁止全量物化导出、禁止热路径大字符串拼接。

2. **运行时观测（后续验证）**
   - 增加 heap/rss 指标与关键容器 size 指标暴露，做版本对比。

3. **压测场景基线（后续）**
   - 大窗口日志查询、最大导出、长流式响应并发场景，作为回归基线。

---

## 7. 静态验收清单（仅代码阅读可确认）

- [ ] 报告中每个 High 风险点均可定位到具体源码（`文件:行号`）。
- [ ] 每条优化建议都映射到具体后端修改落点（文件级）。
- [ ] 报告明确声明“未执行代码/测试，仅静态分析”。
- [ ] 报告明确声明“仅后端范围，前端不纳入改造”。
- [ ] 报告未出现“已验证提升/已证明下降 xx%”等运行时结论性措辞。
- [ ] 报告内容仅聚焦内存/性能范围，不扩展无关重构。

---

## 8. 运行时待验证事项（非本次执行）

1. P0 后验证：
   - 长时间运行 RSS/heap 是否趋稳；
   - `cryptoSessions`、SSE 活跃连接数、cache entry 数是否受控。

2. P1 后验证：
   - 大响应与长流场景下峰值内存与 GC pause 是否下降。

3. P2 后验证：
   - 新增代码是否持续满足“容量边界 + 生命周期清理”红线。

---

## 9. 结论（执行建议）

从静态证据看，最可能导致“运行一段时间后升至 500MB+”的后端主因是：
- **无界容器（会话/缓存）** +
- **查询/导出全量物化** +
- **代理链路高频大字符串分配**。

建议按 P0 -> P1 -> P2 推进；其中 P0 优先级最高，可最快降低持续增长与峰值风险。
