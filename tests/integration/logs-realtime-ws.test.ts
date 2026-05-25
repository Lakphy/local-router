import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLogTailSubscriberCount } from '../../src/log-tail';
import { getLogger, type LogEvent, resetLogger } from '../../src/logger';
import { type RunningServer, startServer } from '../../src/server';

function createEvent(provider: string, requestId: string): LogEvent {
  return {
    request_id: requestId,
    ts_start: new Date().toISOString(),
    ts_end: new Date().toISOString(),
    latency_ms: 100,
    method: 'POST',
    path: '/v1/chat/completions',
    route_type: 'openai-completions',
    route_rule_key: '*',
    provider,
    model_in: 'gpt-4.1',
    model_out: 'gpt-4.1',
    target_url: 'https://example.com/v1/chat/completions',
    proxy_url: null,
    is_stream: false,
    upstream_status: 200,
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
    error_message: null,
    request_body: {
      metadata: {
        user_id: 'user-a_account__session_session-1',
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
    ),
    'utf-8'
  );
  return configPath;
}

function wsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, 'ws')}/api/logs/events/ws`;
}

function waitForMessage<T extends Record<string, unknown>>(
  ws: WebSocket,
  predicate: (message: T) => boolean,
  timeoutMs = 1000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error('WebSocket message timeout'));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as T;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      resolve(message);
    };

    ws.addEventListener('message', onMessage);
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket open failed')), { once: true });
  });
}

describe('logs realtime WebSocket', () => {
  let tempDir: string;
  let server: RunningServer | null = null;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'logs-realtime-ws-test-'));
    server = await startServer({
      configPath: writeConfig(tempDir),
      host: '127.0.0.1',
      port: 0,
    });
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    resetLogger();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('应只推送符合当前订阅条件的新日志', async () => {
    const running = server;
    if (!running) throw new Error('server not started');

    const ws = new WebSocket(wsUrl(running.baseUrl));
    await waitForOpen(ws);
    await waitForMessage(ws, (message) => message.type === 'ready');

    ws.send(
      JSON.stringify({
        type: 'subscribe',
        requestId: 'test-subscribe',
        query: {
          window: '24h',
          provider: 'openai',
          sort: 'time_desc',
        },
      })
    );
    const subscribed = await waitForMessage<{ type: string; subscriptionId: string }>(
      ws,
      (message) => message.type === 'subscribed'
    );

    expect(getLogTailSubscriberCount()).toBe(1);

    getLogger()?.writeEvent(createEvent('anthropic', 'ws-non-matching'));
    await expect(
      waitForMessage(ws, (message) => message.type === 'log.event', 100)
    ).rejects.toThrow('WebSocket message timeout');

    getLogger()?.writeEvent(createEvent('openai', 'ws-matching'));
    const pushed = await waitForMessage<{
      type: string;
      subscriptionId: string;
      item: { requestId: string; provider: string };
    }>(ws, (message) => message.type === 'log.event');

    expect(pushed.subscriptionId).toBe(subscribed.subscriptionId);
    expect(pushed.item.requestId).toBe('ws-matching');
    expect(pushed.item.provider).toBe('openai');

    ws.close();
  });
});
