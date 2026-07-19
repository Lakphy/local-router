import type { AppConfig, ConfigMeta, LogMetricsResponse, LogMetricsWindow } from '@/types/config';
import { CryptoClient, type EncryptedPayload } from './crypto';

interface OneShotSession {
  client: CryptoClient;
  sessionId: string;
}

async function createOneShotSession(): Promise<OneShotSession> {
  const client = new CryptoClient();
  try {
    const clientPublicKey = await client.generateKeyPair();

    const res = await fetch('/api/crypto/handshake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientPublicKey }),
    });

    if (!res.ok) throw new Error('加密握手失败');

    const data = await res.json();
    await client.deriveKey(data.serverPublicKey);

    return { client, sessionId: data.sessionId };
  } catch (err) {
    client.dispose();
    throw err;
  }
}

async function runWithOneShotSession<T>(
  action: (session: OneShotSession) => Promise<T>
): Promise<T> {
  const session = await createOneShotSession();
  try {
    return await action(session);
  } finally {
    session.client.dispose();
  }
}

async function withOneShotSession<T>(
  action: (session: OneShotSession) => Promise<T>,
  retry401 = true
): Promise<T> {
  try {
    return await runWithOneShotSession(action);
  } catch (err) {
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? (err as { status?: number }).status
        : undefined;
    if (retry401 && status === 401) {
      return runWithOneShotSession(action);
    }
    throw err;
  }
}

export async function fetchConfig(): Promise<AppConfig> {
  return withOneShotSession(async ({ client, sessionId }) => {
    const res = await fetch('/api/config', {
      headers: { 'x-crypto-session': sessionId },
    });

    if (!res.ok) {
      const error = new Error(`获取配置失败: ${res.status}`) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }

    const encrypted: EncryptedPayload = await res.json();
    const decrypted = await client.decrypt(encrypted);
    return JSON.parse(decrypted);
  });
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await withOneShotSession(async ({ client, sessionId }) => {
    const encrypted = await client.encrypt(JSON.stringify(config));

    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-crypto-session': sessionId,
      },
      body: JSON.stringify(encrypted),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error ?? `保存配置失败: ${res.status}`) as Error & {
        status?: number;
      };
      error.status = res.status;
      throw error;
    }
  });
}

export interface ApplyResult {
  summary: { providers: number; routes: number };
  /** 监听地址（host/port/idleTimeout）发生变化，需要重启服务才能生效 */
  restartRequired: boolean;
  /** 当前运行方式是否支持由服务自动重启（dev/test 等场景为 false） */
  canRestart: boolean;
  /** 重启后服务的目标监听地址 */
  listen?: { host: string; port: number };
}

export async function applyConfig(): Promise<ApplyResult> {
  const res = await fetch('/api/config/apply', { method: 'POST' });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `应用配置失败: ${res.status}`);
  }

  const data = await res.json();
  return {
    summary: data.summary ?? { providers: 0, routes: 0 },
    restartRequired: Boolean(data.restartRequired),
    canRestart: Boolean(data.canRestart),
    listen: data.listen,
  };
}

export async function restartServer(): Promise<{ host: string; port: number }> {
  const res = await fetch('/api/restart', { method: 'POST' });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `重启服务失败: ${res.status}`);
  }

  const data = await res.json();
  return data.listen;
}

export async function fetchConfigMeta(): Promise<ConfigMeta> {
  const res = await fetch('/api/config/meta');
  if (!res.ok) throw new Error(`获取配置元信息失败: ${res.status}`);
  return res.json();
}

export async function fetchConfigSchema(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/config/schema');
  if (!res.ok) throw new Error(`获取配置 schema 失败: ${res.status}`);
  return res.json();
}

export async function discoverRemoteModels(
  ip: string,
  port: string,
  protocol: string
): Promise<string[]> {
  const params = new URLSearchParams({ ip, port, protocol });
  const res = await fetch(`/api/providers/discover?${params.toString()}`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `嗅探对端模型失败: ${res.status}`);
  }

  const data = await res.json();
  return Array.isArray(data.models) ? data.models : [];
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

export async function fetchLogMetrics(
  window: LogMetricsWindow = '24h',
  refresh = false
): Promise<LogMetricsResponse> {
  const params = new URLSearchParams({ window, refresh: refresh ? '1' : '0' });
  const res = await fetch(`/api/metrics/logs?${params.toString()}`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `获取日志统计失败: ${res.status}`);
  }

  return res.json();
}

export interface LogStorageInfo {
  totalBytes: number;
  eventsBytes: number;
  streamsBytes: number;
  indexBytes: number;
  fileCount: number;
  lastUpdatedAt: string;
  isCalculating: boolean;
}

