import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createAppFromConfigPath } from '../../src/index';

describe('Provider 级代理转发', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'local-router-provider-proxy-'));
  const tempConfigPath = join(tempDir, 'config.json');

  writeFileSync(
    tempConfigPath,
    JSON.stringify(
      {
        providers: {
          proxied: {
            type: 'openai-completions',
            base: 'http://mock-upstream-proxied',
            apiKey: 'mock-key',
            proxy: 'http://127.0.0.1:7890',
            models: { 'proxied-model-upstream': {} },
          },
          direct: {
            type: 'openai-completions',
            base: 'http://mock-upstream-direct',
            apiKey: 'mock-key',
            proxy: '',
            models: { 'direct-model-upstream': {} },
          },
          directWithoutField: {
            type: 'openai-completions',
            base: 'http://mock-upstream-direct-2',
            apiKey: 'mock-key',
            models: { 'direct-model-upstream-2': {} },
          },
        },
        routes: {
          'openai-completions': {
            'use-proxy': { provider: 'proxied', model: 'proxied-model-upstream' },
            'no-proxy-empty': { provider: 'direct', model: 'direct-model-upstream' },
            'no-proxy-undefined': {
              provider: 'directWithoutField',
              model: 'direct-model-upstream-2',
            },
            '*': { provider: 'direct', model: 'direct-model-upstream' },
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
  const capturedCalls: Array<{ url: string; proxy: unknown }> = [];

  beforeAll(async () => {
    app = await createAppFromConfigPath(tempConfigPath);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const proxy = (init as RequestInit & { proxy?: unknown } | undefined)?.proxy;
      capturedCalls.push({ url, proxy });

      return Response.json({ ok: true, url });
    }) as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('命中带 proxy 的 provider 时应透传 fetch.proxy', async () => {
    const res = await app.request('http://localhost/openai-completions/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'use-proxy',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.ok).toBe(true);
    const last = capturedCalls.at(-1);
    expect(last?.url).toBe('http://mock-upstream-proxied/v1/chat/completions');
    expect(last?.proxy).toBe('http://127.0.0.1:7890');
  });

  test('proxy 为空字符串或未配置时不应传 fetch.proxy', async () => {
    const res1 = await app.request('http://localhost/openai-completions/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'no-proxy-empty',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(res1.ok).toBe(true);
    const last1 = capturedCalls.at(-1);
    expect(last1?.url).toBe('http://mock-upstream-direct/v1/chat/completions');
    expect(last1?.proxy).toBeUndefined();

    const res2 = await app.request('http://localhost/openai-completions/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'no-proxy-undefined',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(res2.ok).toBe(true);
    const last2 = capturedCalls.at(-1);
    expect(last2?.url).toBe('http://mock-upstream-direct-2/v1/chat/completions');
    expect(last2?.proxy).toBeUndefined();
  });
});
