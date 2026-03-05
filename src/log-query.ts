import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { LogConfig, ProviderType } from './config';
import { resolveLogBaseDir } from './config';
import { resolveLogSessionIdentity } from './log-session-identity';
import type { LogEvent } from './logger';

export type LogQueryWindow = '1h' | '6h' | '24h';
export type LogSort = 'time_desc' | 'time_asc';
export type LogLevel = 'info' | 'error';
export type StatusClass = '2xx' | '4xx' | '5xx' | 'network_error';

const WINDOW_MS: Record<LogQueryWindow, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

const MAX_LINES_SCANNED = 250_000;
const MAX_QUERY_LIMIT = 200;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_EXPORT_ROWS = 5_000;
const MAX_Q_LENGTH = 200;

const SENSITIVE_FIELD_PATTERN =
  /(authorization|token|cookie|password|passphrase|secret|api[_-]?key)/i;

interface LocatedLogEvent {
  id: string;
  date: string;
  line: number;
  ts: number;
  level: LogLevel;
  statusClass: StatusClass;
  event: LogEvent;
}

export interface LogEventSummary {
  id: string;
  ts: string;
  level: LogLevel;
  provider: string;
  routeType: string;
  model: string;
  modelIn: string;
  modelOut: string;
  path: string;
  requestId: string;
  latencyMs: number;
  upstreamStatus: number;
  statusClass: StatusClass;
  hasError: boolean;
  message: string;
  errorType: string | null;
  hasMetadata: boolean;
  userIdRaw: string | null;
  userKey: string | null;
  sessionId: string | null;
}

