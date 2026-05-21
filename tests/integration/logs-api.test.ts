import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { type AppRuntime, createAppRuntimeFromConfigPath } from '../../src/index';
import { type LogEvent, resetLogger } from '../../src/logger';

function createEvent(index: number): LogEvent {
  return {
    request_id: `api-req-${index}`,
    ts_start: `2026-03-16T10:00:0${index}.000Z`,
    ts_end: `2026-03-16T10:00:0${index}.250Z`,
    latency_ms: index * 50,
    method: 'POST',
    path: '/v1/messages',
    route_type: 'anthropic-messages',
    route_rule_key: '*',
    provider: index % 2 === 0 ? 'anthropic' : 'openai',
    model_in: 'sonnet',
    model_out: index % 2 === 0 ? 'claude-sonnet' : 'gpt-4.1',
    target_url: 'https://example.com/v1/messages',
    proxy_url: null,
    is_stream: false,
    upstream_status: index === 3 ? 502 : 200,
    content_type_req: 'application/json',
    content_type_res: 'application/json',
    user_agent: null,
    request_headers: {},
    response_headers: {},
    request_bytes: 10,
    response_bytes: 20,
    stream_bytes: null,
    provider_request_id: null,
    error_type: null,
    error_message: index === 3 ? 'bad gateway' : null,
    request_body: {
      metadata: {
        user_id: `user-${index}_account__session_session-${index}`,
      },
    },
    response_body: '{}',
  };
}

function writeConfig(dir: string): string {
  const configPath = join(dir, 'config.json5');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: {},
        routes: {},
        log: {
          enabled: true,
          baseDir: join(dir, 'logs'),
          bodyPolicy: 'full',
        },
      },
      null,
      2
    )
  );
  return configPath;
}

function writeEvents(dir: string): void {
  const eventsDir = join(dir, 'logs', 'events');
  mkdirSync(eventsDir, { recursive: true });
  writeFileSync(
    join(eventsDir, '2026-03-16.jsonl'),
    `${[1, 2, 3].map((index) => JSON.stringify(createEvent(index))).join('\n')}\n`
  );
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('logs API', () => {
  let tempDir: string;
  let runtime: AppRuntime;
  let app: Hono;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'logs-api-test-'));
    const configPath = writeConfig(tempDir);
    writeEvents(tempDir);
    runtime = await createAppRuntimeFromConfigPath(configPath);
    app = runtime.app;
  });

  afterEach(() => {
    runtime?.dispose();
    resetLogger();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('GET /api/logs/events 应走索引并返回可打开详情的 offset id', async () => {
    const res = await app.request(
      'http://localhost/api/logs/events?from=2026-03-16T09:59:00.000Z&to=2026-03-16T10:01:00.000Z&limit=2&sort=time_desc'
    );
    const data = await readJson(res);

    expect(res.status).toBe(200);
    expect((data.meta as { indexUsed?: boolean }).indexUsed).toBe(true);
    expect((data.items as Array<{ requestId: string }>).map((item) => item.requestId)).toEqual([
      'api-req-3',
      'api-req-2',
    ]);
    expect(data.nextCursor).toBeString();

    const firstId = (data.items as Array<{ id: string }>)[0]?.id;
    const detailRes = await app.request(
      `http://localhost/api/logs/events/${encodeURIComponent(firstId)}`
    );
    const detail = await readJson(detailRes);

    expect(detailRes.status).toBe(200);
    expect((detail.summary as { requestId?: string }).requestId).toBe('api-req-3');
    expect((detail.location as { line?: number }).line).toBe(3);
  });

  test('GET /api/logs/events 应校验查询参数', async () => {
    const badLevel = await app.request('http://localhost/api/logs/events?levels=debug');
    expect(badLevel.status).toBe(400);
    expect(await badLevel.json()).toEqual({ error: 'levels 参数仅支持 info,error' });

    const badSort = await app.request('http://localhost/api/logs/events?sort=time_random');
    expect(badSort.status).toBe(400);
    expect(await badSort.json()).toEqual({ error: 'sort 参数仅支持 time_desc | time_asc' });

    const badStatus = await app.request('http://localhost/api/logs/events?statusClass=3xx');
    expect(badStatus.status).toBe(400);
    expect(await badStatus.json()).toEqual({
      error: 'statusClass 参数仅支持 2xx,4xx,5xx,network_error',
    });
  });

  test('GET /api/logs/export 应导出受筛选条件限制的 CSV 和 JSON', async () => {
    const csvRes = await app.request(
      'http://localhost/api/logs/export?format=csv&from=2026-03-16T09:59:00.000Z&to=2026-03-16T10:01:00.000Z&provider=anthropic'
    );
    const csv = await csvRes.text();

    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get('x-exported-count')).toBe('1');
    expect(csv).toContain('id,ts,level,provider');
    expect(csv).toContain('api-req-2');
    expect(csv).not.toContain('api-req-1');

    const jsonRes = await app.request(
      'http://localhost/api/logs/export?format=json&from=2026-03-16T09:59:00.000Z&to=2026-03-16T10:01:00.000Z&hasError=true'
    );
    const exported = await readJson(jsonRes);

    expect(jsonRes.status).toBe(200);
    expect((exported.items as Array<{ requestId: string }>).map((item) => item.requestId)).toEqual([
      'api-req-3',
    ]);
    expect((exported.stats as { errorCount?: number }).errorCount).toBe(1);
  });

  test('GET /api/logs/export 应拒绝不支持的格式', async () => {
    const res = await app.request('http://localhost/api/logs/export?format=xlsx');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'format 参数仅支持 csv | json' });
  });
});
