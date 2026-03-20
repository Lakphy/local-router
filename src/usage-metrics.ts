import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AppConfig, LogConfig } from './config';
import { resolveLogBaseDir } from './config';

export type UsageMetricsWindow = '1h' | '6h' | '24h';

export function isUsageMetricsWindow(value: string): value is UsageMetricsWindow {
  return value === '1h' || value === '6h' || value === '24h';
}

interface LogEventForUsage {
  ts_start?: string;
  provider?: string;
  model_out?: string;
  upstream_status?: number;
  error_type?: string | null;
  usage_input_tokens?: number | null;
  usage_output_tokens?: number | null;
  usage_cache_read_tokens?: number | null;
  usage_cache_creation_tokens?: number | null;
}

export interface UsageMetricsResponse {
  window: string;
  from: string;
  to: string;
  summary: {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    totalCost: number;
  };
  byProvider: Array<{
    provider: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cost: number;
  }>;
  byModel: Array<{
    provider: string;
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cost: number;
    pricing: { input: number; output: number; cacheRead: number; cacheCreation: number } | null;
    usageAvailable: boolean;
  }>;
  series: Array<{
    ts: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
}

const WINDOW_MS: Record<UsageMetricsWindow, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

const BUCKET_MS: Record<UsageMetricsWindow, number> = {
  '1h': 5 * 60 * 1000,
  '6h': 15 * 60 * 1000,
  '24h': 30 * 60 * 1000,
};

const MAX_LINES_SCANNED = 250_000;
const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  expiresAt: number;
  value: UsageMetricsResponse;
}

const usageCache = new Map<string, CacheEntry>();

interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function buildPricingMap(config: AppConfig): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const [, provider] of Object.entries(config.providers)) {
    for (const [modelName, capabilities] of Object.entries(provider.models)) {
      if (capabilities.pricing) {
        map.set(modelName, {
          input: capabilities.pricing.input ?? 0,
          output: capabilities.pricing.output ?? 0,
          cacheRead: capabilities.pricing.cacheRead ?? 0,
          cacheCreation: capabilities.pricing.cacheCreation ?? 0,
        });
      }
    }
  }
  return map;
}

