import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export type TokenUsageProviderStyle =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'cohere'
  | 'mistral'
  | 'openrouter'
  | 'unknown';

export type TokenUsageSource =
  | 'explicit'
  | 'response_body'
  | 'response_body_after_plugins'
  | 'response_body_before_plugins'
  | 'stream_chunk'
  | 'stream_file';

export interface TokenUsageMetrics {
  schemaVersion: 1;
  source: TokenUsageSource;
  providerStyle: TokenUsageProviderStyle;
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
  creditUsage: number | null;
  cost: number | null;
  rawUsage: unknown;
  rawUsagePath: string | null;
  warnings: string[];
}

export type TokenUsageSummary = Omit<TokenUsageMetrics, 'rawUsage'>;

export interface TokenUsageLogEventLike {
  provider?: string;
  route_type?: string;
  model_in?: string;
  model_out?: string;
  response_body?: string;
  response_body_after_plugins?: string;
  response_body_before_plugins?: string;
  stream_file?: string;
  token_usage?: TokenUsageMetrics | TokenUsageSummary | null;
}

export interface TokenUsageStreamCollector {
  addChunk(chunk: Uint8Array): void;
  getUsage(): TokenUsageMetrics | null;
}

const MAX_STREAM_USAGE_BYTES = 25 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function numberAt(value: unknown, path: string[]): number | null {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record || !(key in record)) return null;
    current = record[key];
  }
  return numeric(current);
}

function firstNumber(value: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    const found = numberAt(value, path);
    if (found !== null) return found;
  }
  return null;
}

function maxNullable(...values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => value !== null && value !== undefined);
  if (numbers.length === 0) return null;
  return Math.max(...numbers);
}

function sumNullable(...values: Array<number | null | undefined>): number | null {
  let total = 0;
  let hasValue = false;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    total += value;
    hasValue = true;
  }
  return hasValue ? total : null;
}

function roundPercent(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function inferProviderStyle(
  usage: Record<string, unknown>,
  providerHint?: string
): TokenUsageProviderStyle {
  const hint = providerHint?.toLowerCase() ?? '';
  if (hint.includes('anthropic') || hint.includes('claude')) return 'anthropic';
  if (hint.includes('gemini') || hint.includes('google')) return 'gemini';
  if (hint.includes('deepseek')) return 'deepseek';
  if (hint.includes('cohere')) return 'cohere';
  if (hint.includes('mistral')) return 'mistral';
  if (hint.includes('openrouter')) return 'openrouter';
  if (hint.includes('openai') || hint.includes('gpt-')) return 'openai';

  if ('cache_read_input_tokens' in usage || 'cache_creation_input_tokens' in usage) {
    return 'anthropic';
  }
  if ('prompt_cache_hit_tokens' in usage || 'prompt_cache_miss_tokens' in usage) {
    return 'deepseek';
  }
  if (
    'promptTokenCount' in usage ||
    'usageMetadata' in usage ||
    'cachedContentTokenCount' in usage
  ) {
    return 'gemini';
  }
  if ('billed_units' in usage || 'tokens' in usage) {
    return 'cohere';
  }
  if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
    return 'openai';
  }
  if ('input_tokens' in usage || 'output_tokens' in usage) {
    return 'openai';
  }
  return 'unknown';
}

function createEmptyMetrics(input: {
  source: TokenUsageSource;
  providerStyle: TokenUsageProviderStyle;
  rawUsage: unknown;
  rawUsagePath: string | null;
}): TokenUsageMetrics {
  return {
    schemaVersion: 1,
    source: input.source,
    providerStyle: input.providerStyle,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedInputTokens: null,
    cacheHitInputTokens: null,
    cacheHitRate: null,
    cacheHitRateDenominatorTokens: null,
    cacheHitRateFormula: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    cacheCreationInputTokens5m: null,
    cacheCreationInputTokens1h: null,
    cacheWriteInputTokens: null,
    cacheMissInputTokens: null,
    reasoningTokens: null,
    audioInputTokens: null,
    audioOutputTokens: null,
    textInputTokens: null,
    textOutputTokens: null,
    acceptedPredictionTokens: null,
    rejectedPredictionTokens: null,
    toolUsePromptTokens: null,
    billableInputTokens: null,
    billableOutputTokens: null,
    creditUsage: null,
    cost: null,
    rawUsage: input.rawUsage,
    rawUsagePath: input.rawUsagePath,
    warnings: [],
  };
}