export interface LogQueryStats {
  total: number;
  errorCount: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface LogQueryMeta {
  scannedFiles: number;
  scannedLines: number;
  parseErrors: number;
  truncated: boolean;
}

export interface LogQueryResult {
  items: LogEventSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  stats: LogQueryStats;
  meta: LogQueryMeta;
}

export interface LogEventDetail {
  id: string;
  summary: {
    id: string;
    ts: string;
    level: LogLevel;
    provider: string;
    routeType: string;
    routeRuleKey: string;
    requestId: string;
    latencyMs: number;
    upstreamStatus: number;
    statusClass: StatusClass;
    hasError: boolean;
    model: string;
    modelIn: string;
    modelOut: string;
  };
  request: {
    method: string;
    path: string;
    contentType: string | null;
    requestHeadersMasked: Record<string, string>;
    requestBody: unknown | null;
  };
  response: {
    upstreamStatus: number;
    contentType: string | null;
    responseHeaders: Record<string, string>;
    responseBody: string | null;
  };
  upstream: {
    targetUrl: string;
    providerRequestId: string | null;
    errorType: string | null;
    errorMessage: string | null;
    isStream: boolean;
    streamFile: string | null;
    streamContent: string | null;
  };
  capture: {
    bodyPolicy: 'off' | 'masked' | 'full' | 'unknown';
    requestBodyAvailable: boolean;
    responseBodyAvailable: boolean;
    streamCaptured: boolean;
    truncatedHints: string[];
  };
  rawEvent: unknown;
  location: {
    date: string;
    line: number;
    file: string;
  };
}

export interface LogQueryParams {
  fromMs: number;
  toMs: number;
  levels: LogLevel[];
  providers: string[];
  routeTypes: ProviderType[] | string[];
  models: string[];
  modelIns: string[];
  modelOuts: string[];
  users: string[];
  sessions: string[];
  statusClasses: StatusClass[];
  hasError: boolean | null;
  q: string;
  sort: LogSort;
  limit: number;
  cursor: string | null;
}

export interface NormalizedLogQueryInput {
  fromMs: number;
  toMs: number;
  levels?: LogLevel[];
  providers?: string[];
  routeTypes?: string[];
  models?: string[];
  modelIns?: string[];
  modelOuts?: string[];
  users?: string[];
  sessions?: string[];
  statusClasses?: StatusClass[];
  hasError?: boolean | null;
  q?: string;
  sort?: LogSort;
  limit?: number;
  cursor?: string | null;
}

export interface LogQueryContext {
  logConfig?: LogConfig;
}

interface CursorData {
  offset: number;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf-8');
}

function encodeCursor(data: CursorData): string {
  return encodeBase64Url(JSON.stringify(data));
}

function decodeCursor(raw: string): CursorData {
  const parsed = JSON.parse(decodeBase64Url(raw)) as CursorData;
  if (!Number.isInteger(parsed.offset) || parsed.offset < 0) {
    throw new Error('cursor 非法');
  }
  return parsed;
}

function encodeEventId(date: string, line: number): string {
  return encodeBase64Url(JSON.stringify({ d: date, l: line }));
}

function decodeEventId(id: string): { date: string; line: number } {
  const parsed = JSON.parse(decodeBase64Url(id)) as { d?: unknown; l?: unknown };
  if (typeof parsed.d !== 'string' || !Number.isInteger(parsed.l) || Number(parsed.l) <= 0) {
    throw new Error('id 非法');
  }
  return { date: parsed.d, line: Number(parsed.l) };
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

function getStatusClass(event: LogEvent): StatusClass {
  if (event.error_type) return 'network_error';
  const status = event.upstream_status ?? 0;
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500) return '5xx';
  return 'network_error';
}

function isErrorEvent(event: LogEvent): boolean {
  if (event.error_type) return true;
  const status = event.upstream_status ?? 0;
  return status < 200 || status >= 400;
}

function getLevel(event: LogEvent): LogLevel {
  return isErrorEvent(event) ? 'error' : 'info';
}

function buildMessage(event: LogEvent): string {
  if (event.error_message) return event.error_message;
  if (event.error_type) return event.error_type;
  const status = event.upstream_status ?? 0;
  return `${event.method} ${event.path} -> ${status}`;
}

function containsKeyword(event: LogEvent, q: string): boolean {
  if (!q) return true;
  const identity = resolveLogSessionIdentity(event.request_body);
  const keyword = q.toLowerCase();
  const haystack = [
    event.request_id,
    event.path,
    event.provider,
    event.model_in,
    event.model_out,
    event.route_type,
    identity.userIdRaw ?? '',
    identity.userKey ?? '',
    identity.sessionId ?? '',
    event.error_type ?? '',
    event.error_message ?? '',
    buildMessage(event),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(keyword);
}

interface RunningStats {
  total: number;
  errorCount: number;
  latencySum: number;
  latencyCounts: Map<number, number>;
}

function createRunningStats(): RunningStats {
  return {
    total: 0,
    errorCount: 0,
    latencySum: 0,
    latencyCounts: new Map(),
  };
}

function updateRunningStats(stats: RunningStats, item: LocatedLogEvent): void {
  stats.total += 1;
  if (item.level === 'error') {
    stats.errorCount += 1;
  }

  const latency = Math.max(0, item.event.latency_ms ?? 0);
  stats.latencySum += latency;
  const roundedLatency = Math.round(latency);
  stats.latencyCounts.set(roundedLatency, (stats.latencyCounts.get(roundedLatency) ?? 0) + 1);
}

function percentileFromCounts(latencyCounts: Map<number, number>, total: number, ratio: number): number {
  if (total <= 0 || latencyCounts.size === 0) return 0;
  const targetRank = Math.max(1, Math.ceil(total * ratio));
  const sorted = [...latencyCounts.entries()].sort((a, b) => a[0] - b[0]);
  let accumulated = 0;

  for (const [latency, count] of sorted) {
    accumulated += count;
    if (accumulated >= targetRank) {
      return latency;
    }
  }

  return sorted[sorted.length - 1]?.[0] ?? 0;
}

function finalizeStats(stats: RunningStats): LogQueryStats {
  if (stats.total === 0) {
    return {
      total: 0,
      errorCount: 0,
      errorRate: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
    };
  }

  return {
    total: stats.total,
    errorCount: stats.errorCount,
    errorRate: toPercent(stats.errorCount, stats.total),
    avgLatencyMs: Math.round(stats.latencySum / stats.total),
    p95LatencyMs: percentileFromCounts(stats.latencyCounts, stats.total, 0.95),
  };
}

function compareLocatedEvents(a: LocatedLogEvent, b: LocatedLogEvent, sort: LogSort): number {
  if (a.ts !== b.ts) {
    return sort === 'time_asc' ? a.ts - b.ts : b.ts - a.ts;
  }
  return sort === 'time_asc'
    ? a.event.request_id.localeCompare(b.event.request_id)
    : b.event.request_id.localeCompare(a.event.request_id);
}

function insertBoundedEvent(
  items: LocatedLogEvent[],
  item: LocatedLogEvent,
  sort: LogSort,
  maxKeep: number
): void {
  if (maxKeep <= 0) return;

  items.push(item);
  items.sort((a, b) => compareLocatedEvents(a, b, sort));
  if (items.length > maxKeep) {
    items.pop();
  }
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_QUERY_LIMIT;
  const integer = Math.floor(limit as number);
  if (integer <= 0) return DEFAULT_QUERY_LIMIT;
  return Math.min(MAX_QUERY_LIMIT, integer);
}

function normalizeQuery(input: NormalizedLogQueryInput): LogQueryParams {
  const sort = input.sort ?? 'time_desc';
  const limit = clampLimit(input.limit);
  const qRaw = (input.q ?? '').trim();
  const q = qRaw.length > MAX_Q_LENGTH ? qRaw.slice(0, MAX_Q_LENGTH) : qRaw;

  return {
    fromMs: input.fromMs,
    toMs: input.toMs,
    levels: input.levels ?? [],
    providers: (input.providers ?? []).map((item) => item.trim()).filter(Boolean),
    routeTypes: (input.routeTypes ?? []).map((item) => item.trim()).filter(Boolean),
    models: (input.models ?? []).map((item) => item.trim()).filter(Boolean),
    modelIns: (input.modelIns ?? []).map((item) => item.trim()).filter(Boolean),
    modelOuts: (input.modelOuts ?? []).map((item) => item.trim()).filter(Boolean),
    users: (input.users ?? []).map((item) => item.trim()).filter(Boolean),
    sessions: (input.sessions ?? []).map((item) => item.trim()).filter(Boolean),
    statusClasses: input.statusClasses ?? [],
    hasError: input.hasError ?? null,
    q,
    sort,
    limit,
    cursor: input.cursor ?? null,
  };
}

function eventToSummary(item: LocatedLogEvent): LogEventSummary {
  const { event } = item;
  const identity = resolveLogSessionIdentity(event.request_body);
  return {
    id: item.id,
    ts: event.ts_start,
    level: item.level,
    provider: event.provider,
    routeType: event.route_type,
    model: event.model_out || event.model_in,
    modelIn: event.model_in,
    modelOut: event.model_out,
    path: event.path,
    requestId: event.request_id,
    latencyMs: Math.max(0, event.latency_ms ?? 0),
    upstreamStatus: event.upstream_status ?? 0,
    statusClass: item.statusClass,
    hasError: item.level === 'error',
    message: buildMessage(event),
    errorType: event.error_type,
    hasMetadata: identity.hasMetadata,
    userIdRaw: identity.userIdRaw,
    userKey: identity.userKey,
    sessionId: identity.sessionId,
  };
}

function maskValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > 4 ? `${value.slice(0, 2)}****` : '****';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return '****';
  }
  return '****';
}

