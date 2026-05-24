# Token 指标提取与索引化方案

日期：2026-05-23

## 1. 目标

为日志系统增加一个通用 token 指标提取能力，让日志详情、日志列表、索引表和后续统计都能复用同一套 token usage 数据。

目标不是估算 token，而是优先使用上游 API 返回的真实 usage 字段：

1. 非流式请求：从 `response_body`、`response_body_before_plugins`、`response_body_after_plugins` 中提取。
2. 流式请求：从 `.sse.raw` 中的最终 usage 事件提取。
3. 索引表：保存常用归一化字段，方便列表展示和统计聚合。
4. 原始字段：保留 provider 原始 usage 对象，避免不同厂商口径被丢失。

## 2. 本地日志发现

抽样目录：`/Users/lakphy/.local-router/logs`

本次只做字段聚合统计，没有记录具体请求内容。

本地日志规模：

1. JSONL event：`11151` 条。
2. 非流式 response body 中发现 usage：`1130` 次。
3. stream raw 文件：`9126` 个。
4. stream raw 中发现 usage 的文件：`8939` 个。

usage 出现路径：

| 路径 | 次数 | 说明 |
| --- | ---: | --- |
| `stream.message.usage` | 8939 | Anthropic Messages 风格，常见于 `message_start` 事件 |
| `stream.usage` | 8855 | Anthropic `message_delta` 或 OpenAI-compatible chunk 顶层 usage |
| `response.usage` | 1130 | 非流式 JSON 响应体 |
| `stream.response.usage` | 6 | OpenAI Responses stream 的 `response.completed.response.usage` |

本地 response body 中出现的 token 字段：

| 字段 | 次数 |
| --- | ---: |
| `input_tokens` | 1117 |
| `output_tokens` | 1117 |
| `cache_read_input_tokens` | 1097 |
| `total_tokens` | 34 |
| `prompt_tokens` | 26 |
| `completion_tokens` | 25 |
| `cache_creation_input_tokens` | 22 |
| `cached_tokens` | 13 |
| `cache_creation.ephemeral_1h_input_tokens` | 8 |
| `cache_creation.ephemeral_5m_input_tokens` | 8 |
| `completion_tokens_details.reasoning_tokens` | 4 |
| `completion_tokens_details.text_tokens` | 4 |
| `prompt_tokens_details.text_tokens` | 4 |
| `credit_usage` | 1 |

本地 stream raw 中出现的 token 字段：

| 字段 | 次数 |
| --- | ---: |
| `output_tokens` | 17795 |
| `input_tokens` | 17794 |
| `cache_read_input_tokens` | 16383 |
| `cache_creation_input_tokens` | 14034 |
| `cached_tokens` | 9460 |
| `prompt_tokens` | 9460 |
| `total_tokens` | 4730 |
| `completion_tokens` | 4729 |
| `cache_creation.ephemeral_5m_input_tokens` | 2853 |
| `cache_creation.ephemeral_1h_input_tokens` | 2470 |
| `credit_usage` | 835 |
| `claude_cache_creation_1_h_tokens` | 70 |
| `claude_cache_creation_5_m_tokens` | 70 |
| `input_tokens_details.cached_tokens` | 1 |
| `output_tokens_details.reasoning_tokens` | 1 |

结论：

1. 只看 `prompt_tokens + completion_tokens` 会漏掉本地大量 Anthropic 风格 `input_tokens / output_tokens / cache_*`。
2. 只看 response body 会漏掉绝大部分流式请求。
3. stream 文件中同一次请求可能出现多次 usage，需要选“最终且最完整”的 usage，而不是简单累加所有 usage。
4. cache read / cache creation 是本地日志的核心指标，必须进入归一化模型和索引。

## 3. 主流 API usage 字段

### 3.1 OpenAI Responses

OpenAI Responses API 的 `usage` 包含：

1. `input_tokens`
2. `input_tokens_details.cached_tokens`
3. `output_tokens`
4. `output_tokens_details.reasoning_tokens`
5. `total_tokens`

流式时最终 `response.completed` 事件里可能带 `response.usage`。

### 3.2 OpenAI Chat Completions / 兼容接口

OpenAI Chat Completions 与大量 OpenAI-compatible 服务常见字段：

