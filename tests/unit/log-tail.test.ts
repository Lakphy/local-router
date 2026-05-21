import { describe, expect, test } from 'bun:test';
import { getLogTailSubscriberCount, publishLogEvent, subscribeLogEvents } from '../../src/log-tail';
import type { LogEvent } from '../../src/logger';

function event(requestId: string): LogEvent {
  return {
    request_id: requestId,
    ts_start: '2026-03-16T10:00:00.000Z',
    ts_end: '2026-03-16T10:00:00.100Z',
    latency_ms: 100,
    method: 'POST',
    path: '/v1/messages',
    route_type: 'anthropic-messages',
    route_rule_key: '*',
    provider: 'test',
    model_in: 'sonnet',
    model_out: 'claude-sonnet',
    target_url: 'https://example.com/v1/messages',
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
  };
}

describe('log-tail pub/sub', () => {
  test('应向订阅者发布事件并支持取消订阅', () => {
    const received: string[] = [];
    const unsubscribe = subscribeLogEvents((item) => {
      received.push(item.event.request_id);
    });

    expect(getLogTailSubscriberCount()).toBe(1);
    publishLogEvent({
      id: 'id-1',
      date: '2026-03-16',
      filePath: '/tmp/events/2026-03-16.jsonl',
      offset: 0,
      event: event('req-1'),
    });

    unsubscribe();
    publishLogEvent({
      id: 'id-2',
      date: '2026-03-16',
      filePath: '/tmp/events/2026-03-16.jsonl',
      offset: 100,
      event: event('req-2'),
    });

    expect(received).toEqual(['req-1']);
    expect(getLogTailSubscriberCount()).toBe(0);
  });

  test('单个订阅者异常不应影响其他订阅者', () => {
    const received: string[] = [];
    const cleanup: Array<() => void> = [];

    try {
      cleanup.push(
        subscribeLogEvents(() => {
          throw new Error('subscriber failed');
        })
      );
      cleanup.push(
        subscribeLogEvents((item) => {
          received.push(item.event.request_id);
        })
      );

      publishLogEvent({
        id: 'id-1',
        date: '2026-03-16',
        filePath: '/tmp/events/2026-03-16.jsonl',
        offset: 0,
        event: event('req-1'),
      });

      expect(received).toEqual(['req-1']);
    } finally {
      for (const unsubscribe of cleanup) unsubscribe();
    }

    expect(getLogTailSubscriberCount()).toBe(0);
  });
});
