# local-router 日志系统完整技术方案

本文档给出一个可直接落地的日志方案，用于记录 local-router 转发的所有 AI 请求与响应，覆盖：

- 非流式请求：完整请求体 + 完整响应体（可配置脱敏）
- 流式请求（SSE）：完整原始流字符串（逐 chunk 原样落盘）
- 可检索、可轮转、可清理、可演进

---

## 1. 目标与约束

### 1.1 目标

1. 记录每一次转发请求的全链路信息（发送与接收）。
2. 支持流式和非流式，且流式可回放原始文本。
3. 不影响主链路稳定性（日志失败不影响请求转发）。
4. 便于后续检索和统计（按时间、模型、provider、状态码等）。

### 1.2 非目标

1. 暂不做复杂可视化后台。
2. 暂不接入远程日志平台（如 ELK/Loki/ClickHouse）。

### 1.3 当前项目事实

当前所有协议都汇聚到 `src/proxy.ts` 的 `proxyRequest`，这是最合适的统一日志切点。  
模型路由与重写发生在 `src/routes/common.ts`，适合补充“路由决策元数据”。  
`src/config.ts` 已支持用户目录配置：默认全局配置位于 `~/.local-router/config.json5`（若本地无 `config.json5` 且未传 `--config`）。

### 1.4 日志目录定位规则（更新）

日志目录默认固定在用户目录 `~/.local-router/logs/`，可通过配置覆盖：

1. 若 `log.baseDir` 已显式配置，使用该绝对路径。
2. 若未配置 `log.baseDir`，默认 `~/.local-router/logs/`。

无论配置文件在哪（项目目录或全局目录），日志始终落在统一位置，便于查找和管理。

---

## 2. 存储方案结论（先给结论）

推荐采用 **纯文件系统分层存储**，且根目录放在“配置文件目录”下：

1. **事件主日志（JSONL 文件）**
   - 每日一个文件：`<log.baseDir>/events/YYYY-MM-DD.jsonl`
   - 一次请求写一条结构化事件（元数据 + 非流式响应摘要/全文）
2. **流式原文文件（raw 文件）**
   - 每个流式请求一个文件：`<log.baseDir>/streams/YYYY-MM-DD/<request_id>.sse.raw`
   - 保存完整原始 SSE 文本（按 chunk 追加）
> 结论：是基于文件系统，但不是“单文件”；应采用“按天分片 + 按请求分文件”的结构，避免检索和写入瓶颈。

---

## 3. 你关心的问题：单文件会不会慢？

会。单文件在聊天量变大后会出现以下问题：

1. 文件体积增长快，全文扫描慢。
2. 并发写入与轮转困难，恢复不便。
3. 任一文件损坏影响范围大。
4. 备份、归档、删除粒度太粗。

所以不建议“只存一个文件”。正确做法是：

1. **按天分片**：降低单文件大小，便于检索与归档。
2. **流式一请求一文件**：避免把超长流内容塞进同一个 events 文件。
3. **分片检索**：先按日期过滤日志文件，再按字段扫描，必要时配合每日清单文件。

---

## 4. 目录结构设计

```text
<config_dir>/
  config.json5
  logs/
    events/
      2026-02-28.jsonl
      2026-03-01.jsonl
    streams/
      2026-02-28/
        req_01H....sse.raw
        req_01J....sse.raw
    state/
      write-queue.meta    # 可选：用于诊断写入积压
    manifests/
      2026-02-28.summary.json   # 可选：当日聚合统计，提升检索速度
```

默认全局示例：

```text
~/.local-router/
  config.json5
  logs/
    events/...
    streams/...
```

---

## 5. 数据模型设计

### 5.1 事件日志（JSONL）字段建议

每行一个 JSON 对象：

- **默认记录（低成本，建议直接上线）**
  - `request_id`: string，全局唯一
  - `ts_start`: string，ISO 时间
  - `ts_end`: string，ISO 时间
  - `latency_ms`: number
  - `method`: string（如 `POST`）
  - `path`: string，本地入口路径
  - `route_type`: `"openai-completions" | "openai-responses" | "anthropic-messages"`
  - `route_rule_key`: string，命中的路由规则 key（如 `gpt-4o` 或 `*`）
  - `provider`: string，命中的 provider
  - `model_in`: string，客户端传入模型
  - `model_out`: string，转发到上游模型
  - `target_url`: string，最终上游地址（脱敏，不含密钥）
  - `is_stream`: boolean
  - `upstream_status`: number
  - `content_type_req`: string|null
  - `content_type_res`: string|null
  - `user_agent`: string|null
  - `request_headers_masked`: object（已脱敏）
  - `response_headers`: object（建议裁剪非关键头）
  - `request_bytes`: number|null
  - `response_bytes`: number|null（非流式）
  - `stream_bytes`: number|null（流式）
  - `provider_request_id`: string|null（从上游响应头提取，header 名可配置）
  - `error_type`: string|null
  - `error_message`: string|null