export async function fetchLogStorage(refresh = false): Promise<LogStorageInfo> {
  const params = new URLSearchParams({ refresh: refresh ? '1' : '0' });
  const res = await fetch(`/api/logs/storage?${params.toString()}`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `获取日志存储统计失败: ${res.status}`);
  }

  return res.json();
}

export interface LogEventSummary {
  id: string;
  ts: string;
  level: 'info' | 'error';
  provider: string;
  routeType: string;
  model: string;
  modelIn: string;
  modelOut: string;
  path: string;
  requestId: string;
  latencyMs: number;
  upstreamStatus: number;
  statusClass: '2xx' | '4xx' | '5xx' | 'network_error';
  hasError: boolean;
  message: string;
  errorType: string | null;
  hasMetadata: boolean;
  userIdRaw: string | null;
  userKey: string | null;
  sessionId: string | null;
  tokenUsage: TokenUsageSummary | null;
}

export interface TokenUsageSummary {
  schemaVersion: 1;
  source:
    | 'explicit'
    | 'response_body'
    | 'response_body_after_plugins'
    | 'response_body_before_plugins'
    | 'stream_chunk'
    | 'stream_file';
  providerStyle:
    | 'openai'
    | 'anthropic'
    | 'gemini'
    | 'deepseek'
    | 'cohere'
    | 'mistral'
    | 'openrouter'
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
  creditUsage: number | null;
  cost: number | null;
  rawUsagePath: string | null;
  warnings: string[];
}

export interface LogEventsResponse {
  items: LogEventSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  stats: {
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
  };
  meta: {
    scannedFiles: number;
    scannedLines: number;
    parseErrors: number;
    truncated: boolean;
    indexUsed?: boolean;
    indexFresh?: boolean;
    usesFts?: boolean;
    queryMs?: number;
    rowsReturned?: number;
    fallbackReason?: string;
    statsMode?: 'none' | 'cached' | 'exact' | 'partial';
  };
}

export interface LogSessionSummary {
  sessionId: string;
  requestCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  models: Array<{ key: string; count: number }>;
  latestRequestId: string;
}

export interface LogUserSummary {
  userKey: string;
  requestCount: number;
  sessionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  models: Array<{ key: string; count: number }>;
  providers: Array<{ key: string; count: number }>;
  routeTypes: Array<{ key: string; count: number }>;
  sessions: LogSessionSummary[];
}

export interface LogSessionsResponse {
  from: string;
  to: string;
  summary: {
    totalRequests: number;
    metadataRequests: number;
    uniqueUsers: number;
    uniqueSessions: number;
  };
  users: LogUserSummary[];
  meta: {
    scannedFiles: number;
    scannedLines: number;
    parseErrors: number;
    truncated: boolean;
    indexUsed?: boolean;
    indexFresh?: boolean;
    queryMs?: number;
    fallbackReason?: string;
  };
}