function maskSensitiveDeep(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveDeep(item, parentKey));
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_PATTERN.test(key) || SENSITIVE_FIELD_PATTERN.test(parentKey)) {
        output[key] = maskValue(child);
      } else {
        output[key] = maskSensitiveDeep(child, key);
      }
    }
    return output;
  }

  return value;
}

function detectBodyPolicy(event: LogEvent): 'off' | 'masked' | 'full' | 'unknown' {
  const hasRequestBody = event.request_body !== undefined;
  const hasResponseBody = event.response_body !== undefined;

  if (!hasRequestBody && !hasResponseBody) return 'off';

  if (hasResponseBody) {
    const sample = String(event.response_body ?? '');
    if (sample.includes('****')) return 'masked';
    return 'full';
  }

  const serialized = JSON.stringify(event.request_body);
  if (typeof serialized === 'string' && serialized.includes('****')) return 'masked';

  if (hasRequestBody) return 'full';
  return 'unknown';
}

function buildTruncatedHints(
  event: LogEvent,
  bodyPolicy: 'off' | 'masked' | 'full' | 'unknown'
): string[] {
  const hints: string[] = [];

  if (bodyPolicy === 'off') {
    hints.push('bodyPolicy=off，request/response body 未采集。');
  }

  if (event.request_body === undefined) {
    hints.push('request body 不可用。');
  }

  if (event.response_body === undefined) {
    hints.push('response body 不可用。');
  }

  if (event.stream_file?.endsWith('.sse.raw')) {
    hints.push('stream 文件可能因 maxBytesPerRequest 被截断，尾部会包含 [TRUNCATED] 标记。');
  }

  if (event.is_stream && !event.stream_file) {
    hints.push('本次为流式请求，但未生成 stream 文件（可能是 streams.enabled=false 或写入失败）。');
  }

  if (!event.is_stream) {
    hints.push('非流式请求，无 stream 数据。');
  }

  if (event.is_stream && event.stream_bytes != null && event.stream_bytes > 0) {
    hints.push(`已记录 stream 字节数: ${event.stream_bytes}`);
  }

  return hints;
}

