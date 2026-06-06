import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LogEventSummary, LogEventsResponse } from '../../web/src/lib/api';
import { useLogsStore } from '../../web/src/stores/logs-store';

const originalFetch = globalThis.fetch;

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
    tokenUsage: null,
    ...overrides,
  };
}

function createEventsResponse(overrides: Partial<LogEventsResponse> = {}): LogEventsResponse {
  return {
    items: [createSummary('log-1', '2026-03-16T10:00:00.000Z')],
    nextCursor: null,
    hasMore: false,
    stats: {
      total: 1,
      errorCount: 0,
      errorRate: 0,
      avgLatencyMs: 100,
      p95LatencyMs: 100,
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

function resetStore(): void {
  useLogsStore.getState().stopRealtime?.('test-reset');
  useLogsStore.setState(useLogsStore.getInitialState(), true);
}

describe('logs store', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    resetStore();
    globalThis.fetch = originalFetch;
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
    expect(state.items.map((item) => item.id)).toEqual(['log-2']);
    expect(state.currentPage).toBe(1);
    expect(state.stats?.total).toBe(12);
    expect(state.meta?.indexUsed).toBe(true);
    expect(state.appliedQuery?.levels).toEqual(['error']);
    expect(state.appliedQuery?.provider).toBe('openai');
    expect(state.appliedQuery?.hasError).toBe(true);
    expect(state.realtime.enabled).toBe(false);
  });

  test('fetchFirstPage 应根据 stats.total 计算 totalPages', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        jsonResponse(
          createEventsResponse({
            items: Array.from({ length: 50 }, (_, i) =>
              createSummary(`log-${i}`, `2026-03-16T10:00:${String(i).padStart(2, '0')}.000Z`)
            ),
            stats: {
              total: 120,
              errorCount: 0,
              errorRate: 0,
              avgLatencyMs: 100,
              p95LatencyMs: 100,
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
            },
          })
        )
      )) as typeof fetch;

    await useLogsStore.getState().fetchFirstPage();

    const state = useLogsStore.getState();
    expect(state.currentPage).toBe(1);
    expect(state.totalPages).toBe(3); // ceil(120 / 50) = 3
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
  });

  test('fetchPage 应使用 offset 翻页并替换 items', async () => {
    let capturedUrl = '';

    useLogsStore.setState({
      items: [
        createSummary('log-1', '2026-03-16T10:00:01.000Z'),
        createSummary('log-2', '2026-03-16T10:00:02.000Z'),
      ],
      currentPage: 1,
      totalPages: 3,
      pageSize: 50,
      sort: 'time_desc',
    });

    globalThis.fetch = ((input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return Promise.resolve(
        jsonResponse(
          createEventsResponse({
            items: [
              createSummary('log-51', '2026-03-16T09:59:01.000Z'),
              createSummary('log-52', '2026-03-16T09:59:02.000Z'),
            ],
            stats: {
              total: 120,
              errorCount: 0,
              errorRate: 0,
              avgLatencyMs: 100,
              p95LatencyMs: 100,
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
            },
          })
        )
      );
    }) as typeof fetch;

    await useLogsStore.getState().fetchPage(2);

    const url = new URL(capturedUrl, 'http://localhost');
    const state = useLogsStore.getState();
    expect(url.searchParams.get('offset')).toBe('50');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(state.items.map((item) => item.id)).toEqual(['log-51', 'log-52']);
    expect(state.currentPage).toBe(2);
    expect(state.totalPages).toBe(3);
    expect(state.loading).toBe(false);
  });

  test('fetchPage 在越界或当前页或正在加载时不发起请求', async () => {
    let callCount = 0;
    globalThis.fetch = (() => {
      callCount += 1;
      return Promise.resolve(jsonResponse(createEventsResponse()));
    }) as typeof fetch;

    // No totalPages set (default 1), page 2 is out of range
    await useLogsStore.getState().fetchPage(2);

    // Same page
    useLogsStore.setState({ currentPage: 1, totalPages: 3 });
    await useLogsStore.getState().fetchPage(1);

    // Page < 1
    await useLogsStore.getState().fetchPage(0);

    // Loading
    useLogsStore.setState({ loading: true });
    await useLogsStore.getState().fetchPage(2);

    expect(callCount).toBe(0);
  });

  test('修改筛选项应清空已查询快照并关闭实时状态', async () => {
    useLogsStore.setState({
      appliedQuery: { window: '24h', provider: 'openai', sort: 'time_desc', limit: 50 },
      realtime: {
        enabled: true,
        status: 'active',
        subscriptionId: 'sub-1',
        error: null,
        received: 2,
        dropped: 0,
      },
    });

    useLogsStore.getState().setFilter('provider', 'anthropic');

    const state = useLogsStore.getState();
    expect(state.filters.provider).toBe('anthropic');
    expect(state.appliedQuery).toBeNull();
    expect(state.realtime.enabled).toBe(false);
    expect(state.realtime.status).toBe('idle');
  });

  test('receiveRealtimeLogEvents 应在第一页时合并去重并更新接收计数', () => {
    useLogsStore.setState({
      sort: 'time_desc',
      currentPage: 1,
      items: [
        createSummary('log-1', '2026-03-16T10:00:01.000Z', { message: 'old copy' }),
        createSummary('log-2', '2026-03-16T10:00:02.000Z'),
      ],
    });

    useLogsStore
      .getState()
      .receiveRealtimeLogEvents([
        createSummary('log-3', '2026-03-16T10:00:03.000Z'),
        createSummary('log-1', '2026-03-16T10:00:01.000Z', { message: 'new copy' }),
      ]);

    const state = useLogsStore.getState();
    expect(state.items.map((item) => item.id)).toEqual(['log-3', 'log-2', 'log-1']);
    expect(state.items.find((item) => item.id === 'log-1')?.message).toBe('new copy');
    expect(state.realtime.received).toBe(2);
  });

  test('receiveRealtimeLogEvents 不在第一页时只更新计数不修改 items', () => {
    useLogsStore.setState({
      sort: 'time_desc',
      currentPage: 2,
      items: [
        createSummary('log-51', '2026-03-16T09:59:01.000Z'),
      ],
    });

    useLogsStore
      .getState()
      .receiveRealtimeLogEvents([
        createSummary('log-new', '2026-03-16T10:00:03.000Z'),
      ]);

    const state = useLogsStore.getState();
    expect(state.items.map((item) => item.id)).toEqual(['log-51']);
    expect(state.realtime.received).toBe(1);
  });

  test('startRealtime 在没有已查询快照时应拒绝开启', async () => {
    await useLogsStore.getState().startRealtime();

    const state = useLogsStore.getState();
    expect(state.realtime.enabled).toBe(false);
    expect(state.realtime.status).toBe('error');
    expect(state.realtime.error).toBe('请先查询后再开启实时推送');
  });
});