1. `prompt_tokens`
2. `completion_tokens`
3. `total_tokens`
4. `prompt_tokens_details.cached_tokens`
5. `prompt_tokens_details.audio_tokens`
6. `completion_tokens_details.reasoning_tokens`
7. `completion_tokens_details.audio_tokens`
8. `completion_tokens_details.accepted_prediction_tokens`
9. `completion_tokens_details.rejected_prediction_tokens`

Mistral、OpenRouter、DeepSeek 等兼容接口通常也复用 `prompt_tokens / completion_tokens / total_tokens`，但会扩展 cache 或 reasoning 字段。

### 3.3 Anthropic Messages

Anthropic Messages API 的 `usage` 常见字段：

1. `input_tokens`
2. `output_tokens`
3. `cache_creation_input_tokens`
4. `cache_read_input_tokens`
5. `cache_creation.ephemeral_5m_input_tokens`
6. `cache_creation.ephemeral_1h_input_tokens`

注意：Anthropic 文档说明，总输入 token 是 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` 的总和。不能只看 `input_tokens`。

### 3.4 Gemini

Gemini `usageMetadata` 常见字段：

1. `promptTokenCount`
2. `candidatesTokenCount`
3. `totalTokenCount`
4. `cachedContentTokenCount`
5. `thoughtsTokenCount`
6. `toolUsePromptTokenCount`

这些字段是 camelCase，需要映射到统一 snake_case 指标。

### 3.5 DeepSeek

DeepSeek Chat Completion 兼容 OpenAI 字段，同时扩展上下文缓存字段：

1. `prompt_tokens`
2. `completion_tokens`
3. `total_tokens`
4. `prompt_cache_hit_tokens`
5. `prompt_cache_miss_tokens`
6. `completion_tokens_details`

其中 `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`。

### 3.6 Mistral

Mistral Chat Completion 主要字段：

1. `prompt_tokens`
2. `completion_tokens`
3. `total_tokens`
4. `prompt_tokens_details.cached_tokens`

### 3.7 OpenRouter

OpenRouter 会返回详细 usage，常见字段：

1. `prompt_tokens`
2. `completion_tokens`
3. `total_tokens`
4. `prompt_tokens_details.cached_tokens`
5. `prompt_tokens_details.cache_write_tokens`
6. `prompt_tokens_details.audio_tokens`
7. `completion_tokens_details.reasoning_tokens`
8. `cost` 或 credit 类字段

流式响应中 usage 通常位于最终 chunk。

### 3.8 Cohere

Cohere 的 Chat API usage 常见于 `usage` 或 `meta`：

1. `billed_units.input_tokens`
2. `billed_units.output_tokens`
3. `tokens.input_tokens`
4. `tokens.output_tokens`

Cohere 同时区分“实际 token”和“计费 token”，需要分别保留。

## 4. 归一化数据模型

建议新增独立工具文件，例如 `src/token-usage.ts`。

核心类型：

```ts
export interface TokenUsageMetrics {
  schemaVersion: 1;
  source:
    | 'response_body'
    | 'response_body_before_plugins'
    | 'response_body_after_plugins'
    | 'stream_file'
    | 'raw_event'
    | 'none';
  providerStyle:
    | 'openai-responses'
    | 'openai-compatible'
    | 'anthropic'
    | 'gemini'
    | 'cohere'
    | 'unknown';

  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;

  cachedInputTokens: number | null;
  cacheHitInputTokens: number | null;
  cacheHitRate: number | null;
  cacheHitRateDenominatorTokens: number | null;
  cacheHitRateFormula: string | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheCreationInputTokens5m: number | null;
  cacheCreationInputTokens1h: number | null;
  cacheWriteInputTokens: number | null;
  cacheMissInputTokens: number | null;

  reasoningTokens: number | null;
  audioInputTokens: number | null;
  audioOutputTokens: number | null;
  textInputTokens: number | null;
  textOutputTokens: number | null;
  acceptedPredictionTokens: number | null;
  rejectedPredictionTokens: number | null;
  toolUsePromptTokens: number | null;

  billableInputTokens: number | null;
  billableOutputTokens: number | null;

