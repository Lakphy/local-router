import type { ConfigStore } from './config-store';
import {
  createLogEventSummaryFromFacts,
  extractLogEventFacts,
  getLogQueryWindowMs,
  isLogQueryWindow,
  type LogEventFacts,
  type LogEventSummary,
  type LogLevel,
  type LogQueryWindow,
  type LogSort,
  parseBooleanFlag,
  parseCommaSeparated,
  resolveLogQueryRange,
  type StatusClass,
  validateLogLevel,
  validateSort,
  validateStatusClass,
} from './log-query';
import { type PublishedLogEvent, subscribeLogEvents } from './log-tail';
import { decideNetworkAccess } from './network-access';

const WS_PATHNAME = '/api/logs/events/ws';
const MAX_CONNECTIONS = 64;
const MAX_SUBSCRIPTIONS = 64;
const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;
const MAX_GLOBAL_EVENT_QUEUE_ITEMS = 1000;
const MAX_GLOBAL_EVENT_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_BYTES_PER_CONNECTION = 1024 * 1024;
const MAX_TOTAL_PENDING_BYTES = 32 * 1024 * 1024;
const BACKPRESSURE_BUFFERED_BYTES = 512 * 1024;
const HEARTBEAT_INTERVAL_MS = 15_000;
const FLUSH_BUDGET_MS = 10;
const MAX_Q_LENGTH = 200;

export interface LogRealtimeWebSocketData {
  kind: 'log-realtime';
  connectionId: string;
  remoteAddress: string | null;
}

interface LogRealtimeUpgradeServer {
  upgrade(request: Request, options: { data: LogRealtimeWebSocketData }): boolean;
}

interface LogRealtimeWebSocket {
  data: LogRealtimeWebSocketData;
  readyState?: number;
  bufferedAmount?: number;
  send(message: string): number | undefined;
  close(code?: number, reason?: string): void;
}

export interface LogRealtimeUpgradeResult {
  handled: boolean;
  upgraded?: boolean;
  response?: Response;
}

export interface LogRealtimeRuntime {
  pathname: typeof WS_PATHNAME;
  upgrade: (
    request: Request,
    server: LogRealtimeUpgradeServer,
    remoteAddress: string | null
  ) => LogRealtimeUpgradeResult;
  websocket: {
    open: (ws: LogRealtimeWebSocket) => void;
    message: (ws: LogRealtimeWebSocket, message: string | ArrayBuffer | Uint8Array) => void;
    drain: (ws: LogRealtimeWebSocket) => void;
    close: (ws: LogRealtimeWebSocket) => void;
  };
  dispose: () => void;
}

type ClientMessage =
  | {
      type: 'subscribe';
      requestId?: string;
      query?: Record<string, unknown>;
    }
  | { type: 'unsubscribe'; subscriptionId?: string }
  | { type: 'ping'; ts?: string };

type ServerMessage =
  | { type: 'ready'; connectionId: string; now: string }
  | {
      type: 'subscribed';
      requestId: string | null;
      subscriptionId: string;
      queryHash: string;
      now: string;
    }
  | { type: 'unsubscribed'; subscriptionId: string; reason?: string }
  | { type: 'log.event'; subscriptionId: string; item: LogEventSummary }
  | { type: 'overflow'; subscriptionId: string; dropped: number; message: string }
  | { type: 'pong'; ts: string }
  | { type: 'error'; requestId?: string; error: string };

type RealtimeQueryRange =
  | { type: 'window'; window: LogQueryWindow; windowMs: number }
  | { type: 'fixed'; fromMs: number; toMs: number };

interface CompiledRealtimeQuery {
  queryHash: string;
  sort: LogSort;
  range: RealtimeQueryRange;
  levels: Set<LogLevel>;
  providers: Set<string>;
  routeTypes: Set<string>;
  models: Set<string>;
  modelIns: Set<string>;
  modelOuts: Set<string>;
  users: Set<string>;
  sessions: Set<string>;
  statusClasses: Set<StatusClass>;
  hasError: boolean | null;
  q: string;
}

interface RealtimeSubscription {
  id: string;
  connectionId: string;
  query: CompiledRealtimeQuery;
}

interface OutboundMessage {
  text: string;
  bytes: number;
}

interface RealtimeConnection {
  id: string;
  remoteAddress: string | null;
  ws: LogRealtimeWebSocket;
  subscriptions: Set<string>;
  queue: OutboundMessage[];
  pendingBytes: number;
  droppedOutbound: number;
}