- **可配置记录（中等成本，按需开启）**
  - `request_body`: object|string|null（受 `bodyPolicy` 控制）
  - `response_body`: string|null（仅非流式或被截断）
  - `stream_file`: string|null（仅流式）

- **后置记录（复杂，建议后续迭代）**
  - `retry_count`
  - `timeout_ms` / `did_timeout`（若实现超时控制）
  - `queue_wait_ms`（若实现异步落盘队列）
  - `prompt_tokens` / `completion_tokens` / `total_tokens`
  - `cost_estimate`

### 5.2 可选清单文件（无数据库）

为了保持纯文件系统并提升检索体验，可选新增“每日清单文件”：

- 文件：`<log.baseDir>/manifests/YYYY-MM-DD.summary.json`
- 内容：当日计数聚合（按 `route_type`、`provider`、`model_out`、`status`）
- 用途：先用清单定位“问题时间段/模型”，再扫描对应 JSONL 文件

---

## 6. 写入链路设计

### 6.1 请求进入（`common.ts`）

1. 生成 `request_id`（例如 `crypto.randomUUID()`）。
2. 记录 `ts_start`。
3. 在模型路由完成后产出路由元数据：
   - `route_type`
   - `route_rule_key`
   - `provider`
   - `model_in` / `model_out`
4. 将上述元数据传给 `proxyRequest`（扩展参数）。

### 6.2 代理转发（`proxy.ts`）

1. 发起上游请求前记录发送信息。
2. 收到上游响应后分支：
   - **非流式**：读取完整响应文本，写 event，然后将文本重新构造 Response 返回客户端。
   - **流式**：`ReadableStream.tee()` 一分为二：
     - 分支 A：原样回客户端。
     - 分支 B：按 chunk 逐段写入 `stream_file`，结束后写 event（包含 `stream_file`、`stream_bytes`）。
3. 任意日志失败仅记录内部告警，不中断转发流程。

补充：默认同时采集以下低成本元数据（无需显著改变现有链路）：

1. `method`、`path`、`target_url`
2. `content_type_req`、`content_type_res`、`user_agent`
3. `request_bytes`、`response_bytes` / `stream_bytes`
4. `provider_request_id`（从响应头提取）

### 6.3 写入模型

采用“内存队列 + 单 worker 顺序落盘”：

1. 主请求线程仅 enqueue 日志任务。
2. worker 负责 append 文件，减少并发竞争。
3. 队列上限可配置，超限时降级（只保留关键元数据）。

---

## 7. 性能与检索策略

### 7.1 检索路径

1. 轻量阶段：`rg`/脚本扫描 `<log.baseDir>/events/YYYY-MM-DD.jsonl`。
2. 增长阶段：按日期分片 + 清单文件缩小范围，再回读 `stream_file`。

### 7.2 为什么检索不会因“文件系统”必然变慢

关键在于“分片 + 清单”，不是“单文件”的模式：

1. 按天分片让扫描范围可控。
2. 流式正文单独文件，避免污染事件日志。
3. 高频过滤条件先用每日清单粗筛，再扫描命中分片。

### 7.3 建议阈值（经验值）

1. 单日日志 > 200MB：建议启用“小时级分片”或拆分为多段 events 文件。
2. 单请求流内容 > 10MB：截断并标记 `truncated=true`（可配置）。
3. 日志目录 > 20GB：触发归档/压缩策略。

---

## 8. 安全与合规

1. 默认脱敏：
   - `authorization`、`x-api-key`、`cookie` 全部掩码。
2. 请求体记录策略：
   - `off`：不记录 body
   - `masked`：字段级脱敏后记录（推荐默认）
   - `full`：仅调试场景临时开启
3. 支持配置“敏感字段名单”：
   - `password`, `token`, `secret`, `api_key`, `authorization` 等
