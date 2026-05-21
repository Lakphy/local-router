import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogConfig } from '../../src/config';
import { getLogEventDetailById } from '../../src/log-query';
import type { LogEvent } from '../../src/logger';

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
});
