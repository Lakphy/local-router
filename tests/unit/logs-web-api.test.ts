import { afterEach, describe, expect, test } from 'bun:test';
import { exportLogEvents, fetchLogEvents, type LogEventsResponse } from '../../web/src/lib/api';

const originalFetch = globalThis.fetch;

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
    tokenUsage: null,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('logs web api client', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
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
});
