import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogConfig } from '../../src/config';
import { getLogEventDetailById, queryLogEvents } from '../../src/log-query';
import { getLogger, initLogger, type LogEvent, resetLogger } from '../../src/logger';

function createLogEvent(index: number, overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    request_id: `req-${index}`,
    ts_start: `2026-03-16T10:00:0${index}.000Z`,
    ts_end: `2026-03-16T10:00:0${index}.100Z`,
    latency_ms: index * 100,
    method: 'POST',
    path: '/v1/chat/completions',
    route_type: 'openai-completions',
    route_rule_key: '*',
    provider: index % 2 === 0 ? 'anthropic' : 'openai',
    model_in: 'gpt-4.1',
    model_out: index % 2 === 0 ? 'claude-sonnet' : 'gpt-4.1',
    target_url: 'https://example.com/v1/chat/completions',
    proxy_url: null,
    is_stream: false,
    upstream_status: index === 4 ? 500 : 200,
    content_type_req: 'application/json',
    content_type_res: 'application/json',
    user_agent: 'test-agent/1.0',
    request_headers: {},
    response_headers: {},
    request_bytes: 123,
    response_bytes: 456,
    stream_bytes: null,
    provider_request_id: null,
    error_type: null,
    error_message: null,
    request_body: {
      metadata: {
        user_id:
          index % 2 === 0
            ? 'user-a_account__session_session-0'
            : 'user-b_account__session_session-1',
      },
    },
    response_body: '{}',
    ...overrides,
  };
}

function writeEventsFile(dir: string, indexes = [1, 2, 3, 4, 5]): string {
  const filePath = join(dir, 'events', '2026-03-16.jsonl');
  writeFileSync(
    filePath,
    `${indexes.map((index) => JSON.stringify(createLogEvent(index))).join('\n')}\n`
  );
  return filePath;
}

