import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createAppFromConfigPath } from '../../src/index';

function isStreamRequest(init?: RequestInit): boolean {
  const headers = new Headers(init?.headers);
  const accept = headers.get('accept') ?? '';
  if (accept.includes('text/event-stream')) return true;

  if (typeof init?.body === 'string') {
    return init.body.includes('"stream":true');
  }

  return false;
}

function mockUpstreamResponse(url: string, init?: RequestInit): Response | null {
  if (url.startsWith('http://mock-openai-completions')) {
    if (isStreamRequest(init)) {
      return new Response(
        [
          'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":0,"model":"mock-openai-chat","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
          '',
          'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":0,"model":"mock-openai-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    }

    return Response.json({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 0,
      model: 'mock-openai-chat',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
    });
  }

  if (url.startsWith('http://mock-openai-responses')) {
    if (isStreamRequest(init)) {
      return new Response(
        [
          'data: {"type":"response.created","response":{"id":"resp-stream-mock","created_at":0,"model":"mock-openai-responses","service_tier":null}}',
          '',
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-stream-mock","phase":null}}',
          '',
          'data: {"type":"response.output_text.delta","item_id":"msg-stream-mock","delta":"ok"}',
          '',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg-stream-mock","phase":null}}',
          '',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    }

    return Response.json({
      id: 'resp-mock',
      created_at: 0,
      model: 'mock-openai-responses',
      output: [
        {
          type: 'message',
          role: 'assistant',
          id: 'msg-mock',
          content: [{ type: 'output_text', text: 'ok', annotations: [] }],
        },
      ],
    });
  }

  if (url.startsWith('http://mock-anthropic-messages')) {
    if (isStreamRequest(init)) {
      return new Response(
        [
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"msg-stream-mock","model":"mock-anthropic","role":"assistant","usage":{"input_tokens":1}}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
          '',
          'event: content_block_stop',
          'data: {"type":"content_block_stop","index":0}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    }

    return Response.json({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: 'mock-anthropic',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }

  return null;
}

async function readResponseText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';

  let text = '';
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

describe('聊天代理接口', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'local-router-chat-proxy-'));
  const tempConfigPath = join(tempDir, 'config.json');

  writeFileSync(
    tempConfigPath,
    JSON.stringify(
      {
        providers: {
          'mock-openai-completions': {
            type: 'openai-completions',
            base: 'http://mock-openai-completions',
            apiKey: 'mock-key',
            models: { 'mock-openai-chat': {} },
          },
          'mock-openai-responses': {
            type: 'openai-responses',
            base: 'http://mock-openai-responses',
            apiKey: 'mock-key',
            models: { 'mock-openai-responses': {} },
          },
          'mock-anthropic-messages': {
            type: 'anthropic-messages',
            base: 'http://mock-anthropic-messages',
            apiKey: 'mock-key',
            models: { 'mock-anthropic': {} },
          },
        },
        routes: {},
      },
      null,
      2
    ),
    'utf-8'
  );

  let app: Hono;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    app = await createAppFromConfigPath(tempConfigPath);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      const mocked = mockUpstreamResponse(url, init);
      if (mocked) return mocked;
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test.each([
    ['mock-openai-completions', 'mock-openai-chat'],
    ['mock-openai-responses', 'mock-openai-responses'],
    ['mock-anthropic-messages', 'mock-anthropic'],
  ])('provider=%s 时应返回统一文本流', async (provider, model) => {
    const res = await app.request('http://localhost/api/chat/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider,
        model,
        messages: [{ role: 'user', content: '请只回复 ok' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await readResponseText(res);
    expect(text.trim()).toBe('ok');
  });
});
