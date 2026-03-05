import { describe, expect, test } from 'bun:test';
import type { LogEventDetail } from '../../web/src/lib/api';
import { parseChatHistory } from '../../web/src/lib/log-chat-history/parse-chat-history';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown>
    ? DeepPartial<T[K]>
    : T[K] extends (infer U)[]
      ? U[]
      : T[K];
};

function baseDetail(overrides: DeepPartial<LogEventDetail> = {}): LogEventDetail {
  const base: LogEventDetail = {
    id: 'id-1',
    summary: {
      id: 'id-1',
      ts: '2026-03-03T00:00:00.000Z',
      level: 'info',
      provider: 'test-provider',
      routeType: 'anthropic-messages',
      routeRuleKey: '*',
      requestId: 'req-1',
      latencyMs: 100,
      upstreamStatus: 200,
      statusClass: '2xx',
      hasError: false,
      model: 'test-model',
      modelIn: 'test-in',
      modelOut: 'test-out',
    },
    request: {
      method: 'POST',
      path: '/v1/messages',
      contentType: 'application/json',
      requestHeadersMasked: {},
      requestBody: null,
    },
    response: {
      upstreamStatus: 200,
      contentType: 'application/json',
      responseHeaders: {},
      responseBody: null,
    },
    upstream: {
      targetUrl: 'https://example.com',
      providerRequestId: null,
      errorType: null,
      errorMessage: null,
      isStream: false,
      streamFile: null,
      streamContent: null,
    },
    capture: {
      bodyPolicy: 'full',
      requestBodyAvailable: true,
      responseBodyAvailable: true,
      streamCaptured: false,
      truncatedHints: [],
    },
    rawEvent: {},
    location: {
      date: '2026-03-03',
      line: 1,
      file: '/tmp/log.jsonl',
    },
  };

  return {
    ...base,
    ...overrides,
    summary: { ...base.summary, ...(overrides.summary ?? {}) },
    request: { ...base.request, ...(overrides.request ?? {}) },
    response: { ...base.response, ...(overrides.response ?? {}) },
    upstream: { ...base.upstream, ...(overrides.upstream ?? {}) },
    capture: { ...base.capture, ...(overrides.capture ?? {}) },
    location: { ...base.location, ...(overrides.location ?? {}) },
  } as LogEventDetail;
}

describe('parseChatHistory', () => {
  test('parses anthropic non-stream request+response merge', () => {
    const detail = baseDetail({
      summary: { routeType: 'anthropic-messages' },
      request: {
        requestBody: {
          model: 'claude-3-7-sonnet',
          messages: [{ role: 'user', content: 'hello' }],
        },
      },
      response: {
        responseBody: JSON.stringify({
          model: 'claude-3-7-sonnet',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'text', text: 'world' }],
        }),
      },
    });

    const parsed = parseChatHistory(detail);

    expect(parsed.messages.length).toBe(2);
    expect(parsed.stats.inputCount).toBe(1);
    expect(parsed.stats.outputCount).toBe(1);
    expect(parsed.messages[0]?.role).toBe('user');
    expect(parsed.messages[1]?.role).toBe('assistant');
    expect(parsed.messages[1]?.blocks[0]).toEqual({ type: 'text', text: 'world' });
    expect(parsed.warnings.length).toBe(0);
  });

  test('parses anthropic stream thinking/text/tool_use aggregation', () => {
    const streamContent = [
      'event: message_start',
      'data: {"type":"message_start","message":{"role":"assistant","model":"claude-x","content":[]}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step1"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_1","name":"ToolA","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":",\\"b\\":2}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":2}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    const detail = baseDetail({
      summary: { routeType: 'anthropic-messages' },
      request: { requestBody: { messages: [{ role: 'user', content: 'q' }] } },
      upstream: { isStream: true, streamContent },
      capture: { streamCaptured: true },
    });

    const parsed = parseChatHistory(detail);

    expect(parsed.messages.length).toBe(2);
    expect(parsed.stats.streamEventCount).toBeGreaterThan(0);
    const output = parsed.messages[1];
    expect(output?.source).toBe('stream');
    expect(output?.blocks[0]?.type).toBe('thinking');
    expect(output?.blocks[1]).toEqual({ type: 'text', text: 'hi' });
    expect(output?.blocks[2]?.type).toBe('tool_use');
    if (output?.blocks[2]?.type === 'tool_use') {
      expect(output.blocks[2].input).toEqual({ a: 1, b: 2 });
      expect(output.blocks[2].partial).toBe(false);
    }
  });

  test('parses openai-completions non-stream choices[0].message', () => {
    const detail = baseDetail({
      summary: { routeType: 'openai-completions' },
      request: {
        requestBody: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hello' }],
        },
      },
      response: {
        responseBody: JSON.stringify({
          model: 'gpt-4o-mini',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'hi',
                tool_calls: [
                  {
                    id: 'call_1',
                    function: {
                      name: 'weather',
                      arguments: '{"city":"shanghai"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
    });

    const parsed = parseChatHistory(detail);

    expect(parsed.messages.length).toBe(2);
    const output = parsed.messages[1];
    expect(output?.blocks[0]).toEqual({ type: 'text', text: 'hi' });
    expect(output?.blocks[1]?.type).toBe('tool_use');
    if (output?.blocks[1]?.type === 'tool_use') {
      expect(output.blocks[1].name).toBe('weather');
      expect(output.blocks[1].input).toEqual({ city: 'shanghai' });
    }
  });

  test('parses openai-completions stream delta and tool_calls', () => {
    const streamContent = [
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello "},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"world"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"calc","arguments":"{\\"x\\":1"}}]},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"y\\":2}"}}]},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const detail = baseDetail({
      summary: { routeType: 'openai-completions' },
      request: { requestBody: { messages: [{ role: 'user', content: 'q' }] } },
      upstream: { isStream: true, streamContent },
      capture: { streamCaptured: true },
    });

    const parsed = parseChatHistory(detail);

    expect(parsed.messages.length).toBe(2);
    const output = parsed.messages[1];
    expect(output?.blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
    expect(output?.blocks[1]?.type).toBe('tool_use');
    if (output?.blocks[1]?.type === 'tool_use') {
      expect(output.blocks[1].name).toBe('calc');
      expect(output.blocks[1].input).toEqual({ x: 1, y: 2 });
    }
  });

  test('handles truncated stream and bad json with warnings', () => {
    const detail = baseDetail({
      summary: { routeType: 'anthropic-messages' },
      request: { requestBody: { messages: [{ role: 'user', content: 'q' }] } },
      upstream: {
        isStream: true,
        streamContent: [
          'event: message_start',
          'data: {"type":"message_start","message":{"role":"assistant","model":"x","content":[]}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
          '',
          '[TRUNCATED]',
          '',
          'event: content_block_delta',
          'data: {not-json}',
          '',
        ].join('\n'),
      },
      capture: { streamCaptured: true },
    });

    const parsed = parseChatHistory(detail);

    expect(parsed.stats.streamPartial).toBe(true);
    expect(parsed.warnings.some((item) => item.includes('JSON parse failed'))).toBe(true);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.messages.length).toBeGreaterThanOrEqual(1);
  });
});
