# 日志详情查看器体验重构方案

日期：2026-05-23

## 1. 页面定位

日志详情页是给用户查看一次大模型请求的页面，不是问题判断页面，也不是处理流程页面。

新版页面只回答四类问题：

1. 这次请求的基本状态是什么：状态码、耗时、模型、Provider、是否流式。
2. 用户发出了什么，Provider 收到了什么。
3. Provider 返回了什么，最终返回给用户的是什么。
4. 哪些内容来自原始日志，哪些内容是为了阅读体验生成的视图。

页面不自动给原因判断，不生成处理动作，也不把派生视图伪装成原始事实。用户需要的是清楚、完整、可追溯地看懂这条日志。

## 2. 当前页面能力

现有详情页已经具备较完整的底层能力，主要入口在 `web/src/pages/log-detail.tsx`，相关组件位于 `web/src/components/log-detail/`。

已有能力：

1. 展示请求概览、请求体、响应体、插件、Stream、Raw。
2. 支持从日志索引定位 JSONL 行。
3. 支持复制 request id、Raw JSON 和 cURL。
4. Chat History 能从 request、response、stream 等字段还原。
5. 后端日志结构已经保留插件前后快照、Provider 信息和 stream 文件位置。

主要体验问题：

1. 信息按技术字段堆叠，用户需要自己组合上下文。
2. 用户请求、Provider 请求、Provider 响应、最终响应分散展示，对比成本高。
3. Chat、Stream、Raw 可能很大，打开详情时不应一次性解析和渲染。
4. 插件区域展示了列表，但“插件前后内容差异”不够直观。
5. bodyPolicy、streamCaptured、partial 等完整度信息分散，用户难以判断当前视图是否覆盖完整内容。
6. 复制入口层级不清，Raw、cURL、当前视图内容应有不同的默认行为。

## 3. 设计原则

### 3.1 用户优先

页面语言应面向普通使用者、调用方和产品运营人员。避免把详情页设计成工程处理界面。

设计要求：

1. 首屏展示请求状态、模型路由、耗时和关键 ID。
2. 主区用视图组织内容，而不是按数据库字段组织内容。
3. 复杂内容默认折叠或分页，用户主动打开时再加载。
4. 按钮文案使用“复制”“打开”“查看”“上一条”“下一条”等明确动作。
5. 不展示自动原因判断，不展示下一步处理动作。

### 3.2 不失真

体验友好不能牺牲信息真实性。新版必须把事实源和阅读视图区分清楚。

核心规则：

1. `Raw / JSONL event` 是唯一事实源。
2. Conversation、Diff、Compare、Stream parser、cURL 生成器都是事实源上的投影。
3. 每个内容块都显示来源标签。
4. 缺失字段显示为缺失，不用推断补齐。
5. 派生视图必须能跳回 Raw 字段路径。
6. `partial` 状态必须明确说明当前只覆盖已加载内容。

### 3.3 来源标签

统一使用以下标签：

1. `raw`：直接来自 JSONL event 或 stream raw 文件。
2. `captured`：来自日志采集字段，例如 `request_body`、`response_body`、headers。
3. `plugin-before`：插件处理前快照，例如 `response_body_before_plugins`。
4. `plugin-after`：插件处理后快照，例如 `request_body_after_plugins`。
5. `derived`：由解析器生成，例如 Conversation、Stream event type、usage 摘要。
6. `reconstructed`：由多个字段重建，例如把 `model_in` 写回 request body 后展示的用户请求。
7. `unavailable`：字段未采集、被 bodyPolicy 关闭、stream 文件缺失或已清理。
8. `partial`：当前只加载了部分内容。

视觉规则：

1. `raw`、`captured` 使用中性标签。
2. `plugin-before`、`plugin-after` 使用对比标签。
3. `derived`、`reconstructed` 使用提示标签，并提供“查看来源”。
4. `unavailable`、`partial` 使用轻量提醒，不遮挡主要内容。

## 4. 新版布局

采用三栏布局，但页面语义是“查看”，不是处理流程。

