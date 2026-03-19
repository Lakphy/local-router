import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import { swaggerUI } from '@hono/swagger-ui';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import type { AppConfig, RouteTarget } from './config';
import { parseConfigPath, resolveLogBaseDir } from './config';
import { ConfigStore } from './config-store';
import { CryptoSession } from './crypto';
import { getLogMetrics, isLogMetricsWindow } from './log-metrics';
import {
  exportLogEvents,
  getLogEventDetailById,
  isLogQueryWindow,
  parseBooleanFlag,
  parseCommaSeparated,
  queryLogEvents,
  resolveLogQueryRange,
  validateLogLevel,
  validateSort,
  validateStatusClass,
} from './log-query';
import { queryLogSessions } from './log-sessions';
import { getLogStorageInfo, startLogStorageBackgroundTask } from './log-storage';
import { initLogger, resetLogger } from './logger';
import { openAPISpec } from './openapi';
import type { Plugin, PluginContext } from './plugin';
import { executeRequestPlugins } from './plugin-engine';
import { PluginManager } from './plugin-loader';
import { createAnthropicMessagesRoutes } from './routes/anthropic-messages';
import { createOpenaiCompletionsRoutes } from './routes/openai-completions';
import { createOpenaiResponsesRoutes } from './routes/openai-responses';
import { getBundledSchemaPath, getBundledWebRoot } from './runtime-assets';
import { validateConfigOrThrow } from './config-validate';

type CleanupFn = () => void;

export interface AppRuntime {
  app: Hono;
  dispose: () => void;
}

const ROUTE_REGISTRY: Record<
  string,
  {
    mountPrefix: string;
    localPath: string;
    authHint: string;
    requiredFields: string[];
    samplePayload: Record<string, unknown>;
    create: (routeType: string, store: ConfigStore, pluginManager?: PluginManager) => Hono;
  }
> = {
  'openai-completions': {
    mountPrefix: '/openai-completions',
    localPath: '/v1/chat/completions',
    authHint: '无需客户端鉴权头（local-router 自动使用 provider.apiKey 转发）',
    requiredFields: ['model', 'messages'],
    samplePayload: {
      model: 'your-model-alias-or-name',
      messages: [{ role: 'user', content: '请回复 ok' }],
      stream: false,
    },
    create: createOpenaiCompletionsRoutes,
  },
  'openai-responses': {
    mountPrefix: '/openai-responses',
    localPath: '/v1/responses',
    authHint: '无需客户端鉴权头（local-router 自动使用 provider.apiKey 转发）',
    requiredFields: ['model', 'input'],
    samplePayload: {
      model: 'your-model-alias-or-name',
      input: '请回复 ok',
      stream: false,
    },
    create: createOpenaiResponsesRoutes,
  },
  'anthropic-messages': {
    mountPrefix: '/anthropic-messages',
    localPath: '/v1/messages',
    authHint: '无需客户端 x-api-key（local-router 自动使用 provider.apiKey 转发）',
    requiredFields: ['model', 'messages', 'max_tokens'],
    samplePayload: {
      model: 'sonnet',
      max_tokens: 64,
      messages: [{ role: 'user', content: '请回复 ok' }],
    },
    create: createAnthropicMessagesRoutes,
  },
};