function readStreamContent(
  baseDir: string,
  streamFile: string | null | undefined
): { content: string | null; warning: string | null } {
  if (!streamFile) return { content: null, warning: null };

  try {
    const resolvedBase = resolve(baseDir);
    const resolvedFromFile = resolve(streamFile);
    const looksLikeStreamFile = resolvedFromFile.endsWith('.sse.raw');

    if (!looksLikeStreamFile) {
      return { content: null, warning: 'stream_file 不是 .sse.raw 文件，已跳过读取。' };
    }

    if (existsSync(resolvedFromFile)) {
      return { content: readFileSync(resolvedFromFile, 'utf-8'), warning: null };
    }

    const fallbackPath = resolve(resolvedBase, streamFile);
    if (!fallbackPath.startsWith(`${resolvedBase}/`) && fallbackPath !== resolvedBase) {
      return { content: null, warning: 'stream_file 路径非法，已拒绝读取。' };
    }
    if (!existsSync(fallbackPath)) {
      return { content: null, warning: 'stream_file 不存在，可能已被清理。' };
    }

    return { content: readFileSync(fallbackPath, 'utf-8'), warning: null };
  } catch (err) {
    return {
      content: null,
      warning: `stream_file 读取失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function buildLogEventDetail(
  id: string,
  parsed: LogEvent,
  location: { date: string; line: number; file: string },
  context: LogQueryContext
): Promise<LogEventDetail> {
  const maskedEvent = maskSensitiveDeep(parsed) as LogEvent;
  const level = getLevel(maskedEvent);
  const statusClass = getStatusClass(maskedEvent);
  const bodyPolicy = detectBodyPolicy(maskedEvent);
  const requestBodyAvailable = maskedEvent.request_body !== undefined;
  const responseBodyAvailable = maskedEvent.response_body !== undefined;
  const streamCaptured = Boolean(maskedEvent.stream_file);
  const { content: streamContent, warning: streamWarning } = readStreamContent(
    resolveLogBaseDir(context.logConfig),
    maskedEvent.stream_file
  );

  return {
    id,
    summary: {
      id,
      ts: maskedEvent.ts_start,
      level,
      provider: maskedEvent.provider,
      routeType: maskedEvent.route_type,
      routeRuleKey: maskedEvent.route_rule_key,
      requestId: maskedEvent.request_id,
      latencyMs: Math.max(0, maskedEvent.latency_ms ?? 0),
      upstreamStatus: maskedEvent.upstream_status ?? 0,
      statusClass,
      hasError: level === 'error',
      model: maskedEvent.model_out || maskedEvent.model_in,
      modelIn: maskedEvent.model_in,
      modelOut: maskedEvent.model_out,
    },
    request: {
      method: maskedEvent.method,
      path: maskedEvent.path,
      contentType: maskedEvent.content_type_req,
      requestHeadersMasked: maskedEvent.request_headers_masked,
      requestBody: maskedEvent.request_body ?? null,
    },
    response: {
      upstreamStatus: maskedEvent.upstream_status ?? 0,
      contentType: maskedEvent.content_type_res,
      responseHeaders: maskedEvent.response_headers,
      responseBody: maskedEvent.response_body ?? null,
    },
    upstream: {
      targetUrl: maskedEvent.target_url,
      providerRequestId: maskedEvent.provider_request_id,
      errorType: maskedEvent.error_type,
      errorMessage: maskedEvent.error_message,
      isStream: maskedEvent.is_stream,
      streamFile: maskedEvent.stream_file ?? null,
      streamContent,
    },
    capture: {
      bodyPolicy: context.logConfig?.bodyPolicy ?? bodyPolicy,
      requestBodyAvailable,
      responseBodyAvailable,
      streamCaptured,
      truncatedHints: [
        ...buildTruncatedHints(maskedEvent, context.logConfig?.bodyPolicy ?? bodyPolicy),
        ...(streamWarning ? [streamWarning] : []),
      ],
    },
    rawEvent: maskedEvent,
    location,
  };
}

async function scanEvents(
  baseDir: string,
  query: LogQueryParams
): Promise<{
  items: LocatedLogEvent[];
  stats: LogQueryStats;
  meta: LogQueryMeta;
}> {
  const eventsDir = join(baseDir, 'events');
  if (!existsSync(eventsDir)) {
    return {
      items: [],
      stats: {
        total: 0,
        errorCount: 0,
        errorRate: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
      },
      meta: {
        scannedFiles: 0,
        scannedLines: 0,
        parseErrors: 0,
        truncated: false,
      },
    };
  }

  const dates = listDateStrings(query.fromMs, query.toMs);
  const offset = query.cursor ? decodeCursor(query.cursor).offset : 0;
  const maxKeep = offset + query.limit;
  const items: LocatedLogEvent[] = [];
  const runningStats = createRunningStats();

  let scannedFiles = 0;
  let scannedLines = 0;
  let parseErrors = 0;
  let truncated = false;

  for (const date of dates) {
    if (scannedLines >= MAX_LINES_SCANNED) {
      truncated = true;
      break;
    }

    const filePath = join(eventsDir, `${date}.jsonl`);
    if (!existsSync(filePath)) continue;

    scannedFiles += 1;
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber += 1;
      if (scannedLines >= MAX_LINES_SCANNED) {
        truncated = true;
        rl.close();
        stream.destroy();
        break;
      }

      scannedLines += 1;
      if (!line.trim()) continue;

      let event: LogEvent;
      try {
        event = JSON.parse(line) as LogEvent;
      } catch {
        parseErrors += 1;
        continue;
      }

      if (!event.ts_start) continue;
      const ts = Date.parse(event.ts_start);
      if (!Number.isFinite(ts) || ts < query.fromMs || ts > query.toMs) continue;

      const level = getLevel(event);
      const statusClass = getStatusClass(event);

      if (query.levels.length > 0 && !query.levels.includes(level)) continue;
      if (query.providers.length > 0 && !query.providers.includes(event.provider)) continue;
      if (query.routeTypes.length > 0 && !query.routeTypes.includes(event.route_type)) continue;

      const eventModel = event.model_out || event.model_in;
      if (query.models.length > 0 && !query.models.includes(eventModel)) continue;
      if (query.modelIns.length > 0 && !query.modelIns.includes(event.model_in)) continue;
      if (query.modelOuts.length > 0 && !query.modelOuts.includes(event.model_out)) continue;

      const identity = resolveLogSessionIdentity(event.request_body);
      if (query.users.length > 0) {
        const matchedByRaw = identity.userIdRaw ? query.users.includes(identity.userIdRaw) : false;
        const matchedByUserKey = identity.userKey ? query.users.includes(identity.userKey) : false;
        if (!matchedByRaw && !matchedByUserKey) continue;
      }
      if (query.sessions.length > 0) {
        if (!identity.sessionId || !query.sessions.includes(identity.sessionId)) continue;
      }

      if (query.statusClasses.length > 0 && !query.statusClasses.includes(statusClass)) continue;

      const hasError = level === 'error';
      if (query.hasError !== null && query.hasError !== hasError) continue;
      if (!containsKeyword(event, query.q)) continue;

      const located: LocatedLogEvent = {
        id: encodeEventId(date, lineNumber),
        date,
        line: lineNumber,
        ts,
        level,
        statusClass,
        event,
      };

      updateRunningStats(runningStats, located);
      insertBoundedEvent(items, located, query.sort, maxKeep);
    }
  }

  return {
    items,
    stats: finalizeStats(runningStats),
    meta: {
      scannedFiles,
      scannedLines,
      parseErrors,
      truncated,
    },
  };
}

export function isLogQueryWindow(value: string): value is LogQueryWindow {
  return value === '1h' || value === '6h' || value === '24h';
}

export function resolveLogQueryRange(input: {
  window?: LogQueryWindow;
  from?: string;
  to?: string;
  nowMs?: number;
}): { fromMs: number; toMs: number } {
  const nowMs = input.nowMs ?? Date.now();

  const hasFrom = !!input.from;
  const hasTo = !!input.to;

  if (hasFrom || hasTo) {
    const fromMs = Date.parse(input.from ?? '');
    const toMs = Date.parse(input.to ?? '');

    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new Error('from/to 必须为合法 ISO 时间');
    }
    if (fromMs > toMs) {
      throw new Error('from 不能晚于 to');
    }
    return { fromMs, toMs };
  }

  const window = input.window ?? '24h';
  return {
    fromMs: nowMs - WINDOW_MS[window],
    toMs: nowMs,
  };
}

export function validateLogLevel(value: string): value is LogLevel {
  return value === 'info' || value === 'error';
}

export function validateStatusClass(value: string): value is StatusClass {
  return value === '2xx' || value === '4xx' || value === '5xx' || value === 'network_error';
}

export function validateSort(value: string): value is LogSort {
  return value === 'time_desc' || value === 'time_asc';
}

export async function queryLogEvents(
  context: LogQueryContext,
  input: NormalizedLogQueryInput
): Promise<LogQueryResult> {
  const logEnabled = !!context.logConfig && context.logConfig.enabled !== false;
  if (!logEnabled) {
    return {
      items: [],
      nextCursor: null,
      hasMore: false,
      stats: {
        total: 0,
        errorCount: 0,
        errorRate: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
      },
      meta: {
        scannedFiles: 0,
        scannedLines: 0,
        parseErrors: 0,
        truncated: false,
      },
    };
  }

  const baseDir = resolveLogBaseDir(context.logConfig);
  const query = normalizeQuery(input);
  const offset = query.cursor ? decodeCursor(query.cursor).offset : 0;

  const scanned = await scanEvents(baseDir, query);

  const pageItems = scanned.items.slice(offset, offset + query.limit);
  const hasMore = scanned.stats.total > offset + query.limit;
  const nextOffset = offset + pageItems.length;

  return {
    items: pageItems.map(eventToSummary),
    nextCursor: hasMore ? encodeCursor({ offset: nextOffset }) : null,
    hasMore,
    stats: scanned.stats,
    meta: scanned.meta,
  };
}

export async function getLogEventDetailById(
  context: LogQueryContext,
  id: string
): Promise<LogEventDetail | null> {
  const logEnabled = !!context.logConfig && context.logConfig.enabled !== false;
  if (!logEnabled) return null;

  const { date, line } = decodeEventId(id);
  const baseDir = resolveLogBaseDir(context.logConfig);
  const filePath = join(baseDir, 'events', `${date}.jsonl`);

  if (!existsSync(filePath)) return null;

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  let lineNumber = 0;
  for await (const lineText of rl) {
    lineNumber += 1;
    if (lineNumber < line) continue;
    if (lineNumber > line) break;

    if (!lineText.trim()) return null;

    const parsed = JSON.parse(lineText) as LogEvent;
    return buildLogEventDetail(
      id,
      parsed,
      {
        date,
        line,
        file: filePath,
      },
      context
    );
  }

  return null;
}

function escapeCsvValue(value: unknown): string {
  const text = String(value ?? '');
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function toCsvRow(item: LogEventSummary): string {
  return [
    item.id,
    item.ts,
    item.level,
    item.provider,
    item.routeType,
    item.model,
    item.modelIn,
    item.modelOut,
    item.path,
    item.requestId,
    item.latencyMs,
    item.upstreamStatus,
    item.statusClass,
    item.hasError,
    item.hasMetadata,
    item.userIdRaw ?? '',
    item.userKey ?? '',
    item.sessionId ?? '',
    item.message,
    item.errorType ?? '',
  ]
    .map(escapeCsvValue)
    .join(',');
}

function createCsvExportStream(items: LogEventSummary[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const headers = [
    'id',
    'ts',
    'level',
    'provider',
    'routeType',
    'model',
    'modelIn',
    'modelOut',
    'path',
    'requestId',
    'latencyMs',
    'upstreamStatus',
    'statusClass',
    'hasError',
    'hasMetadata',
    'userIdRaw',
    'userKey',
    'sessionId',
    'message',
    'errorType',
  ];

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${headers.join(',')}\n`));
      for (const item of items) {
        controller.enqueue(encoder.encode(`${toCsvRow(item)}\n`));
      }
      controller.close();
    },
  });
}