  rawUsage: Record<string, unknown> | null;
  rawUsagePath: string | null;
  warnings: string[];
}
```

字段解释：

1. `inputTokens`：统一输入 token，OpenAI-compatible 使用 `prompt_tokens`，OpenAI Responses/Anthropic 使用 `input_tokens`，Gemini 使用 `promptTokenCount`。
2. `outputTokens`：统一输出 token，OpenAI-compatible 使用 `completion_tokens`，OpenAI Responses/Anthropic 使用 `output_tokens`，Gemini 使用 `candidatesTokenCount`。
3. `totalTokens`：优先使用上游 `total_tokens / totalTokenCount`，缺失时再用可确认的 input + output 派生。
4. `cachedInputTokens`：OpenAI/Mistral/OpenRouter/Gemini 风格缓存命中原始字段，例如 `prompt_tokens_details.cached_tokens`、`input_tokens_details.cached_tokens`、`cachedContentTokenCount`。
5. `cacheHitInputTokens`：统一缓存命中 token。OpenAI 系取 `cachedInputTokens`，Anthropic 取 `cacheReadInputTokens`，DeepSeek 取 `prompt_cache_hit_tokens`。
6. `cacheHitRate`：缓存命中率，百分比数值，例如 `98.12` 表示 `98.12%`。
7. `cacheHitRateDenominatorTokens`：缓存命中率分母，便于列表 tooltip 解释口径。
8. `cacheHitRateFormula`：口径说明，例如 `cache_read_input_tokens / effective_input_tokens`。
9. `cacheReadInputTokens`：Anthropic 风格 cache read。
10. `cacheCreationInputTokens`：Anthropic 风格 cache write/create。
11. `cacheWriteInputTokens`：OpenRouter/Mistral 可能出现的 cache write。
12. `cacheMissInputTokens`：DeepSeek `prompt_cache_miss_tokens`。
13. `reasoningTokens`：OpenAI/Gemini/OpenRouter reasoning/thoughts。
14. `billableInputTokens / billableOutputTokens`：Cohere billed_units 或未来计费口径。
15. `rawUsage`：保存完整原始 usage 对象，保证未来字段可回放。

### 4.1 缓存命中率口径

缓存命中率是一级指标，详情页大 metric 卡片和日志列表页都必须展示。

统一公式：

```text
cacheHitRate = cacheHitInputTokens / cacheHitRateDenominatorTokens * 100
```

provider 口径：

1. OpenAI Responses：`input_tokens_details.cached_tokens / input_tokens`。
2. OpenAI Chat Completions / Mistral / OpenRouter：`prompt_tokens_details.cached_tokens / prompt_tokens`。
3. Anthropic：`cache_read_input_tokens / (input_tokens + cache_read_input_tokens + cache_creation_input_tokens)`。
4. DeepSeek：`prompt_cache_hit_tokens / prompt_tokens`，如果 `prompt_tokens` 缺失则用 `prompt_cache_hit_tokens + prompt_cache_miss_tokens`。
5. Gemini：`cachedContentTokenCount / promptTokenCount`。
6. Cohere：没有明确缓存命中字段时返回 `null`。

规则：

1. 分子缺失、分母缺失或分母为 0 时，`cacheHitRate=null`。
2. 不能把缺失显示成 `0%`。
3. 如果命中 token 存在但分母是派生值，`cacheHitRateFormula` 要标注 derived denominator。
4. Anthropic 的 `input_tokens` 不是完整输入分母，必须加上 cache read/create 后再算命中率。

## 5. 提取策略

### 5.1 非流式日志

提取顺序：

1. `response_body_after_plugins`
2. `response_body`
3. `response_body_before_plugins`
4. `rawEvent.token_usage`，用于兼容后续写入的新字段

说明：

1. 列表页默认展示最终用户可见响应对应的 token。
2. 如果插件后响应缺少 usage，但插件前或原始 response body 有 usage，可以回退提取，并在 `source` 中标明。
3. 解析失败时返回空 metrics，不影响日志列表。

### 5.2 流式日志

stream `.sse.raw` 提取顺序：

1. 从后往前扫描 SSE `data:` 行，优先找最终 usage。
2. 优先级：
   1. `response.usage`
   2. 顶层 `usage`
   3. `message.usage`
3. 同一文件出现多次 usage 时，不做累加，选择“字段最完整、位置最靠后”的 usage。
4. 如果文件被截断，只提取已存在 usage，并添加 `partial stream usage` warning。

性能要求：

1. 日志写入阶段可以在流式 finalize 时顺手提取最后 usage，避免列表查询再读大文件。
2. 历史日志重建索引时可以读取 stream 文件，但要设置最大扫描大小，例如 8MB 或按尾部块扫描。
3. 列表查询不应为了 token 指标读取 stream 文件；列表只读索引或 event 中已保存字段。

### 5.3 多 provider 字段映射

提取器按字段形状识别 providerStyle，不强依赖 `provider` 名称：

1. 有 `input_tokens / output_tokens` 且有 Anthropic cache 字段，识别为 `anthropic`。
2. 有 `input_tokens / output_tokens / input_tokens_details / output_tokens_details`，识别为 `openai-responses`。
3. 有 `prompt_tokens / completion_tokens`，识别为 `openai-compatible`。
4. 有 `promptTokenCount / candidatesTokenCount / totalTokenCount`，识别为 `gemini`。
5. 有 `billed_units` 或 `tokens`，识别为 `cohere`。

## 6. 日志事件字段

建议在 `LogEvent` 上新增轻量字段：

```ts
token_usage?: TokenUsageMetrics;
```

写入时机：

1. 非流式：在 `proxyRequest` 写事件前，从最终响应体或插件前后 body 提取。
2. 流式：在 `finalizeAndWriteEvent()` 中，从 stream capture 中获得 usage。
3. 如果 bodyPolicy 为 `off`，仍可从 stream raw 或非流式 response text 提取 token，因为 usage 不属于敏感正文。

重要约束：

1. `token_usage` 是派生字段，事实源仍是上游 response body 或 stream raw。
2. `rawUsage` 可以保存原始 usage 对象，但不保存完整 response body。
3. 如果提取失败，不阻断请求，不阻断日志写入。

## 7. SQLite 索引方案

在 `log_events` 表增加常用聚合字段：

```sql
ALTER TABLE log_events ADD COLUMN token_input INTEGER;
ALTER TABLE log_events ADD COLUMN token_output INTEGER;
ALTER TABLE log_events ADD COLUMN token_total INTEGER;
ALTER TABLE log_events ADD COLUMN token_cached_input INTEGER;
ALTER TABLE log_events ADD COLUMN token_cache_hit_input INTEGER;
ALTER TABLE log_events ADD COLUMN token_cache_hit_rate REAL;
ALTER TABLE log_events ADD COLUMN token_cache_hit_rate_denominator INTEGER;
ALTER TABLE log_events ADD COLUMN token_cache_read_input INTEGER;
ALTER TABLE log_events ADD COLUMN token_cache_creation_input INTEGER;
ALTER TABLE log_events ADD COLUMN token_cache_write_input INTEGER;
ALTER TABLE log_events ADD COLUMN token_cache_miss_input INTEGER;
ALTER TABLE log_events ADD COLUMN token_reasoning INTEGER;
ALTER TABLE log_events ADD COLUMN token_billable_input INTEGER;
ALTER TABLE log_events ADD COLUMN token_billable_output INTEGER;
ALTER TABLE log_events ADD COLUMN token_source TEXT;
ALTER TABLE log_events ADD COLUMN token_provider_style TEXT;
```

建议索引：

```sql
CREATE INDEX IF NOT EXISTS idx_log_events_token_total_time
ON log_events(token_total, ts_ms DESC)
WHERE token_total IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_log_events_token_input_time
ON log_events(token_input, ts_ms DESC)
WHERE token_input IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_log_events_token_cache_hit_rate_time
ON log_events(token_cache_hit_rate, ts_ms DESC)
WHERE token_cache_hit_rate IS NOT NULL;
```

统计用途：

1. 列表页展示每条日志 input / output / total。
2. Dashboard 可以按 provider、model、user、session 聚合 token。
3. 导出 CSV/JSON 可直接包含 token 字段。
4. 后续可以按 token_total 排序或筛选高 token 请求。

迁移策略：

1. `SCHEMA_VERSION` 从 `1` 提升到 `2`。
2. `migrate()` 检查缺失列并执行 `ALTER TABLE`。
3. 旧索引文件无需删除，首次查询范围时 rebuild 对应 JSONL 文件即可补齐。
4. 对于历史流式日志，如果 stream 文件存在则提取；不存在则保留 null。

## 8. 列表页展示方案

日志列表新增一列 `Usage`，放在“延迟”和“状态”之间。该列必须带上全部 usage 指标和缓存命中率，不能只展示 input/output/total。

行内主展示：

```text
in 1.2k · out 340 · total 1.5k
cache hit 98.1%
```

交互细节：

1. 行内固定展示 input、output、total、cache hit rate。
2. cache hit rate 缺失时显示 `cache hit -`，不能显示 `0%`。
3. hover tooltip 或展开浮层展示完整 usage 指标：
   - input
   - output
   - total
   - cache hit tokens
   - cache hit rate
   - cache hit denominator
   - cache hit formula
   - cached input
   - cache read input
   - cache creation input
   - cache creation 5m input
   - cache creation 1h input
   - cache write input
   - cache miss input
   - reasoning
   - audio input
   - audio output
   - text input
   - text output
   - accepted prediction
   - rejected prediction
   - tool use prompt
   - billable input
   - billable output
   - source
   - provider style
   - raw usage path
4. 缺失 token usage 时显示 `-`。
5. 列宽控制在 160 到 220px。行内只放主指标，完整字段放 tooltip/展开浮层，避免挤压消息列。
6. 表格列设置里可选打开独立列：Total、Cache hit、Reasoning、Billable input、Billable output，便于运营统计场景横向扫描。

顶部大 metric 卡必须增加缓存命中率：

1. 总 token。
2. 输入 token。
3. 输出 token。
4. 缓存命中率。
5. cache 命中 token。
6. reasoning token。

缓存命中率聚合口径：

1. 顶部总缓存命中率 = `sum(cacheHitInputTokens) / sum(cacheHitRateDenominatorTokens) * 100`。
2. 只统计分子、分母都存在且分母大于 0 的日志。
3. 聚合样本数要在 tooltip 中显示，避免用户误以为覆盖全部请求。

## 9. API 返回结构

`LogEventSummary` 增加：

```ts
tokenUsage: TokenUsageMetrics | null;
```

为了列表轻量，也可以定义 summary 子集：

```ts
export interface TokenUsageSummary {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheHitInputTokens: number | null;
  cacheHitRate: number | null;
  cacheHitRateDenominatorTokens: number | null;
  cacheHitRateFormula: string | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheCreationInputTokens5m: number | null;
  cacheCreationInputTokens1h: number | null;
  cacheWriteInputTokens: number | null;
  cacheMissInputTokens: number | null;
  reasoningTokens: number | null;
  audioInputTokens: number | null;
  audioOutputTokens: number | null;
  textInputTokens: number | null;
  textOutputTokens: number | null;
  acceptedPredictionTokens: number | null;
  rejectedPredictionTokens: number | null;
  toolUsePromptTokens: number | null;
  billableInputTokens: number | null;
  billableOutputTokens: number | null;
  source: string | null;
  providerStyle: string | null;
  rawUsagePath: string | null;
}
```

列表接口返回 `TokenUsageSummary` 时也要包含全部归一化 usage 字段和缓存命中率；详情接口再额外返回完整 `TokenUsageMetrics.rawUsage`。

## 10. 测试计划

新增单元测试：

1. OpenAI Responses usage：
   - `input_tokens`
   - `input_tokens_details.cached_tokens`
   - `output_tokens_details.reasoning_tokens`
   - `cacheHitRate`
2. OpenAI-compatible usage：
   - `prompt_tokens`
   - `completion_tokens`
   - `prompt_tokens_details.cached_tokens`
   - `completion_tokens_details.reasoning_tokens`
   - `cacheHitRate`
3. Anthropic usage：
   - `input_tokens`
   - `output_tokens`
   - `cache_creation_input_tokens`
   - `cache_read_input_tokens`
   - `cache_creation.ephemeral_5m_input_tokens`
   - `cache_creation.ephemeral_1h_input_tokens`
   - `cacheHitRate` 使用 effective input 分母
4. Gemini usageMetadata：
   - `promptTokenCount`
   - `candidatesTokenCount`
   - `thoughtsTokenCount`
   - `cachedContentTokenCount`
   - `cacheHitRate`
5. DeepSeek cache：
   - `prompt_cache_hit_tokens`
   - `prompt_cache_miss_tokens`
   - `cacheHitRate`
6. Cohere：
   - `usage.billed_units`
   - `usage.tokens`
   - `meta.billed_units`
   - `meta.tokens`
7. SSE stream：
   - OpenAI-compatible final chunk usage。
   - Anthropic `message_delta.usage`。
   - OpenAI Responses `response.completed.response.usage`。
   - 多个 usage 时选择最终且最完整的一个。

回归测试：

1. `log-query` 列表 summary 返回 token usage。
2. SQLite index query 返回 token usage。
3. JSONL fallback query 返回 token usage。
4. CSV export 包含 token 字段。
5. 旧日志缺失 token_usage 时不会报错。

## 11. 分阶段落地

### P0：提取器与测试

1. 新增 `src/token-usage.ts`。
2. 支持 response object、SSE data object、完整 SSE 文本三类输入。
3. 覆盖 OpenAI、Anthropic、Gemini、DeepSeek、Mistral/OpenRouter、Cohere。
4. 加单元测试。

### P1：日志写入接入

1. 非流式写入 `token_usage`。
2. 流式 finalize 时提取 `token_usage`。
3. 保证 bodyPolicy=off 时仍能记录 usage。

### P2：索引与查询接入

1. `log_events` 增加 token columns。
2. `eventToRow()` 写入 token columns。
3. `rowToSummary()` 返回 token summary。
4. JSONL fallback 同样返回 token summary。

### P3：列表页展示

1. `web/src/lib/api.ts` 增加 token 类型。
2. 日志列表增加 Usage 列，行内展示 input、output、total、cache hit rate。
3. tooltip 或展开浮层展示全部 usage 指标、缓存命中率口径、source、provider style、raw usage path。
4. 顶部大 metric 卡增加总 token、输入 token、输出 token、缓存命中率、cache 命中 token、reasoning token。
5. export CSV/JSON 增加全部 token 字段和缓存命中率字段。

### P4：统计能力

1. Dashboard 按 provider/model 聚合 token。
2. 用户和 session 维度聚合 token。
3. 高 token 请求筛选。
4. cache 命中率和 reasoning token 趋势。

## 12. 验收标准

1. 本地已有 OpenAI-compatible、Anthropic stream、OpenAI Responses stream 都能提取 token。
2. 列表页无需打开详情即可看到 input、output、total 和缓存命中率。
3. SQLite 索引查询和 JSONL fallback 查询返回一致的 token summary。
4. 缺失 usage 的日志显示 `-`，不会影响列表加载。
5. 历史索引能通过 rebuild 补齐 token columns。
6. 日志列表 tooltip 或展开浮层能看到全部归一化 usage 指标。
7. 原始 provider usage 不丢失，详情页可追溯到原字段路径。

## 13. 参考来源

1. OpenAI Responses API：`usage.input_tokens`、`usage.input_tokens_details.cached_tokens`、`usage.output_tokens`、`usage.output_tokens_details.reasoning_tokens`、`usage.total_tokens`。
   https://platform.openai.com/docs/api-reference/responses
2. OpenAI prompt caching：Chat/Completion usage 中的 `prompt_tokens_details.cached_tokens` 和 `completion_tokens_details.reasoning_tokens`。
   https://platform.openai.com/docs/guides/prompt-caching
3. Anthropic Messages API：`usage.input_tokens`、`usage.output_tokens`，以及 input token 汇总口径。
   https://docs.anthropic.com/en/api/messages
4. Anthropic prompt caching：`cache_creation_input_tokens`、`cache_read_input_tokens`、`cache_creation`。
   https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
5. Gemini GenerateContent UsageMetadata：`promptTokenCount`、`candidatesTokenCount`、`cachedContentTokenCount`、`thoughtsTokenCount`、`toolUsePromptTokenCount`、`totalTokenCount`。
   https://ai.google.dev/api/generate-content
6. DeepSeek Chat Completion：`prompt_tokens`、`completion_tokens`、`total_tokens`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`。
   https://api-docs.deepseek.com/api/create-chat-completion
7. Mistral prompt caching：`usage.prompt_tokens_details.cached_tokens`。
   https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching
8. OpenRouter usage accounting：prompt/completion/total、cached、reasoning、stream final chunk usage。
   https://openrouter.ai/docs/cookbook/administration/usage-accounting
9. Cohere Chat API：`usage.billed_units` 与 `usage.tokens`。
   https://docs.cohere.com/reference/chat