function hasAnyTokenSignal(metrics: TokenUsageMetrics): boolean {
  return [
    metrics.inputTokens,
    metrics.outputTokens,
    metrics.totalTokens,
    metrics.cachedInputTokens,
    metrics.cacheHitInputTokens,
    metrics.cacheReadInputTokens,
    metrics.cacheCreationInputTokens,
    metrics.cacheMissInputTokens,
    metrics.reasoningTokens,
    metrics.billableInputTokens,
    metrics.billableOutputTokens,
    metrics.creditUsage,
    metrics.cost,
  ].some((value) => value !== null);
}

function normalizeUsageObject(input: {
  usage: Record<string, unknown>;
  source: TokenUsageSource;
  rawUsagePath: string | null;
  providerHint?: string;
}): TokenUsageMetrics | null {
  const { usage, source, rawUsagePath, providerHint } = input;
  const providerStyle = inferProviderStyle(usage, providerHint);
  const metrics = createEmptyMetrics({
    source,
    providerStyle,
    rawUsage: usage,
    rawUsagePath,
  });

  const usageBody = asRecord(usage.usageMetadata) ?? usage;

  metrics.inputTokens = firstNumber(usageBody, [
    ['input_tokens'],
    ['prompt_tokens'],
    ['promptTokenCount'],
    ['tokens', 'input_tokens'],
    ['billed_units', 'input_tokens'],
  ]);
  metrics.outputTokens = firstNumber(usageBody, [
    ['output_tokens'],
    ['completion_tokens'],
    ['candidatesTokenCount'],
    ['tokens', 'output_tokens'],
    ['billed_units', 'output_tokens'],
  ]);
  const explicitTotalTokens = firstNumber(usageBody, [
    ['total_tokens'],
    ['totalTokenCount'],
    ['tokens', 'total_tokens'],
  ]);
  metrics.totalTokens = explicitTotalTokens;

  const cachedTokens = firstNumber(usageBody, [
    ['input_tokens_details', 'cached_tokens'],
    ['prompt_tokens_details', 'cached_tokens'],
    ['cached_tokens'],
    ['cachedContentTokenCount'],
  ]);
  const cacheReadTokens = firstNumber(usageBody, [
    ['cache_read_input_tokens'],
    ['cacheReadInputTokens'],
    ['claude_cache_read_input_tokens'],
  ]);
  const promptCacheHitTokens = firstNumber(usageBody, [['prompt_cache_hit_tokens']]);
  const promptCacheMissTokens = firstNumber(usageBody, [['prompt_cache_miss_tokens']]);
  const cacheCreationTokens = firstNumber(usageBody, [
    ['cache_creation_input_tokens'],
    ['cacheCreationInputTokens'],
    ['cache_creation', 'input_tokens'],
    ['claude_cache_creation_input_tokens'],
  ]);

  metrics.cacheCreationInputTokens5m = firstNumber(usageBody, [
    ['cache_creation', 'ephemeral_5m_input_tokens'],
    ['cache_creation', 'ephemeral5mInputTokens'],
    ['cache_creation_ephemeral_5m_input_tokens'],
    ['claude_cache_creation_5_m_tokens'],
  ]);
  metrics.cacheCreationInputTokens1h = firstNumber(usageBody, [
    ['cache_creation', 'ephemeral_1h_input_tokens'],
    ['cache_creation', 'ephemeral1hInputTokens'],
    ['cache_creation_ephemeral_1h_input_tokens'],
    ['claude_cache_creation_1_h_tokens'],
  ]);
  metrics.cacheCreationInputTokens = maxNullable(
    cacheCreationTokens,
    sumNullable(metrics.cacheCreationInputTokens5m, metrics.cacheCreationInputTokens1h)
  );
  metrics.cacheReadInputTokens = cacheReadTokens;
  metrics.cacheHitInputTokens = maxNullable(cachedTokens, cacheReadTokens, promptCacheHitTokens);
  metrics.cachedInputTokens = metrics.cacheHitInputTokens;
  metrics.cacheMissInputTokens = promptCacheMissTokens;
  metrics.cacheWriteInputTokens = firstNumber(usageBody, [
    ['cache_write_input_tokens'],
    ['cacheWriteInputTokens'],
  ]);

  if (metrics.cacheWriteInputTokens === null && providerStyle === 'anthropic') {
    metrics.cacheWriteInputTokens = metrics.cacheCreationInputTokens;
  }

  metrics.reasoningTokens = firstNumber(usageBody, [
    ['output_tokens_details', 'reasoning_tokens'],
    ['completion_tokens_details', 'reasoning_tokens'],
    ['reasoning_tokens'],
    ['thoughtsTokenCount'],
  ]);
  metrics.audioInputTokens = firstNumber(usageBody, [
    ['input_tokens_details', 'audio_tokens'],
    ['prompt_tokens_details', 'audio_tokens'],
    ['audio_input_tokens'],
  ]);
  metrics.audioOutputTokens = firstNumber(usageBody, [
    ['output_tokens_details', 'audio_tokens'],
    ['completion_tokens_details', 'audio_tokens'],
    ['audio_output_tokens'],
  ]);
  metrics.textInputTokens = firstNumber(usageBody, [
    ['input_tokens_details', 'text_tokens'],
    ['prompt_tokens_details', 'text_tokens'],
    ['text_input_tokens'],
  ]);
  metrics.textOutputTokens = firstNumber(usageBody, [
    ['output_tokens_details', 'text_tokens'],
    ['completion_tokens_details', 'text_tokens'],
    ['text_output_tokens'],
  ]);
  metrics.acceptedPredictionTokens = firstNumber(usageBody, [
    ['output_tokens_details', 'accepted_prediction_tokens'],
    ['completion_tokens_details', 'accepted_prediction_tokens'],
    ['accepted_prediction_tokens'],
  ]);
  metrics.rejectedPredictionTokens = firstNumber(usageBody, [
    ['output_tokens_details', 'rejected_prediction_tokens'],
    ['completion_tokens_details', 'rejected_prediction_tokens'],
    ['rejected_prediction_tokens'],
  ]);
  metrics.toolUsePromptTokens = firstNumber(usageBody, [
    ['toolUsePromptTokenCount'],
    ['tool_use_prompt_tokens'],
  ]);
  metrics.billableInputTokens = firstNumber(usageBody, [
    ['billed_units', 'input_tokens'],
    ['billable_input_tokens'],
  ]);
  metrics.billableOutputTokens = firstNumber(usageBody, [
    ['billed_units', 'output_tokens'],
    ['billable_output_tokens'],
  ]);
  metrics.creditUsage = firstNumber(usageBody, [['credit_usage'], ['creditUsage']]);
  metrics.cost = firstNumber(usageBody, [['cost'], ['total_cost'], ['totalCost']]);

  let cacheDenominator: number | null = null;
  let cacheFormula: string | null = null;
  if (providerStyle === 'anthropic') {
    cacheDenominator = sumNullable(
      metrics.inputTokens,
      metrics.cacheReadInputTokens,
      metrics.cacheCreationInputTokens
    );
    cacheFormula =
      'cache_read_input_tokens / (input_tokens + cache_read_input_tokens + cache_creation_input_tokens)';
  } else if (providerStyle === 'deepseek') {
    cacheDenominator =
      metrics.inputTokens ?? sumNullable(metrics.cacheHitInputTokens, metrics.cacheMissInputTokens);
    cacheFormula = 'prompt_cache_hit_tokens / prompt_tokens';
  } else if (providerStyle === 'gemini') {
    cacheDenominator = metrics.inputTokens;
    cacheFormula = 'cachedContentTokenCount / promptTokenCount';
  } else if (
    providerStyle === 'openai' ||
    providerStyle === 'mistral' ||
    providerStyle === 'openrouter' ||
    providerStyle === 'unknown'
  ) {
    cacheDenominator = metrics.inputTokens;
    cacheFormula = 'cached_tokens / input_tokens';
  }

  if (metrics.cacheHitInputTokens !== null && cacheDenominator !== null && cacheDenominator > 0) {
    metrics.cacheHitRateDenominatorTokens = cacheDenominator;
    metrics.cacheHitRateFormula = cacheFormula;
    metrics.cacheHitRate = roundPercent(metrics.cacheHitInputTokens, cacheDenominator);
    if (metrics.cacheMissInputTokens === null) {
      metrics.cacheMissInputTokens = Math.max(0, cacheDenominator - metrics.cacheHitInputTokens);
    }
  }

  if (metrics.totalTokens === null && metrics.outputTokens !== null) {
    const effectiveInputTokens = metrics.cacheHitRateDenominatorTokens ?? metrics.inputTokens;
    if (effectiveInputTokens !== null) {
      metrics.totalTokens = effectiveInputTokens + metrics.outputTokens;
      metrics.warnings.push(
        metrics.cacheHitRateDenominatorTokens !== null
          ? 'totalTokens 由 cacheHitRateDenominatorTokens + outputTokens 推导'
          : 'totalTokens 由 inputTokens + outputTokens 推导'
      );
    }
  }

  return hasAnyTokenSignal(metrics) ? metrics : null;
}

