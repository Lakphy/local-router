import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createAppFromConfigPath } from '../../src/index';
import { config } from '../setup';

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
    const isStream = isStreamRequest(init);
    if (isStream) {
      const sseBody = [
        'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":0,"model":"mock-openai-chat","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
        '',
        'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":0,"model":"mock-openai-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n');
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
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
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    });
  }

  if (url.startsWith('http://mock-openai-responses')) {
    const isStream = isStreamRequest(init);
    if (isStream) {
      const sseBody = [
        'data: {"type":"response.created","response":{"id":"resp-stream-mock","created_at":0,"model":"mock-openai-responses","service_tier":null}}',
        '',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-stream-mock","phase":null}}',
        '',
        'data: {"type":"response.output_text.delta","item_id":"msg-stream-mock","delta":"ok"}',
        '',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg-stream-mock","phase":null}}',
        '',
        'data: {"type":"response.completed","response":{"incomplete_details":null,"usage":{"input_tokens":1,"input_tokens_details":{"cached_tokens":null},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":null}},"service_tier":null}}',
        '',
      ].join('\n');
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
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
          content: [
            {
              type: 'output_text',
              text: 'ok',
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
  }

  if (url.startsWith('http://mock-anthropic-messages')) {
    const isStream = isStreamRequest(init);
    if (isStream) {
      const sseBody = [
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
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null,"container":null},"usage":{"output_tokens":1}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n');
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    return Response.json({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: 'mock-anthropic',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }

  return null;
}

function createLocalFetch(app: Hono) {
  const localFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return app.request(url, init);
  };
  return localFetch as unknown as typeof globalThis.fetch;
}

describe('AI SDK v6 Provider 解析兼容性', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'local-router-ai-sdk-v6-'));
  const tempConfigPath = join(tempDir, 'config.json');

  const compatConfig = structuredClone(config);
  compatConfig.providers['mock-openai-completions'] = {
    type: 'openai-completions',
    base: 'http://mock-openai-completions',
    apiKey: 'mock-key',
    models: { 'mock-openai-chat': {} },
  };
  compatConfig.providers['mock-openai-responses'] = {
    type: 'openai-responses',
    base: 'http://mock-openai-responses',
    apiKey: 'mock-key',
    models: { 'mock-openai-responses': {} },
  };
  compatConfig.providers['mock-anthropic-messages'] = {
    type: 'anthropic-messages',
    base: 'http://mock-anthropic-messages',
    apiKey: 'mock-key',
    models: { 'mock-anthropic': {} },
  };
  compatConfig.routes['openai-completions'] = {
    '*': { provider: 'mock-openai-completions', model: 'mock-openai-chat' },
  };
  compatConfig.routes['openai-responses'] = {
    '*': { provider: 'mock-openai-responses', model: 'mock-openai-responses' },
  };
  compatConfig.routes['anthropic-messages'] = {
    '*': { provider: 'mock-anthropic-messages', model: 'mock-anthropic' },
  };

  writeFileSync(tempConfigPath, JSON.stringify(compatConfig, null, 2), 'utf-8');

  let localFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    const compatApp = await createAppFromConfigPath(tempConfigPath);
    localFetch = createLocalFetch(compatApp);

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

  test('openai-completions + @ai-sdk/openai-compatible 可正常解析', async () => {
    const provider = createOpenAICompatible({
      name: 'local-router-openai-completions',
      apiKey: 'test-key',
      baseURL: 'http://local-router/openai-completions/v1',
      fetch: localFetch,
    });

    const nonStream = await generateText({
      model: provider('test-model'),
      prompt: '请只回复 ok',
      maxOutputTokens: 16,
    });
    expect(nonStream.text.trim()).toBe('ok');

    const stream = streamText({
      model: provider('test-model'),
      prompt: '请只回复 ok',
      maxOutputTokens: 16,
    });
    const streamedText = await stream.text;
    expect(streamedText.trim()).toBe('ok');
  });

  test('openai-responses + @ai-sdk/openai 可正常解析', async () => {
    const provider = createOpenAI({
      name: 'local-router-openai-responses',
      apiKey: 'test-key',
      baseURL: 'http://local-router/openai-responses/v1',
      fetch: localFetch,
    });

    const nonStream = await generateText({
      model: provider.responses('test-model'),
      prompt: '请只回复 ok',
      maxOutputTokens: 16,
    });
    expect(nonStream.text.trim()).toBe('ok');

    const stream = streamText({
      model: provider.responses('test-model'),
      prompt: '请只回复 ok',
      maxOutputTokens: 16,
    });
    const streamedText = await stream.text;
    expect(streamedText.trim()).toBe('ok');
  });

  test('anthropic-messages + @ai-sdk/anthropic 可正常解析', async () => {
    const provider = createAnthropic({
      apiKey: 'test-key',
      baseURL: 'http://local-router/anthropic-messages/v1',
      fetch: localFetch,
    });

    const nonStream = await generateText({
      model: provider('sonnet'),
      prompt: '请只回复 ok',
      maxOutputTokens: 32,
    });
    expect(nonStream.text.trim()).toBe('ok');

    const stream = streamText({
      model: provider('sonnet'),
      prompt: '请只回复 ok',
      maxOutputTokens: 32,
    });
    const streamedText = await stream.text;
    expect(streamedText.trim()).toBe('ok');
  });
});