```text
┌──────────────────────────────────────────────────────────────┐
│ 顶部摘要栏：状态 / 模型 / Provider / 耗时 / 请求 ID / 复制动作 │
├──────────────┬──────────────────────────────────┬────────────┤
│ 内容导航      │ 主查看区                          │ 信息侧栏    │
│ Overview      │ Conversation / Compare / Stream    │ Capture    │
│ Conversation  │ Raw / Plugins                       │ Trace      │
│ Request       │                                    │ Provenance │
│ Response      │                                    │ Files      │
│ Plugins       │                                    │            │
│ Stream        │                                    │            │
│ Raw           │                                    │            │
└──────────────┴──────────────────────────────────┴────────────┘
```

### 4.1 顶部摘要栏

顶部固定展示最稳定的判断字段：

1. 状态：`2xx`、`4xx`、`5xx`、`network_error`。
2. 路由：`model_in -> provider / model_out`。
3. 性能：latency、request bytes、response bytes、stream bytes。
4. 定位：request_id、provider_request_id、日志文件位置。
5. 操作：上一条、下一条、复制 ID、复制 local-router cURL、复制 provider cURL、复制 Raw JSON。

设计约束：

1. 不增加顶部命令入口。
2. 不把 Raw JSON 放成最强按钮，避免用户误点复制大内容。
3. provider cURL 旁标注来源，例如 `plugin-after`。
4. 如果 body 或 stream 不是完整采集，在摘要栏显示轻量提示。

### 4.2 内容导航

左侧导航保持少而稳定：

1. `Overview`：请求摘要、模型路由、链路、大小和完整度提示。
2. `Conversation`：按 role 阅读消息历史。
3. `Request`：用户请求与 Provider 请求并排对比。
4. `Response`：Provider 响应与最终响应并排对比。
5. `Plugins`：插件列表、阶段、输入输出差异。
6. `Stream`：分页查看 SSE 事件。
7. `Raw`：完整原始日志事件。

每个导航项可带轻量元信息：

1. Conversation 显示消息数。
2. Plugins 显示插件数和是否修改内容。
3. Stream 显示已加载事件数和 `partial`。
4. Raw 显示 bodyPolicy。
5. 派生视图显示 `derived` 或 `reconstructed`。

### 4.3 主查看区

主区承担阅读与对比，避免把所有字段一次性铺开。

通用规则：

1. 每个视图顶部说明本视图来源和完整度。
2. 大 JSON 使用折叠、虚拟列表或懒格式化。
3. Request / Response 默认 Split，对比按钮切换到 Diff。
4. Conversation 默认展开短文本，折叠工具调用和长 block。
5. Stream 默认只加载首屏事件，用户点击“加载更多”再读取后续片段。
6. Raw 进入视图后再格式化，不作为详情页首屏负担。

### 4.4 信息侧栏

右侧侧栏只保留稳定上下文：

1. Capture：bodyPolicy、request body、response body、stream 状态。
2. Trace：request_id、provider_id、文件日期、行号、offset。
3. Provenance：当前视图来源、完整度、Raw 字段路径。
4. 快捷操作：复制当前摘要、打开 Raw 字段路径、按 session 查看。

侧栏不展示自动原因判断，也不展示下一步处理动作。

## 5. 核心视图

### 5.1 Overview

Overview 是用户进入详情后的首页，应保持清楚、克制。

包含模块：

1. 请求结果：状态、耗时、Provider、routeType、是否流式。
2. 模型路由：model_in、route_rule_key、model_out、target_url。
3. 请求链路：Client -> local-router -> Provider -> local-router -> Client。
4. Usage / Size：完整 token usage、cache、reasoning、billable、request bytes、response bytes、stream bytes。
5. 完整度提示：bodyPolicy、stream captured、partial、unavailable。

不包含模块：

1. 自动原因判断。
2. 下一步处理动作。
3. 长篇说明文字。
4. 会让用户误以为系统已经理解原因的卡片。

#### Usage / Size 模块

Usage / Size 不能只展示 input/output。它应该直接复用 `docs/token-usage-metrics-plan.md` 中的 `TokenUsageMetrics`，按“主指标 + 细分指标 + 来源”展示。