export interface LogEventDetail {
  id: string;
  summary: {
    id: string;
    ts: string;
    level: 'info' | 'error';
    provider: string;
    routeType: string;
    routeRuleKey: string;
    requestId: string;
    latencyMs: number;
    upstreamStatus: number;
    statusClass: '2xx' | '4xx' | '5xx' | 'network_error';
    hasError: boolean;
    model: string;
    modelIn: string;
    modelOut: string;
    tokenUsage: TokenUsageSummary | null;
  };
  usage: {
    tokenUsage: TokenUsageSummary | null;
    requestBytes: number;
    responseBytes: number | null;
    streamBytes: number | null;
    streamFileBytes: number | null;
    streamFileTruncated: boolean;
  };
  request: {
    method: string;
    path: string;
    contentType: string | null;
    requestHeaders: Record<string, string> | null;
    requestBody: unknown | null;
  };
  response: {
    upstreamStatus: number;
    contentType: string | null;
    responseHeaders: Record<string, string> | null;
    responseBody: string | null;
  };
  upstream: {
    targetUrl: string;
    proxyUrl: string | null;
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
  plugins?: {
    request?: Array<{ name: string; package: string; params: Record<string, unknown> }>;
    response?: Array<{ name: string; package: string; params: Record<string, unknown> }>;
    requestBodyAfterPlugins?: unknown;
    requestUrlAfterPlugins?: string;
    responseBodyBeforePlugins?: string;
    responseBodyAfterPlugins?: string;
  };
  rawEvent: unknown;
  location: {
    date: string;
    line: number;
    file: string;
  };
}

export interface FetchLogEventsParams {
  window?: '1h' | '6h' | '24h' | '7d' | '1mo' | '1y';
  from?: string;
  to?: string;
  levels?: Array<'info' | 'error'>;
  provider?: string;
  routeType?: string;
  model?: string;
  modelIn?: string;
  modelOut?: string;
  user?: string;
  session?: string;
  statusClass?: Array<'2xx' | '4xx' | '5xx' | 'network_error'>;
  hasError?: boolean;
  q?: string;
  sort?: 'time_desc' | 'time_asc';
  limit?: number;
  cursor?: string;
  offset?: number;
}

function appendArrayParam(params: URLSearchParams, key: string, values?: string[]): void {
  if (!values || values.length === 0) return;
  params.set(key, values.join(','));
}

function buildLogQueryString(paramsInput: FetchLogEventsParams): string {
  const params = new URLSearchParams();

  if (paramsInput.window) params.set('window', paramsInput.window);
  if (paramsInput.from) params.set('from', paramsInput.from);
  if (paramsInput.to) params.set('to', paramsInput.to);
  appendArrayParam(params, 'levels', paramsInput.levels);
  if (paramsInput.provider) params.set('provider', paramsInput.provider);
  if (paramsInput.routeType) params.set('routeType', paramsInput.routeType);
  if (paramsInput.model) params.set('model', paramsInput.model);
  if (paramsInput.modelIn) params.set('modelIn', paramsInput.modelIn);
  if (paramsInput.modelOut) params.set('modelOut', paramsInput.modelOut);
  if (paramsInput.user) params.set('user', paramsInput.user);
  if (paramsInput.session) params.set('session', paramsInput.session);
  appendArrayParam(params, 'statusClass', paramsInput.statusClass);
  if (typeof paramsInput.hasError === 'boolean') {
    params.set('hasError', paramsInput.hasError ? 'true' : 'false');
  }
  if (paramsInput.q) params.set('q', paramsInput.q);
  if (paramsInput.sort) params.set('sort', paramsInput.sort);
  if (paramsInput.limit) params.set('limit', String(paramsInput.limit));
  if (paramsInput.cursor) params.set('cursor', paramsInput.cursor);
  if (paramsInput.offset) params.set('offset', String(paramsInput.offset));

  return params.toString();
}

export interface FetchLogSessionsParams {
  window?: '1h' | '6h' | '24h' | '7d' | '1mo' | '1y';
  from?: string;
  to?: string;
  user?: string;
  session?: string;
  q?: string;
}

function buildLogSessionsQueryString(paramsInput: FetchLogSessionsParams): string {
  const params = new URLSearchParams();
  if (paramsInput.window) params.set('window', paramsInput.window);
  if (paramsInput.from) params.set('from', paramsInput.from);
  if (paramsInput.to) params.set('to', paramsInput.to);
  if (paramsInput.user) params.set('user', paramsInput.user);
  if (paramsInput.session) params.set('session', paramsInput.session);
  if (paramsInput.q) params.set('q', paramsInput.q);
  return params.toString();
}

export async function fetchLogSessions(
  params: FetchLogSessionsParams = {}
): Promise<LogSessionsResponse> {
  const query = buildLogSessionsQueryString(params);
  const res = await fetch(`/api/logs/sessions${query ? `?${query}` : ''}`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `获取用户会话失败: ${res.status}`);
  }

  return res.json();
}

export async function fetchLogEvents(
  params: FetchLogEventsParams = {},
  options: { signal?: AbortSignal } = {}
): Promise<LogEventsResponse> {
  const query = buildLogQueryString(params);
  const res = await fetch(`/api/logs/events${query ? `?${query}` : ''}`, {
    signal: options.signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `获取日志列表失败: ${res.status}`);
  }

  return res.json();
}

export async function fetchLogEventDetail(id: string): Promise<LogEventDetail> {
  const res = await fetch(`/api/logs/events/${encodeURIComponent(id)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `获取日志详情失败: ${res.status}`);
  }
  return res.json();
}

export async function exportLogEvents(
  params: FetchLogEventsParams,
  format: 'csv' | 'json'
): Promise<Blob> {
  const query = buildLogQueryString(params);
  const url = `/api/logs/export?format=${format}${query ? `&${query}` : ''}`;
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `导出日志失败: ${res.status}`);
  }

  return res.blob();
}

// ─── Autostart ──────────────────────────────────────────────────────────────

export interface AutostartStatus {
  enabled: boolean;
  systemInstalled: boolean;
  platform: string;
  servicePath: string;
}

export async function fetchAutostartStatus(): Promise<AutostartStatus> {
  const res = await fetch('/api/autostart');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `获取自启动状态失败: ${res.status}`);
  }
  return res.json();
}

export async function setAutostart(enabled: boolean): Promise<void> {
  const res = await fetch('/api/autostart', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `设置自启动失败: ${res.status}`);
  }
}
