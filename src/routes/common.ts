import type { Context } from 'hono';
import type { RouteTarget } from '../config';
import type { ConfigStore } from '../config-store';
import type { LogMeta } from '../logger';
import { collectHeaders } from '../logger';
import type { PluginManager } from '../plugin-loader';
import type { AuthType } from '../proxy';
import { proxyRequest } from '../proxy';

export interface ModelRoutingOptions {
  routeType: string;
  store: ConfigStore;
  authType: AuthType;
  buildTargetUrl: (providerBase: string) => string;
  pluginManager?: PluginManager;
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
  const { routeType, store, authType, buildTargetUrl, pluginManager } = options;

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
    const targetUrl = buildTargetUrl(provider.base);

    // requestBytes 表达"客户端发来的请求字节数"。优先用客户端 content-length 头，
    // 避免再次序列化 payload；缺失或非法（非整数 / 负数）时回退到一次 stringify 测量。
    // 注意：因为路由层会改写 payload.model，fallback 测得的字节数可能与原始客户端
    // 字节数有几字节差异（model 名长度差），但仍能准确反映"日志事件发生时的请求体大小"。
    const contentLengthHeader = c.req.header('content-length');
    const parsedContentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
    const requestBytes =
      Number.isInteger(parsedContentLength) && parsedContentLength >= 0
        ? parsedContentLength
        : Buffer.byteLength(JSON.stringify(payload), 'utf-8');

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
      requestBytes,
      requestHeaders: collectHeaders(c.req.raw.headers),
    };

    const plugins = pluginManager?.getPlugins(target.provider) ?? [];
    const pluginConfigs = pluginManager?.getLoadedPlugins(target.provider) ?? [];

    return proxyRequest(c, {
      targetUrl,
      apiKey: provider.apiKey,
      proxy: provider.proxy,
      authType,
      body: payload,
      logMeta,
      plugins: plugins.length > 0 ? plugins : undefined,
      pluginConfigs:
        pluginConfigs.length > 0
          ? pluginConfigs.map((lp) => ({
              name: lp.definition.name,
              package: lp.config.package,
              params: lp.config.params ?? {},
            }))
          : undefined,
    });
  };
}
