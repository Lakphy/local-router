import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createAppFromConfigPath } from '../../src/index';

/**
 * 协议适配器插件集成测试
 *
 * 场景：用户通过 anthropic-messages 路由访问 openai-responses 类型的 provider，
 * 插件自动完成协议转换。
 */

function isStreamRequest(init?: RequestInit): boolean {
  if (typeof init?.body === 'string') {
    return init.body.includes('"stream":true');
  }
  return false;
}

// 捕获发往上游的请求，验证插件是否正确转换了请求体
const capturedUpstreamRequests: Array<{
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}> = [];

function mockUpstreamResponse(url: string, init?: RequestInit): Response | null {
  // 只拦截发往 mock-openai-responses 的请求
  if (!url.startsWith('http://mock-openai-responses-adapter')) return null;

  // 捕获请求信息
  const headers: Record<string, string> = {};
  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((v, k) => { headers[k] = v; });
  }
  let body: Record<string, unknown> = {};
  if (typeof init?.body === 'string') {
    try { body = JSON.parse(init.body); } catch { /* ignore */ }
  }
  capturedUpstreamRequests.push({ url, headers, body });

  const isStream = isStreamRequest(init);

  if (isStream) {
    // OpenAI Responses 流式格式
    const sseBody = [
      'data: {"type":"response.created","response":{"id":"resp-stream-mock","created_at":0,"model":"gpt-4o-test","service_tier":null}}',
      '',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-stream-mock","role":"assistant","status":"in_progress","content":[]}}',
      '',
      'data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}',
      '',
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg-stream-mock","delta":"Hello"}',
      '',
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg-stream-mock","delta":" from"}',
      '',
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg-stream-mock","delta":" OpenAI"}',
      '',
      'data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello from OpenAI","annotations":[]}}',
      '',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg-stream-mock","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hello from OpenAI","annotations":[]}]}}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp-stream-mock","model":"gpt-4o-test","output":[{"type":"message","id":"msg-stream-mock","role":"assistant","content":[{"type":"output_text","text":"Hello from OpenAI"}]}],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15},"status":"completed"}}',
      '',
    ].join('\n');
    return new Response(sseBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  // 非流式 OpenAI Responses 格式
  return Response.json({
    id: 'resp-mock',
    object: 'response',
    created_at: 1234567890,
    model: 'gpt-4o-test',
    output: [
      {
        type: 'message',
        id: 'msg-mock',
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: 'Hello from OpenAI', annotations: [] },
        ],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
    status: 'completed',
  });
}

function mockUpstreamToolResponse(url: string, init?: RequestInit): Response | null {
  if (!url.startsWith('http://mock-openai-responses-tools')) return null;

  // 捕获请求信息
  const headers: Record<string, string> = {};
  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((v, k) => { headers[k] = v; });
  }
  let body: Record<string, unknown> = {};
  if (typeof init?.body === 'string') {
    try { body = JSON.parse(init.body); } catch { /* ignore */ }
  }
  capturedUpstreamRequests.push({ url, headers, body });

  // 返回包含 function_call 的 OpenAI Responses 格式
  return Response.json({
    id: 'resp-tool-mock',
    object: 'response',
    created_at: 1234567890,
    model: 'gpt-4o-test',
    output: [
      {
        type: 'function_call',
        id: 'fc_mock',
        call_id: 'call_mock_123',
        name: 'get_weather',
        arguments: '{"location":"Tokyo","unit":"celsius"}',
        status: 'completed',
      },
    ],
    usage: { input_tokens: 15, output_tokens: 8, total_tokens: 23 },
    status: 'completed',
  });
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