function createJsonExportStream(data: {
  items: LogEventSummary[];
  stats: LogQueryStats;
  meta: LogQueryMeta;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{\n  "items": [\n'));
      data.items.forEach((item, index) => {
        const prefix = index === 0 ? '    ' : ',\n    ';
        controller.enqueue(encoder.encode(`${prefix}${JSON.stringify(item)}`));
      });
      controller.enqueue(
        encoder.encode(
          `\n  ],\n  "stats": ${JSON.stringify(data.stats)},\n  "meta": ${JSON.stringify(data.meta)}\n}`
        )
      );
      controller.close();
    },
  });
}

export async function exportLogEvents(
  context: LogQueryContext,
  input: NormalizedLogQueryInput,
  format: 'csv' | 'json'
): Promise<{
  contentType: string;
  filename: string;
  body: ReadableStream<Uint8Array>;
  exported: number;
  total: number;
}> {
  const data = await queryLogEvents(context, {
    ...input,
    cursor: null,
    limit: MAX_EXPORT_ROWS,
  });

  const now = new Date().toISOString().replace(/[:.]/g, '-');
  if (format === 'csv') {
    return {
      contentType: 'text/csv; charset=utf-8',
      filename: `logs-export-${now}.csv`,
      body: createCsvExportStream(data.items),
      exported: data.items.length,
      total: data.stats.total,
    };
  }

  return {
    contentType: 'application/json; charset=utf-8',
    filename: `logs-export-${now}.json`,
    body: createJsonExportStream({
      items: data.items,
      stats: data.stats,
      meta: data.meta,
    }),
    exported: data.items.length,
    total: data.stats.total,
  };
}

export function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseBooleanFlag(value: string | undefined): boolean | null {
  if (!value) return null;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new Error('hasError 参数仅支持 true/false/1/0');
}
