import { Database } from 'bun:sqlite';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LogConfig } from './config';
import { resolveLogBaseDir } from './config';
import { resolveLogSessionIdentity } from './log-session-identity';
import type { LogEvent } from './logger';
import { extractTokenUsageSummaryFromLogEvent, type TokenUsageSummary } from './token-usage';

export type IndexedLogLevel = 'info' | 'error';
export type IndexedStatusClass = '2xx' | '4xx' | '5xx' | 'network_error';
export type IndexedLogSort = 'time_desc' | 'time_asc';

export interface IndexedLogEventLocation {
  id: string;
  date: string;
  file: string;
  line: number | null;
  offset: number;
}

export interface IndexedLogQuery {
  fromMs: number;
  toMs: number;
  levels: IndexedLogLevel[];
  providers: string[];
  routeTypes: string[];
  models: string[];
  modelIns: string[];
  modelOuts: string[];
  users: string[];
  sessions: string[];
  statusClasses: IndexedStatusClass[];
  hasError: boolean | null;
  q: string;
  sort: IndexedLogSort;
  limit: number;
  cursor: string | null;
  offset?: number;
}

export interface IndexedLogEventSummary {
  id: string;
  ts: string;
  level: IndexedLogLevel;
  provider: string;
  routeType: string;
  model: string;
  modelIn: string;
  modelOut: string;
  path: string;
  requestId: string;
  latencyMs: number;
  upstreamStatus: number;
  statusClass: IndexedStatusClass;
  hasError: boolean;
  message: string;
  errorType: string | null;
  hasMetadata: boolean;
  userIdRaw: string | null;
  userKey: string | null;
  sessionId: string | null;
  tokenUsage: TokenUsageSummary | null;
}

export interface IndexedLogStats {
  total: number;
  errorCount: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  tokenUsageCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheHitInputTokens: number;
  cacheHitRate: number;
  cacheHitRateDenominatorTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheWriteInputTokens: number;
  cacheMissInputTokens: number;
  reasoningTokens: number;
  billableInputTokens: number;
  billableOutputTokens: number;
}

export interface IndexedLogMeta {
  scannedFiles: number;
  scannedLines: number;
  parseErrors: number;
  truncated: boolean;
  indexUsed: boolean;
  indexFresh: boolean;
  usesFts: boolean;
  queryMs: number;
  rowsReturned: number;
  fallbackReason?: string;
  statsMode: 'none' | 'cached' | 'exact' | 'partial';
}

export interface IndexedLogQueryResult {
  items: IndexedLogEventSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  stats: IndexedLogStats;
  meta: IndexedLogMeta;
}

export interface IndexedLogEventRecord {
  event: LogEvent;
  location: IndexedLogEventLocation;
}

export interface IndexedLogSessionsQuery {
  fromMs: number;
  toMs: number;
  users: string[];
  sessions: string[];
  q: string;
}

export interface IndexedSessionCountItem {
  key: string;
  count: number;
}

export interface IndexedLogSessionSummary {
  sessionId: string;
  requestCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  models: IndexedSessionCountItem[];
  latestRequestId: string;
}

export interface IndexedLogUserSummary {
  userKey: string;
  requestCount: number;
  sessionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  models: IndexedSessionCountItem[];
  providers: IndexedSessionCountItem[];
  routeTypes: IndexedSessionCountItem[];
  sessions: IndexedLogSessionSummary[];
}

export interface IndexedLogSessionsResult {
  from: string;
  to: string;
  summary: {
    totalRequests: number;
    metadataRequests: number;
    uniqueUsers: number;
    uniqueSessions: number;
  };
  users: IndexedLogUserSummary[];
  meta: {
    scannedFiles: number;
    scannedLines: number;
    parseErrors: number;
    truncated: boolean;
    indexUsed: boolean;
    indexFresh: boolean;
    queryMs: number;
    fallbackReason?: string;
  };
}

interface LogCursorV2 {
  v: 2;
  sort: IndexedLogSort;
  tsMs: number;
  id: string;
  queryHash: string;
}

interface LogEventRow {
  id: string;
  ts_start: string;
  level: IndexedLogLevel;
  provider: string;
  route_type: string;
  model: string;
  model_in: string;
  model_out: string;
  path: string;
  request_id: string;
  latency_ms: number;
  upstream_status: number;
  status_class: IndexedStatusClass;
  has_error: 0 | 1;
  message: string;
  error_type: string | null;
  has_metadata: 0 | 1;
  user_id_raw: string | null;
  user_key: string | null;
  session_id: string | null;
  ts_ms: number;
  token_usage_json: string | null;
}

interface IndexFileRow {
  size_bytes: number;
  mtime_ms: number;
}

interface QueueItem {
  filePath: string;
  date: string;
  offset: number;
  byteLength: number;
  event: LogEvent;
}

interface JsonlLine {
  line: string;
  offset: number;
  lineNumber: number;
  byteLength: number;
}

const SCHEMA_VERSION = 3;
const MAX_INDEX_QUEUE = 20_000;
const INDEX_BATCH_SIZE = 250;
const INDEX_FLUSH_DELAY_MS = 50;
const LIKE_SEARCH_THRESHOLD = 2;
const FTS_TOKEN_PATTERN = /[\p{L}\p{N}_-]+/gu;

let singleton: LogIndex | null = null;

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf-8');
}

export function encodeOffsetLogEventId(date: string, offset: number): string {
  return encodeBase64Url(JSON.stringify({ v: 2, d: date, o: offset }));
}

export function decodeOffsetLogEventId(id: string): { v: 2; date: string; offset: number } | null {
  try {
    const parsed = JSON.parse(decodeBase64Url(id)) as { v?: unknown; d?: unknown; o?: unknown };
    if (parsed.v !== 2 || typeof parsed.d !== 'string' || !Number.isInteger(parsed.o)) {
      return null;
    }
    const offset = Number(parsed.o);
    if (offset < 0) return null;
    return { v: 2, date: parsed.d, offset };
  } catch {
    return null;
  }
}

function encodeCursor(data: LogCursorV2): string {
  return encodeBase64Url(JSON.stringify(data));
}

