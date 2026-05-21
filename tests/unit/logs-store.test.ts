import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LogEventSummary, LogEventsResponse } from '../../web/src/lib/api';
import { useLogsStore } from '../../web/src/stores/logs-store';

type MutableGlobal = typeof globalThis & {
  EventSource?: typeof EventSource;
};

const globalRef = globalThis as MutableGlobal;
const originalFetch = globalThis.fetch;
const originalEventSource = globalRef.EventSource;

function createSummary(
  id: string,
  ts: string,
  overrides: Partial<LogEventSummary> = {}
): LogEventSummary {
  return {
    id,
    ts,
    level: 'info',
    provider: 'openai',
    routeType: 'openai-completions',
    model: 'gpt-4.1',
    modelIn: 'gpt-4.1',
    modelOut: 'gpt-4.1',
    path: '/v1/chat/completions',
    requestId: `req-${id}`,
    latencyMs: 100,
    upstreamStatus: 200,
    statusClass: '2xx',
    hasError: false,
    message: 'ok',
    errorType: null,
    hasMetadata: true,
    userIdRaw: 'user-a_account__session_session-1',
    userKey: 'user-a',
    sessionId: 'session-1',
    ...overrides,
  };
}

function createEventsResponse(overrides: Partial<LogEventsResponse> = {}): LogEventsResponse {
  return {
    items: [createSummary('log-1', '2026-03-16T10:00:00.000Z')],
    nextCursor: 'cursor-1',
    hasMore: true,
    stats: {
      total: 1,
      errorCount: 0,
      errorRate: 0,
      avgLatencyMs: 100,
      p95LatencyMs: 100,
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
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

function resetStore(): void {
  useLogsStore.getState().stopAutoRefresh();
  useLogsStore.getState().stopTail();
  useLogsStore.setState(useLogsStore.getInitialState(), true);
}

describe('logs store', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    resetStore();
  });

  afterEach(() => {
    resetStore();
    globalThis.fetch = originalFetch;
    globalRef.EventSource = originalEventSource;
  });

  test('fetchFirstPage 应用当前过滤条件并保存首屏查询结果', async () => {
    const calls: Array<{ url: string; signal?: AbortSignal }> = [];

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), signal: init?.signal ?? undefined });
      return Promise.resolve(
        jsonResponse(
          createEventsResponse({
            items: [
              createSummary('log-2', '2026-03-16T10:00:02.000Z', {
                level: 'error',
                hasError: true,
              }),
            ],
            stats: {
              total: 12,
              errorCount: 3,
              errorRate: 0.25,
              avgLatencyMs: 240,
              p95LatencyMs: 800,
            },
          })
        )
      );
    }) as typeof fetch;

    const store = useLogsStore.getState();
    store.setFilter('levels', ['error']);
    store.setFilter('provider', 'openai');
    store.setFilter('hasError', 'true');
    store.setFilter('q', 'timeout');

    await useLogsStore.getState().fetchFirstPage();

    const url = new URL(calls[0]?.url ?? '', 'http://localhost');
    const state = useLogsStore.getState();
    expect(url.pathname).toBe('/api/logs/events');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('levels')).toBe('error');
    expect(url.searchParams.get('provider')).toBe('openai');
    expect(url.searchParams.get('hasError')).toBe('true');
    expect(url.searchParams.get('q')).toBe('timeout');
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(state.loading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.items.map((item) => item.id)).toEqual(['log-2']);
    expect(state.nextCursor).toBe('cursor-1');
    expect(state.hasMore).toBe(true);
    expect(state.stats?.total).toBe(12);
    expect(state.meta?.indexUsed).toBe(true);
  });

  test('fetchFirstPage 连续触发时应中断旧请求且忽略晚返回的旧响应', async () => {
    const requests: Array<{
      signal?: AbortSignal;
      resolve: (response: Response) => void;
    }> = [];

    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        requests.push({ signal: init?.signal ?? undefined, resolve });
      })) as typeof fetch;

    const firstFetch = useLogsStore.getState().fetchFirstPage();
    const secondFetch = useLogsStore.getState().fetchFirstPage();

    requests[1]?.resolve(
      jsonResponse(
        createEventsResponse({
          items: [createSummary('new-log', '2026-03-16T10:00:02.000Z')],
        })
      )
    );
    await secondFetch;

    requests[0]?.resolve(
      jsonResponse(
        createEventsResponse({
          items: [createSummary('old-log', '2026-03-16T10:00:01.000Z')],
        })
      )
    );
    await firstFetch;

    const state = useLogsStore.getState();
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(state.items.map((item) => item.id)).toEqual(['new-log']);
    expect(state.loading).toBe(false);
    expect(state.refreshing).toBe(false);
  });

  test('fetchNextPage 应使用 cursor 翻页、按时间合并去重并更新分页状态', async () => {
    let capturedUrl = '';

    useLogsStore.setState({
      items: [
        createSummary('log-1', '2026-03-16T10:00:01.000Z', { message: 'old copy' }),
        createSummary('log-2', '2026-03-16T10:00:02.000Z'),
      ],
      nextCursor: 'cursor-1',
      hasMore: true,
      sort: 'time_desc',
    });

    globalThis.fetch = ((input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return Promise.resolve(
        jsonResponse(
          createEventsResponse({
            items: [
              createSummary('log-3', '2026-03-16T10:00:03.000Z'),
              createSummary('log-1', '2026-03-16T10:00:01.000Z', { message: 'new copy' }),
            ],
            nextCursor: null,
            hasMore: false,
          })
        )
      );
    }) as typeof fetch;

    await useLogsStore.getState().fetchNextPage();

    const url = new URL(capturedUrl, 'http://localhost');
    const state = useLogsStore.getState();
    expect(url.searchParams.get('cursor')).toBe('cursor-1');
    expect(state.items.map((item) => item.id)).toEqual(['log-3', 'log-2', 'log-1']);
    expect(state.items.find((item) => item.id === 'log-1')?.message).toBe('new copy');
    expect(state.nextCursor).toBeNull();
    expect(state.hasMore).toBe(false);
    expect(state.loadingMore).toBe(false);
  });

  test('fetchNextPage 在没有 cursor 或正在加载时不发起请求', async () => {
    let callCount = 0;
    globalThis.fetch = (() => {
      callCount += 1;
      return Promise.resolve(jsonResponse(createEventsResponse()));
    }) as typeof fetch;

    await useLogsStore.getState().fetchNextPage();

    useLogsStore.setState({ nextCursor: 'cursor-1', loadingMore: true });
    await useLogsStore.getState().fetchNextPage();

    expect(callCount).toBe(0);
  });

  test('tail 事件应合并到当前列表并暴露连接状态', () => {
    globalRef.EventSource = FakeEventSource as unknown as typeof EventSource;

    useLogsStore.setState({
      items: [createSummary('log-1', '2026-03-16T10:00:01.000Z')],
      sort: 'time_desc',
    });

    useLogsStore.getState().startTail();
    const source = FakeEventSource.instances[0];

    source?.emit('ready');
    source?.emit(
      'events',
      JSON.stringify(
        createEventsResponse({
          items: [
            createSummary('log-2', '2026-03-16T10:00:02.000Z'),
            createSummary('log-1', '2026-03-16T10:00:01.000Z', { message: 'tail refresh' }),
          ],
          stats: {
            total: 2,
            errorCount: 0,
            errorRate: 0,
            avgLatencyMs: 100,
            p95LatencyMs: 100,
          },
        })
      )
    );

    const state = useLogsStore.getState();
    expect(source?.url).toBe('/api/logs/tail?window=24h&sort=time_desc');
    expect(state.tailConnected).toBe(true);
    expect(state.items.map((item) => item.id)).toEqual(['log-2', 'log-1']);
    expect(state.items.find((item) => item.id === 'log-1')?.message).toBe('tail refresh');
    expect(state.stats?.total).toBe(2);

    useLogsStore.getState().stopTail();
    expect(source?.closed).toBe(true);
    expect(useLogsStore.getState().tailConnected).toBe(false);
  });
});
