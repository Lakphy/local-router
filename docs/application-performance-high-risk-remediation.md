# High 风险内存问题修复技术方案（聚焦可落地改造）

## 1. 目标与边界

- 目标：仅针对当前已识别的 **High 风险** 内存问题给出可实施修复指导。
- 范围：
  - 后端：`src/**`
  - **例外（按你的补充要求）**：加密会话“一次一用即销毁”需要前后端协同，包含 `web/src/lib/api.ts`。
- 约束：本方案基于静态代码阅读，不包含运行时实测结论。

---

## 2. High 风险清单（与源码证据）

### H1. 加密会话容器无边界，存在持续累积风险

- 后端会话池：`src/index.ts:127` `cryptoSessions = new Map<string, CryptoSession>()`
- 握手持续写入：`src/index.ts:145` `cryptoSessions.set(sessionId, session)`
- 当前读取方式仅按 header 取会话：`src/index.ts:149-153`
- 前端当前是“长会话复用”模型：
  - 全局缓存：`web/src/lib/api.ts:4-7`
  - 握手缓存：`web/src/lib/api.ts:27-41`
  - config GET/PUT 都复用同一个 `sessionId`：`web/src/lib/api.ts:50-92`

### H2. SSE tail 每连接定时轮询 + 关闭路径未完整解绑

- SSE 入口：`src/index.ts:471`
- 每连接 `setInterval`：`src/index.ts:518`
- 关闭时只 `clearInterval + controller.close`：`src/index.ts:564-568`
- 注册了 abort listener 但未显式移除：`src/index.ts:571`

### H3. 日志查询“全量扫描→全量物化→排序→分页”

- 全量容器：`src/log-query.ts:568` `const items: LocatedLogEvent[] = []`
- 持续 push：`src/log-query.ts:641`
- 全量排序：`src/log-query.ts:788`
- 分页发生在末端：`src/log-query.ts:797` `slice(...)`
- 统计再次持有全量 latency：`src/log-query.ts:689,694,700`

### H4. 导出路径再次全量序列化

- 导出先走 `queryLogEvents(...limit: MAX_EXPORT_ROWS)`：`src/log-query.ts:926-930`
- CSV 全量拼接：`src/log-query.ts:858,937`
- JSON 全量 stringify：`src/log-query.ts:946`

### H5. 代理链路大字符串多副本

- 流式响应累加大字符串：`src/proxy.ts:163,170,172`
- 非流式全量 `text()`：`src/proxy.ts:199`
- 日志与响应复用同一大文本：`src/proxy.ts:214,219`
- 路由层请求体 parse/stringify 往返：`src/routes/common.ts:46,53,71`

---

## 3. 修复原则（确保“不影响正常转发”）

1. **转发主路径语义不变**：上游请求头、认证、响应状态码、响应体透传行为不变。
2. **内存治理优先做“生命周期收口”**，避免先改协议语义。
3. **日志能力可降级，不可阻断转发**：日志处理失败时仅记录错误，不影响代理返回。
4. **控制改造爆炸半径**：先高风险止血，再做性能增强。

---

## 4. High 修复设计（按优先顺序）

## P0-1：加密会话“一次一用即销毁”（前后端协同）

> 目标：把 `cryptoSessions` 从“长期缓存容器”改为“短生命周期一次性会话”。

### 现状问题

- 后端 Map 无 TTL / 无上限，理论上可持续增长。
- 前端长期缓存 `cryptoClient + sessionId`，使服务端会话长期存活。

### 目标行为

- 每次配置操作（GET `/api/config` 或 PUT `/api/config`）使用一次独立会话。
- 服务端在成功完成该次加解密后，立即销毁该会话（Map delete + 会话资源清理）。

### 后端改造要点（`src/index.ts`, `src/crypto.ts`）

1. `CryptoSession` 增加显式销毁能力（如 `dispose()`），将内部敏感引用置空。
2. 会话访问改为“取出即消费”语义：
   - 成功完成 `/api/config` 或 `/api/config` PUT 后立即 `cryptoSessions.delete(sessionId)`。
   - 同时调用 `session.dispose()`。
3. 增加兜底清理：
   - 握手会话创建时间戳；
   - 短 TTL（例如 1~3 分钟）后台清扫过期未使用会话（防止握手后未消费）。
4. 增加硬上限（max sessions），超限时拒绝新握手并返回可识别错误（避免异常洪峰撑爆内存）。

### 前端改造要点（`web/src/lib/api.ts`）

1. 去掉全局长会话缓存模型（`cryptoClient/sessionId/handshakePromise` 的跨请求复用）。
2. 改为“单次操作内握手”：
   - `fetchConfig()`：本次调用内 `handshake -> decrypt -> 结束`。
   - `saveConfig()`：本次调用内 `handshake -> encrypt -> PUT -> 结束`。
3. 失败重试保持一次：仅对 401 做“重新握手再试一次”，避免无限递归。