首行主指标：

1. Input：统一输入 token。OpenAI-compatible 对应 `prompt_tokens`，OpenAI Responses/Anthropic 对应 `input_tokens`，Gemini 对应 `promptTokenCount`。
2. Output：统一输出 token。OpenAI-compatible 对应 `completion_tokens`，OpenAI Responses/Anthropic 对应 `output_tokens`，Gemini 对应 `candidatesTokenCount`。
3. Total：优先使用上游 `total_tokens / totalTokenCount`，缺失时只在 input/output 可信时派生。
4. Cache hit rate：缓存命中率。该指标必须放在首行大 metric 卡片里，不能只藏在 tooltip 中。

细分指标：

1. Cached input：`prompt_tokens_details.cached_tokens`、`input_tokens_details.cached_tokens`、Gemini `cachedContentTokenCount`。
2. Cache read：Anthropic `cache_read_input_tokens`。
3. Cache creation：Anthropic `cache_creation_input_tokens`，并展开 `ephemeral_5m_input_tokens`、`ephemeral_1h_input_tokens`。
4. Cache write：OpenRouter/Mistral 类 `cache_write_tokens`。
5. Cache miss：DeepSeek `prompt_cache_miss_tokens`。
6. Reasoning / thoughts：OpenAI `output_tokens_details.reasoning_tokens`、Gemini `thoughtsTokenCount`、OpenRouter reasoning 字段。
7. Audio input/output：OpenAI-compatible `audio_tokens`。
8. Prediction accepted/rejected：OpenAI-compatible `accepted_prediction_tokens`、`rejected_prediction_tokens`。
9. Billable input/output：Cohere `billed_units.input_tokens`、`billed_units.output_tokens`。

缓存命中率口径：

1. OpenAI / Mistral / OpenRouter：`cached_tokens / inputTokens`。
2. Anthropic：`cache_read_input_tokens / (input_tokens + cache_read_input_tokens + cache_creation_input_tokens)`。
3. DeepSeek：`prompt_cache_hit_tokens / prompt_tokens`，或 `prompt_cache_hit_tokens / (prompt_cache_hit_tokens + prompt_cache_miss_tokens)`。
4. Gemini：`cachedContentTokenCount / promptTokenCount`。
5. Cohere：没有明确 cache 字段时显示 `-`。
6. 分母缺失或为 0 时显示 `-`，不能显示 0%。

数据大小：

1. request bytes。
2. response bytes。
3. stream bytes。
4. stream file bytes 和 truncated 状态。

显示规则：

1. 主指标固定展示 Input、Output、Total、Cache hit rate；没有 usage 时显示 `-`。
2. 细分指标只展示非空字段，避免空表格。
3. 来源必须显示：`response_body`、`response_body_after_plugins`、`response_body_before_plugins`、`stream_file` 或 `raw_event.token_usage`。
4. 如果 token 是从 stream 文件提取，标注 `stream final usage`；如果 stream 被截断，标注 `partial`。
5. 如果 total 是派生值，标注 `derived total`，不能伪装成上游原始字段。
6. hover 或展开态显示 raw usage path，例如 `response.usage`、`message_delta.usage`、`response.completed.response.usage`。

### 5.2 Conversation

Conversation 是面向阅读的消息视图，来源是 `derived`。

能力：

1. 按 role 过滤：All、System、User、Assistant、Tool。
2. 消息头展示序号、role、内容类型和 token/字符数。
3. 长文本折叠，工具结果默认折叠。
4. 局部搜索只搜索已解析消息。
5. 每条消息可复制，也可跳转 Raw 字段路径。

失真控制：

1. 标注 `derived`。
2. 如果 response 或 stream 不完整，标注 `partial`。
3. 如果用户请求经过 `restoreLocalRouterBody()` 重建，标注 `reconstructed`。

### 5.3 Request Compare

Request 视图展示“用户请求”和“Provider 请求”。

默认 Split：

1. 左侧：用户请求，通常是 `reconstructed`。
2. 右侧：Provider 请求，优先使用 `request_body_after_plugins`，标注 `plugin-after`。