interface UsageCandidate {
  usage: Record<string, unknown>;
  path: string;
}

function collectUsageCandidates(value: unknown, prefix = ''): UsageCandidate[] {
  const record = asRecord(value);
  if (!record) return [];

  const candidates: UsageCandidate[] = [];
  const candidateKeys = [
    'usage',
    'usageMetadata',
    'message.usage',
    'response.usage',
    'body.usage',
    'data.usage',
    'event.usage',
  ];

  for (const key of candidateKeys) {
    const path = key.split('.');
    let current: unknown = record;
    for (const part of path) {
      const currentRecord = asRecord(current);
      current = currentRecord?.[part];
    }
    const usage = asRecord(current);
    if (usage) {
      candidates.push({ usage, path: prefix ? `${prefix}.${key}` : key });
    }
  }

  const direct = normalizeUsageObject({
    usage: record,
    source: 'response_body',
    rawUsagePath: prefix || null,
  });
  if (direct) {
    candidates.push({ usage: record, path: prefix || '$' });
  }

  return candidates;
}

function mergeNumber(
  current: number | null,
  incoming: number | null,
  strategy: 'max' | 'latest' = 'max'
): number | null {
  if (incoming === null) return current;
  if (current === null) return incoming;
  return strategy === 'latest' ? incoming : Math.max(current, incoming);
}