function computeCost(
  pricing: ModelPricing | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number {
  if (!pricing) return 0;
  return (
    (inputTokens * pricing.input +
      outputTokens * pricing.output +
      cacheReadTokens * pricing.cacheRead +
      cacheCreationTokens * pricing.cacheCreation) /
    1_000_000
  );
}

function toDayStart(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function listDateStrings(fromMs: number, toMs: number): string[] {
  const result: string[] = [];
  for (let day = toDayStart(fromMs); day <= toDayStart(toMs); day += 24 * 60 * 60 * 1000) {
    result.push(new Date(day).toISOString().slice(0, 10));
  }
  return result;
}

function createEmptyResponse(window: UsageMetricsWindow, nowMs: number): UsageMetricsResponse {
  const fromMs = nowMs - WINDOW_MS[window];
  const bucketMs = BUCKET_MS[window];
  const bucketCount = Math.max(1, Math.ceil((nowMs - fromMs) / bucketMs));

  return {
    window,
    from: new Date(fromMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    summary: {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCost: 0,
    },
    byProvider: [],
    byModel: [],
    series: Array.from({ length: bucketCount }, (_, i) => ({
      ts: new Date(fromMs + i * bucketMs).toISOString(),
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    })),
  };
}

interface ModelAgg {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requestsWithUsage: number;
}

interface ProviderAgg {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export async function getUsageMetrics(options: {
  config: AppConfig;
  logConfig?: LogConfig;
  window?: UsageMetricsWindow;
  refresh?: boolean;
  nowMs?: number;
}): Promise<UsageMetricsResponse> {
  const window = options.window ?? '24h';
  const refresh = options.refresh === true;
  const nowMs = options.nowMs ?? Date.now();

  const logEnabled = options.logConfig?.enabled !== false && !!options.logConfig;
  if (!logEnabled) {
    return createEmptyResponse(window, nowMs);
  }

  const baseDir = resolveLogBaseDir(options.logConfig);
  const cacheKey = `usage:${baseDir}:${window}`;
  const cached = usageCache.get(cacheKey);

  if (!refresh && cached && cached.expiresAt > nowMs) {
    return cached.value;
  }

  const eventsDir = join(baseDir, 'events');
  if (!existsSync(eventsDir)) {
    const empty = createEmptyResponse(window, nowMs);
    usageCache.set(cacheKey, { expiresAt: nowMs + CACHE_TTL_MS, value: empty });
    return empty;
  }

  const fromMs = nowMs - WINDOW_MS[window];
  const bucketMs = BUCKET_MS[window];
  const bucketCount = Math.max(1, Math.ceil((nowMs - fromMs) / bucketMs));

  const buckets = Array.from({ length: bucketCount }, () => ({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  }));

  const providerAgg = new Map<string, ProviderAgg>();
  const modelAgg = new Map<string, ModelAgg>();
  const pricingMap = buildPricingMap(options.config);

  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCost = 0;
  let linesScanned = 0;

  const dateStrings = listDateStrings(fromMs, nowMs);

  for (const dateStr of dateStrings) {
    if (linesScanned >= MAX_LINES_SCANNED) break;

    const filePath = join(eventsDir, `${dateStr}.jsonl`);
    if (!existsSync(filePath)) continue;

    try {
      const stream = createReadStream(filePath, { encoding: 'utf-8' });
      const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

      for await (const line of rl) {
        if (linesScanned >= MAX_LINES_SCANNED) {
          rl.close();
          stream.destroy();
          break;
        }

        linesScanned += 1;
        if (!line.trim()) continue;

        let event: LogEventForUsage;
        try {
          event = JSON.parse(line) as LogEventForUsage;
        } catch {
          continue;
        }

        if (!event.ts_start) continue;
        const ts = Date.parse(event.ts_start);
        if (!Number.isFinite(ts) || ts < fromMs || ts > nowMs) continue;

        // Skip error events (network errors / non-2xx)
        if (event.error_type) continue;
        const status = event.upstream_status ?? 0;
        if (status < 200 || status >= 300) continue;

        const rawInput = event.usage_input_tokens;
        const rawOutput = event.usage_output_tokens;
        const hasUsage = rawInput !== null || rawOutput !== null;

        const inputTokens = Math.max(0, rawInput ?? 0);
        const outputTokens = Math.max(0, rawOutput ?? 0);
        const cacheReadTokens = Math.max(0, event.usage_cache_read_tokens ?? 0);
        const cacheCreationTokens = Math.max(0, event.usage_cache_creation_tokens ?? 0);

        const providerKey = event.provider || 'unknown';
        const modelKey = event.model_out || 'unknown';
        const pricing = pricingMap.get(modelKey);
        const cost = computeCost(
          pricing,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens
        );

        totalRequests += 1;
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        totalCacheReadTokens += cacheReadTokens;
        totalCacheCreationTokens += cacheCreationTokens;
        totalCost += cost;

        // Bucket
        const bucketIndex = Math.min(
          bucketCount - 1,
          Math.max(0, Math.floor((ts - fromMs) / bucketMs))
        );
        const bucket = buckets[bucketIndex];
        bucket.requests += 1;
        bucket.inputTokens += inputTokens;
        bucket.outputTokens += outputTokens;
        bucket.cost += cost;

        // Provider aggregation
        const prov = providerAgg.get(providerKey) ?? {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        prov.requests += 1;
        prov.inputTokens += inputTokens;
        prov.outputTokens += outputTokens;
        prov.cacheReadTokens += cacheReadTokens;
        prov.cacheCreationTokens += cacheCreationTokens;
        providerAgg.set(providerKey, prov);

        // Model aggregation
        const modelAggKey = `${providerKey}:${modelKey}`;
        const mod = modelAgg.get(modelAggKey) ?? {
          provider: providerKey,
          model: modelKey,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          requestsWithUsage: 0,
        };
        mod.requests += 1;
        mod.inputTokens += inputTokens;
        mod.outputTokens += outputTokens;
        mod.cacheReadTokens += cacheReadTokens;
        mod.cacheCreationTokens += cacheCreationTokens;
        if (hasUsage) mod.requestsWithUsage += 1;
        modelAgg.set(modelAggKey, mod);
      }
    } catch {
      // skip file read errors
    }
  }

  const byProvider = Array.from(providerAgg.entries())
    .map(([provider, agg]) => {
      let providerCost = 0;
      for (const [, mod] of modelAgg.entries()) {
        if (mod.provider === provider) {
          const p = pricingMap.get(mod.model);
          providerCost += computeCost(
            p,
            mod.inputTokens,
            mod.outputTokens,
            mod.cacheReadTokens,
            mod.cacheCreationTokens
          );
        }
      }
      return { provider, ...agg, cost: providerCost };
    })
    .sort((a, b) => b.requests - a.requests);

  const byModel = Array.from(modelAgg.values())
    .map((mod) => {
      const pricing = pricingMap.get(mod.model);
      const cost = computeCost(
        pricing,
        mod.inputTokens,
        mod.outputTokens,
        mod.cacheReadTokens,
        mod.cacheCreationTokens
      );
      return {
        ...mod,
        cost,
        pricing: pricing
          ? {
              input: pricing.input,
              output: pricing.output,
              cacheRead: pricing.cacheRead,
              cacheCreation: pricing.cacheCreation,
            }
          : null,
        usageAvailable: mod.requestsWithUsage > 0,
      };
    })
    .sort((a, b) => b.requests - a.requests);

  const series = buckets.map((bucket, index) => ({
    ts: new Date(fromMs + index * bucketMs).toISOString(),
    requests: bucket.requests,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cost: Number(bucket.cost.toFixed(6)),
  }));

  const response: UsageMetricsResponse = {
    window,
    from: new Date(fromMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    summary: {
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalCost: Number(totalCost.toFixed(6)),
    },
    byProvider,
    byModel,
    series,
  };

  usageCache.set(cacheKey, {
    expiresAt: nowMs + CACHE_TTL_MS,
    value: response,
  });

  return response;
}