describe('协议适配器插件：Anthropic Messages → OpenAI Responses', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'local-router-protocol-adapter-'));
  const tempConfigPath = join(tempDir, 'config.json');

  // 获取插件路径（相对于配置文件）
  const pluginPath = join(__dirname, '../../packages/plugin-protocol-adapter');

  const testConfig = {
    providers: {
      'mock-openai-via-anthropic': {
        type: 'openai-responses' as const,
        base: 'http://mock-openai-responses-adapter',
        apiKey: 'test-api-key-123',
        models: { 'gpt-4o-test': {} },
        plugins: [
          { package: pluginPath },
        ],
      },
      'mock-openai-tools': {
        type: 'openai-responses' as const,
        base: 'http://mock-openai-responses-tools',
        apiKey: 'test-api-key-tools',
        models: { 'gpt-4o-tools': {} },
        plugins: [
          { package: pluginPath },
        ],
      },
    },
    routes: {
      'anthropic-messages': {
        'gpt-4o-test': { provider: 'mock-openai-via-anthropic', model: 'gpt-4o-test' },
        'gpt-4o-tools': { provider: 'mock-openai-tools', model: 'gpt-4o-tools' },
        '*': { provider: 'mock-openai-via-anthropic', model: 'gpt-4o-test' },
      },
    },
  };

  writeFileSync(tempConfigPath, JSON.stringify(testConfig, null, 2), 'utf-8');

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

      const mocked = mockUpstreamResponse(url, init) ?? mockUpstreamToolResponse(url, init);
      if (mocked) return mocked;
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('非流式：Anthropic 请求格式被正确转换为 OpenAI Responses 格式', async () => {
    capturedUpstreamRequests.length = 0;

    const res = await app.request('http://localhost/anthropic-messages/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'client-key',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'gpt-4o-test',
        max_tokens: 1024,
        system: 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: 'Hello!' },
        ],
      }),
    });

    expect(res.status).toBe(200);

    // 验证上游请求被正确转换
    expect(capturedUpstreamRequests.length).toBeGreaterThanOrEqual(1);
    const upstream = capturedUpstreamRequests[capturedUpstreamRequests.length - 1];

    // URL 应该从 /v1/messages 变为 /v1/responses
    expect(upstream.url).toContain('/v1/responses');

    // 认证头应该从 x-api-key 变为 Authorization: Bearer
    expect(upstream.headers['authorization']).toBe('Bearer test-api-key-123');
    expect(upstream.headers['x-api-key']).toBeUndefined();

    // 请求体应该是 OpenAI Responses 格式
    expect(upstream.body.input).toBeDefined();
    expect(upstream.body.instructions).toBe('You are a helpful assistant.');
    expect(upstream.body.max_output_tokens).toBe(1024);
    expect(upstream.body.messages).toBeUndefined(); // 不应保留 Anthropic 格式
    expect(upstream.body.max_tokens).toBeUndefined();
    expect(upstream.body.system).toBeUndefined();

    // 验证响应被正确转换为 Anthropic 格式
    const body = await res.json();
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content).toBeArrayOfSize(1);
    expect(body.content[0].type).toBe('text');
    expect(body.content[0].text).toBe('Hello from OpenAI');
    expect(body.stop_reason).toBe('end_turn');
    expect(body.usage.input_tokens).toBe(10);
    expect(body.usage.output_tokens).toBe(5);
  });

  test('非流式：工具调用响应被正确转换', async () => {
    capturedUpstreamRequests.length = 0;

    const res = await app.request('http://localhost/anthropic-messages/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-tools',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'What is the weather in Tokyo?' },
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a location',
            input_schema: {
              type: 'object',
              properties: {
                location: { type: 'string' },
                unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
              },
              required: ['location'],
            },
          },
        ],
        tool_choice: { type: 'auto' },
      }),
    });

    expect(res.status).toBe(200);

    // 验证工具定义被正确转换
    const upstream = capturedUpstreamRequests[capturedUpstreamRequests.length - 1];
    const tools = upstream.body.tools as Array<Record<string, unknown>>;
    expect(tools).toBeDefined();
    expect(tools[0].type).toBe('function');
    expect(tools[0].name).toBe('get_weather');
    expect(tools[0].parameters).toBeDefined();
    expect(tools[0].input_schema).toBeUndefined();

    // tool_choice 应该被转换
    expect(upstream.body.tool_choice).toBe('auto');

    // 验证响应被正确转换为 Anthropic 格式
    const body = await res.json();
    expect(body.type).toBe('message');
    expect(body.stop_reason).toBe('tool_use');
    expect(body.content).toBeArrayOfSize(1);
    expect(body.content[0].type).toBe('tool_use');
    expect(body.content[0].name).toBe('get_weather');
    expect(body.content[0].id).toBe('call_mock_123');
    expect(body.content[0].input).toEqual({ location: 'Tokyo', unit: 'celsius' });
  });

  test('流式：OpenAI Responses SSE 被转换为 Anthropic Messages SSE', async () => {
    const res = await app.request('http://localhost/anthropic-messages/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-test',
        max_tokens: 1024,
        stream: true,
        messages: [
          { role: 'user', content: 'Hello!' },
        ],
      }),
    });

    expect(res.status).toBe(200);

    const text = await readResponseText(res);
    const lines = text.split('\n').filter((l) => l.trim());

    // 解析 SSE 事件
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('event: ')) {
        const eventType = line.slice(7);
        const nextLine = lines[i + 1];
        if (nextLine?.startsWith('data: ')) {
          try {
            const data = JSON.parse(nextLine.slice(6));
            events.push({ event: eventType, data });
            i++; // 跳过 data 行
          } catch { /* ignore */ }
        }
      }
    }

    // 验证 Anthropic SSE 事件序列
    expect(events.length).toBeGreaterThan(0);

    // 应该有 message_start
    const messageStart = events.find((e) => e.event === 'message_start');
    expect(messageStart).toBeDefined();
    expect(messageStart!.data.type).toBe('message_start');
    const msg = messageStart!.data.message as Record<string, unknown>;
    expect(msg.role).toBe('assistant');

    // 应该有 content_block_start (text)
    const blockStart = events.find((e) => e.event === 'content_block_start');
    expect(blockStart).toBeDefined();
    const block = blockStart!.data.content_block as Record<string, unknown>;
    expect(block.type).toBe('text');

    // 应该有 content_block_delta (text_delta)
    const deltas = events.filter((e) => e.event === 'content_block_delta');
    expect(deltas.length).toBe(3); // "Hello", " from", " OpenAI"
    const deltaTexts = deltas.map(
      (d) => ((d.data.delta as Record<string, unknown>).text as string)
    );
    expect(deltaTexts.join('')).toBe('Hello from OpenAI');

    // 应该有 content_block_stop
    const blockStop = events.find((e) => e.event === 'content_block_stop');
    expect(blockStop).toBeDefined();

    // 应该有 message_delta (带 stop_reason)
    const messageDelta = events.find((e) => e.event === 'message_delta');
    expect(messageDelta).toBeDefined();
    const delta = messageDelta!.data.delta as Record<string, unknown>;
    expect(delta.stop_reason).toBe('end_turn');

    // 应该有 message_stop
    const messageStop = events.find((e) => e.event === 'message_stop');
    expect(messageStop).toBeDefined();
  });

  test('多轮对话（含 tool_result）请求被正确转换', async () => {
    capturedUpstreamRequests.length = 0;

    const res = await app.request('http://localhost/anthropic-messages/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-test',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'What is the weather in Tokyo?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check the weather for you.' },
              {
                type: 'tool_use',
                id: 'toolu_123',
                name: 'get_weather',
                input: { location: 'Tokyo' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_123',
                content: '{"temperature": 22, "condition": "sunny"}',
              },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);

    // 验证请求转换
    const upstream = capturedUpstreamRequests[capturedUpstreamRequests.length - 1];
    const input = upstream.body.input as Array<Record<string, unknown>>;
    expect(input).toBeDefined();

    // 第一项：user 消息
    expect(input[0].role).toBe('user');
    expect(input[0].content).toBe('What is the weather in Tokyo?');

    // 第二项：assistant 文本部分
    expect(input[1].role).toBe('assistant');

    // 第三项：function_call（从 tool_use 转换）
    const fcItem = input.find((i) => i.type === 'function_call');
    expect(fcItem).toBeDefined();
    expect(fcItem!.call_id).toBe('toolu_123');
    expect(fcItem!.name).toBe('get_weather');
    expect(fcItem!.arguments).toBe('{"location":"Tokyo"}');

    // 第四项：function_call_output（从 tool_result 转换）
    const fcoItem = input.find((i) => i.type === 'function_call_output');
    expect(fcoItem).toBeDefined();
    expect(fcoItem!.call_id).toBe('toolu_123');
    expect(fcoItem!.output).toBe('{"temperature": 22, "condition": "sunny"}');
  });
});