export function mergeTokenUsageMetrics(
  current: TokenUsageMetrics | null,
  incoming: TokenUsageMetrics | null
): TokenUsageMetrics | null {
  if (!current) return incoming;
  if (!incoming) return current;

  const merged: TokenUsageMetrics = {
    ...current,
    source: incoming.source,
    providerStyle:
      current.providerStyle === 'unknown' ? incoming.providerStyle : current.providerStyle,
    rawUsage: incoming.rawUsage ?? current.rawUsage,
    rawUsagePath: incoming.rawUsagePath ?? current.rawUsagePath,
    warnings: Array.from(new Set([...current.warnings, ...incoming.warnings])),
  };

  const numericKeys: Array<keyof TokenUsageMetrics> = [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cachedInputTokens',
    'cacheHitInputTokens',
    'cacheHitRateDenominatorTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'cacheCreationInputTokens5m',
    'cacheCreationInputTokens1h',
    'cacheWriteInputTokens',
    'cacheMissInputTokens',
    'reasoningTokens',
    'audioInputTokens',
    'audioOutputTokens',
    'textInputTokens',
    'textOutputTokens',
    'acceptedPredictionTokens',
    'rejectedPredictionTokens',
    'toolUsePromptTokens',
    'billableInputTokens',
    'billableOutputTokens',
    'creditUsage',
    'cost',
  ];

  for (const key of numericKeys) {
    const value = mergeNumber(
      current[key] as number | null,
      incoming[key] as number | null,
      key === 'cost' || key === 'creditUsage' ? 'latest' : 'max'
    );
    (merged as unknown as Record<string, number | null>)[key] = value;
  }

  if (
    incoming.cacheHitRate !== null &&
    (current.cacheHitRate === null ||
      (incoming.cacheHitRateDenominatorTokens ?? 0) >= (current.cacheHitRateDenominatorTokens ?? 0))
  ) {
    merged.cacheHitRate = incoming.cacheHitRate;
    merged.cacheHitRateFormula = incoming.cacheHitRateFormula;
  }

  if (merged.cacheHitInputTokens !== null && merged.cacheHitRateDenominatorTokens !== null) {
    merged.cacheHitRate = roundPercent(
      merged.cacheHitInputTokens,
      merged.cacheHitRateDenominatorTokens
    );
  }

  if (merged.totalTokens === null && merged.outputTokens !== null) {
    const effectiveInputTokens = merged.cacheHitRateDenominatorTokens ?? merged.inputTokens;
    if (effectiveInputTokens !== null) {
      merged.totalTokens = effectiveInputTokens + merged.outputTokens;
      merged.warnings.push(
        merged.cacheHitRateDenominatorTokens !== null
          ? 'totalTokens 由 cacheHitRateDenominatorTokens + outputTokens 推导'
          : 'totalTokens 由 inputTokens + outputTokens 推导'
      );
      merged.warnings = Array.from(new Set(merged.warnings));
    }
  }

  return merged;
}