function decodeCursor(raw: string): LogCursorV2 {
  const parsed = JSON.parse(decodeBase64Url(raw)) as Partial<LogCursorV2>;
  if (
    parsed.v !== 2 ||
    (parsed.sort !== 'time_desc' && parsed.sort !== 'time_asc') ||
    typeof parsed.id !== 'string' ||
    typeof parsed.queryHash !== 'string' ||
    !Number.isFinite(parsed.tsMs)
  ) {
    throw new Error('cursor 非法');
  }
  return parsed as LogCursorV2;
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

function getStatusClass(event: LogEvent): IndexedStatusClass {
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

function getLevel(event: LogEvent): IndexedLogLevel {
  return isErrorEvent(event) ? 'error' : 'info';
}

function buildMessage(event: LogEvent): string {
  if (event.error_message) return event.error_message;
  if (event.error_type) return event.error_type;
  const status = event.upstream_status ?? 0;
  return `${event.method} ${event.path} -> ${status}`;
}

function toPercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function hashQuery(query: IndexedLogQuery): string {
  const stable = {
    fromMs: query.fromMs,
    toMs: query.toMs,
    levels: [...query.levels].sort(),
    providers: [...query.providers].sort(),
    routeTypes: [...query.routeTypes].sort(),
    models: [...query.models].sort(),
    modelIns: [...query.modelIns].sort(),
    modelOuts: [...query.modelOuts].sort(),
    users: [...query.users].sort(),
    sessions: [...query.sessions].sort(),
    statusClasses: [...query.statusClasses].sort(),
    hasError: query.hasError,
    q: query.q,
  };
  return Bun.hash(JSON.stringify(stable)).toString(36);
}

function buildSearchText(event: LogEvent): string {
  const identity = resolveLogSessionIdentity(event.request_body);
  return [
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
}

function buildFtsQuery(q: string): string | null {
  const tokens =
    q
      .match(FTS_TOKEN_PATTERN)
      ?.map((token) => token.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

function shouldUseFts(q: string): boolean {
  return q.trim().length >= LIKE_SEARCH_THRESHOLD && buildFtsQuery(q) !== null;
}

function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function eventToRow(input: {
  baseDir: string;
  id: string;
  date: string;
  filePath: string;
  lineNumber: number | null;
  offset: number;
  byteLength: number;
  event: LogEvent;
}): Record<string, unknown> | null {
  const { event } = input;
  if (!event.ts_start) return null;
  const tsMs = Date.parse(event.ts_start);
  if (!Number.isFinite(tsMs)) return null;

  const identity = resolveLogSessionIdentity(event.request_body);
  const level = getLevel(event);
  const statusClass = getStatusClass(event);
  const latencyMs = Math.max(0, event.latency_ms ?? 0);
  const model = event.model_out || event.model_in;
  const tokenUsage = extractTokenUsageSummaryFromLogEvent(event, { baseDir: input.baseDir });

  return {
    id: input.id,
    ts_ms: tsMs,
    ts_start: event.ts_start,
    level,
    provider: event.provider,
    route_type: event.route_type,
    model,
    model_in: event.model_in,
    model_out: event.model_out,
    path: event.path,
    request_id: event.request_id,
    latency_ms: latencyMs,
    upstream_status: event.upstream_status ?? 0,
    status_class: statusClass,
    has_error: level === 'error' ? 1 : 0,
    message: buildMessage(event),
    error_type: event.error_type,
    has_metadata: identity.hasMetadata ? 1 : 0,
    user_id_raw: identity.userIdRaw,
    user_key: identity.userKey,
    session_id: identity.sessionId,
    source_date: input.date,
    source_file: input.filePath,
    line_number: input.lineNumber,
    byte_offset: input.offset,
    byte_length: input.byteLength,
    search_text: buildSearchText(event),
    token_input: tokenUsage?.inputTokens ?? null,
    token_output: tokenUsage?.outputTokens ?? null,
    token_total: tokenUsage?.totalTokens ?? null,
    token_cached_input: tokenUsage?.cachedInputTokens ?? null,
    token_cache_hit_input: tokenUsage?.cacheHitInputTokens ?? null,
    token_cache_hit_rate: tokenUsage?.cacheHitRate ?? null,
    token_cache_hit_rate_denominator: tokenUsage?.cacheHitRateDenominatorTokens ?? null,
    token_cache_read_input: tokenUsage?.cacheReadInputTokens ?? null,
    token_cache_creation_input: tokenUsage?.cacheCreationInputTokens ?? null,
    token_cache_creation_input_5m: tokenUsage?.cacheCreationInputTokens5m ?? null,
    token_cache_creation_input_1h: tokenUsage?.cacheCreationInputTokens1h ?? null,
    token_cache_write_input: tokenUsage?.cacheWriteInputTokens ?? null,
    token_cache_miss_input: tokenUsage?.cacheMissInputTokens ?? null,
    token_reasoning: tokenUsage?.reasoningTokens ?? null,
    token_audio_input: tokenUsage?.audioInputTokens ?? null,
    token_audio_output: tokenUsage?.audioOutputTokens ?? null,
    token_text_input: tokenUsage?.textInputTokens ?? null,
    token_text_output: tokenUsage?.textOutputTokens ?? null,
    token_accepted_prediction: tokenUsage?.acceptedPredictionTokens ?? null,
    token_rejected_prediction: tokenUsage?.rejectedPredictionTokens ?? null,
    token_tool_use_prompt: tokenUsage?.toolUsePromptTokens ?? null,
    token_billable_input: tokenUsage?.billableInputTokens ?? null,
    token_billable_output: tokenUsage?.billableOutputTokens ?? null,
    token_credit_usage: tokenUsage?.creditUsage ?? null,
    token_cost: tokenUsage?.cost ?? null,
    token_source: tokenUsage?.source ?? null,
    token_provider_style: tokenUsage?.providerStyle ?? null,
    token_raw_usage_path: tokenUsage?.rawUsagePath ?? null,
    token_usage_json: tokenUsage ? JSON.stringify(tokenUsage) : null,
  };
}

function parseTokenUsageSummary(value: string | null): TokenUsageSummary | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as TokenUsageSummary;
  } catch {
    return null;
  }
}

function rowToSummary(row: LogEventRow): IndexedLogEventSummary {
  return {
    id: row.id,
    ts: row.ts_start,
    level: row.level,
    provider: row.provider,
    routeType: row.route_type,
    model: row.model,
    modelIn: row.model_in,
    modelOut: row.model_out,
    path: row.path,
    requestId: row.request_id,
    latencyMs: row.latency_ms,
    upstreamStatus: row.upstream_status,
    statusClass: row.status_class,
    hasError: row.has_error === 1,
    message: row.message,
    errorType: row.error_type,
    hasMetadata: row.has_metadata === 1,
    userIdRaw: row.user_id_raw,
    userKey: row.user_key,
    sessionId: row.session_id,
    tokenUsage: parseTokenUsageSummary(row.token_usage_json),
  };
}

async function* readJsonlLinesWithOffsets(filePath: string): AsyncGenerator<JsonlLine> {
  const stream = createReadStream(filePath);
  let buffer = Buffer.alloc(0);
  let bufferOffset = 0;
  let lineNumber = 0;

  for await (const chunk of stream) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = buffer.length === 0 ? chunkBuffer : Buffer.concat([buffer, chunkBuffer]);

    let newlineIndex = buffer.indexOf(0x0a);
    while (newlineIndex !== -1) {
      const lineBuffer = buffer.subarray(0, newlineIndex);
      const byteLength = newlineIndex + 1;
      const lineOffset = bufferOffset;
      lineNumber += 1;
      yield {
        line: lineBuffer.toString('utf-8').replace(/\r$/, ''),
        offset: lineOffset,
        lineNumber,
        byteLength,
      };
      buffer = buffer.subarray(byteLength);
      bufferOffset += byteLength;
      newlineIndex = buffer.indexOf(0x0a);
    }
  }

  if (buffer.length > 0) {
    lineNumber += 1;
    yield {
      line: buffer.toString('utf-8').replace(/\r$/, ''),
      offset: bufferOffset,
      lineNumber,
      byteLength: buffer.length,
    };
  }
}

function readLineAtOffset(filePath: string, offset: number): string | null {
  const fd = openSync(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = offset;

    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;

      const readable = buffer.subarray(0, bytesRead);
      const newline = readable.indexOf(0x0a);
      if (newline >= 0 && newline < bytesRead) {
        chunks.push(Buffer.from(readable.subarray(0, newline)));
        break;
      }

      chunks.push(Buffer.from(readable));
      position += bytesRead;
    }

    if (chunks.length === 0) return null;
    return Buffer.concat(chunks).toString('utf-8').replace(/\r$/, '');
  } finally {
    closeSync(fd);
  }
}

function createEmptyStats(): IndexedLogStats {
  return {
    total: 0,
    errorCount: 0,
    errorRate: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    tokenUsageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheHitInputTokens: 0,
    cacheHitRate: 0,
    cacheHitRateDenominatorTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheMissInputTokens: 0,
    reasoningTokens: 0,
    billableInputTokens: 0,
    billableOutputTokens: 0,
  };
}

function createEmptyQueryResult(
  query: IndexedLogQuery,
  meta: Partial<IndexedLogMeta> = {}
): IndexedLogQueryResult {
  return {
    items: [],
    nextCursor: null,
    hasMore: false,
    stats: createEmptyStats(),
    meta: {
      scannedFiles: 0,
      scannedLines: 0,
      parseErrors: 0,
      truncated: false,
      indexUsed: true,
      indexFresh: true,
      usesFts: shouldUseFts(query.q),
      queryMs: 0,
      rowsReturned: 0,
      statsMode: 'exact',
      ...meta,
    },
  };
}

function appendInClause(
  clauses: string[],
  params: unknown[],
  column: string,
  values: string[]
): void {
  if (values.length === 0) return;
  clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
  params.push(...values);
}

function buildWhereClause(
  query: IndexedLogQuery,
  options: { forceLikeSearch?: boolean } = {}
): {
  whereSql: string;
  params: unknown[];
  usesFts: boolean;
} {
  const clauses: string[] = ['e.ts_ms >= ?', 'e.ts_ms <= ?'];
  const params: unknown[] = [query.fromMs, query.toMs];
  const usesFts = !options.forceLikeSearch && shouldUseFts(query.q);

  appendInClause(clauses, params, 'e.level', query.levels);
  appendInClause(clauses, params, 'e.provider', query.providers);
  appendInClause(clauses, params, 'e.route_type', query.routeTypes);
  appendInClause(clauses, params, 'e.model', query.models);
  appendInClause(clauses, params, 'e.model_in', query.modelIns);
  appendInClause(clauses, params, 'e.model_out', query.modelOuts);
  appendInClause(clauses, params, 'e.status_class', query.statusClasses);

  if (query.users.length > 0) {
    clauses.push(
      `(e.user_id_raw IN (${query.users.map(() => '?').join(', ')}) OR e.user_key IN (${query.users
        .map(() => '?')
        .join(', ')}))`
    );
    params.push(...query.users, ...query.users);
  }

  appendInClause(clauses, params, 'e.session_id', query.sessions);

  if (query.hasError !== null) {
    clauses.push('e.has_error = ?');
    params.push(query.hasError ? 1 : 0);
  }

  if (query.q) {
    if (usesFts) {
      const ftsQuery = buildFtsQuery(query.q);
      clauses.push('e.id IN (SELECT event_id FROM log_events_fts WHERE log_events_fts MATCH ?)');
      params.push(ftsQuery);
    } else {
      clauses.push("e.search_text LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLikePattern(query.q.toLowerCase())}%`);
    }
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    usesFts,
  };
}

function buildSessionsWhereClause(query: IndexedLogSessionsQuery): {
  whereSql: string;
  params: unknown[];
} {
  const pseudo: IndexedLogQuery = {
    fromMs: query.fromMs,
    toMs: query.toMs,
    levels: [],
    providers: [],
    routeTypes: [],
    models: [],
    modelIns: [],
    modelOuts: [],
    users: query.users,
    sessions: query.sessions,
    statusClasses: [],
    hasError: null,
    q: query.q,
    sort: 'time_desc',
    limit: 1,
    cursor: null,
  };
  const { whereSql, params } = buildWhereClause(pseudo);
  return { whereSql, params };
}

function sortIndexedCountItems(map: Map<string, number>): IndexedSessionCountItem[] {
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

interface SessionAggRow {
  userKey: string;
  sessionId: string;
  requestCount: number;
  firstMs: number;
  lastMs: number;
}

interface UserAggRow {
  userKey: string;
  requestCount: number;
  firstMs: number;
  lastMs: number;
  sessionCount: number;
}

interface CountRow {
  userKey: string;
  key: string | null;
  count: number;
}

interface SessionCountRow {
  userKey: string;
  sessionId: string;
  key: string | null;
  count: number;
}

interface LatestRequestRow {
  userKey: string;
  sessionId: string;
  latestRequestId: string;
}

class LogIndex {
  private db: Database;
  private queue: QueueItem[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private rebuildingFiles = new Set<string>();
  private dirtyFiles = new Set<string>();

  private insertEventStmt: ReturnType<Database['prepare']>;
  private insertFtsStmt: ReturnType<Database['prepare']>;
  private deleteFtsStmt: ReturnType<Database['prepare']>;
  private upsertFileStmt: ReturnType<Database['prepare']>;

  constructor(
    readonly baseDir: string,
    readonly config?: LogConfig
  ) {
    mkdirSync(baseDir, { recursive: true });
    const dbPath = join(baseDir, 'logs-index.sqlite');
    this.db = new Database(dbPath, { create: true, strict: true });
    this.configure();
    this.migrate();

    this.insertEventStmt = this.db.prepare(`
      INSERT OR REPLACE INTO log_events (
        id, ts_ms, ts_start, level, provider, route_type, model, model_in, model_out,
        path, request_id, latency_ms, upstream_status, status_class, has_error,
        message, error_type, has_metadata, user_id_raw, user_key, session_id,
        source_date, source_file, line_number, byte_offset, byte_length, search_text,
        token_input, token_output, token_total, token_cached_input, token_cache_hit_input,
        token_cache_hit_rate, token_cache_hit_rate_denominator, token_cache_read_input,
        token_cache_creation_input, token_cache_creation_input_5m, token_cache_creation_input_1h,
        token_cache_write_input, token_cache_miss_input, token_reasoning, token_audio_input,
        token_audio_output, token_text_input, token_text_output, token_accepted_prediction,
        token_rejected_prediction, token_tool_use_prompt, token_billable_input,
        token_billable_output, token_credit_usage, token_cost, token_source,
        token_provider_style, token_raw_usage_path, token_usage_json
      ) VALUES (
        $id, $ts_ms, $ts_start, $level, $provider, $route_type, $model, $model_in, $model_out,
        $path, $request_id, $latency_ms, $upstream_status, $status_class, $has_error,
        $message, $error_type, $has_metadata, $user_id_raw, $user_key, $session_id,
        $source_date, $source_file, $line_number, $byte_offset, $byte_length, $search_text,
        $token_input, $token_output, $token_total, $token_cached_input, $token_cache_hit_input,
        $token_cache_hit_rate, $token_cache_hit_rate_denominator, $token_cache_read_input,
        $token_cache_creation_input, $token_cache_creation_input_5m, $token_cache_creation_input_1h,
        $token_cache_write_input, $token_cache_miss_input, $token_reasoning, $token_audio_input,
        $token_audio_output, $token_text_input, $token_text_output, $token_accepted_prediction,
        $token_rejected_prediction, $token_tool_use_prompt, $token_billable_input,
        $token_billable_output, $token_credit_usage, $token_cost, $token_source,
        $token_provider_style, $token_raw_usage_path, $token_usage_json
      )
    `);
    this.deleteFtsStmt = this.db.prepare('DELETE FROM log_events_fts WHERE event_id = ?');
    this.insertFtsStmt = this.db.prepare(
      'INSERT INTO log_events_fts(event_id, search_text) VALUES (?, ?)'
    );
    this.upsertFileStmt = this.db.prepare(`
      INSERT INTO log_index_files(file_path, source_date, size_bytes, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        source_date = excluded.source_date,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `);
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.queue = [];
    this.disposed = true;
    this.db.close();
  }

  enqueue(item: QueueItem): void {
    if (this.disposed) return;
    if (this.queue.length >= MAX_INDEX_QUEUE) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.dirtyFiles.add(dropped.filePath);
      }
    }
    this.queue.push(item);

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushQueue();
      }, INDEX_FLUSH_DELAY_MS);
      this.flushTimer.unref?.();
    }
  }

  async ensureRangeIndexed(
    fromMs: number,
    toMs: number
  ): Promise<{
    scannedFiles: number;
    scannedLines: number;
    parseErrors: number;
  }> {
    let scannedFiles = 0;
    let scannedLines = 0;
    let parseErrors = 0;
    const eventsDir = join(this.baseDir, 'events');
    const dates = listDateStrings(fromMs, toMs);

    for (const date of dates) {
      const filePath = join(eventsDir, `${date}.jsonl`);
      if (!existsSync(filePath)) continue;
      const stats = statSync(filePath);
      const fileRow = this.db
        .query('SELECT size_bytes, mtime_ms FROM log_index_files WHERE file_path = ?')
        .get(filePath) as IndexFileRow | null;
      const sizeBytes = stats.size;
      const mtimeMs = Math.trunc(stats.mtimeMs);

      if (
        !this.dirtyFiles.has(filePath) &&
        fileRow &&
        fileRow.size_bytes === sizeBytes &&
        fileRow.mtime_ms === mtimeMs
      ) {
        continue;
      }

      const result = await this.rebuildFile(filePath, date, sizeBytes, mtimeMs);
      scannedFiles += 1;
      scannedLines += result.scannedLines;
      parseErrors += result.parseErrors;
    }

    return { scannedFiles, scannedLines, parseErrors };
  }

  queryEvents(
    query: IndexedLogQuery,
    options: { forceLikeSearch?: boolean } = {}
  ): IndexedLogQueryResult {
    const startedAt = performance.now();
    const queryHash = hashQuery(query);
    const decodedCursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (decodedCursor) {
      if (decodedCursor.sort !== query.sort || decodedCursor.queryHash !== queryHash) {
        throw new Error('cursor 与当前查询条件不匹配');
      }
    }

    const useOffset = !query.cursor && (query.offset ?? 0) > 0;

    const { whereSql, params, usesFts } = buildWhereClause(query, options);
    const cursorClause = decodedCursor
      ? query.sort === 'time_desc'
        ? 'AND (e.ts_ms < ? OR (e.ts_ms = ? AND e.id < ?))'
        : 'AND (e.ts_ms > ? OR (e.ts_ms = ? AND e.id > ?))'
      : '';
    const cursorParams = decodedCursor
      ? [decodedCursor.tsMs, decodedCursor.tsMs, decodedCursor.id]
      : [];
    const orderSql =
      query.sort === 'time_desc'
        ? 'ORDER BY e.ts_ms DESC, e.id DESC'
        : 'ORDER BY e.ts_ms ASC, e.id ASC';
    const limit = Math.max(1, query.limit);
    const offsetClause = useOffset ? 'OFFSET ?' : '';
    const offsetParams = useOffset ? [query.offset!] : [];

    let rows: LogEventRow[];
    try {
      rows = this.db
        .query(`
          SELECT
            e.id, e.ts_start, e.level, e.provider, e.route_type, e.model, e.model_in,
            e.model_out, e.path, e.request_id, e.latency_ms, e.upstream_status,
            e.status_class, e.has_error, e.message, e.error_type, e.has_metadata,
            e.user_id_raw, e.user_key, e.session_id, e.ts_ms, e.token_usage_json
          FROM log_events e
          ${whereSql}
          ${cursorClause}
          ${orderSql}
          LIMIT ?
          ${offsetClause}
        `)
        .all(...params, ...cursorParams, limit + 1, ...offsetParams) as LogEventRow[];
    } catch (err) {
      if (!usesFts) throw err;
      const fallback = this.queryEvents(query, { forceLikeSearch: true });
      return {
        ...fallback,
        meta: {
          ...fallback.meta,
          usesFts: false,
          fallbackReason: `FTS 查询失败，已退回索引 LIKE/内存过滤: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      };
    }

    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const lastRow = pageRows[pageRows.length - 1];
    const stats = this.queryStats(whereSql, params);

    return {
      items: pageRows.map(rowToSummary),
      nextCursor:
        useOffset || !hasMore || !lastRow
          ? null
          : encodeCursor({
              v: 2,
              sort: query.sort,
              tsMs: lastRow.ts_ms,
              id: lastRow.id,
              queryHash,
            }),
      hasMore,
      stats,
      meta: {
        scannedFiles: 0,
        scannedLines: 0,
        parseErrors: 0,
        truncated: false,
        indexUsed: true,
        indexFresh: true,
        usesFts,
        queryMs: Math.round((performance.now() - startedAt) * 100) / 100,
        rowsReturned: pageRows.length,
        statsMode: 'exact',
      },
    };
  }

  getEventRecordByOffsetId(id: string): IndexedLogEventRecord | null {
    const parsedId = decodeOffsetLogEventId(id);
    if (!parsedId) return null;

    const row = this.db
      .query(
        'SELECT source_date, source_file, line_number, byte_offset FROM log_events WHERE id = ?'
      )
      .get(id) as {
      source_date: string;
      source_file: string;
      line_number: number | null;
      byte_offset: number;
    } | null;

    const filePath = row?.source_file ?? join(this.baseDir, 'events', `${parsedId.date}.jsonl`);
    if (!existsSync(filePath)) return null;

    const line = readLineAtOffset(filePath, row?.byte_offset ?? parsedId.offset);
    if (!line?.trim()) return null;

    const event = JSON.parse(line) as LogEvent;
    return {
      event,
      location: {
        id,
        date: row?.source_date ?? parsedId.date,
        file: filePath,
        line: row?.line_number ?? null,
        offset: row?.byte_offset ?? parsedId.offset,
      },
    };
  }

  querySessions(query: IndexedLogSessionsQuery): Omit<IndexedLogSessionsResult, 'meta'> & {
    queryMs: number;
  } {
    const startedAt = performance.now();
    const { whereSql, params } = buildSessionsWhereClause(query);
    const aggregatedWhere = `${whereSql} AND e.user_key IS NOT NULL AND e.session_id IS NOT NULL`;

    // totalRequests/metadataRequests count every event in range, while the per-user
    // breakdown below only counts identity-bearing events (aggregatedWhere). The two
    // intentionally differ: unattributable requests still contribute to the totals.
    // uniqueSessions keys on user_key+session_id to match the per-user sessionCount and
    // the realtime fold, so a session_id reused across users isn't collapsed.
    const summaryRow = this.db
      .query(`
        SELECT
          COUNT(*) AS totalRequests,
          COALESCE(SUM(has_metadata), 0) AS metadataRequests,
          COUNT(DISTINCT user_key) AS uniqueUsers,
          COUNT(DISTINCT CASE
            WHEN user_key IS NOT NULL AND session_id IS NOT NULL
            THEN user_key || ' ' || session_id
          END) AS uniqueSessions
        FROM log_events e
        ${whereSql}
      `)
      .get(...params) as {
      totalRequests: number;
      metadataRequests: number;
      uniqueUsers: number;
      uniqueSessions: number;
    };

    const userRows = this.db
      .query(`
        SELECT
          user_key AS userKey,
          COUNT(*) AS requestCount,
          MIN(ts_ms) AS firstMs,
          MAX(ts_ms) AS lastMs,
          COUNT(DISTINCT session_id) AS sessionCount
        FROM log_events e
        ${aggregatedWhere}
        GROUP BY user_key
      `)
      .all(...params) as UserAggRow[];

    const sessionRows = this.db
      .query(`
        SELECT
          user_key AS userKey,
          session_id AS sessionId,
          COUNT(*) AS requestCount,
          MIN(ts_ms) AS firstMs,
          MAX(ts_ms) AS lastMs
        FROM log_events e
        ${aggregatedWhere}
        GROUP BY user_key, session_id
      `)
      .all(...params) as SessionAggRow[];

    const userModelRows = this.db
      .query(`
        SELECT user_key AS userKey, model AS key, COUNT(*) AS count
        FROM log_events e
        ${aggregatedWhere}
        GROUP BY user_key, model
      `)
      .all(...params) as CountRow[];

    const userProviderRows = this.db
      .query(`
        SELECT user_key AS userKey, provider AS key, COUNT(*) AS count
        FROM log_events e
        ${aggregatedWhere}
        GROUP BY user_key, provider
      `)
      .all(...params) as CountRow[];

    const userRouteRows = this.db
      .query(`
        SELECT user_key AS userKey, route_type AS key, COUNT(*) AS count
        FROM log_events e
        ${aggregatedWhere}
        GROUP BY user_key, route_type
      `)
      .all(...params) as CountRow[];

    const sessionModelRows = this.db
      .query(`
        SELECT user_key AS userKey, session_id AS sessionId, model AS key, COUNT(*) AS count
        FROM log_events e
        ${aggregatedWhere}
        GROUP BY user_key, session_id, model
      `)
      .all(...params) as SessionCountRow[];

    const latestRows = this.db
      .query(`
        SELECT userKey, sessionId, request_id AS latestRequestId
        FROM (
          SELECT
            user_key AS userKey,
            session_id AS sessionId,
            request_id,
            ROW_NUMBER() OVER (
              PARTITION BY user_key, session_id ORDER BY ts_ms DESC, id DESC
            ) AS rn
          FROM log_events e
          ${aggregatedWhere}
        )
        WHERE rn = 1
      `)
      .all(...params) as LatestRequestRow[];

    const userModels = new Map<string, Map<string, number>>();
    const userProviders = new Map<string, Map<string, number>>();
    const userRoutes = new Map<string, Map<string, number>>();
    const sessionModels = new Map<string, Map<string, number>>();
    const latestBySession = new Map<string, string>();

    const addCount = (
      target: Map<string, Map<string, number>>,
      groupKey: string,
      key: string | null,
      count: number
    ): void => {
      if (!key) return;
      let inner = target.get(groupKey);
      if (!inner) {
        inner = new Map<string, number>();
        target.set(groupKey, inner);
      }
      inner.set(key, count);
    };

    for (const row of userModelRows) addCount(userModels, row.userKey, row.key, row.count);
    for (const row of userProviderRows) addCount(userProviders, row.userKey, row.key, row.count);
    for (const row of userRouteRows) addCount(userRoutes, row.userKey, row.key, row.count);
    for (const row of sessionModelRows) {
      addCount(sessionModels, `${row.userKey} ${row.sessionId}`, row.key, row.count);
    }
    for (const row of latestRows) {
      latestBySession.set(`${row.userKey} ${row.sessionId}`, row.latestRequestId);
    }

    const sessionsByUser = new Map<string, IndexedLogSessionSummary[]>();
    for (const row of sessionRows) {
      const sessionKey = `${row.userKey} ${row.sessionId}`;
      const session: IndexedLogSessionSummary = {
        sessionId: row.sessionId,
        requestCount: row.requestCount,
        firstSeenAt: new Date(row.firstMs).toISOString(),
        lastSeenAt: new Date(row.lastMs).toISOString(),
        models: sortIndexedCountItems(sessionModels.get(sessionKey) ?? new Map()),
        latestRequestId: latestBySession.get(sessionKey) ?? '',
      };
      const list = sessionsByUser.get(row.userKey);
      if (list) {
        list.push(session);
      } else {
        sessionsByUser.set(row.userKey, [session]);
      }
    }

    const users: IndexedLogUserSummary[] = userRows
      .map((row) => {
        const sessions = (sessionsByUser.get(row.userKey) ?? []).sort((a, b) => {
          if (a.requestCount !== b.requestCount) return b.requestCount - a.requestCount;
          return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
        });
        return {
          userKey: row.userKey,
          requestCount: row.requestCount,
          sessionCount: row.sessionCount,
          firstSeenAt: new Date(row.firstMs).toISOString(),
          lastSeenAt: new Date(row.lastMs).toISOString(),
          models: sortIndexedCountItems(userModels.get(row.userKey) ?? new Map()),
          providers: sortIndexedCountItems(userProviders.get(row.userKey) ?? new Map()),
          routeTypes: sortIndexedCountItems(userRoutes.get(row.userKey) ?? new Map()),
          sessions,
        };
      })
      .sort((a, b) => {
        if (a.requestCount !== b.requestCount) return b.requestCount - a.requestCount;
        return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
      });

    return {
      from: new Date(query.fromMs).toISOString(),
      to: new Date(query.toMs).toISOString(),
      summary: {
        totalRequests: Number(summaryRow.totalRequests) || 0,
        metadataRequests: Number(summaryRow.metadataRequests) || 0,
        uniqueUsers: Number(summaryRow.uniqueUsers) || 0,
        uniqueSessions: Number(summaryRow.uniqueSessions) || 0,
      },
      users,
      queryMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }

  private configure(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA busy_timeout = 3000;
      PRAGMA foreign_keys = ON;
    `);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS log_index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS log_index_files (
        file_path TEXT PRIMARY KEY,
        source_date TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS log_events (
        id TEXT PRIMARY KEY,
        ts_ms INTEGER NOT NULL,
        ts_start TEXT NOT NULL,
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
        source_date TEXT NOT NULL,
        source_file TEXT NOT NULL,
        line_number INTEGER,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        search_text TEXT NOT NULL,
        token_input INTEGER,
        token_output INTEGER,
        token_total INTEGER,
        token_cached_input INTEGER,
        token_cache_hit_input INTEGER,
        token_cache_hit_rate REAL,
        token_cache_hit_rate_denominator INTEGER,
        token_cache_read_input INTEGER,
        token_cache_creation_input INTEGER,
        token_cache_creation_input_5m INTEGER,
        token_cache_creation_input_1h INTEGER,
        token_cache_write_input INTEGER,
        token_cache_miss_input INTEGER,
        token_reasoning INTEGER,
        token_audio_input INTEGER,
        token_audio_output INTEGER,
        token_text_input INTEGER,
        token_text_output INTEGER,
        token_accepted_prediction INTEGER,
        token_rejected_prediction INTEGER,
        token_tool_use_prompt INTEGER,
        token_billable_input INTEGER,
        token_billable_output INTEGER,
        token_credit_usage REAL,
        token_cost REAL,
        token_source TEXT,
        token_provider_style TEXT,
        token_raw_usage_path TEXT,
        token_usage_json TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS log_events_fts
      USING fts5(event_id UNINDEXED, search_text);

      CREATE INDEX IF NOT EXISTS idx_log_events_time_desc ON log_events(ts_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_log_events_time_asc ON log_events(ts_ms ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_log_events_level_time ON log_events(level, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_log_events_provider_time ON log_events(provider, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_log_events_route_time ON log_events(route_type, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_log_events_model_time ON log_events(model, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_log_events_status_time ON log_events(status_class, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_log_events_error_time ON log_events(has_error, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_log_events_user_time ON log_events(user_key, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_log_events_session_time ON log_events(session_id, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_log_events_file ON log_events(source_file);
    `);

    this.ensureTokenColumns();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_log_events_token_total_time ON log_events(token_total, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_log_events_token_input_time ON log_events(token_input, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_log_events_token_cache_hit_rate_time ON log_events(token_cache_hit_rate, ts_ms DESC);
    `);

    const versionRow = this.db
      .query("SELECT value FROM log_index_meta WHERE key = 'schema_version'")
      .get() as { value: string } | null;
    const previousVersion = Number.parseInt(versionRow?.value ?? '0', 10) || 0;
    if (previousVersion > 0 && previousVersion < SCHEMA_VERSION) {
      this.db.exec(`
        DELETE FROM log_events_fts;
        DELETE FROM log_events;
        DELETE FROM log_index_files;
      `);
    }

    this.db
      .prepare(
        `
        INSERT INTO log_index_meta(key, value)
        VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `
      )
      .run(String(SCHEMA_VERSION));
  }

  private ensureTokenColumns(): void {
    const rows = this.db.query('PRAGMA table_info(log_events)').all() as Array<{ name: string }>;
    const existing = new Set(rows.map((row) => row.name));
    const columns: Array<{ name: string; type: string }> = [
      { name: 'token_input', type: 'INTEGER' },
      { name: 'token_output', type: 'INTEGER' },
      { name: 'token_total', type: 'INTEGER' },
      { name: 'token_cached_input', type: 'INTEGER' },
      { name: 'token_cache_hit_input', type: 'INTEGER' },
      { name: 'token_cache_hit_rate', type: 'REAL' },
      { name: 'token_cache_hit_rate_denominator', type: 'INTEGER' },
      { name: 'token_cache_read_input', type: 'INTEGER' },
      { name: 'token_cache_creation_input', type: 'INTEGER' },
      { name: 'token_cache_creation_input_5m', type: 'INTEGER' },
      { name: 'token_cache_creation_input_1h', type: 'INTEGER' },
      { name: 'token_cache_write_input', type: 'INTEGER' },
      { name: 'token_cache_miss_input', type: 'INTEGER' },
      { name: 'token_reasoning', type: 'INTEGER' },
      { name: 'token_audio_input', type: 'INTEGER' },
      { name: 'token_audio_output', type: 'INTEGER' },
      { name: 'token_text_input', type: 'INTEGER' },
      { name: 'token_text_output', type: 'INTEGER' },
      { name: 'token_accepted_prediction', type: 'INTEGER' },
      { name: 'token_rejected_prediction', type: 'INTEGER' },
      { name: 'token_tool_use_prompt', type: 'INTEGER' },
      { name: 'token_billable_input', type: 'INTEGER' },
      { name: 'token_billable_output', type: 'INTEGER' },
      { name: 'token_credit_usage', type: 'REAL' },
      { name: 'token_cost', type: 'REAL' },
      { name: 'token_source', type: 'TEXT' },
      { name: 'token_provider_style', type: 'TEXT' },
      { name: 'token_raw_usage_path', type: 'TEXT' },
      { name: 'token_usage_json', type: 'TEXT' },
    ];

    for (const column of columns) {
      if (existing.has(column.name)) continue;
      this.db.exec(`ALTER TABLE log_events ADD COLUMN ${column.name} ${column.type}`);
    }
  }

  private flushQueue(): void {
    if (this.queue.length === 0 || this.disposed) return;

    const batch = this.queue.splice(0, INDEX_BATCH_SIZE);
    const transaction = this.db.transaction((items: QueueItem[]) => {
      for (const item of items) {
        this.insertQueueItem(item);
      }
    });

    try {
      transaction(batch);
    } catch (err) {
      console.error('[log-index] 增量索引写入失败:', err);
    }

    if (this.queue.length > 0 && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushQueue();
      }, INDEX_FLUSH_DELAY_MS);
      this.flushTimer.unref?.();
    }
  }

  private insertQueueItem(item: QueueItem): void {
    if (this.rebuildingFiles.has(item.filePath)) return;
    const id = encodeOffsetLogEventId(item.date, item.offset);
    const row = eventToRow({
      baseDir: this.baseDir,
      id,
      date: item.date,
      filePath: item.filePath,
      lineNumber: null,
      offset: item.offset,
      byteLength: item.byteLength,
      event: item.event,
    });
    if (!row) return;

    this.insertEventStmt.run(row);
    this.deleteFtsStmt.run(id);
    this.insertFtsStmt.run(id, row.search_text);

    if (!this.dirtyFiles.has(item.filePath)) {
      try {
        const stats = statSync(item.filePath);
        const indexedThrough = item.offset + item.byteLength;
        this.upsertFileStmt.run(
          item.filePath,
          item.date,
          Math.min(indexedThrough, stats.size),
          Math.trunc(stats.mtimeMs),
          Date.now()
        );
      } catch {
        // 文件状态刷新失败不影响 JSONL 主链路；下一次查询会触发重建。
      }
    }
  }

  private async rebuildFile(
    filePath: string,
    date: string,
    sizeBytes: number,
    mtimeMs: number
  ): Promise<{ scannedLines: number; parseErrors: number }> {
    if (this.rebuildingFiles.has(filePath)) {
      return { scannedLines: 0, parseErrors: 0 };
    }

    this.rebuildingFiles.add(filePath);
    let scannedLines = 0;
    let parseErrors = 0;
    const rows: Record<string, unknown>[] = [];

    try {
      for await (const item of readJsonlLinesWithOffsets(filePath)) {
        scannedLines += 1;
        if (!item.line.trim()) continue;

        let event: LogEvent;
        try {
          event = JSON.parse(item.line) as LogEvent;
        } catch {
          parseErrors += 1;
          continue;
        }

        const row = eventToRow({
          baseDir: this.baseDir,
          id: encodeOffsetLogEventId(date, item.offset),
          date,
          filePath,
          lineNumber: item.lineNumber,
          offset: item.offset,
          byteLength: item.byteLength,
          event,
        });
        if (row) rows.push(row);
      }

      const transaction = this.db.transaction((eventRows: Record<string, unknown>[]) => {
        this.db
          .prepare(
            'DELETE FROM log_events_fts WHERE event_id IN (SELECT id FROM log_events WHERE source_file = ?)'
          )
          .run(filePath);
        this.db.prepare('DELETE FROM log_events WHERE source_file = ?').run(filePath);
        for (const row of eventRows) {
          this.insertEventStmt.run(row);
          this.insertFtsStmt.run(row.id, row.search_text);
        }
        this.upsertFileStmt.run(filePath, date, sizeBytes, mtimeMs, Date.now());
      });

      transaction(rows);
      this.dirtyFiles.delete(filePath);
      return { scannedLines, parseErrors };
    } finally {
      this.rebuildingFiles.delete(filePath);
    }
  }

  private queryStats(whereSql: string, params: unknown[]): IndexedLogStats {
    const aggregate = this.db
      .query(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(has_error), 0) AS errorCount,
          COALESCE(AVG(latency_ms), 0) AS avgLatencyMs,
          COALESCE(SUM(CASE WHEN token_usage_json IS NOT NULL THEN 1 ELSE 0 END), 0) AS tokenUsageCount,
          COALESCE(SUM(token_input), 0) AS inputTokens,
          COALESCE(SUM(token_output), 0) AS outputTokens,
          COALESCE(SUM(token_total), 0) AS totalTokens,
          COALESCE(SUM(token_cached_input), 0) AS cachedInputTokens,
          COALESCE(SUM(token_cache_hit_input), 0) AS cacheHitInputTokens,
          COALESCE(SUM(token_cache_hit_rate_denominator), 0) AS cacheHitRateDenominatorTokens,
          COALESCE(SUM(token_cache_read_input), 0) AS cacheReadInputTokens,
          COALESCE(SUM(token_cache_creation_input), 0) AS cacheCreationInputTokens,
          COALESCE(SUM(token_cache_write_input), 0) AS cacheWriteInputTokens,
          COALESCE(SUM(token_cache_miss_input), 0) AS cacheMissInputTokens,
          COALESCE(SUM(token_reasoning), 0) AS reasoningTokens,
          COALESCE(SUM(token_billable_input), 0) AS billableInputTokens,
          COALESCE(SUM(token_billable_output), 0) AS billableOutputTokens
        FROM log_events e
        ${whereSql}
      `)
      .get(...params) as {
      total: number;
      errorCount: number;
      avgLatencyMs: number;
      tokenUsageCount: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedInputTokens: number;
      cacheHitInputTokens: number;
      cacheHitRateDenominatorTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      cacheWriteInputTokens: number;
      cacheMissInputTokens: number;
      reasoningTokens: number;
      billableInputTokens: number;
      billableOutputTokens: number;
    };

    const total = Number(aggregate.total) || 0;
    if (total <= 0) return createEmptyStats();

    const p95Offset = Math.max(0, Math.ceil(total * 0.95) - 1);
    const p95Row = this.db
      .query(`
        SELECT latency_ms
        FROM log_events e
        ${whereSql}
        ORDER BY latency_ms ASC
        LIMIT 1 OFFSET ?
      `)
      .get(...params, p95Offset) as { latency_ms: number } | null;

    const errorCount = Number(aggregate.errorCount) || 0;
    return {
      total,
      errorCount,
      errorRate: toPercent(errorCount, total),
      avgLatencyMs: Math.round(Number(aggregate.avgLatencyMs) || 0),
      p95LatencyMs: Math.round(p95Row?.latency_ms ?? 0),
      tokenUsageCount: Number(aggregate.tokenUsageCount) || 0,
      inputTokens: Number(aggregate.inputTokens) || 0,
      outputTokens: Number(aggregate.outputTokens) || 0,
      totalTokens: Number(aggregate.totalTokens) || 0,
      cachedInputTokens: Number(aggregate.cachedInputTokens) || 0,
      cacheHitInputTokens: Number(aggregate.cacheHitInputTokens) || 0,
      cacheHitRate: toPercent(
        Number(aggregate.cacheHitInputTokens) || 0,
        Number(aggregate.cacheHitRateDenominatorTokens) || 0
      ),
      cacheHitRateDenominatorTokens: Number(aggregate.cacheHitRateDenominatorTokens) || 0,
      cacheReadInputTokens: Number(aggregate.cacheReadInputTokens) || 0,
      cacheCreationInputTokens: Number(aggregate.cacheCreationInputTokens) || 0,
      cacheWriteInputTokens: Number(aggregate.cacheWriteInputTokens) || 0,
      cacheMissInputTokens: Number(aggregate.cacheMissInputTokens) || 0,
      reasoningTokens: Number(aggregate.reasoningTokens) || 0,
      billableInputTokens: Number(aggregate.billableInputTokens) || 0,
      billableOutputTokens: Number(aggregate.billableOutputTokens) || 0,
    };
  }
}

export function initLogIndex(baseDir: string, config?: LogConfig): void {
  disposeLogIndex();
  if (config?.enabled === false) return;
  try {
    singleton = new LogIndex(baseDir, config);
  } catch (err) {
    singleton = null;
    console.error('[log-index] SQLite 索引初始化失败，将退回 JSONL 扫描:', err);
  }
}

export function disposeLogIndex(): void {
  if (!singleton) return;
  try {
    singleton.dispose();
  } catch (err) {
    console.error('[log-index] SQLite 索引关闭失败:', err);
  } finally {
    singleton = null;
  }
}

export function getLogIndex(baseDir?: string): LogIndex | null {
  if (!singleton) return null;
  if (baseDir && singleton.baseDir !== baseDir) return null;
  return singleton;
}

export function enqueueLogEventForIndex(input: {
  baseDir: string;
  filePath: string;
  date: string;
  offset: number;
  byteLength: number;
  event: LogEvent;
}): void {
  const index = getLogIndex(input.baseDir);
  index?.enqueue(input);
}

export async function queryIndexedLogEvents(
  logConfig: LogConfig | undefined,
  query: IndexedLogQuery
): Promise<IndexedLogQueryResult | null> {
  if (!logConfig || logConfig.enabled === false) return createEmptyQueryResult(query);
  const baseDir = resolveLogBaseDir(logConfig);
  const index = getLogIndex(baseDir);
  if (!index) return null;

  try {
    const freshness = await index.ensureRangeIndexed(query.fromMs, query.toMs);
    const result = index.queryEvents(query);
    return {
      ...result,
      meta: {
        ...result.meta,
        scannedFiles: freshness.scannedFiles,
        scannedLines: freshness.scannedLines,
        parseErrors: freshness.parseErrors,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes('cursor')) {
      throw err;
    }
    return {
      ...createEmptyQueryResult(query, {
        indexUsed: false,
        indexFresh: false,
        fallbackReason: err instanceof Error ? err.message : String(err),
        statsMode: 'none',
      }),
    };
  }
}

export async function queryIndexedLogSessions(
  logConfig: LogConfig | undefined,
  query: IndexedLogSessionsQuery
): Promise<IndexedLogSessionsResult | null> {
  if (!logConfig || logConfig.enabled === false) {
    return {
      from: new Date(query.fromMs).toISOString(),
      to: new Date(query.toMs).toISOString(),
      summary: { totalRequests: 0, metadataRequests: 0, uniqueUsers: 0, uniqueSessions: 0 },
      users: [],
      meta: {
        scannedFiles: 0,
        scannedLines: 0,
        parseErrors: 0,
        truncated: false,
        indexUsed: true,
        indexFresh: true,
        queryMs: 0,
      },
    };
  }

  const baseDir = resolveLogBaseDir(logConfig);
  const index = getLogIndex(baseDir);
  if (!index) return null;

  try {
    const freshness = await index.ensureRangeIndexed(query.fromMs, query.toMs);
    const result = index.querySessions(query);
    return {
      from: result.from,
      to: result.to,
      summary: result.summary,
      users: result.users,
      meta: {
        scannedFiles: freshness.scannedFiles,
        scannedLines: freshness.scannedLines,
        parseErrors: freshness.parseErrors,
        truncated: false,
        indexUsed: true,
        indexFresh: true,
        queryMs: result.queryMs,
      },
    };
  } catch (err) {
    return {
      from: new Date(query.fromMs).toISOString(),
      to: new Date(query.toMs).toISOString(),
      summary: { totalRequests: 0, metadataRequests: 0, uniqueUsers: 0, uniqueSessions: 0 },
      users: [],
      meta: {
        scannedFiles: 0,
        scannedLines: 0,
        parseErrors: 0,
        truncated: false,
        indexUsed: false,
        indexFresh: false,
        queryMs: 0,
        fallbackReason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export function getIndexedLogEventDetail(
  logConfig: LogConfig | undefined,
  id: string
): IndexedLogEventRecord | null {
  if (!logConfig || logConfig.enabled === false) return null;
  const baseDir = resolveLogBaseDir(logConfig);
  const indexed = getLogIndex(baseDir)?.getEventRecordByOffsetId(id);
  if (indexed) return indexed;

  const parsedId = decodeOffsetLogEventId(id);
  if (!parsedId) return null;

  const filePath = join(baseDir, 'events', `${parsedId.date}.jsonl`);
  if (!existsSync(filePath)) return null;
  const line = readLineAtOffset(filePath, parsedId.offset);
  if (!line?.trim()) return null;

  return {
    event: JSON.parse(line) as LogEvent,
    location: {
      id,
      date: parsedId.date,
      file: filePath,
      line: null,
      offset: parsedId.offset,
    },
  };
}
