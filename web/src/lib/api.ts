import type { AppConfig, ConfigMeta, LogMetricsResponse, LogMetricsWindow, UsageMetricsResponse, UsageMetricsWindow } from '@/types/config';
import { CryptoClient, type EncryptedPayload } from './crypto';

interface OneShotSession {
  client: CryptoClient;
  sessionId: string;
}

async function createOneShotSession(): Promise<OneShotSession> {
  const client = new CryptoClient();
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
}

async function withOneShotSession<T>(
  action: (session: OneShotSession) => Promise<T>,
  retry401 = true
): Promise<T> {
  const session = await createOneShotSession();
  try {
    return await action(session);
  } catch (err) {
    const status =
      typeof err === 'object' && err !== null && 'status' in err ? (err as { status?: number }).status :
        undefined;
    if (retry401 && status === 401) {
      const retriedSession = await createOneShotSession();
      return action(retriedSession);
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

export async function applyConfig(): Promise<{ providers: number; routes: number }> {
  const res = await fetch('/api/config/apply', { method: 'POST' });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `应用配置失败: ${res.status}`);
  }

  const data = await res.json();
  return data.summary;
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
  };
  meta: {
    scannedFiles: number;
    scannedLines: number;
    parseErrors: number;
    truncated: boolean;
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
  window?: '1h' | '6h' | '24h';
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

  return params.toString();
}

export interface FetchLogSessionsParams {
  window?: '1h' | '6h' | '24h';
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
  params: FetchLogEventsParams = {}
): Promise<LogEventsResponse> {
  const query = buildLogQueryString(params);
  const res = await fetch(`/api/logs/events${query ? `?${query}` : ''}`);

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

export function openLogTail(
  params: Omit<FetchLogEventsParams, 'from' | 'to' | 'limit' | 'cursor'>,
  handlers: {
    onReady?: () => void;
    onEvents?: (payload: LogEventsResponse) => void;
    onError?: (message: string) => void;
  }
): () => void {
  const query = buildLogQueryString(params);
  const source = new EventSource(`/api/logs/tail${query ? `?${query}` : ''}`);

  source.addEventListener('ready', () => {
    handlers.onReady?.();
  });

  source.addEventListener('events', (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent).data) as LogEventsResponse;
      handlers.onEvents?.(payload);
    } catch {
      handlers.onError?.('实时日志数据解析失败');
    }
  });

  source.addEventListener('error', (event) => {
    if ((event as MessageEvent).data) {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { error?: string };
        handlers.onError?.(payload.error ?? '实时日志连接异常');
        return;
      } catch {
        // ignore parse error
      }
    }
    handlers.onError?.('实时日志连接异常');
  });

  source.onerror = () => {
    handlers.onError?.('实时日志连接中断');
  };

  return () => {
    source.close();
  };
}

export async function fetchUsageMetrics(
  window: UsageMetricsWindow = '24h',
  refresh = false
): Promise<UsageMetricsResponse> {
  const params = new URLSearchParams({ window, refresh: refresh ? '1' : '0' });
  const res = await fetch(`/api/usage?${params.toString()}`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `获取用量统计失败: ${res.status}`);
  }

  return res.json();
}
