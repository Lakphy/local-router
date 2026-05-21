import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  exportLogEvents,
  fetchLogEvents,
  type LogEventsResponse,
  openLogTail,
} from '../../web/src/lib/api';

type MutableGlobal = typeof globalThis & {
  EventSource?: typeof EventSource;
};

const globalRef = globalThis as MutableGlobal;
const originalFetch = globalThis.fetch;
const originalEventSource = globalRef.EventSource;

function createSummary(id = 'log-1') {
  return {
    id,
    ts: '2026-03-16T10:00:00.000Z',
    level: 'info' as const,
    provider: 'openai',
    routeType: 'openai-completions',
    model: 'gpt-4.1',
    modelIn: 'gpt-4.1',
    modelOut: 'gpt-4.1',
    path: '/v1/chat/completions',
    requestId: `req-${id}`,
    latencyMs: 120,
    upstreamStatus: 200,
    statusClass: '2xx' as const,
    hasError: false,
    message: 'ok',
    errorType: null,
    hasMetadata: true,
    userIdRaw: 'user-a_account__session_session-1',
    userKey: 'user-a',
    sessionId: 'session-1',
  };
}

function createEventsResponse(overrides: Partial<LogEventsResponse> = {}): LogEventsResponse {
  return {
    items: [createSummary()],
    nextCursor: 'cursor-1',
    hasMore: true,
    stats: {
      total: 1,
      errorCount: 0,
      errorRate: 0,
      avgLatencyMs: 120,
      p95LatencyMs: 120,
    },
    meta: {
      scannedFiles: 0,
      scannedLines: 1,
      parseErrors: 0,
      truncated: false,
      indexUsed: true,
      rowsReturned: 1,
      statsMode: 'exact',
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent);
    }
  }

  close(): void {
    this.closed = true;
  }
}

describe('logs web api client', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalRef.EventSource = originalEventSource;
  });

  test('fetchLogEvents 应完整编码过滤、排序、分页参数并透传 abort signal', async () => {
    const controller = new AbortController();
    let capturedUrl = '';
    let capturedSignal: AbortSignal | undefined;

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedSignal = init?.signal ?? undefined;
      return Promise.resolve(jsonResponse(createEventsResponse()));
    }) as typeof fetch;

    const data = await fetchLogEvents(
      {
        window: '6h',
        from: '2026-03-16T09:00:00.000Z',
        to: '2026-03-16T11:00:00.000Z',
        levels: ['info', 'error'],
        provider: 'openai',
        routeType: 'openai-completions',
        modelIn: 'gpt-4.1',
        modelOut: 'gpt-4.1-mini',
        user: 'user-a',
        session: 'session-1',
        statusClass: ['2xx', '5xx'],
        hasError: true,
        q: 'req-1 timeout',
        sort: 'time_asc',
        limit: 25,
        cursor: 'cursor-0',
      },
      { signal: controller.signal }
    );

    const url = new URL(capturedUrl, 'http://localhost');
    expect(url.pathname).toBe('/api/logs/events');
    expect(url.searchParams.get('window')).toBe('6h');
    expect(url.searchParams.get('levels')).toBe('info,error');
    expect(url.searchParams.get('statusClass')).toBe('2xx,5xx');
    expect(url.searchParams.get('hasError')).toBe('true');
    expect(url.searchParams.get('q')).toBe('req-1 timeout');
    expect(url.searchParams.get('sort')).toBe('time_asc');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('cursor')).toBe('cursor-0');
    expect(capturedSignal).toBe(controller.signal);
    expect(data.items[0]?.requestId).toBe('req-log-1');
  });

  test('fetchLogEvents 应优先展示服务端错误信息', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(jsonResponse({ error: 'cursor 已失效，请刷新列表' }, 400))) as typeof fetch;

    await expect(fetchLogEvents({ cursor: 'bad-cursor' })).rejects.toThrow(
      'cursor 已失效，请刷新列表'
    );
  });

  test('exportLogEvents 应组合导出格式与当前过滤条件', async () => {
    let capturedUrl = '';
    const blob = new Blob(['id,ts\nlog-1,2026-03-16T10:00:00.000Z\n'], { type: 'text/csv' });

    globalThis.fetch = ((input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return Promise.resolve(new Response(blob, { status: 200 }));
    }) as typeof fetch;

    const result = await exportLogEvents(
      {
        window: '24h',
        levels: ['error'],
        provider: 'anthropic',
        q: 'rate limit',
        sort: 'time_desc',
      },
      'csv'
    );

    const url = new URL(capturedUrl, 'http://localhost');
    expect(url.pathname).toBe('/api/logs/export');
    expect(url.searchParams.get('format')).toBe('csv');
    expect(url.searchParams.get('levels')).toBe('error');
    expect(url.searchParams.get('provider')).toBe('anthropic');
    expect(url.searchParams.get('q')).toBe('rate limit');
    expect(await result.text()).toContain('log-1');
  });

  test('openLogTail 应处理 ready、events、解析失败、服务端错误和关闭', () => {
    globalRef.EventSource = FakeEventSource as unknown as typeof EventSource;
    const received: LogEventsResponse[] = [];
    const errors: string[] = [];
    let readyCount = 0;

    const cleanup = openLogTail(
      { levels: ['error'], q: 'timeout', sort: 'time_desc' },
      {
        onReady: () => {
          readyCount += 1;
        },
        onEvents: (payload) => {
          received.push(payload);
        },
        onError: (message) => {
          errors.push(message);
        },
      }
    );

    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe('/api/logs/tail?levels=error&q=timeout&sort=time_desc');

    source?.emit('ready');
    source?.emit('events', JSON.stringify(createEventsResponse()));
    source?.emit('events', '{bad json');
    source?.emit('error', JSON.stringify({ error: 'tail failed' }));
    source?.onerror?.();
    cleanup();

    expect(readyCount).toBe(1);
    expect(received).toHaveLength(1);
    expect(errors).toEqual(['实时日志数据解析失败', 'tail failed', '实时日志连接中断']);
    expect(source?.closed).toBe(true);
  });
});