describe('log-query 详情查询', () => {
  let tempDir: string;
  let logConfig: LogConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'log-query-test-'));
    mkdirSync(join(tempDir, 'events'), { recursive: true });
    logConfig = {
      enabled: true,
      baseDir: tempDir,
      bodyPolicy: 'full',
    };
  });

  afterEach(() => {
    resetLogger();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('应返回完整的 headers、body 和 URL', async () => {
    const event: LogEvent = {
      request_id: 'req-1',
      ts_start: '2026-03-16T10:00:00.000Z',
      ts_end: '2026-03-16T10:00:01.000Z',
      latency_ms: 1000,
      method: 'POST',
      path: '/v1/chat/completions',
      route_type: 'openai-completions',
      route_rule_key: '*',
      provider: 'openai',
      model_in: 'gpt-4.1',
      model_out: 'gpt-4.1',
      target_url: 'https://user:pass@example.com/v1/chat/completions',
      proxy_url: 'http://user:pass@127.0.0.1:7890',
      is_stream: false,
      upstream_status: 200,
      content_type_req: 'application/json',
      content_type_res: 'application/json',
      user_agent: 'test-agent/1.0',
      request_headers: {
        authorization: 'Bearer sk-full-secret',
        cookie: 'session=abc123',
      },
      response_headers: {
        'content-type': 'application/json',
      },
      request_bytes: 123,
      response_bytes: 456,
      stream_bytes: null,
      provider_request_id: 'upstream-1',
      error_type: null,
      error_message: null,
      request_body: {
        apiKey: 'sk-full-secret',
        nested: { token: 'tok-123' },
      },
      response_body: '{"access_token":"resp-token"}',
    };

    const filePath = join(tempDir, 'events', '2026-03-16.jsonl');
    writeFileSync(filePath, `${JSON.stringify(event)}\n`);
    const id = Buffer.from(JSON.stringify({ d: '2026-03-16', l: 1 }), 'utf-8').toString(
      'base64url'
    );

    const detail = await getLogEventDetailById({ logConfig }, id);

    expect(detail).not.toBeNull();
    expect(detail?.request.requestHeaders.authorization).toBe('Bearer sk-full-secret');
    expect(detail?.request.requestHeaders.cookie).toBe('session=abc123');
    expect(detail?.request.requestBody).toEqual({
      apiKey: 'sk-full-secret',
      nested: { token: 'tok-123' },
    });
    expect(detail?.response.responseBody).toBe('{"access_token":"resp-token"}');
    expect(detail?.upstream.targetUrl).toBe('https://user:pass@example.com/v1/chat/completions');
    expect(detail?.upstream.proxyUrl).toBe('http://user:pass@127.0.0.1:7890');
    expect(detail?.rawEvent).toEqual(JSON.parse(readFileSync(filePath, 'utf-8').trim()));
  });

  test('应通过 SQLite 索引执行列表查询和 keyset 翻页', async () => {
    initLogger(tempDir, logConfig);

    writeEventsFile(tempDir);

    const firstPage = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        sort: 'time_desc',
        limit: 2,
      }
    );

    expect(firstPage.meta.indexUsed).toBe(true);
    expect(firstPage.meta.scannedLines).toBe(5);
    expect(firstPage.items.map((item) => item.requestId)).toEqual(['req-5', 'req-4']);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.stats.total).toBe(5);
    expect(firstPage.stats.errorCount).toBe(1);
    expect(firstPage.stats.avgLatencyMs).toBe(300);
    expect(firstPage.stats.p95LatencyMs).toBe(500);

    const secondPage = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        sort: 'time_desc',
        limit: 2,
        cursor: firstPage.nextCursor,
      }
    );

    expect(secondPage.meta.indexUsed).toBe(true);
    expect(secondPage.meta.scannedLines).toBe(0);
    expect(secondPage.items.map((item) => item.requestId)).toEqual(['req-3', 'req-2']);

    const filtered = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        providers: ['anthropic'],
        statusClasses: ['5xx'],
        q: 'claude-sonnet',
        sort: 'time_desc',
        limit: 10,
      }
    );

    expect(filtered.items.map((item) => item.requestId)).toEqual(['req-4']);

    const userSessionFiltered = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        users: ['user-a'],
        sessions: ['session-0'],
        sort: 'time_asc',
        limit: 10,
      }
    );

    expect(userSessionFiltered.items.map((item) => item.requestId)).toEqual(['req-2', 'req-4']);

    const detail = await getLogEventDetailById({ logConfig }, firstPage.items[0].id);
    expect(detail?.summary.requestId).toBe('req-5');
    expect(detail?.location.line).toBe(5);
  });

  test('SQLite 索引应回填 token usage 并聚合缓存命中率', async () => {
    initLogger(tempDir, logConfig);

    const filePath = join(tempDir, 'events', '2026-03-16.jsonl');
    writeFileSync(
      filePath,
      `${[
        createLogEvent(1, {
          provider: 'openai',
          response_body: JSON.stringify({
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_tokens_details: { cached_tokens: 50 },
            },
          }),
        }),
        createLogEvent(2, {
          provider: 'anthropic',
          response_body: JSON.stringify({
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 5,
            },
          }),
        }),
      ]
        .map((event) => JSON.stringify(event))
        .join('\n')}\n`
    );

    const data = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        sort: 'time_desc',
        limit: 10,
      }
    );

    expect(data.meta.indexUsed).toBe(true);
    expect(data.items[0]?.tokenUsage?.providerStyle).toBe('anthropic');
    expect(data.items[1]?.tokenUsage?.cacheHitInputTokens).toBe(50);
    expect(data.stats.tokenUsageCount).toBe(2);
    expect(data.stats.inputTokens).toBe(110);
    expect(data.stats.outputTokens).toBe(24);
    expect(data.stats.totalTokens).toBe(144);
    expect(data.stats.cacheHitInputTokens).toBe(55);
    expect(data.stats.cacheHitRateDenominatorTokens).toBe(120);
    expect(data.stats.cacheHitRate).toBe(45.83);

    const detail = await getLogEventDetailById({ logConfig }, data.items[0]!.id);
    expect(detail?.usage.tokenUsage?.cacheReadInputTokens).toBe(5);
    expect(detail?.usage.responseBytes).toBe(456);
  });

  test('SQLite 索引未初始化时应回退 JSONL 扫描并支持旧 offset cursor', async () => {
    writeEventsFile(tempDir);

    const firstPage = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        sort: 'time_desc',
        limit: 2,
      }
    );

    expect(firstPage.meta.indexUsed).toBe(false);
    expect(firstPage.meta.scannedLines).toBe(5);
    expect(firstPage.items.map((item) => item.requestId)).toEqual(['req-5', 'req-4']);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        sort: 'time_desc',
        limit: 2,
        cursor: firstPage.nextCursor,
      }
    );

    expect(secondPage.meta.indexUsed).toBe(false);
    expect(secondPage.items.map((item) => item.requestId)).toEqual(['req-3', 'req-2']);
  });

  test('SQLite 索引应在 JSONL 文件追加后自动重建并包含新增事件', async () => {
    initLogger(tempDir, logConfig);
    const filePath = writeEventsFile(tempDir, [1, 2]);

    const initial = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        sort: 'time_desc',
        limit: 10,
      }
    );

    expect(initial.meta.indexUsed).toBe(true);
    expect(initial.meta.scannedLines).toBe(2);
    expect(initial.items.map((item) => item.requestId)).toEqual(['req-2', 'req-1']);

    appendFileSync(filePath, `${JSON.stringify(createLogEvent(3))}\n`);

    const refreshed = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        sort: 'time_desc',
        limit: 10,
      }
    );

    expect(refreshed.meta.indexUsed).toBe(true);
    expect(refreshed.meta.scannedLines).toBe(3);
    expect(refreshed.stats.total).toBe(3);
    expect(refreshed.items.map((item) => item.requestId)).toEqual(['req-3', 'req-2', 'req-1']);
  });

  test('SQLite 增量索引不应把尚未消费的写入队列误标为已索引', async () => {
    initLogger(tempDir, logConfig);
    const logger = getLogger();
    expect(logger).not.toBeNull();

    const baseMs = Date.parse('2026-03-16T10:00:00.000Z');
    for (let index = 1; index <= 300; index += 1) {
      const ts = new Date(baseMs + index * 1000).toISOString();
      logger?.writeEvent(
        createLogEvent(index, {
          request_id: `burst-${index}`,
          ts_start: ts,
          ts_end: new Date(baseMs + index * 1000 + 100).toISOString(),
        })
      );
    }

    await Bun.sleep(75);

    const data = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:10:00.000Z'),
        sort: 'time_desc',
        limit: 5,
      }
    );

    expect(data.meta.indexUsed).toBe(true);
    expect(data.stats.total).toBe(300);
    expect(data.items.map((item) => item.requestId)).toEqual([
      'burst-300',
      'burst-299',
      'burst-298',
      'burst-297',
      'burst-296',
    ]);
  });

  test('SQLite backfill 应跳过坏 JSON 并继续返回有效日志', async () => {
    initLogger(tempDir, logConfig);
    const filePath = join(tempDir, 'events', '2026-03-16.jsonl');
    writeFileSync(
      filePath,
      `${JSON.stringify(createLogEvent(1))}\n{not-json}\n${JSON.stringify(createLogEvent(2))}\n`
    );

    const data = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        sort: 'time_asc',
        limit: 10,
      }
    );

    expect(data.meta.indexUsed).toBe(true);
    expect(data.meta.scannedLines).toBe(3);
    expect(data.meta.parseErrors).toBe(1);
    expect(data.stats.total).toBe(2);
    expect(data.items.map((item) => item.requestId)).toEqual(['req-1', 'req-2']);
  });

  test('SQLite LIKE 回退搜索应按字面量匹配百分号和下划线', async () => {
    initLogger(tempDir, logConfig);
    const filePath = join(tempDir, 'events', '2026-03-16.jsonl');
    writeFileSync(
      filePath,
      [
        JSON.stringify(createLogEvent(1, { path: '/v1/literal/%_marker', request_body: {} })),
        JSON.stringify(createLogEvent(2, { path: '/v1/no-wildcard-marker', request_body: {} })),
      ].join('\n')
    );

    const percent = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        q: '%',
        sort: 'time_asc',
        limit: 10,
      }
    );

    const underscore = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        q: '_',
        sort: 'time_asc',
        limit: 10,
      }
    );

    expect(percent.items.map((item) => item.requestId)).toEqual(['req-1']);
    expect(underscore.items.map((item) => item.requestId)).toEqual(['req-1']);
  });

  test('offset id 即使没有索引单例也应能直接读取详情', async () => {
    initLogger(tempDir, logConfig);
    writeEventsFile(tempDir);

    const data = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        sort: 'time_desc',
        limit: 1,
      }
    );

    const id = data.items[0]?.id;
    expect(id).toBeTruthy();
    resetLogger();

    const detail = await getLogEventDetailById({ logConfig }, id);

    expect(detail?.summary.requestId).toBe('req-5');
    expect(detail?.location.line).toBe(0);
  });

  test('索引 cursor 失配时应明确拒绝而不是静默回退 JSONL', async () => {
    initLogger(tempDir, logConfig);
    writeEventsFile(tempDir);

    const firstPage = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        sort: 'time_desc',
        limit: 2,
      }
    );

    expect(firstPage.nextCursor).not.toBeNull();

    await expect(
      queryLogEvents(
        { logConfig },
        {
          fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
          toMs: Date.parse('2026-03-16T10:01:00.000Z'),
          sort: 'time_asc',
          limit: 2,
          cursor: firstPage.nextCursor,
        }
      )
    ).rejects.toThrow('cursor 与当前查询条件不匹配');
  });

  test('索引 cursor 在索引不可用时应要求重新查询第一页', async () => {
    initLogger(tempDir, logConfig);
    writeEventsFile(tempDir);

    const firstPage = await queryLogEvents(
      { logConfig },
      {
        fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
        toMs: Date.parse('2026-03-16T10:01:00.000Z'),
        sort: 'time_desc',
        limit: 2,
      }
    );

    resetLogger();

    await expect(
      queryLogEvents(
        { logConfig },
        {
          fromMs: Date.parse('2026-03-16T09:59:00.000Z'),
          toMs: Date.parse('2026-03-16T10:01:00.000Z'),
          sort: 'time_desc',
          limit: 2,
          cursor: firstPage.nextCursor,
        }
      )
    ).rejects.toThrow('无法使用索引 cursor 回退到 JSONL');
  });
});