Diff 模式：

1. 只比较已采集快照。
2. 不推断插件中间态。
3. 缺少任一侧时禁用 Diff，并说明缺失字段。

复制规则：

1. 复制用户请求时标注是否为 `reconstructed`。
2. 复制 provider cURL 时默认不包含真实密钥。
3. provider cURL 使用 `request_url_after_plugins` 和 `request_body_after_plugins`。

### 5.4 Response Compare

Response 视图展示“Provider 响应”和“最终响应”。

默认 Split：

1. 左侧：`response_body_before_plugins`，标注 `plugin-before`。
2. 右侧：`response_body` 或 `response_body_after_plugins`，标注 `captured`。

Diff 模式：

1. 只在 before/after 都存在时启用。
2. 新增、删除、修改使用明确标记，不能只靠颜色。
3. 大响应使用分块渲染，避免一次性 diff 整个 JSON。

### 5.5 Plugins

Plugins 视图从“插件列表”升级为“插件影响查看”。

包含：

1. 请求阶段插件顺序。
2. 响应阶段插件顺序。
3. 每个插件是否修改 URL、headers、body、status。
4. 修改摘要和对应字段路径。
5. 跳转到 Request / Response Diff。

说明：

1. 该视图可以展示“改了什么”，但不生成原因判断。
2. 如果插件只记录名称，没有前后快照，则只展示名称和阶段。

### 5.6 Stream

Stream 视图用于查看 SSE 事件，默认不读取完整文件。

能力：

1. 首屏加载固定数量事件，例如 200 行。
2. 支持按 event type 过滤：All、Delta、Usage、Error。
3. 点击事件查看 rawLine 和 parsedPayload。
4. 局部搜索默认只覆盖已加载事件，并标注范围。
5. 加载更多时保持滚动位置。

性能要求：

1. 后端支持 range 或 cursor 读取 stream 文件。
2. 前端列表使用虚拟渲染。
3. parsedPayload 在点击事件后再格式化。

### 5.7 Raw

Raw 是兜底视图，也是事实源入口。

能力：

1. 进入 Raw 后再读取和格式化完整 JSON。
2. 支持 Pretty、Compact、Original 三种显示。
3. 支持字段路径定位。
4. 支持复制完整 Raw，并明确提示可能包含敏感内容。

Raw 不参与美化推断，不改写字段含义。

## 6. 交互策略

### 6.1 局部搜索

不做顶部全局命令入口。搜索只出现在需要搜索的视图内：

1. Conversation：搜索已解析消息。
2. Stream：搜索已加载事件。
3. Raw：搜索字段名或文本。
4. Request / Response：搜索当前两侧内容或当前 diff。

### 6.2 前后日志导航

详情页支持沿用列表上下文跳转：

1. `上一条` / `下一条` 保留列表筛选条件和排序。
2. `返回列表` 恢复列表滚动位置和选中行。
3. URL 保留当前 view、compare mode、focused raw path。
4. 没有列表上下文时隐藏上一条/下一条。

### 6.3 复制行为

复制动作应和当前视图一致：

1. 复制当前摘要：只包含状态、模型、Provider、耗时、来源标签和当前可见片段。
2. 复制 cURL：默认使用占位符密钥。
3. 复制 Raw：保持完整内容，按钮旁提示可能包含敏感信息。
4. 复制派生视图时，toast 中显示来源，例如 `derived` 或 `reconstructed`。

### 6.4 空状态

空状态必须说明缺失原因：

1. bodyPolicy 未开启。
2. stream 文件不存在或已清理。
3. 插件前后快照未采集。
4. 当前日志版本不包含该字段。

空状态只说明事实，不生成原因判断。

## 7. 性能方案

### 7.1 数据分层

详情接口应拆成基础摘要和按需 section：

1. `GET /api/logs/:id`：返回摘要、Trace、Capture、可用 section 列表。
2. `GET /api/logs/:id/sections/request`：返回 Request Compare 数据。
3. `GET /api/logs/:id/sections/response`：返回 Response Compare 数据。
4. `GET /api/logs/:id/sections/conversation`：返回分页或分块消息。
5. `GET /api/logs/:id/sections/stream?cursor=...`：返回 stream 片段。
6. `GET /api/logs/:id/sections/raw`：返回 Raw 或字段路径片段。