interface QueuedPublishedLogEvent {
  event: PublishedLogEvent;
  bytes: number;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function estimatePublishedEventBytes(event: PublishedLogEvent): number {
  const bodyBytes = (event.event.request_bytes ?? 0) + (event.event.response_bytes ?? 0);
  const streamBytes = event.event.stream_bytes ?? 0;
  return 1024 + Math.min(64 * 1024, Math.max(0, bodyBytes + streamBytes));
}

function byteLength(text: string): number {
  return Buffer.byteLength(text);
}

function isSocketOpen(ws: LogRealtimeWebSocket): boolean {
  return typeof ws.readyState !== 'number' || ws.readyState === 1;
}

function bufferedAmount(ws: LogRealtimeWebSocket): number {
  return typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0;
}

function parseClientMessage(raw: string | ArrayBuffer | Uint8Array): ClientMessage {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else {
    text = new TextDecoder().decode(raw);
  }

  if (byteLength(text) > MAX_CLIENT_MESSAGE_BYTES) {
    throw new Error('客户端消息过大');
  }

  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('客户端消息必须是 JSON 对象');
  }

  const message = parsed as ClientMessage;
  if (message.type !== 'subscribe' && message.type !== 'unsubscribe' && message.type !== 'ping') {
    throw new Error('不支持的实时日志消息类型');
  }
  return message;
}

function parseStringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseStringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === 'string' ? parseCommaSeparated(item) : []));
  }
  if (typeof value === 'string') return parseCommaSeparated(value);
  return [];
}

function parseBooleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return parseBooleanFlag(value);
  return null;
}

function createQueryHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `q_${(hash >>> 0).toString(36)}`;
}

function parseValidatedArray<T extends string>(
  value: unknown,
  validate: (item: string) => item is T,
  errorMessage: string
): T[] {
  const raw = parseStringArrayValue(value);
  const parsed = raw.filter(validate);
  if (parsed.length !== raw.length) {
    throw new Error(errorMessage);
  }
  return parsed;
}

function compileRealtimeQuery(input: Record<string, unknown> | undefined): CompiledRealtimeQuery {
  const query = input ?? {};
  const nowMs = Date.now();

  const windowRaw = parseStringValue(query.window) ?? '24h';
  if (!isLogQueryWindow(windowRaw)) {
    throw new Error('window 参数仅支持 1h | 6h | 24h | 7d | 1mo | 1y');
  }

  const from = parseStringValue(query.from);
  const to = parseStringValue(query.to);
  const range: RealtimeQueryRange =
    from || to
      ? {
          type: 'fixed',
          ...resolveLogQueryRange({ window: windowRaw, from, to, nowMs }),
        }
      : {
          type: 'window',
          window: windowRaw,
          windowMs: getLogQueryWindowMs(windowRaw),
        };

  if (range.type === 'fixed' && range.toMs <= nowMs) {
    throw new Error('固定结束时间已过期，实时推送仅支持仍在滚动的查询窗口');
  }

  const sortRaw = parseStringValue(query.sort) ?? 'time_desc';
  if (!validateSort(sortRaw)) {
    throw new Error('sort 参数仅支持 time_desc | time_asc');
  }

  const levels = parseValidatedArray(
    query.levels,
    validateLogLevel,
    'levels 参数仅支持 info,error'
  );
  const statusClasses = parseValidatedArray(
    query.statusClass,
    validateStatusClass,
    'statusClass 参数仅支持 2xx,4xx,5xx,network_error'
  );
  const q = (parseStringValue(query.q) ?? '').slice(0, MAX_Q_LENGTH).toLowerCase();

  const normalized = {
    range,
    sort: sortRaw,
    levels,
    providers: parseStringArrayValue(query.provider),
    routeTypes: parseStringArrayValue(query.routeType),
    models: parseStringArrayValue(query.model),
    modelIns: parseStringArrayValue(query.modelIn),
    modelOuts: parseStringArrayValue(query.modelOut),
    users: parseStringArrayValue(query.user),
    sessions: parseStringArrayValue(query.session),
    statusClasses,
    hasError: parseBooleanValue(query.hasError),
    q,
  };

  return {
    queryHash: createQueryHash(normalized),
    sort: sortRaw,
    range,
    levels: new Set(levels),
    providers: new Set(normalized.providers),
    routeTypes: new Set(normalized.routeTypes),
    models: new Set(normalized.models),
    modelIns: new Set(normalized.modelIns),
    modelOuts: new Set(normalized.modelOuts),
    users: new Set(normalized.users),
    sessions: new Set(normalized.sessions),
    statusClasses: new Set(statusClasses),
    hasError: normalized.hasError,
    q,
  };
}

