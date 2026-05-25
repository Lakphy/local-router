import type { FetchLogEventsParams, LogEventSummary } from './api';

export type LogRealtimeStatus = 'idle' | 'connecting' | 'active' | 'error';

export interface LogRealtimeSubscribedMessage {
  type: 'subscribed';
  requestId: string | null;
  subscriptionId: string;
  queryHash: string;
  now: string;
}

export interface LogRealtimeOverflowMessage {
  type: 'overflow';
  subscriptionId: string;
  dropped: number;
  message: string;
}

interface LogRealtimeClientCallbacks {
  onStatus?: (status: LogRealtimeStatus) => void;
  onSubscribed?: (message: LogRealtimeSubscribedMessage) => void;
  onEvents?: (items: LogEventSummary[]) => void;
  onOverflow?: (message: LogRealtimeOverflowMessage) => void;
  onError?: (message: string) => void;
  onClose?: (reason: string) => void;
}

type ServerMessage =
  | { type: 'ready'; connectionId: string; now: string }
  | LogRealtimeSubscribedMessage
  | { type: 'unsubscribed'; subscriptionId: string; reason?: string }
  | { type: 'log.event'; subscriptionId: string; item: LogEventSummary }
  | LogRealtimeOverflowMessage
  | { type: 'pong'; ts: string }
  | { type: 'error'; requestId?: string; error: string };

function buildWebSocketUrl(): string {
  if (typeof window === 'undefined') {
    throw new Error('当前运行环境不支持 WebSocket');
  }

  const url = new URL('/api/logs/events/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function createSubscribeQuery(params: FetchLogEventsParams): Record<string, unknown> {
  return {
    window: params.window,
    from: params.from,
    to: params.to,
    levels: params.levels,
    provider: params.provider,
    routeType: params.routeType,
    model: params.model,
    modelIn: params.modelIn,
    modelOut: params.modelOut,
    user: params.user,
    session: params.session,
    statusClass: params.statusClass,
    hasError: params.hasError,
    q: params.q,
    sort: params.sort,
  };
}

async function readMessageData(data: MessageEvent['data']): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

export class LogRealtimeClient {
  private socket: WebSocket | null = null;
  private subscriptionId: string | null = null;
  private closed = false;
  private bufferedItems: LogEventSummary[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly query: FetchLogEventsParams;
  private readonly callbacks: LogRealtimeClientCallbacks;

  constructor(query: FetchLogEventsParams, callbacks: LogRealtimeClientCallbacks) {
    this.query = query;
    this.callbacks = callbacks;
  }

  connect(): void {
    if (this.socket) return;
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前浏览器不支持 WebSocket');
    }

    this.closed = false;
    this.callbacks.onStatus?.('connecting');
    const socket = new WebSocket(buildWebSocketUrl());
    this.socket = socket;

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          requestId: crypto.randomUUID(),
          query: createSubscribeQuery(this.query),
        })
      );
    });

    socket.addEventListener('message', (event) => {
      void this.handleMessage(event.data);
    });

    socket.addEventListener('error', () => {
      this.callbacks.onStatus?.('error');
      this.callbacks.onError?.('实时日志连接失败');
    });

    socket.addEventListener('close', () => {
      this.flushBufferedItems();
      this.socket = null;
      this.subscriptionId = null;
      const reason = this.closed ? 'closed' : 'connection-closed';
      this.callbacks.onClose?.(reason);
    });
  }

  close(reason = 'client-close'): void {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushBufferedItems();

    const socket = this.socket;
    if (!socket) return;

    if (socket.readyState === WebSocket.OPEN && this.subscriptionId) {
      socket.send(JSON.stringify({ type: 'unsubscribe', subscriptionId: this.subscriptionId }));
    }
    socket.close(1000, reason);
    this.socket = null;
    this.subscriptionId = null;
  }

  private async handleMessage(data: MessageEvent['data']): Promise<void> {
    let message: ServerMessage;
    try {
      message = JSON.parse(await readMessageData(data)) as ServerMessage;
    } catch {
      this.callbacks.onError?.('实时日志消息解析失败');
      return;
    }

    if (message.type === 'subscribed') {
      this.subscriptionId = message.subscriptionId;
      this.callbacks.onStatus?.('active');
      this.callbacks.onSubscribed?.(message);
      return;
    }

    if (message.type === 'log.event') {
      this.bufferedItems.push(message.item);
      this.scheduleFlush();
      return;
    }

    if (message.type === 'overflow') {
      this.callbacks.onOverflow?.(message);
      return;
    }

    if (message.type === 'error') {
      this.callbacks.onStatus?.('error');
      this.callbacks.onError?.(message.error);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushBufferedItems();
    }, 50);
  }

  private flushBufferedItems(): void {
    if (this.bufferedItems.length === 0) return;
    const items = this.bufferedItems.splice(0, this.bufferedItems.length);
    this.callbacks.onEvents?.(items);
  }
}
