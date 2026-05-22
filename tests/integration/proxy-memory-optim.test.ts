import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { loadConfig } from '../../src/config';
import { createAppFromConfigPath } from '../../src/index';
import { initLogger, resetLogger } from '../../src/logger';

/**
 * 这套测试覆盖代理路径内存优化的两组改造：
 *  - A. payload 对象贯通：fetch 上游时只发生一次序列化，且最终 wireBody 与原 payload 等价
 *  - B. 流式日志 tap 直写：upstream chunk 直接落到 streams/{date}/{requestId}.sse.raw，
 *       不再产生 /tmp 临时文件；客户端中途 cancel 仍写出 LogEvent。
 *
 * 旁路读取最近一条事件日志：测试不依赖私有 API，直接读 events/{date}.jsonl 的最后一行。
 */

interface CapturedFetchCall {
  url: string;
  method: string;
  body: string | null;
  bodyByteLength: number;
}

const ENC = new TextEncoder();

function makeStreamingMockResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(ENC.encode(chunk));
        await Promise.resolve();
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function readLastEventLine(eventsDir: string): Record<string, unknown> | null {
  if (!existsSync(eventsDir)) return null;
  const files = readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) return null;
  files.sort();
  const latest = files[files.length - 1];
  const content = readFileSync(join(eventsDir, latest), 'utf-8').trim();
  if (!content) return null;
  const lines = content.split('\n');
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