function setHas<T>(set: Set<T>, value: T): boolean {
  return set.size === 0 || set.has(value);
}

function matchesCompiledQuery(
  query: CompiledRealtimeQuery,
  facts: LogEventFacts,
  nowMs: number
): boolean {
  if (!facts.event.ts_start || !Number.isFinite(facts.ts)) return false;

  const fromMs = query.range.type === 'window' ? nowMs - query.range.windowMs : query.range.fromMs;
  const toMs = query.range.type === 'window' ? nowMs : query.range.toMs;
  if (facts.ts < fromMs || facts.ts > toMs) return false;

  if (!setHas(query.levels, facts.level)) return false;
  if (!setHas(query.providers, facts.event.provider)) return false;
  if (!setHas(query.routeTypes, facts.event.route_type)) return false;
  if (!setHas(query.models, facts.model)) return false;
  if (!setHas(query.modelIns, facts.event.model_in)) return false;
  if (!setHas(query.modelOuts, facts.event.model_out)) return false;

  if (query.users.size > 0) {
    const matchedByRaw = facts.identity.userIdRaw
      ? query.users.has(facts.identity.userIdRaw)
      : false;
    const matchedByUserKey = facts.identity.userKey
      ? query.users.has(facts.identity.userKey)
      : false;
    if (!matchedByRaw && !matchedByUserKey) return false;
  }

  if (query.sessions.size > 0) {
    if (!facts.identity.sessionId || !query.sessions.has(facts.identity.sessionId)) return false;
  }

  if (!setHas(query.statusClasses, facts.statusClass)) return false;
  if (query.hasError !== null && query.hasError !== facts.hasError) return false;
  return !query.q || facts.keywordText.includes(query.q);
}