export function toTokenUsageSummary(
  metrics: TokenUsageMetrics | TokenUsageSummary
): TokenUsageSummary {
  const { rawUsage: _rawUsage, ...summary } = metrics as TokenUsageMetrics;
  return summary;
}

export function extractTokenUsageFromJson(
  value: unknown,
  options: {
    source: TokenUsageSource;
    providerHint?: string;
    rawUsagePathPrefix?: string;
  }
): TokenUsageMetrics | null {
  let merged: TokenUsageMetrics | null = null;
  const candidates = collectUsageCandidates(value, options.rawUsagePathPrefix ?? '');

  for (const candidate of candidates) {
    const metrics = normalizeUsageObject({
      usage: candidate.usage,
      source: options.source,
      rawUsagePath: candidate.path,
      providerHint: options.providerHint,
    });
    merged = mergeTokenUsageMetrics(merged, metrics);
  }

  return merged;
}

export function extractTokenUsageFromResponseText(
  text: string | undefined,
  source: Extract<
    TokenUsageSource,
    'response_body' | 'response_body_after_plugins' | 'response_body_before_plugins'
  > = 'response_body',
  providerHint?: string
): TokenUsageMetrics | null {
  if (!text?.trim()) return null;
  try {
    return extractTokenUsageFromJson(JSON.parse(text), { source, providerHint });
  } catch {
    return null;
  }
}

function processSseMessage(
  dataLines: string[],
  source: Extract<TokenUsageSource, 'stream_chunk' | 'stream_file'>,
  providerHint?: string
): TokenUsageMetrics | null {
  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n').trim();
  if (!data || data === '[DONE]') return null;
  try {
    return extractTokenUsageFromJson(JSON.parse(data), {
      source,
      providerHint,
      rawUsagePathPrefix: source === 'stream_file' ? 'stream' : 'stream',
    });
  } catch {
    return null;
  }
}

export function extractTokenUsageFromSseText(
  text: string | undefined,
  source: Extract<TokenUsageSource, 'stream_chunk' | 'stream_file'> = 'stream_file',
  providerHint?: string
): TokenUsageMetrics | null {
  if (!text?.trim()) return null;

  let merged: TokenUsageMetrics | null = null;
  let dataLines: string[] = [];
  const flush = () => {
    merged = mergeTokenUsageMetrics(merged, processSseMessage(dataLines, source, providerHint));
    dataLines = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === '') {
      flush();
      continue;
    }
    if (rawLine.startsWith('data:')) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  flush();

  return merged;
}