function printIntegrationGuide(config: { routes: Record<string, Record<string, RouteTarget>> }) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = process.env.PORT ?? '4099';
  const baseUrl = `http://${host}:${port}`;

  console.log('\n================ local-router 接入指南 ================');
  console.log(`本地服务地址: ${baseUrl}`);
  console.log('健康检查: GET /');
  console.log(`API 文档: ${baseUrl}/api/docs`);
  console.log(`管理面板: ${baseUrl}/admin`);
  console.log('说明: 客户端请求 local-router 时不需要上游 API Key。');

  for (const [routeType, modelMap] of Object.entries(config.routes)) {
    const entry = ROUTE_REGISTRY[routeType];
    if (!entry) continue;

    const endpoint = `${entry.mountPrefix}${entry.localPath}`;
    const sampleBody = JSON.stringify(entry.samplePayload, null, 2);
    const modelRules = Object.entries(modelMap)
      .map(
        ([incoming, target]) => `${incoming} -> provider:${target.provider}, model:${target.model}`
      )
      .join(' | ');

    console.log(`\n[${routeType}]`);
    console.log(`- 本地入口: POST ${endpoint}`);
    console.log(`- 请求头: Content-Type: application/json`);
    console.log(`- 鉴权: ${entry.authHint}`);
    console.log(`- 必填字段: ${entry.requiredFields.join(', ')}`);
    console.log(`- 模型路由: ${modelRules}`);
    console.log(`- 最小请求体示例:\n${sampleBody}`);
    console.log(`- curl 示例:`);
    console.log(
      `  curl -X POST "${baseUrl}${endpoint}" -H "Content-Type: application/json" -d '${JSON.stringify(
        entry.samplePayload
      )}'`
    );
  }

  console.log('=======================================================\n');
}

interface ChatProxyMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatProxyRequestBody {
  provider: string;
  model: string;
  messages: ChatProxyMessage[];
  maxOutputTokens?: number;
}

function isChatProxyMessage(value: unknown): value is ChatProxyMessage {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.role === 'system' || candidate.role === 'user' || candidate.role === 'assistant') &&
    typeof candidate.content === 'string'
  );
}

function createUpstreamFetch(proxy?: string): typeof fetch | undefined {
  const proxyUrl = proxy?.trim();
  if (!proxyUrl) return undefined;

  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, {
      ...init,
      proxy: proxyUrl,
      decompress: true,
    })) as typeof fetch;
}

/**
 * 创建一个 fetch 包装，在实际发送请求前执行插件的 onRequest 钩子。
 * 用于 chat proxy 场景，让 AI SDK 的请求也能经过插件管线。
 */
function createPluginFetch(
  plugins: Plugin[],
  providerName: string,
  model: string,
  proxy?: string
): typeof fetch {
  const proxyUrl = proxy?.trim() || undefined;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    let bodyStr = typeof init?.body === 'string' ? init.body : '';
    let bodyObj: Record<string, unknown> = {};
    try {
      bodyObj = JSON.parse(bodyStr) as Record<string, unknown>;
    } catch {
      // non-JSON body, skip plugin processing
    }

    const ctx: PluginContext = {
      requestId: crypto.randomUUID(),
      provider: providerName,
      modelIn: model,
      modelOut: model,
      routeType: 'chat-proxy',
      isStream: bodyObj.stream === true,
    };

    const result = await executeRequestPlugins(plugins, ctx, url, headers, bodyObj);

    return fetch(result.url, {
      ...init,
      headers: result.headers,
      body: JSON.stringify(result.body),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
      decompress: true,
    });
  }) as typeof fetch;
}

function normalizeChatProxyBaseUrl(
  providerType: AppConfig['providers'][string]['type'],
  base: string
): string {
  const normalized = base.replace(/\/+$/, '');

  // AI SDK 各 provider 默认拼接路径：
  //   Anthropic: `${baseURL}/messages`  → 需要 baseURL 以 /v1 结尾
  //   OpenAI:    `${baseURL}/chat/completions` → 需要 baseURL 以 /v1 结尾
  // local-router 配置里 base 通常是上游根前缀（不含 /v1），这里做兼容补齐。
  if (!normalized.endsWith('/v1')) {
    return `${normalized}/v1`;
  }

  return normalized;
}

function createChatProxyModel(
  providerName: string,
  providerConfig: AppConfig['providers'][string],
  model: string,
  customFetch?: typeof fetch
) {
  const common = {
    apiKey: providerConfig.apiKey,
    baseURL: normalizeChatProxyBaseUrl(providerConfig.type, providerConfig.base),
    name: `chat-proxy.${providerName}`,
    fetch: customFetch,
  };

  switch (providerConfig.type) {
    case 'openai-completions':
      return createOpenAICompatible(common)(model);
    case 'openai-responses':
      return createOpenAI(common).responses(model);
    case 'anthropic-messages':
      return createAnthropic(common).messages(model);
    default:
      throw new Error(`暂不支持的 provider 类型: ${providerConfig.type}`);
  }
}