4. 支持 TTL 清理（如 7/14/30 天）。

---

## 9. 配置项设计（建议扩展 `config.json5`）

```json5
{
  log: {
    enabled: true,
    // 推荐不手填：默认自动解析到 config.json5 同目录下的 logs/
    // 例如默认全局配置时为 ~/.local-router/logs
    // baseDir: "/absolute/path/to/logs",
    events: {
      rotate: "daily",           // daily | hourly
      maxFileSizeMB: 200,        // 可选，触发额外滚动
      retainDays: 14
    },
    streams: {
      enabled: true,
      retainDays: 7,
      maxBytesPerRequest: 10485760
    },
    bodyPolicy: "masked",        // off | masked | full
    manifest: {
      enabled: true,             // 纯文件系统下推荐开启
      flushIntervalSec: 60       // 每分钟刷新一次当日清单
    },
    queue: {
      maxItems: 5000
    }
  }
}
```

---

## 10. 分阶段实施计划

### Phase 1（立刻可做，低风险）

1. 新增 `src/logger.ts`：
   - JSONL append
   - stream raw append
   - 基础脱敏
2. `src/routes/common.ts` 增加 `request_id` 与路由元数据组装（含 `route_rule_key`）。
3. `src/proxy.ts` 增加流式 `tee` 记录与非流式完整响应记录。
4. 默认写入低成本字段：
   - `method`、`path`、`route_type`、`route_rule_key`
   - `provider`、`model_in`、`model_out`、`target_url`
   - `is_stream`、`upstream_status`
   - `content_type_req`、`content_type_res`、`user_agent`
   - `request_bytes`、`response_bytes` / `stream_bytes`
   - `provider_request_id`、`error_type`、`error_message`
4. 新增集成测试：
   - 非流式写 event 成功
   - 流式写 raw 文件成功且包含 `data:` / `event:`

> 注：这里测试编号沿用原文，实施时可调整为连续编号。

### Phase 2（数据量上来后）

1. 增加日志查询脚本（按时间、模型、状态筛选）。
2. 增加每日清单写入（聚合统计）与小时级分片能力。
3. 按需启用中等成本字段：`request_body`、`response_body`、`stream_file`。

### Phase 3（长期）

1. 增加压缩与归档（如按日 gzip）。
2. 引入超时控制、队列监控字段、重试统计。
3. 可选接入远程日志系统。

---

## 13. 字段实现复杂度分级（更新）

### 13.1 低成本（本次纳入默认）

1. 请求标识与时间：`request_id`、`ts_start`、`ts_end`、`latency_ms`
2. 路由决策：`route_type`、`route_rule_key`、`provider`、`model_in`、`model_out`
3. 传输元数据：`method`、`path`、`target_url`、`is_stream`、`upstream_status`
4. 头信息与体积：`content_type_req`、`content_type_res`、`user_agent`、`request_bytes`、`response_bytes`、`stream_bytes`
5. 诊断信息：`provider_request_id`、`error_type`、`error_message`

### 13.2 中等成本（二期按需）

1. `request_body`（脱敏后）
2. `response_body`（非流式、截断策略）
3. `stream_file`（流式原文文件）

### 13.3 复杂（明确后置）

1. `retry_count`（需先实现稳定重试策略）
2. `timeout_ms` / `did_timeout`（需引入 abort 控制与错误分类）
3. `queue_wait_ms`（需引入异步落盘队列监控）
4. token 统计与 `cost_estimate`（provider 差异 + 价格表维护）

---

## 11. 运维建议

1. 日志目录放在独立磁盘或至少独立分区配额可控。
2. 对 `<config_dir>/logs/` 做定期备份与清理任务。
3. 监控指标建议：
   - `log_queue_size`
   - `log_write_fail_count`
   - `stream_truncated_count`
   - `log_disk_usage_bytes`

---

## 12. 最终推荐

对 local-router 当前规模，建议从以下组合起步：

1. **文件系统为主**：日志落在配置目录下，`events` 按天 JSONL + `streams` 按请求 raw 文件。
2. **不是单文件**：必须分片存储。
3. **保持纯文件系统**：数据量上来后优先用小时分片 + 每日清单提升检索效率。

这样既能满足你“完整记录流式原始字符串”的需求，又能避免未来聊天量增长后检索性能退化。

