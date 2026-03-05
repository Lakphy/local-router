import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { LogConfig } from './config';
import { resolveLogBaseDir } from './config';

export type LogMetricsWindow = '1h' | '6h' | '24h';

interface LogEventForMetrics {
  ts_start?: string;
  latency_ms?: number;
  upstream_status?: number;
  provider?: string;
  route_type?: string;
  request_bytes?: number;
  response_bytes?: number | null;
  stream_bytes?: number | null;
  error_type?: string | null;
}

interface AggregateRow {
  requests: number;
  errors: number;
  latencySum: number;
}

export interface LogMetricsSeriesPoint {
  ts: string;
  requests: number;
  errors: number;
  avgLatencyMs: number;
}

export interface LogMetricsResponse {
  window: LogMetricsWindow;
  from: string;
  to: string;
  generatedAt: string;
  source: {
    logEnabled: boolean;
    baseDir: string | null;
    filesScanned: number;
    linesScanned: number;
    partial: boolean;
  };
  summary: {
    totalRequests: number;
    successRequests: number;
    errorRequests: number;
    successRate: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    totalRequestBytes: number;
    totalResponseBytes: number;
  };
  series: LogMetricsSeriesPoint[];
  topProviders: Array<{ key: string; requests: number; errorRate: number; avgLatencyMs: number }>;
  topRouteTypes: Array<{ key: string; requests: number; errorRate: number }>;
  statusClasses: {
    '2xx': number;
    '4xx': number;
    '5xx': number;
    network_error: number;
  };
  warnings: string[];
}

const WINDOW_MS: Record<LogMetricsWindow, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

const BUCKET_MS: Record<LogMetricsWindow, number> = {
  '1h': 5 * 60 * 1000,
  '6h': 15 * 60 * 1000,
  '24h': 30 * 60 * 1000,
};

const TOP_LIMIT = 5;
const MAX_LINES_SCANNED = 250_000;
const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  expiresAt: number;
  value: LogMetricsResponse;
}

const metricsCache = new Map<string, CacheEntry>();

export function isLogMetricsWindow(value: string): value is LogMetricsWindow {
  return value === '1h' || value === '6h' || value === '24h';
}

function toPercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
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

function getStatusClass(event: LogEventForMetrics): '2xx' | '4xx' | '5xx' | 'network_error' {
  if (event.error_type) return 'network_error';
  const status = event.upstream_status ?? 0;
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500) return '5xx';
  return 'network_error';
}

function isErrorEvent(event: LogEventForMetrics): boolean {
  if (event.error_type) return true;
  const status = event.upstream_status ?? 0;
  return status < 200 || status >= 400;
}

function percentile(sortedNumbers: number[], ratio: number): number {
  if (sortedNumbers.length === 0) return 0;
  const index = Math.min(sortedNumbers.length - 1, Math.ceil(sortedNumbers.length * ratio) - 1);
  return Math.round(sortedNumbers[index]);
}