export function createTokenUsageStreamCollector(providerHint?: string): TokenUsageStreamCollector {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let latest: TokenUsageMetrics | null = null;

  const flushMessage = () => {
    latest = mergeTokenUsageMetrics(
      latest,
      processSseMessage(dataLines, 'stream_chunk', providerHint)
    );
    dataLines = [];
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') {
      flushMessage();
      return;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  };

  return {
    addChunk(chunk: Uint8Array): void {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        processLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    },
    getUsage(): TokenUsageMetrics | null {
      buffer += decoder.decode();
      if (buffer) {
        processLine(buffer);
        buffer = '';
      }
      flushMessage();
      return latest;
    },
  };
}

function safeReadStreamFile(
  streamFile: string | undefined,
  baseDir?: string
): { content: string | null; warning: string | null } {
  if (!streamFile) return { content: null, warning: null };

  try {
    const candidates = [streamFile];
    if (baseDir) candidates.push(resolve(baseDir, streamFile));

    for (const candidate of candidates) {
      const resolved = resolve(candidate);
      if (!resolved.endsWith('.sse.raw')) continue;
      if (!existsSync(resolved)) continue;
      const stats = statSync(resolved);
      if (stats.size > MAX_STREAM_USAGE_BYTES) {
        return {
          content: null,
          warning: `stream_file 超过 ${MAX_STREAM_USAGE_BYTES} 字节，已跳过 token usage 回填`,
        };
      }
      return { content: readFileSync(resolved, 'utf-8'), warning: null };
    }
  } catch (err) {
    return {
      content: null,
      warning: `stream_file token usage 读取失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { content: null, warning: null };
}

export function extractTokenUsageFromLogEvent(
  event: TokenUsageLogEventLike,
  options: { baseDir?: string; streamContent?: string } = {}
): TokenUsageMetrics | null {
  if (event.token_usage) {
    return {
      rawUsage: null,
      ...event.token_usage,
      source: event.token_usage.source ?? 'explicit',
    } as TokenUsageMetrics;
  }

  const providerHint = [event.provider, event.route_type, event.model_in, event.model_out]
    .filter(Boolean)
    .join(' ');

  const responseBodyUsage = extractTokenUsageFromResponseText(
    event.response_body,
    'response_body',
    providerHint
  );
  if (responseBodyUsage) return responseBodyUsage;

  const responseAfterPluginsUsage = extractTokenUsageFromResponseText(
    event.response_body_after_plugins,
    'response_body_after_plugins',
    providerHint
  );
  if (responseAfterPluginsUsage) return responseAfterPluginsUsage;

  const responseBeforePluginsUsage = extractTokenUsageFromResponseText(
    event.response_body_before_plugins,
    'response_body_before_plugins',
    providerHint
  );
  if (responseBeforePluginsUsage) return responseBeforePluginsUsage;

  const streamContent =
    options.streamContent ?? safeReadStreamFile(event.stream_file, options.baseDir).content;
  return extractTokenUsageFromSseText(streamContent ?? undefined, 'stream_file', providerHint);
}

export function extractTokenUsageSummaryFromLogEvent(
  event: TokenUsageLogEventLike,
  options: { baseDir?: string; streamContent?: string } = {}
): TokenUsageSummary | null {
  const metrics = extractTokenUsageFromLogEvent(event, options);
  return metrics ? toTokenUsageSummary(metrics) : null;
}

export function enrichLogEventTokenUsage<T extends TokenUsageLogEventLike>(
  event: T,
  options: { baseDir?: string } = {}
): T {
  if (event.token_usage) return event;
  const tokenUsage = extractTokenUsageFromLogEvent(event, options);
  if (!tokenUsage) return event;
  return {
    ...event,
    token_usage: tokenUsage,
  };
}