// 管理面板配置 API
function createAdminApiRoutes(store: ConfigStore, pluginManager: PluginManager, registerCleanup?: (cleanup: CleanupFn) => void): Hono {
  const api = new Hono();
  const cryptoSessions = new Map<string, { session: CryptoSession; createdAt: number }>();
  const CRYPTO_SESSION_TTL_MS = 2 * 60 * 1000;
  const CRYPTO_SESSION_MAX = 512;
  const schemaPath = getBundledSchemaPath();
  const schemaJson = JSON.parse(readFileSync(schemaPath, 'utf-8')) as Record<string, unknown>;

  const pruneExpiredCryptoSessions = (now = Date.now()) => {
    for (const [id, record] of Array.from(cryptoSessions.entries())) {
      if (now - record.createdAt > CRYPTO_SESSION_TTL_MS) {
        record.session.dispose();
        cryptoSessions.delete(id);
      }
    }
  };

  const consumeSession = (c: Context): CryptoSession | null => {
    const sessionId = c.req.header('x-crypto-session');
    if (!sessionId) return null;
    const record = cryptoSessions.get(sessionId);
    if (!record) return null;

    cryptoSessions.delete(sessionId);
    if (Date.now() - record.createdAt > CRYPTO_SESSION_TTL_MS) {
      record.session.dispose();
      return null;
    }

    return record.session;
  };

  const sessionSweepTimer = setInterval(() => {
    pruneExpiredCryptoSessions();
  }, Math.max(5_000, Math.floor(CRYPTO_SESSION_TTL_MS / 2)));
  sessionSweepTimer.unref?.();
  registerCleanup?.(() => {
    clearInterval(sessionSweepTimer);
    for (const { session } of Array.from(cryptoSessions.values())) {
      session.dispose();
    }
    cryptoSessions.clear();
  });

  api.get('/health', (c) => c.json({ status: 'ok', service: 'local-router' }));

  // --- 加密握手 ---
  api.post('/crypto/handshake', async (c) => {
    pruneExpiredCryptoSessions();
    if (cryptoSessions.size >= CRYPTO_SESSION_MAX) {
      return c.json({ error: '加密会话已达上限，请稍后重试' }, 503);
    }

    const body = await c.req.json<{ clientPublicKey: string }>();
    if (!body.clientPublicKey) {
      return c.json({ error: '缺少 clientPublicKey' }, 400);
    }

    const session = new CryptoSession();
    try {
      const serverPublicKey = await session.init();
      await session.deriveKey(body.clientPublicKey);
      const sessionId = crypto.randomUUID();
      cryptoSessions.set(sessionId, { session, createdAt: Date.now() });
      return c.json({ serverPublicKey, sessionId });
    } catch (err) {
      session.dispose();
      return c.json({ error: `握手失败: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
  });

  // --- 配置 CRUD ---
  api.get('/config', async (c) => {
    const session = consumeSession(c);
    if (!session) {
      return c.json({ error: '未建立加密会话，请先调用 /api/crypto/handshake' }, 401);
    }

    try {
      const config = store.get();
      const encrypted = await session.encrypt(JSON.stringify(config));
      return c.json(encrypted);
    } finally {
      session.dispose();
    }
  });

  api.put('/config', async (c) => {
    const session = consumeSession(c);
    if (!session) {
      return c.json({ error: '未建立加密会话，请先调用 /api/crypto/handshake' }, 401);
    }

    try {
      const encryptedBody = await c.req.json<{ iv: string; data: string }>();
      let configJson: string;
      try {
        configJson = await session.decrypt(encryptedBody);
      } catch {
        return c.json({ error: '解密失败' }, 400);
      }

      let newConfig: unknown;
      try {
        newConfig = JSON.parse(configJson);
      } catch {
        return c.json({ error: '解密后的数据不是合法 JSON' }, 400);
      }
      const candidate = newConfig as AppConfig;

      try {
        store.validate(candidate);
      } catch (err) {
        return c.json({ error: `配置校验失败: ${err instanceof Error ? err.message : err}` }, 400);
      }

      try {
        validateConfigOrThrow(candidate);
      } catch (err) {
        return c.json({ error: `配置校验失败: ${err instanceof Error ? err.message : err}` }, 400);
      }

      store.save(candidate);
      return c.json({ ok: true });
    } finally {
      session.dispose();
    }
  });

  api.post('/config/apply', async (_c) => {
    try {
      const config = store.reload();
      if (config.log) {
        const logBaseDir = resolveLogBaseDir(config.log);
        initLogger(logBaseDir, config.log);
      }
      const pluginResult = await pluginManager.reloadAll(config.providers);
      return _c.json({
        ok: true,
        summary: {
          providers: Object.keys(config.providers).length,
          routes: Object.keys(config.routes).length,
        },
        ...(pluginResult.failures.length > 0 && {
          pluginWarnings: pluginResult.failures,
        }),
      });
    } catch (err) {
      return _c.json({ error: `应用配置失败: ${err instanceof Error ? err.message : err}` }, 500);
    }
  });

  api.get('/config/meta', (c) => {
    return c.json({
      configPath: store.getPath(),
      routeTypes: Object.keys(ROUTE_REGISTRY),
    });
  });

  api.get('/config/schema', (c) => {
    try {
      return c.json(schemaJson);
    } catch (err) {
      return c.json(
        { error: `读取配置 schema 失败: ${err instanceof Error ? err.message : err}` },
        500
      );
    }
  });

  api.post('/chat/proxy', async (c) => {
    let body: ChatProxyRequestBody;
    try {
      body = await c.req.json<ChatProxyRequestBody>();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }

    if (!body || typeof body.provider !== 'string' || typeof body.model !== 'string') {
      return c.json({ error: 'provider 和 model 为必填字段' }, 400);
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0 || !body.messages.every(isChatProxyMessage)) {
      return c.json({ error: 'messages 必须是非空消息数组' }, 400);
    }

    if (
      body.maxOutputTokens !== undefined &&
      (!Number.isInteger(body.maxOutputTokens) || body.maxOutputTokens <= 0)
    ) {
      return c.json({ error: 'maxOutputTokens 必须是正整数' }, 400);
    }

    const config = store.get();
    const providerConfig = config.providers[body.provider];
    if (!providerConfig) {
      return c.json({ error: `provider "${body.provider}" 未在配置中定义` }, 404);
    }

    if (!providerConfig.base.trim() || !providerConfig.apiKey.trim()) {
      return c.json({ error: `provider "${body.provider}" 缺少 base 或 apiKey` }, 400);
    }

    try {
      const plugins = pluginManager.getPlugins(body.provider);
      const pluginFetch = plugins.length > 0
        ? createPluginFetch(plugins, body.provider, body.model, providerConfig.proxy)
        : createUpstreamFetch(providerConfig.proxy);

      const result = streamText({
        model: createChatProxyModel(body.provider, providerConfig, body.model, pluginFetch),
        messages: body.messages,
        ...(body.maxOutputTokens ? { maxOutputTokens: body.maxOutputTokens } : {}),
      });

      return result.toTextStreamResponse({
        headers: {
          'x-chat-provider': body.provider,
          'x-chat-model': body.model,
        },
      });
    } catch (err) {
      return c.json(
        { error: `chat 代理失败: ${err instanceof Error ? err.message : String(err)}` },
        500
      );
    }
  });

  api.get('/metrics/logs', async (c) => {
    const config = store.get();
    const window = c.req.query('window') ?? '24h';
    const refresh = c.req.query('refresh') === '1';

    if (!isLogMetricsWindow(window)) {
      return c.json({ error: 'window 参数仅支持 1h | 6h | 24h' }, 400);
    }

    try {
      const metrics = await getLogMetrics({
        logConfig: config.log,
        window,
        refresh,
      });
      return c.json(metrics);
    } catch (err) {
      return c.json(
        { error: `读取日志统计失败: ${err instanceof Error ? err.message : err}` },
        500
      );
    }
  });

  api.get('/logs/storage', async (c) => {
    const config = store.get();
    const refresh = c.req.query('refresh') === '1';

    try {
      const storage = await getLogStorageInfo({
        logConfig: config.log,
        forceRefresh: refresh,
      });
      return c.json(storage);
    } catch (err) {
      return c.json(
        { error: `读取日志存储统计失败: ${err instanceof Error ? err.message : err}` },
        500
      );
    }
  });

  api.get('/logs/events', async (c) => {
    const config = store.get();

    try {
      const windowRaw = c.req.query('window') ?? '24h';
      if (!isLogQueryWindow(windowRaw)) {
        return c.json({ error: 'window 参数仅支持 1h | 6h | 24h' }, 400);
      }

      const range = resolveLogQueryRange({
        window: windowRaw,
        from: c.req.query('from'),
        to: c.req.query('to'),
      });

      const levelsRaw = parseCommaSeparated(c.req.query('levels'));
      const levels = levelsRaw.filter(validateLogLevel);
      if (levels.length !== levelsRaw.length) {
        return c.json({ error: 'levels 参数仅支持 info,error' }, 400);
      }

      const statusClassesRaw = parseCommaSeparated(c.req.query('statusClass'));
      const statusClasses = statusClassesRaw.filter(validateStatusClass);
      if (statusClasses.length !== statusClassesRaw.length) {
        return c.json({ error: 'statusClass 参数仅支持 2xx,4xx,5xx,network_error' }, 400);
      }

      const sortRaw = c.req.query('sort') ?? 'time_desc';
      if (!validateSort(sortRaw)) {
        return c.json({ error: 'sort 参数仅支持 time_desc | time_asc' }, 400);
      }

      const hasError = parseBooleanFlag(c.req.query('hasError'));
      const limitRaw = c.req.query('limit');
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

      const data = await queryLogEvents(
        { logConfig: config.log },
        {
          ...range,
          levels,
          providers: parseCommaSeparated(c.req.query('provider')),
          routeTypes: parseCommaSeparated(c.req.query('routeType')),
          models: parseCommaSeparated(c.req.query('model')),
          modelIns: parseCommaSeparated(c.req.query('modelIn')),
          modelOuts: parseCommaSeparated(c.req.query('modelOut')),
          users: parseCommaSeparated(c.req.query('user')),
          sessions: parseCommaSeparated(c.req.query('session')),
          statusClasses,
          hasError,
          q: c.req.query('q') ?? '',
          sort: sortRaw,
          limit,
          cursor: c.req.query('cursor') ?? null,
        }
      );

      return c.json(data);
    } catch (err) {
      return c.json(
        { error: `日志查询失败: ${err instanceof Error ? err.message : String(err)}` },
        400
      );
    }
  });

  api.get('/logs/sessions', async (c) => {
    const config = store.get();

    try {
      const windowRaw = c.req.query('window') ?? '24h';
      if (!isLogQueryWindow(windowRaw)) {
        return c.json({ error: 'window 参数仅支持 1h | 6h | 24h' }, 400);
      }

      const range = resolveLogQueryRange({
        window: windowRaw,
        from: c.req.query('from'),
        to: c.req.query('to'),
      });

      const data = await queryLogSessions(
        { logConfig: config.log },
        {
          ...range,
          users: parseCommaSeparated(c.req.query('user')),
          sessions: parseCommaSeparated(c.req.query('session')),
          q: c.req.query('q') ?? '',
        }
      );

      return c.json(data);
    } catch (err) {
      return c.json(
        { error: `用户会话查询失败: ${err instanceof Error ? err.message : String(err)}` },
        400
      );
    }
  });

  api.get('/logs/events/:id', async (c) => {
    const config = store.get();

    try {
      const detail = await getLogEventDetailById({ logConfig: config.log }, c.req.param('id'));
      if (!detail) {
        return c.json({ error: '日志事件不存在' }, 404);
      }
      return c.json(detail);
    } catch (err) {
      return c.json(
        { error: `读取日志详情失败: ${err instanceof Error ? err.message : String(err)}` },
        400
      );
    }
  });

  api.get('/logs/export', async (c) => {
    const config = store.get();
    const format = (c.req.query('format') ?? 'json').toLowerCase();
    if (format !== 'csv' && format !== 'json') {
      return c.json({ error: 'format 参数仅支持 csv | json' }, 400);
    }

    try {
      const windowRaw = c.req.query('window') ?? '24h';
      if (!isLogQueryWindow(windowRaw)) {
        return c.json({ error: 'window 参数仅支持 1h | 6h | 24h' }, 400);
      }

      const range = resolveLogQueryRange({
        window: windowRaw,
        from: c.req.query('from'),
        to: c.req.query('to'),
      });

      const levelsRaw = parseCommaSeparated(c.req.query('levels'));
      const levels = levelsRaw.filter(validateLogLevel);
      if (levels.length !== levelsRaw.length) {
        return c.json({ error: 'levels 参数仅支持 info,error' }, 400);
      }

      const statusClassesRaw = parseCommaSeparated(c.req.query('statusClass'));
      const statusClasses = statusClassesRaw.filter(validateStatusClass);
      if (statusClasses.length !== statusClassesRaw.length) {
        return c.json({ error: 'statusClass 参数仅支持 2xx,4xx,5xx,network_error' }, 400);
      }

      const sortRaw = c.req.query('sort') ?? 'time_desc';
      if (!validateSort(sortRaw)) {
        return c.json({ error: 'sort 参数仅支持 time_desc | time_asc' }, 400);
      }

      const hasError = parseBooleanFlag(c.req.query('hasError'));

      const exported = await exportLogEvents(
        { logConfig: config.log },
        {
          ...range,
          levels,
          providers: parseCommaSeparated(c.req.query('provider')),
          routeTypes: parseCommaSeparated(c.req.query('routeType')),
          models: parseCommaSeparated(c.req.query('model')),
          modelIns: parseCommaSeparated(c.req.query('modelIn')),
          modelOuts: parseCommaSeparated(c.req.query('modelOut')),
          users: parseCommaSeparated(c.req.query('user')),
          sessions: parseCommaSeparated(c.req.query('session')),
          statusClasses,
          hasError,
          q: c.req.query('q') ?? '',
          sort: sortRaw,
        },
        format
      );

      c.header('Content-Type', exported.contentType);
      c.header('Content-Disposition', `attachment; filename="${exported.filename}"`);
      c.header('X-Exported-Count', String(exported.exported));
      c.header('X-Total-Count', String(exported.total));
      return c.body(exported.body);
    } catch (err) {
      return c.json(
        { error: `导出日志失败: ${err instanceof Error ? err.message : String(err)}` },
        400
      );
    }
  });

  api.get('/logs/tail', async (c) => {
    const config = store.get();
    const target = c.req.raw;

    const windowRaw = c.req.query('window') ?? '1h';
    if (!isLogQueryWindow(windowRaw)) {
      return c.json({ error: 'window 参数仅支持 1h | 6h | 24h' }, 400);
    }

    const sortRaw = c.req.query('sort') ?? 'time_desc';
    if (!validateSort(sortRaw)) {
      return c.json({ error: 'sort 参数仅支持 time_desc | time_asc' }, 400);
    }

    const levelsRaw = parseCommaSeparated(c.req.query('levels'));
    const levels = levelsRaw.filter(validateLogLevel);
    if (levels.length !== levelsRaw.length) {
      return c.json({ error: 'levels 参数仅支持 info,error' }, 400);
    }

    const statusClassesRaw = parseCommaSeparated(c.req.query('statusClass'));
    const statusClasses = statusClassesRaw.filter(validateStatusClass);
    if (statusClasses.length !== statusClassesRaw.length) {
      return c.json({ error: 'statusClass 参数仅支持 2xx,4xx,5xx,network_error' }, 400);
    }

    let hasError: boolean | null = null;
    try {
      hasError = parseBooleanFlag(c.req.query('hasError'));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const encoder = new TextEncoder();
    let closed = false;
    let lastSeenTs = Date.now() - 60 * 1000;

    let closeStream: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let timer: ReturnType<typeof setInterval> | null = null;

        const push = (event: string, payload: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };

        const close = () => {
          if (closed) return;
          closed = true;
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          target.signal.removeEventListener('abort', close);
          try {
            controller.close();
          } catch {
            // ignore close-after-closed
          }
        };
        closeStream = close;

        push('ready', { ok: true, now: new Date().toISOString() });

        timer = setInterval(async () => {
          if (closed) return;

          try {
            const toMs = Date.now();
            const data = await queryLogEvents(
              { logConfig: config.log },
              {
                fromMs: Math.max(lastSeenTs, toMs - 60 * 60 * 1000),
                toMs,
                levels,
                providers: parseCommaSeparated(c.req.query('provider')),
                routeTypes: parseCommaSeparated(c.req.query('routeType')),
                models: parseCommaSeparated(c.req.query('model')),
                modelIns: parseCommaSeparated(c.req.query('modelIn')),
                modelOuts: parseCommaSeparated(c.req.query('modelOut')),
                users: parseCommaSeparated(c.req.query('user')),
                sessions: parseCommaSeparated(c.req.query('session')),
                statusClasses,
                hasError,
                q: c.req.query('q') ?? '',
                sort: sortRaw,
                limit: 100,
              }
            );

            if (closed) return;

            if (data.items.length > 0) {
              const maxTs = Math.max(...data.items.map((item) => Date.parse(item.ts)).filter(Number.isFinite));
              if (Number.isFinite(maxTs)) {
                lastSeenTs = Math.max(lastSeenTs, maxTs + 1);
              }
              push('events', {
                items: data.items,
                stats: data.stats,
                meta: data.meta,
              });
            } else {
              push('heartbeat', { ts: new Date().toISOString() });
            }
          } catch (err) {
            if (closed) return;
            push('error', { error: err instanceof Error ? err.message : String(err) });
          }
        }, 3000);

        target.signal.addEventListener('abort', close);
      },
      cancel() {
        closeStream?.();
      },
    });

    c.header('Content-Type', 'text/event-stream; charset=utf-8');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    return new Response(stream, {
      status: 200,
      headers: c.res.headers,
    });
  });

  return api;
}

function resolveAdminDevServerOrigin(): string | null {
  const raw = process.env.ADMIN_DEV_SERVER_URL?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    console.warn(`ADMIN_DEV_SERVER_URL 无效，已忽略: ${raw}`);
    return null;
  }
}

function buildProxyRequestHeaders(original: Headers): Headers {
  const headers = new Headers();
  const hopByHopHeaders = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
  ]);

  original.forEach((value, key) => {
    if (hopByHopHeaders.has(key.toLowerCase())) return;
    if (key.toLowerCase() === 'accept-encoding') return;
    headers.set(key, value);
  });
  // 管理面板反向代理同样固定 identity，减少压缩/解压兼容问题。
  headers.set('accept-encoding', 'identity');

  return headers;
}

function buildProxyResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  const hopByHopHeaders = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);
  // 防止上游已解压但仍携带压缩相关头，导致客户端二次解压失败。
  const unsafeEndToEndHeaders = new Set(['content-encoding', 'content-length']);

  upstream.forEach((value, key) => {
    if (hopByHopHeaders.has(key.toLowerCase())) return;
    if (unsafeEndToEndHeaders.has(key.toLowerCase())) return;
    headers.set(key, value);
  });

  return headers;
}

async function proxyAdminToDevServer(c: Context, origin: string): Promise<Response> {
  const reqUrl = new URL(c.req.url);
  const targetUrl = `${origin}${reqUrl.pathname}${reqUrl.search}`;
  const headers = buildProxyRequestHeaders(c.req.raw.headers);
  const method = c.req.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const upstreamRes = await fetch(targetUrl, {
    method,
    headers,
    body: hasBody ? c.req.raw.body : undefined,
    redirect: 'manual',
    decompress: true,
  });

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: buildProxyResponseHeaders(upstreamRes.headers),
  });
}

export async function createApp(
  store: ConfigStore,
  options?: { registerCleanup?: (cleanup: CleanupFn) => void }
): Promise<Hono> {
  const config = store.get();
  console.log(`已加载配置: ${store.getPath()}`);

  if (config.log) {
    const logBaseDir = resolveLogBaseDir(config.log);
    initLogger(logBaseDir, config.log);
  } else {
    // 避免多实例/测试场景下复用到旧 logger 单例。
    resetLogger();
  }

  // 启动日志存储空间后台计算任务
  const stopLogStorageTask = startLogStorageBackgroundTask(config.log);
  options?.registerCleanup?.(stopLogStorageTask);

  // 实例化插件管理器
  const configDir = dirname(resolve(store.getPath()));
  const pluginManager = new PluginManager(configDir);
  const reloadResult = await pluginManager.reloadAll(config.providers);
  if (!reloadResult.ok) {
    console.warn(
      `[plugin] 插件初始化完成，但有 ${reloadResult.failures.length} 个插件加载失败`
    );
  }
  options?.registerCleanup?.(() => {
    pluginManager.disposeAll().catch(() => {});
  });

  printIntegrationGuide(config);

  const app = new Hono();
  app.get('/', (c) => c.text('local-router is running'));

  // 一次性注册所有已知协议类型的路由，handler 会在请求时动态检查配置
  for (const [routeType, entry] of Object.entries(ROUTE_REGISTRY)) {
    const subApp = entry.create(routeType, store, pluginManager);
    app.route(entry.mountPrefix, subApp);
    console.log(`已注册路由: ${routeType} -> ${entry.mountPrefix}`);
  }

  // 管理面板 API
  app.route('/api', createAdminApiRoutes(store, pluginManager, options?.registerCleanup));
  console.log('已注册管理 API: /api');

  // Swagger UI
  app.get('/api/docs', swaggerUI({ url: '/api/openapi.json' }));
  app.get('/api/openapi.json', (c) => c.json(openAPISpec));
  console.log('已注册 API 文档: /api/docs');

  const adminDevServerOrigin = resolveAdminDevServerOrigin();
  if (adminDevServerOrigin) {
    app.all('/admin', (c) => c.redirect('/admin/', 308));
    app.all('/admin/*', (c) => proxyAdminToDevServer(c, adminDevServerOrigin));
    console.log(`已注册管理面板代理: /admin -> ${adminDevServerOrigin}/admin`);
  } else {
    app.all('/admin', (c) => c.redirect('/admin/', 308));
    const bundledWebRoot = getBundledWebRoot();
    const adminStatic = serveStatic({
      root: bundledWebRoot,
      rewriteRequestPath: (path) => path.replace(/^\/admin/, ''),
    });
    const adminIndex = serveStatic({ root: bundledWebRoot, path: './index.html' });

    app.use('/admin/*', adminStatic);
    app.get('/admin/*', async (c, next) => {
      // 静态资源不存在时保持 404，避免把 js/css 请求错误回退到 HTML
      if (c.req.path.startsWith('/admin/assets/') || /\.[^/]+$/.test(c.req.path)) {
        return c.notFound();
      }
      return adminIndex(c, next);
    });
    console.log('已注册管理面板静态文件: /admin');
  }

  return app;
}

export async function createAppFromConfigPath(configPath: string): Promise<Hono> {
  const store = new ConfigStore(configPath);
  return createApp(store);
}

export async function createAppRuntimeFromConfigPath(configPath: string): Promise<AppRuntime> {
  const store = new ConfigStore(configPath);
  const cleanups: CleanupFn[] = [];
  const app = await createApp(store, {
    registerCleanup: (cleanup) => {
      cleanups.push(cleanup);
    },
  });
  return {
    app,
    dispose: () => {
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {
          // ignore cleanup error
        }
      }
    },
  };
}

export async function createDefaultAppFromProcessArgs(): Promise<Hono> {
  const configPath = parseConfigPath();
  const store = new ConfigStore(configPath);
  return createApp(store);
}