function createEmptyMetrics(
  window: LogMetricsWindow,
  nowMs: number,
  source: LogMetricsResponse['source'],
  warnings: string[] = []
): LogMetricsResponse {
  const fromMs = nowMs - WINDOW_MS[window];
  const bucketMs = BUCKET_MS[window];
  const bucketCount = Math.max(1, Math.ceil((nowMs - fromMs) / bucketMs));

  const series: LogMetricsSeriesPoint[] = Array.from({ length: bucketCount }, (_, i) => ({
    ts: new Date(fromMs + i * bucketMs).toISOString(),
    requests: 0,
    errors: 0,
    avgLatencyMs: 0,
  }));

  return {
    window,
    from: new Date(fromMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    generatedAt: new Date(nowMs).toISOString(),
    source,
    summary: {
      totalRequests: 0,
      successRequests: 0,
      errorRequests: 0,
      successRate: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      totalRequestBytes: 0,
      totalResponseBytes: 0,
    },
    series,
    topProviders: [],
    topRouteTypes: [],
    statusClasses: {
      '2xx': 0,
      '4xx': 0,
      '5xx': 0,
      network_error: 0,
    },
    warnings,
  };
}

export async function getLogMetrics(options: {
  logConfig?: LogConfig;
  window?: LogMetricsWindow;
  refresh?: boolean;
  nowMs?: number;
}): Promise<LogMetricsResponse> {
  const window = options.window ?? '24h';
  const refresh = options.refresh === true;
  const nowMs = options.nowMs ?? Date.now();

  const logEnabled = options.logConfig?.enabled !== false && !!options.logConfig;
  if (!logEnabled) {
    return createEmptyMetrics(
      window,
      nowMs,
      {
        logEnabled: false,
        baseDir: null,
        filesScanned: 0,
        linesScanned: 0,
        partial: false,
      },
      ['日志未启用']
    );
  }

  const baseDir = resolveLogBaseDir(options.logConfig);
  const cacheKey = `${baseDir}:${window}`;
  const cached = metricsCache.get(cacheKey);

  if (!refresh && cached && cached.expiresAt > nowMs) {
    return cached.value;
  }

  const eventsDir = join(baseDir, 'events');
  if (!existsSync(eventsDir)) {
    const empty = createEmptyMetrics(
      window,
      nowMs,
      {
        logEnabled: true,
        baseDir,
        filesScanned: 0,
        linesScanned: 0,
        partial: false,
      },
      ['日志目录不存在，暂无可分析数据']
    );
    metricsCache.set(cacheKey, { expiresAt: nowMs + CACHE_TTL_MS, value: empty });
    return empty;
  }

  const fromMs = nowMs - WINDOW_MS[window];
  const bucketMs = BUCKET_MS[window];
  const bucketCount = Math.max(1, Math.ceil((nowMs - fromMs) / bucketMs));

  const buckets = Array.from({ length: bucketCount }, () => ({
    requests: 0,
    errors: 0,
    latencySum: 0,
    latencyCount: 0,
  }));

  const providerAgg = new Map<string, AggregateRow>();
  const routeTypeAgg = new Map<string, AggregateRow>();
  const latencies: number[] = [];

  const statusClasses: LogMetricsResponse['statusClasses'] = {
    '2xx': 0,
    '4xx': 0,
    '5xx': 0,
    network_error: 0,
  };

  let filesScanned = 0;
  let linesScanned = 0;
  let parseErrors = 0;
  let partial = false;

  let totalRequests = 0;
  let successRequests = 0;
  let errorRequests = 0;
  let totalLatency = 0;
  let totalRequestBytes = 0;
  let totalResponseBytes = 0;

  const warnings: string[] = [];
  const dateStrings = listDateStrings(fromMs, nowMs);

  for (const dateStr of dateStrings) {
    if (linesScanned >= MAX_LINES_SCANNED) {
      partial = true;
      break;
    }

    const filePath = join(eventsDir, `${dateStr}.jsonl`);
    if (!existsSync(filePath)) continue;

    filesScanned += 1;

    try {
      const stream = createReadStream(filePath, { encoding: 'utf-8' });
      const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

      for await (const line of rl) {
        if (linesScanned >= MAX_LINES_SCANNED) {
          partial = true;
          rl.close();
          stream.destroy();
          break;
        }

        linesScanned += 1;
        if (!line.trim()) continue;

        let event: LogEventForMetrics;
        try {
          event = JSON.parse(line) as LogEventForMetrics;
        } catch {
          parseErrors += 1;
          continue;
        }

        if (!event.ts_start) continue;
        const ts = Date.parse(event.ts_start);
        if (!Number.isFinite(ts) || ts < fromMs || ts > nowMs) continue;

        totalRequests += 1;

        const isError = isErrorEvent(event);
        if (isError) {
          errorRequests += 1;
        } else {
          successRequests += 1;
        }

        const latency = Number.isFinite(event.latency_ms) ? Math.max(0, event.latency_ms ?? 0) : 0;
        totalLatency += latency;
        latencies.push(latency);

        totalRequestBytes += Math.max(0, event.request_bytes ?? 0);
        totalResponseBytes +=
          Math.max(0, event.response_bytes ?? 0) + Math.max(0, event.stream_bytes ?? 0);

        const bucketIndex = Math.min(
          bucketCount - 1,
          Math.max(0, Math.floor((ts - fromMs) / bucketMs))
        );
        const bucket = buckets[bucketIndex];
        bucket.requests += 1;
        bucket.latencySum += latency;
        bucket.latencyCount += 1;
        if (isError) bucket.errors += 1;

        const providerKey = event.provider || 'unknown';
        const providerRow = providerAgg.get(providerKey) ?? {
          requests: 0,
          errors: 0,
          latencySum: 0,
        };
        providerRow.requests += 1;
        providerRow.latencySum += latency;
        if (isError) providerRow.errors += 1;
        providerAgg.set(providerKey, providerRow);

        const routeTypeKey = event.route_type || 'unknown';
        const routeTypeRow = routeTypeAgg.get(routeTypeKey) ?? {
          requests: 0,
          errors: 0,
          latencySum: 0,
        };
        routeTypeRow.requests += 1;
        routeTypeRow.latencySum += latency;
        if (isError) routeTypeRow.errors += 1;
        routeTypeAgg.set(routeTypeKey, routeTypeRow);

        statusClasses[getStatusClass(event)] += 1;
      }
    } catch (err) {
      warnings.push(
        `读取日志文件失败: ${filePath} (${err instanceof Error ? err.message : String(err)})`
      );
      partial = true;
    }
  }

  if (parseErrors > 0) {
    warnings.push(`已跳过 ${parseErrors} 行无效 JSON 日志`);
  }
  if (partial) {
    warnings.push('日志扫描已部分截断，结果可能不完整');
  }

  latencies.sort((a, b) => a - b);

  const series: LogMetricsSeriesPoint[] = buckets.map((bucket, index) => ({
    ts: new Date(fromMs + index * bucketMs).toISOString(),
    requests: bucket.requests,
    errors: bucket.errors,
    avgLatencyMs: bucket.latencyCount > 0 ? Math.round(bucket.latencySum / bucket.latencyCount) : 0,
  }));

  const topProviders = Array.from(providerAgg.entries())
    .map(([key, row]) => ({
      key,
      requests: row.requests,
      errorRate: toPercent(row.errors, row.requests),
      avgLatencyMs: row.requests > 0 ? Math.round(row.latencySum / row.requests) : 0,
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, TOP_LIMIT);

  const topRouteTypes = Array.from(routeTypeAgg.entries())
    .map(([key, row]) => ({
      key,
      requests: row.requests,
      errorRate: toPercent(row.errors, row.requests),
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, TOP_LIMIT);

  const response: LogMetricsResponse = {
    window,
    from: new Date(fromMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    generatedAt: new Date(nowMs).toISOString(),
    source: {
      logEnabled: true,
      baseDir,
      filesScanned,
      linesScanned,
      partial,
    },
    summary: {
      totalRequests,
      successRequests,
      errorRequests,
      successRate: toPercent(successRequests, totalRequests),
      avgLatencyMs: totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0,
      p95LatencyMs: percentile(latencies, 0.95),
      totalRequestBytes,
      totalResponseBytes,
    },
    series,
    topProviders,
    topRouteTypes,
    statusClasses,
    warnings,
  };

  metricsCache.set(cacheKey, {
    expiresAt: nowMs + CACHE_TTL_MS,
    value: response,
  });

  return response;
}