export function createLogRealtimeRuntime(options: { store: ConfigStore }): LogRealtimeRuntime {
  const connections = new Map<string, RealtimeConnection>();
  const subscriptions = new Map<string, RealtimeSubscription>();
  const eventQueue: QueuedPublishedLogEvent[] = [];

  let tailUnsubscribe: (() => void) | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let eventQueueBytes = 0;
  let totalPendingBytes = 0;
  let droppedUpstreamEvents = 0;

  const sendText = (connection: RealtimeConnection, text: string): boolean => {
    if (!isSocketOpen(connection.ws)) return false;

    const bytes = byteLength(text);
    const shouldQueue =
      connection.queue.length > 0 || bufferedAmount(connection.ws) > BACKPRESSURE_BUFFERED_BYTES;

    if (!shouldQueue) {
      try {
        connection.ws.send(text);
        return true;
      } catch {
        removeConnection(connection.id, 'send-failed');
        return false;
      }
    }

    if (
      connection.pendingBytes + bytes > MAX_PENDING_BYTES_PER_CONNECTION ||
      totalPendingBytes + bytes > MAX_TOTAL_PENDING_BYTES
    ) {
      connection.droppedOutbound += 1;
      if (connection.droppedOutbound >= 3) {
        removeConnection(connection.id, 'slow-client');
      }
      return false;
    }

    connection.queue.push({ text, bytes });
    connection.pendingBytes += bytes;
    totalPendingBytes += bytes;
    return true;
  };

  const sendMessage = (connection: RealtimeConnection, message: ServerMessage): boolean => {
    return sendText(connection, JSON.stringify(message));
  };

  const flushConnectionQueue = (connection: RealtimeConnection): void => {
    if (!isSocketOpen(connection.ws)) return;

    while (
      connection.queue.length > 0 &&
      bufferedAmount(connection.ws) <= BACKPRESSURE_BUFFERED_BYTES
    ) {
      const item = connection.queue.shift();
      if (!item) break;
      connection.pendingBytes -= item.bytes;
      totalPendingBytes -= item.bytes;
      try {
        connection.ws.send(item.text);
      } catch {
        removeConnection(connection.id, 'send-failed');
        return;
      }
    }
  };

  const sendError = (connection: RealtimeConnection, error: string, requestId?: string): void => {
    sendMessage(connection, { type: 'error', requestId, error });
  };

  const ensureTailSubscription = (): void => {
    if (tailUnsubscribe || subscriptions.size === 0) return;
    tailUnsubscribe = subscribeLogEvents((event) => {
      if (subscriptions.size === 0) return;

      const bytes = estimatePublishedEventBytes(event);
      while (
        eventQueue.length >= MAX_GLOBAL_EVENT_QUEUE_ITEMS ||
        eventQueueBytes + bytes > MAX_GLOBAL_EVENT_QUEUE_BYTES
      ) {
        const dropped = eventQueue.shift();
        if (!dropped) break;
        eventQueueBytes -= dropped.bytes;
        droppedUpstreamEvents += 1;
      }

      eventQueue.push({ event, bytes });
      eventQueueBytes += bytes;
      scheduleFlush();
    });
  };

  const maybeStopTailSubscription = (): void => {
    if (subscriptions.size > 0) return;

    tailUnsubscribe?.();
    tailUnsubscribe = null;
    eventQueue.length = 0;
    eventQueueBytes = 0;
    droppedUpstreamEvents = 0;
  };

  const sendOverflow = (
    subscription: RealtimeSubscription,
    dropped: number,
    message: string
  ): void => {
    const connection = connections.get(subscription.connectionId);
    if (!connection) return;
    sendMessage(connection, {
      type: 'overflow',
      subscriptionId: subscription.id,
      dropped,
      message,
    });
  };

  const removeSubscription = (subscriptionId: string, reason: string, notify = true): void => {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) return;
    subscriptions.delete(subscriptionId);

    const connection = connections.get(subscription.connectionId);
    if (connection) {
      connection.subscriptions.delete(subscriptionId);
      if (notify) {
        sendMessage(connection, {
          type: 'unsubscribed',
          subscriptionId,
          reason,
        });
      }
    }

    maybeStopTailSubscription();
  };

  function removeConnection(connectionId: string, reason: string): void {
    const connection = connections.get(connectionId);
    if (!connection) return;
    connections.delete(connectionId);

    for (const subscriptionId of Array.from(connection.subscriptions)) {
      removeSubscription(subscriptionId, reason, false);
    }

    for (const item of connection.queue) {
      totalPendingBytes -= item.bytes;
    }
    connection.queue.length = 0;
    connection.pendingBytes = 0;

    try {
      connection.ws.close(1001, reason);
    } catch {
      // ignore close-after-closed
    }

    if (connections.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    maybeStopTailSubscription();
  }

  const pruneExpiredSubscriptions = (nowMs: number): void => {
    for (const subscription of Array.from(subscriptions.values())) {
      const range = subscription.query.range;
      if (range.type === 'fixed' && range.toMs <= nowMs) {
        removeSubscription(subscription.id, 'expired');
      }
    }
  };

  const flushEvents = (): void => {
    flushTimer = null;

    if (subscriptions.size === 0) {
      eventQueue.length = 0;
      eventQueueBytes = 0;
      droppedUpstreamEvents = 0;
      maybeStopTailSubscription();
      return;
    }

    const startedAt = Date.now();
    const nowMs = Date.now();
    pruneExpiredSubscriptions(nowMs);

    if (droppedUpstreamEvents > 0) {
      const dropped = droppedUpstreamEvents;
      droppedUpstreamEvents = 0;
      for (const subscription of subscriptions.values()) {
        sendOverflow(
          subscription,
          dropped,
          `实时日志队列已丢弃 ${dropped} 条事件，请重新查询以补齐。`
        );
      }
    }

    while (eventQueue.length > 0 && Date.now() - startedAt < FLUSH_BUDGET_MS) {
      const queued = eventQueue.shift();
      if (!queued) break;
      eventQueueBytes -= queued.bytes;

      const facts = extractLogEventFacts(queued.event.event);
      let summary: LogEventSummary | null = null;

      for (const subscription of subscriptions.values()) {
        if (!matchesCompiledQuery(subscription.query, facts, Date.now())) continue;
        const connection = connections.get(subscription.connectionId);
        if (!connection) continue;

        summary ??= createLogEventSummaryFromFacts(facts, {
          id: queued.event.id,
          date: queued.event.date,
          line: null,
        });

        const sent = sendMessage(connection, {
          type: 'log.event',
          subscriptionId: subscription.id,
          item: summary,
        });

        if (!sent) {
          sendOverflow(subscription, 1, '实时日志客户端发送队列已满，请重新查询以补齐。');
        }
      }
    }

    for (const connection of connections.values()) {
      flushConnectionQueue(connection);
    }

    if (eventQueue.length > 0) scheduleFlush();
  };

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(flushEvents, 0);
    flushTimer.unref?.();
  }

  const ensureHeartbeat = (): void => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      const ts = new Date().toISOString();
      pruneExpiredSubscriptions(Date.now());
      for (const connection of connections.values()) {
        sendMessage(connection, { type: 'pong', ts });
        flushConnectionQueue(connection);
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  };

  const subscribeConnection = (
    connection: RealtimeConnection,
    requestId: string | undefined,
    query: Record<string, unknown> | undefined
  ): void => {
    if (subscriptions.size >= MAX_SUBSCRIPTIONS && connection.subscriptions.size === 0) {
      sendError(connection, '实时日志订阅数已达上限，请稍后重试', requestId);
      return;
    }

    let compiled: CompiledRealtimeQuery;
    try {
      compiled = compileRealtimeQuery(query);
    } catch (err) {
      sendError(connection, err instanceof Error ? err.message : String(err), requestId);
      return;
    }

    for (const subscriptionId of Array.from(connection.subscriptions)) {
      removeSubscription(subscriptionId, 'replaced');
    }

    const subscriptionId = createId('sub');
    const subscription: RealtimeSubscription = {
      id: subscriptionId,
      connectionId: connection.id,
      query: compiled,
    };
    subscriptions.set(subscriptionId, subscription);
    connection.subscriptions.add(subscriptionId);
    ensureTailSubscription();

    sendMessage(connection, {
      type: 'subscribed',
      requestId: requestId ?? null,
      subscriptionId,
      queryHash: compiled.queryHash,
      now: new Date().toISOString(),
    });
  };

  const openConnection = (ws: LogRealtimeWebSocket): void => {
    const data = ws.data;
    const connection: RealtimeConnection = {
      id: data.connectionId,
      remoteAddress: data.remoteAddress,
      ws,
      subscriptions: new Set(),
      queue: [],
      pendingBytes: 0,
      droppedOutbound: 0,
    };
    connections.set(connection.id, connection);
    ensureHeartbeat();
    sendMessage(connection, {
      type: 'ready',
      connectionId: connection.id,
      now: new Date().toISOString(),
    });
  };

  const handleMessage = (
    ws: LogRealtimeWebSocket,
    raw: string | ArrayBuffer | Uint8Array
  ): void => {
    const connection = connections.get(ws.data.connectionId);
    if (!connection) return;

    let message: ClientMessage;
    try {
      message = parseClientMessage(raw);
    } catch (err) {
      sendError(connection, err instanceof Error ? err.message : String(err));
      return;
    }

    if (message.type === 'ping') {
      sendMessage(connection, { type: 'pong', ts: message.ts ?? new Date().toISOString() });
      return;
    }

    if (message.type === 'unsubscribe') {
      if (message.subscriptionId) {
        removeSubscription(message.subscriptionId, 'client-unsubscribe');
      } else {
        for (const subscriptionId of Array.from(connection.subscriptions)) {
          removeSubscription(subscriptionId, 'client-unsubscribe');
        }
      }
      return;
    }

    subscribeConnection(connection, message.requestId, message.query);
  };

  return {
    pathname: WS_PATHNAME,
    upgrade: (request, server, remoteAddress) => {
      const url = new URL(request.url);
      if (url.pathname !== WS_PATHNAME) return { handled: false };

      const upgradeHeader = request.headers.get('upgrade')?.toLowerCase();
      if (upgradeHeader !== 'websocket') {
        return {
          handled: true,
          response: jsonResponse(400, { error: '需要 WebSocket Upgrade' }),
        };
      }

      const decision = decideNetworkAccess(options.store.get().server, remoteAddress);
      if (!decision.allowed) {
        return {
          handled: true,
          response: jsonResponse(403, {
            error:
              decision.reason === 'lan-disabled'
                ? '局域网服务未开启，已拒绝非本机请求'
                : '仅允许本机或局域网来源访问',
            remoteAddress: decision.remoteAddress,
          }),
        };
      }

      if (connections.size >= MAX_CONNECTIONS) {
        return {
          handled: true,
          response: jsonResponse(503, { error: '实时日志连接数已达上限，请稍后重试' }),
        };
      }

      const upgraded = server.upgrade(request, {
        data: {
          kind: 'log-realtime',
          connectionId: createId('conn'),
          remoteAddress: decision.remoteAddress,
        },
      });

      return upgraded
        ? { handled: true, upgraded: true }
        : { handled: true, response: jsonResponse(400, { error: 'WebSocket Upgrade 失败' }) };
    },
    websocket: {
      open: openConnection,
      message: handleMessage,
      drain: (ws) => {
        const connection = connections.get(ws.data.connectionId);
        if (connection) flushConnectionQueue(connection);
      },
      close: (ws) => {
        removeConnection(ws.data.connectionId, 'closed');
      },
    },
    dispose: () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      tailUnsubscribe?.();
      tailUnsubscribe = null;
      for (const connectionId of Array.from(connections.keys())) {
        removeConnection(connectionId, 'server-dispose');
      }
      eventQueue.length = 0;
      eventQueueBytes = 0;
      totalPendingBytes = 0;
      droppedUpstreamEvents = 0;
    },
  };
}
