import type { Context } from 'hono';
import type { ConfigStore } from '../config-store';
import type { LogMeta } from '../logger';
import { maskHeaders } from '../logger';
import type { AuthType } from '../proxy';
import { proxyRequest } from '../proxy';
import type { RouteTarget } from '../config';

export interface ModelRoutingOptions {
  routeType: string;
  store: ConfigStore;
  authType: AuthType;
  buildTargetUrl: (providerBase: string) => string;
}

function resolveRoute(
  modelMap: Record<string, RouteTarget>,
  incomingModel: string
): { target: RouteTarget; ruleKey: string } | undefined {
  if (modelMap[incomingModel]) {
    return { target: modelMap[incomingModel], ruleKey: incomingModel };
  }
  if (modelMap['*']) {
    return { target: modelMap['*'], ruleKey: '*' };
  }
  return undefined;
}

/**
 * 通用模型路由 handler 工厂。
 *
 * 每次请求时从 ConfigStore 动态读取最新配置，
 * 支持热重载而不影响已进入 proxyRequest 的 in-flight 请求。
 */
export function createModelRoutingHandler(options: ModelRoutingOptions) {
  const { routeType, store, authType, buildTargetUrl } = options;

  return async (c: Context) => {
    const config = store.get();

    const modelMap = config.routes[routeType];
    if (!modelMap) {
      return c.json({ error: `协议 "${routeType}" 未在当前配置中启用` }, 404);
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }

    const incomingModel = typeof payload.model === 'string' ? payload.model : '';
    const resolved = resolveRoute(modelMap, incomingModel);
    if (!resolved) {
      return c.json({ error: `未找到模型 "${incomingModel}" 的路由规则` }, 404);
    }

    const { target, ruleKey } = resolved;
    const provider = config.providers[target.provider];
    if (!provider) {
      return c.json({ error: `provider "${target.provider}" 未在配置中定义` }, 500);
    }

    payload.model = target.model;
    const body = JSON.stringify(payload);
    const targetUrl = buildTargetUrl(provider.base);

    const logMeta: LogMeta = {
      requestId: crypto.randomUUID(),
      tsStart: Date.now(),
      routeType,
      routeRuleKey: ruleKey,
      provider: target.provider,
      modelIn: incomingModel,
      modelOut: target.model,
      isStream: payload.stream === true,
      method: c.req.method,
      path: c.req.path,
      contentTypeReq: c.req.header('content-type') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      requestBytes: Buffer.byteLength(body, 'utf-8'),
      requestHeadersMasked: maskHeaders(c.req.raw.headers),
    };

    return proxyRequest(c, {
      targetUrl,
      apiKey: provider.apiKey,
      authType,
      body,
      logMeta,
    });
  };
}