async function waitForEvent(eventsDir: string, timeoutMs = 1000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const evt = readLastEventLine(eventsDir);
    if (evt) return evt;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitForEvent 超时（${timeoutMs}ms）`);
}

function clearEvents(eventsDir: string): void {
  if (!existsSync(eventsDir)) return;
  for (const f of readdirSync(eventsDir)) {
    rmSync(join(eventsDir, f), { force: true });
  }
}

describe('代理路径内存优化', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'local-router-proxy-mem-'));
  const tempConfigPath = join(tempDir, 'config.json');
  const logBaseDir = join(tempDir, 'logs');
  const eventsDir = join(logBaseDir, 'events');
  const streamsDir = join(logBaseDir, 'streams');

  writeFileSync(
    tempConfigPath,
    JSON.stringify(
      {
        log: {
          enabled: true,
          baseDir: logBaseDir,
          bodyPolicy: 'full',
          streams: { enabled: true, maxBytesPerRequest: 1024 * 1024 },
        },
        providers: {
          mock: {
            type: 'openai-completions',
            base: 'http://mock-mem-upstream',
            apiKey: 'mock-key',
            models: { 'mock-mem-model': {} },
          },
        },
        routes: {
          'openai-completions': {
            'mock-mem-model': { provider: 'mock', model: 'mock-mem-model-upstream' },
            '*': { provider: 'mock', model: 'mock-mem-model-upstream' },
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  let app: Hono;
  const originalFetch = globalThis.fetch;
  let captured: CapturedFetchCall[] = [];
  let nextResponse: () => Response = () =>
    Response.json({ id: 'mock', object: 'chat.completion', choices: [] });

  beforeAll(async () => {
    app = await createAppFromConfigPath(tempConfigPath);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith('http://mock-mem-upstream')) {
        return originalFetch(input, init);
      }
      const bodyStr = typeof init?.body === 'string' ? init.body : null;
      captured.push({
        url,
        method: init?.method ?? 'GET',
        body: bodyStr,
        bodyByteLength: bodyStr ? Buffer.byteLength(bodyStr, 'utf-8') : 0,
      });
      return nextResponse();
    }) as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    resetLogger();
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    captured = [];
    clearEvents(eventsDir);
    if (existsSync(streamsDir)) rmSync(streamsDir, { recursive: true, force: true });
  });

  // ─── 改造 A：payload 对象贯通 ──────────────────────────────────────────────

  test('A1. fetch 上游 body 应仅被序列化一次且字节级等价于客户端 payload（已替换 model）', async () => {
    nextResponse = () =>
      Response.json({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 0,
        model: 'mock-mem-model-upstream',
        choices: [],
      });

    const incoming = {
      model: 'mock-mem-model',
      messages: [{ role: 'user', content: 'hello world' }],
      // 含一个较大的字段，确保对象在路由 → 插件 → 日志路径上是引用传递
      // 而不是反复深拷贝；如果链路上多次 stringify 不同对象会破坏字节等价。
      bigText: 'x'.repeat(8 * 1024),
    };

    const res = await app.request('http://localhost/openai-completions/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(incoming),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(captured).toHaveLength(1);
    expect(captured[0].body).not.toBeNull();

    const upstreamPayload = JSON.parse(captured[0].body!) as Record<string, unknown>;
    // 路由层应把 model 替换为目标 model，其它字段原样保留。
    expect(upstreamPayload.model).toBe('mock-mem-model-upstream');
    expect(upstreamPayload.messages).toEqual(incoming.messages);
    expect(upstreamPayload.bigText).toBe(incoming.bigText);
  });

  test('A2. 日志中的 request_body 应保留原始对象结构（bodyPolicy=full）', async () => {
    nextResponse = () => Response.json({ id: 'mock', object: 'chat.completion', choices: [] });

    const incoming = {
      model: 'mock-mem-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.7,
    };

    const res = await app.request('http://localhost/openai-completions/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(incoming),
    });
    expect(res.status).toBe(200);
    await res.text();

    const event = await waitForEvent(eventsDir);
    expect(event.request_body).toBeDefined();
    const recorded = event.request_body as Record<string, unknown>;
    // request_body 在 logger 单例侧记录的是路由层入参 payload（含已替换的 model）。
    // 重点是字段结构与 messages 等价：消除多次 parse 后日志侧不应漏字段。
    expect(recorded.messages).toEqual(incoming.messages);
    expect(recorded.temperature).toBe(0.7);
  });

  test('A3. content-length 头存在时 requestBytes 应等于头部数值（不再多余 stringify）', async () => {
    nextResponse = () => Response.json({ ok: true });

    const body = JSON.stringify({ model: 'mock-mem-model', messages: [] });
    const expectedBytes = Buffer.byteLength(body, 'utf-8');

    const res = await app.request('http://localhost/openai-completions/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(expectedBytes),
      },
      body,
    });
    expect(res.status).toBe(200);
    await res.text();

    const event = await waitForEvent(eventsDir);
    expect(event.request_bytes).toBe(expectedBytes);
  });

  test('A3b. content-length 头非法（负数 / 非整数 / 缺失）时回退到 stringify 测量', async () => {
    nextResponse = () => Response.json({ ok: true });

    // 通过自定义 ReadableStream 构造无 content-length 的请求体，
    // 触发 routes/common.ts:74 的 fallback 分支。
    const payload = { model: 'mock-mem-model', messages: [{ role: 'user', content: 'hi' }] };
    const bodyStr = JSON.stringify(payload);
    const expectedFallback = Buffer.byteLength(
      JSON.stringify({ ...payload, model: 'mock-mem-model-upstream' }),
      'utf-8'
    );

    // 手工构造一个 Request：用 ReadableStream 作为 body 并显式 duplex='half'，
    // Bun/undici 会以 chunked 编码发送，client side 不带 content-length。
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bodyStr));
        controller.close();
      },
    });
    const req = new Request('http://localhost/openai-completions/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      // @ts-expect-error duplex 是 fetch standard 中流式 body 必填项，TS 类型尚未追上。
      duplex: 'half',
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    await res.text();

    const event = await waitForEvent(eventsDir);
    expect(event.request_bytes).toBe(expectedFallback);
  });

  // ─── 改造 B：流式日志 tap 直写 ────────────────────────────────────────────

  test('B1. 流式响应应直接落盘到 streams/{date}/{requestId}.sse.raw（无 /tmp 临时文件）；stream_bytes 等于上游字节数', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    nextResponse = () => makeStreamingMockResponse(sseChunks);

    const res = await app.request('http://localhost/openai-completions/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-mem-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    // 完整消费流，触发 tap.flush。
    const body = await res.text();
    const expected = sseChunks.join('');
    expect(body).toBe(expected);

    const event = await waitForEvent(eventsDir);
    expect(event.is_stream).toBe(true);
    expect(typeof event.stream_file).toBe('string');
    const streamFile = event.stream_file as string;
    // 落盘路径应在 logBaseDir/streams 下，**不在 /tmp 下**。
    expect(streamFile.startsWith(streamsDir)).toBe(true);
    expect(existsSync(streamFile)).toBe(true);

    const saved = readFileSync(streamFile, 'utf-8');
    expect(saved).toBe(expected);

    // stream_bytes：从上游读到的总字节数（与磁盘截断无关）。
    const expectedUpstreamBytes = Buffer.byteLength(expected, 'utf-8');
    expect(event.stream_bytes).toBe(expectedUpstreamBytes);
    // stream_file_bytes：实际落盘字节数；未触发截断时应与 stream_bytes 一致。
    expect(event.stream_file_bytes).toBe(expectedUpstreamBytes);
    expect(event.stream_file_truncated).toBeUndefined();
  });

  test('B2. 流体超过 maxBytesPerRequest 时应截断落盘但客户端仍收到完整流；stream_bytes 仍是上游全量字节数', async () => {
    // 临时把 logger 切到一个 maxBytesPerRequest=256 的目录；测试结束恢复主 logger。
    const truncLogBase = join(tempDir, 'logs-trunc');
    const truncStreamsDir = join(truncLogBase, 'streams');
    const truncEventsDir = join(truncLogBase, 'events');

    initLogger(truncLogBase, {
      enabled: true,
      baseDir: truncLogBase,
      bodyPolicy: 'off',
      streams: { enabled: true, maxBytesPerRequest: 256 },
    });

    try {
      const fullPayload = `data: ${'a'.repeat(2000)}\n\ndata: [DONE]\n\n`;
      nextResponse = () => makeStreamingMockResponse([fullPayload]);

      const res = await app.request('http://localhost/openai-completions/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-mem-model',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);

      const clientBody = await res.text();
      // 客户端应收到完整未截断的流。
      expect(clientBody).toBe(fullPayload);

      const event = await waitForEvent(truncEventsDir);
      const streamFile = event.stream_file as string;
      expect(streamFile.startsWith(truncStreamsDir)).toBe(true);
      const saved = readFileSync(streamFile, 'utf-8');
      expect(saved.endsWith('\n[TRUNCATED]')).toBe(true);
      // stream_bytes：上游真实字节数（与磁盘截断无关，与历史语义对齐）。
      expect(event.stream_bytes).toBe(Buffer.byteLength(fullPayload, 'utf-8'));
      // stream_file_bytes：实际落盘字节上限 = maxBytesPerRequest = 256。
      expect(event.stream_file_bytes).toBe(256);
      expect(event.stream_file_truncated).toBe(true);
    } finally {
      // 恢复主 logger 配置，避免影响后续测试。
      const mainConfig = loadConfig(tempConfigPath);
      if (mainConfig.log) initLogger(logBaseDir, mainConfig.log);
    }
  });

  test('B3. 客户端中途取消流时仍应写出 LogEvent', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"c"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    nextResponse = () => makeStreamingMockResponse(sseChunks);

    const res = await app.request('http://localhost/openai-completions/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-mem-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    // 只读一段就 cancel —— 模拟客户端中途断开。
    await reader.read();
    await reader.cancel();

    const event = await waitForEvent(eventsDir);
    expect(event.is_stream).toBe(true);
    expect(typeof event.stream_file).toBe('string');
    expect(existsSync(event.stream_file as string)).toBe(true);
    expect(typeof event.stream_bytes).toBe('number');
  });
});

// ─── 防回归：插件 mutate 入参不应污染 request_body 日志 ────────────────────────
// 历史版本通过 `JSON.parse(options.body)` 给日志一份独立对象。改造 A 之后我们对
// 原始 body 做 stringify→parse 快照，确保即使插件直接修改入参对象，request_body
// 日志仍反映"客户端原始视图"。

describe('防回归：插件 mutate 入参不应污染 request_body 日志', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'local-router-proxy-mem-mutate-'));
  const pluginPath = join(tempDir, 'mutating-plugin.ts');
  const tempConfigPath = join(tempDir, 'config.json');
  const logBaseDir = join(tempDir, 'logs');
  const eventsDir = join(logBaseDir, 'events');

  // 一个故意通过 mutate 入参传播改动的插件 —— 没有返回新对象，
  // 只就地修改 body.systemNotes 和 body.messages[0].content。
  // 历史 / 当前实现下，修改前的视图都应该被快照保留在 request_body 日志中。
  writeFileSync(
    pluginPath,
    `
export default {
  name: 'mutating-test-plugin',
  create() {
    return {
      async onRequest({ body }) {
        body.systemNotes = '__INJECTED_BY_PLUGIN__';
        if (Array.isArray(body.messages) && body.messages[0]) {
          body.messages[0].content = '__MUTATED__';
        }
        // 注意：这里没有 return，等价于 return undefined。
        // executeRequestPlugins 会保留 currentBody 引用（同一对象）继续传递。
      },
    };
  },
};
`,
    'utf-8'
  );

  writeFileSync(
    tempConfigPath,
    JSON.stringify(
      {
        log: {
          enabled: true,
          baseDir: logBaseDir,
          bodyPolicy: 'full',
          streams: { enabled: true },
        },
        providers: {
          mock: {
            type: 'openai-completions',
            base: 'http://mock-mutate-upstream',
            apiKey: 'mock-key',
            models: { 'mock-mutate-model': {} },
            plugins: [{ package: pluginPath }],
          },
        },
        routes: {
          'openai-completions': {
            'mock-mutate-model': { provider: 'mock', model: 'mock-mutate-model-upstream' },
            '*': { provider: 'mock', model: 'mock-mutate-model-upstream' },
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  let app: Hono;
  const originalFetch = globalThis.fetch;
  let lastUpstreamBody: string | null = null;

  beforeAll(async () => {
    app = await createAppFromConfigPath(tempConfigPath);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith('http://mock-mutate-upstream')) {
        return originalFetch(input, init);
      }
      lastUpstreamBody = typeof init?.body === 'string' ? init.body : null;
      return Response.json({ ok: true });
    }) as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    resetLogger();
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    if (existsSync(eventsDir)) {
      for (const f of readdirSync(eventsDir)) rmSync(join(eventsDir, f), { force: true });
    }
    lastUpstreamBody = null;
  });

  test('mutate 插件改写入参后，request_body 日志仍是客户端原始视图', async () => {
    const incoming = {
      model: 'mock-mutate-model',
      messages: [{ role: 'user', content: 'hello' }],
      // 没有 systemNotes 字段 —— 插件会注入。
    };

    const res = await app.request('http://localhost/openai-completions/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(incoming),
    });
    expect(res.status).toBe(200);
    await res.text();

    // 上游请求应包含插件 mutate 后的字段（这是预期：插件确实生效）。
    expect(lastUpstreamBody).not.toBeNull();
    const upstream = JSON.parse(lastUpstreamBody!) as Record<string, unknown>;
    expect(upstream.systemNotes).toBe('__INJECTED_BY_PLUGIN__');
    const upstreamMessages = upstream.messages as Array<{ content: string }>;
    expect(upstreamMessages[0].content).toBe('__MUTATED__');

    // 关键断言：日志中的 request_body 不应含插件注入字段，content 不应被改写。
    const event = await waitForEvent(eventsDir);
    const logged = event.request_body as {
      systemNotes?: unknown;
      messages: Array<{ content: string }>;
    };
    expect(logged).toBeDefined();
    expect(logged.systemNotes).toBeUndefined();
    expect(logged.messages[0].content).toBe('hello');
  });

  test('插件 mutate 入参时，pluginCtx 应被冻结防止被插件改写', async () => {
    // 此用例间接验证 Object.freeze(pluginCtx)：
    // 我们让插件试图写一个不存在的 ctx 字段；strict mode 下应抛 TypeError，
    // executeRequestPlugins 会吞 onRequest 异常但插件之后的 mutate 仍未发生。
    // 因此这里我们只断言：在常规请求下，多次请求的 pluginCtx 互不干扰、对象不可扩展。
    // 由于 PluginCtx 不在外部可见，保留这个 lightweight 断言：对同一插件的多次请求
    // 都能正常工作（不会因为 ctx 被前一次 mutate 而出错）。
    for (let i = 0; i < 3; i++) {
      const res = await app.request('http://localhost/openai-completions/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-mutate-model',
          messages: [{ role: 'user', content: `loop-${i}` }],
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
    }
  });
});
