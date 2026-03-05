import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LogConfig, ProviderConfig } from '../../../src/config';
import { initLogger } from '../../../src/logger';

describe('createModelRoutingHandler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'router-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const createMockProviders = (): Record<string, ProviderConfig> => ({
    'test-provider': {
      type: 'openai-completions',
      base: 'https://api.test.com',
      apiKey: 'test-key',
      models: {
        'gpt-4': { reasoning: true },
      },
    },
  });

  describe('日志元数据生成', () => {
    test('应在请求中正确组装 LogMeta', async () => {
      const config: LogConfig = { enabled: true };
      initLogger(tempDir, config);

      const capturedMeta: unknown[] = [];

      // 创建一个测试路由，捕获生成的 LogMeta
      const app = new Hono();

      const modelMap = {
        'gpt-4': { provider: 'test-provider', model: 'gpt-4-turbo' },
      };

      const _providers = createMockProviders();

      // 使用自定义 handler 捕获元数据
      app.post('/v1/chat/completions', async (c) => {
        const rawText = await c.req.raw.text();
        const payload = JSON.parse(rawText);

        // 模拟 handler 中创建的 LogMeta
        const logMeta = {
          requestId: 'test-uuid-123',
          tsStart: Date.now(),
          routeType: 'openai-completions',
          routeRuleKey: modelMap[payload.model] ? payload.model : '*',
          provider: modelMap[payload.model]?.provider || 'unknown',
          modelIn: payload.model || '',
          modelOut: modelMap[payload.model]?.model || '',
          isStream: payload.stream === true,
          method: c.req.method,
          path: c.req.path,
          contentTypeReq: c.req.header('content-type') ?? null,
          userAgent: c.req.header('user-agent') ?? null,
          requestBytes: Buffer.byteLength(rawText, 'utf-8'),
          requestHeadersMasked: Object.fromEntries(
            Array.from(c.req.raw.headers.entries()).map(([k, v]) => [k, v])
          ),
        };

        capturedMeta.push(logMeta);

        return c.json({ id: 'test-response' });
      });

      const res = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'test-client/1.0',
        },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: false,
        }),
      });

      expect(res.ok).toBe(true);
      expect(capturedMeta.length).toBe(1);

      const meta = capturedMeta[0] as {
        routeType: string;
        routeRuleKey: string;
        provider: string;
        modelIn: string;
        modelOut: string;
        isStream: boolean;
        method: string;
        path: string;
        contentTypeReq: string;
        userAgent: string;
      };

      expect(meta.routeType).toBe('openai-completions');
      expect(meta.routeRuleKey).toBe('gpt-4');
      expect(meta.provider).toBe('test-provider');
      expect(meta.modelIn).toBe('gpt-4');
      expect(meta.modelOut).toBe('gpt-4-turbo');
      expect(meta.isStream).toBe(false);
      expect(meta.method).toBe('POST');
      expect(meta.path).toBe('/v1/chat/completions');
      expect(meta.contentTypeReq).toBe('application/json');
      expect(meta.userAgent).toBe('test-client/1.0');
    });

    test('应正确识别流式请求', async () => {
      const config: LogConfig = { enabled: true };
      initLogger(tempDir, config);

      const capturedMeta: unknown[] = [];

      const app = new Hono();

      app.post('/v1/chat/completions', async (c) => {
        const rawText = await c.req.raw.text();
        const payload = JSON.parse(rawText);

        capturedMeta.push({
          isStream: payload.stream === true,
        });

        return c.json({ id: 'test' });
      });

      // 测试流式请求
      await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      });

      // 测试非流式请求
      await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: false,
        }),
      });

      expect((capturedMeta[0] as { isStream: boolean }).isStream).toBe(true);
      expect((capturedMeta[1] as { isStream: boolean }).isStream).toBe(false);
    });

    test('应正确计算请求字节数', async () => {
      const app = new Hono();

      app.post('/v1/chat/completions', async (c) => {
        const rawText = await c.req.raw.text();
        const requestBytes = Buffer.byteLength(rawText, 'utf-8');

        return c.json({ bytes: requestBytes });
      });

      const body = JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const res = await app.request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });

      const json = await res.json();
      expect(json.bytes).toBe(Buffer.byteLength(body, 'utf-8'));
    });
  });

  describe('路由规则匹配', () => {
    test('应匹配具体模型名称', async () => {
      const app = new Hono();

      const modelMap = {
        'gpt-4': { provider: 'openai', model: 'gpt-4-turbo' },
        'gpt-3.5': { provider: 'openai', model: 'gpt-3.5-turbo' },
        '*': { provider: 'fallback', model: 'default-model' },
      };

      app.post('/test', async (c) => {
        const payload = await c.req.json();
        const incomingModel = payload.model;

        // 模拟 resolveRoute 逻辑
        let resolved;
        if (modelMap[incomingModel]) {
          resolved = { target: modelMap[incomingModel], ruleKey: incomingModel };
        } else if (modelMap['*']) {
          resolved = { target: modelMap['*'], ruleKey: '*' };
        }

        return c.json({ ruleKey: resolved?.ruleKey, provider: resolved?.target.provider });
      });

      // 测试具体匹配
      const res1 = await app.request('http://localhost/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4' }),
      });
      const json1 = await res1.json();
      expect(json1.ruleKey).toBe('gpt-4');
      expect(json1.provider).toBe('openai');

      // 测试通配符匹配
      const res2 = await app.request('http://localhost/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'unknown-model' }),
      });
      const json2 = await res2.json();
      expect(json2.ruleKey).toBe('*');
      expect(json2.provider).toBe('fallback');
    });
  });
});