### 不影响转发的保证

- 该改造仅触及管理面 `/api/config*` + `/api/crypto/handshake`，不进入模型代理主路径（`/v1/**` 等）。
- 正常转发链路不依赖 crypto session，不改变 upstream 请求/响应行为。

---

## P0-2：SSE tail 生命周期彻底收口

### 后端改造要点（`src/index.ts`）

1. `close` 中显式 `removeEventListener('abort', close)`，避免 listener 残留。
2. 在 `cancel()` 中复用同一关闭逻辑，确保 timer 与 listener 都被清理。
3. 维护轻量连接注册表（仅句柄，不存大对象），用于统一释放与可观测。
4. 给每连接查询执行增加中断感知，连接关闭后停止后续轮询任务。

### 不影响转发的保证

- 改造仅作用 `/api/logs/tail` 管理接口。
- 普通代理请求无行为变更。

---

## P0-3：日志查询改为“有界内存”处理

### 后端改造要点（`src/log-query.ts`）

1. 从“全量 items”改为“有界窗口”：
   - 针对分页查询，仅保留当前页所需候选集合（按 sort + cursor 规则）。
   - 不再保留全量匹配结果。
2. 统计改为在线聚合：
   - `count/sum/errorCount` 使用流式累加；
   - 分位数使用有界算法（如 fixed-size reservoir / t-digest），避免全量 `latencies[]`。
3. 查询结束显式释放临时引用：
   - 将大数组/临时对象尽早脱离作用域；
   - 避免在闭包中捕获整个结果集。
4. 为 tail 查询设置更严格 limit 与扫描上限，避免“长连接 × 大窗口”叠加。

### 不影响转发的保证

- 仅改日志查询模块，不改代理转发协议与业务路由决策。

---

## P0-4：导出改为流式写出（禁止一次性大字符串）

### 后端改造要点（`src/log-query.ts`, `src/index.ts`）

1. CSV：逐行写入 `ReadableStream`，不构建 `lines[]` 和最终 `join('\n')`。
2. JSON：采用流式 JSON 输出（分块写 header / item / footer），不一次性 `JSON.stringify(whole)`。
3. 导出上限与超时保护：
   - 保持导出行数上限；
   - 达到阈值即截断并在响应头返回截断标记。

### 不影响转发的保证

- 仅影响 `/api/logs/export`，对代理主链路零侵入。

---

## P1：代理链路字符串副本削减（保持语义不变）

### 后端改造要点（`src/proxy.ts`, `src/routes/common.ts`）

1. **流式日志**：去掉 `streamContent +=`，改为“边读边写文件”，只累计计数信息（bytes/chunks）。
2. **非流式响应**：
   - 在需要记录 body 时按策略截断/采样，不保留整段文本多份引用；
   - 响应返回优先复用流/字节缓冲，不重复构造大字符串。
3. **请求体处理**：避免 `raw.text -> parse -> stringify` 三段并存时间过长；尽可能缩短中间对象生命周期。

### 不影响转发的保证

- 保持请求改写语义（仅 model 字段替换）不变；
- 保持响应状态码、头、体对客户端可观察行为不变。

---

## 5. 分阶段实施顺序（建议）

1. **阶段 A（立即）**：P0-1 + P0-2（会话与连接生命周期止血）。
2. **阶段 B（紧随）**：P0-3 + P0-4（查询/导出内存峰值控制）。
3. **阶段 C（随后）**：P1（代理链路副本削减）。

这样可以先解决“持续增长”，再解决“瞬时峰值”。

---

## 6. 回归与验证要点（运行时执行，非本次静态结论）

1. **功能回归**
   - 配置页：读取、保存、应用流程完整可用。
   - 代理：常规与流式请求均可正常转发。

2. **内存观察**
   - `cryptoSessions` size 长时间应接近 0~小范围波动。
   - SSE 连接断开后，连接数/timer 数应快速回落。
   - 日志查询与导出场景下 RSS 峰值显著低于改造前。

3. **稳定性**
   - 并发打开/关闭 tail、并发导出、长流响应压测下无持续爬升。

---

## 7. 风险与兼容说明

- 一次性会话会增加握手频率，但这是可接受交换：
  - 内存可控性显著提升；
  - 作用域限定在配置管理接口，不影响主转发吞吐。
- 若担心握手开销，可在后续做“短窗口批次会话”（例如 30s）作为折中，但默认建议“一次一用”优先止血。

---

## 8. 本文结论

按照你的补充要求，High 问题的最小闭环修复路径是：

1. **加密会话改为一次一用即销毁（前后端协同）**；
2. **SSE/timer/listener 生命周期彻底清理**；
3. **日志查询与导出改为有界内存与流式输出**；
4. **代理链路减少大字符串多副本，但不改变转发语义**。

该路径优先解决“长期运行后内存上冲”的主因，并把对正常转发链路的影响控制在最小范围内。