### 7.2 前端渲染

1. 首屏只渲染顶部摘要、Overview 和信息侧栏。
2. Conversation 使用按需展开和虚拟列表。
3. Stream 使用 cursor 分页和虚拟列表。
4. Raw JSON 使用懒格式化，大对象按节点展开。
5. JSON diff 放到 Web Worker 或后端预处理，避免阻塞主线程。
6. section 数据按 request_id + section 缓存，切换视图不重复请求。

### 7.3 后端读取

1. JSONL event 通过索引定位 offset，避免扫描完整文件。
2. stream 文件使用 range/cursor 读取。
3. 大 body 默认返回摘要、大小和可用性，用户打开对应视图时再读取。
4. section 返回 `byteLength`、`itemCount`、`completeness`。

## 8. 数据契约

为支持来源和完整度标注，section 数据带轻量元信息：

```ts
interface ViewerSectionMeta {
  source:
    | 'raw'
    | 'captured'
    | 'plugin-before'
    | 'plugin-after'
    | 'derived'
    | 'reconstructed'
    | 'unavailable';
  completeness: 'complete' | 'partial' | 'unavailable';
  rawPath?: string;
  derivedFrom?: string[];
  warnings?: string[];
  byteLength?: number;
  itemCount?: number;
}
```

示例：

1. 用户请求 body：`source=reconstructed`，`derivedFrom=["request_body", "summary.modelIn"]`。
2. Provider 请求 body：`source=plugin-after`，`rawPath=request_body_after_plugins`。
3. Conversation：`source=derived`，`derivedFrom=["request_body", "response_body", "stream_file"]`。
4. Stream 当前页：`source=raw`，`completeness=partial`，`itemCount=200`。

## 9. 落地步骤

### P0：整理视图模型

1. 定义 `ViewerSectionMeta`。
2. 梳理现有字段到各视图的映射。
3. 给现有 section 增加 source、completeness、rawPath。
4. 统一空状态文案和来源标签。

### P1：改造页面骨架

1. 顶部摘要栏。
2. 左侧内容导航。
3. 主查看区。
4. 右侧信息侧栏。
5. URL view state。
6. 上一条/下一条上下文跳转。

### P2：重做核心视图

1. Overview 模块化。
2. Request Compare。
3. Response Compare。
4. Conversation 折叠、过滤、局部搜索。
5. Plugins 影响查看。
6. Raw 懒加载。

### P3：大内容优化

1. Stream cursor 分页。
2. 虚拟列表。
3. JSON 懒格式化。
4. Diff Worker。
5. section 缓存。

## 10. 验收标准

体验验收：

1. 用户打开详情首屏能看到状态、模型、Provider、耗时和请求 ID。
2. 用户能在 1 次点击内进入 Conversation、Request、Response、Plugins、Stream、Raw。
3. 用户能清楚知道每个视图的来源和完整度。
4. 用户能从派生视图跳回 Raw 字段路径。
5. 用户能复制当前摘要、cURL、Raw，并知道复制内容的来源。

性能验收：

1. 普通日志详情首屏不读取完整 stream 文件。
2. 大 Raw 不在首屏格式化。
3. Stream 支持分页读取和虚拟渲染。
4. 大 Conversation 不一次性展开所有工具结果。
5. 切换视图不重复拉取已缓存 section。

真实性验收：

1. Raw 始终可达。
2. `derived`、`reconstructed`、`partial`、`unavailable` 标签准确显示。
3. 缺失字段不被推断补齐。
4. Request / Response Diff 只比较已采集快照。
5. cURL 生成器明确使用的来源字段。

## 11. 最终方向

新版日志详情页应成为一个稳定、克制、可追溯的查看器。

它不替用户判断原因，也不把页面做成复杂处理中心。它要做的是把一次大模型请求的真实链路、关键内容和来源边界清楚展示出来，让用户能快速看懂、准确复制、按需深入 Raw。
