import { appendFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Context } from 'hono';
import type { LogEvent, LogMeta } from './logger';
import { extractProviderRequestId, getLogger, normalizeUrl } from './logger';
import type { Plugin, PluginContext, PluginPhaseLog } from './plugin';
import {
  createSSEPluginTransform,
  executeJsonResponsePlugins,
  executeRequestPlugins,
} from './plugin-engine';

export type { PluginPhaseLog } from './plugin';

export type AuthType = 'x-api-key' | 'bearer';

// hop-by-hop 头由当前连接语义决定，不应跨连接转发。
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function buildUpstreamHeaders(original: Headers, apiKey: string, authType: AuthType): Headers {
  const headers = new Headers();

  original.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    if (key.toLowerCase() === 'authorization') return;
    if (key.toLowerCase() === 'x-api-key') return;
    if (key.toLowerCase() === 'accept-encoding') return;
    // 请求体可能被路由层改写，content-length 交给运行时重新计算。
    if (key.toLowerCase() === 'content-length') return;
    headers.set(key, value);
  });

  if (authType === 'x-api-key') {
    headers.set('x-api-key', apiKey);
  } else {
    headers.set('Authorization', `Bearer ${apiKey}`);
  }
  // 代理链路统一请求明文响应，避免压缩协商导致的头体不一致与二次解压问题。
  headers.set('accept-encoding', 'identity');

  return headers;
}

function buildResponseHeaders(upstream: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  // 对 fetch 自动解压后的响应，透传 content-encoding/content-length 会造成头体不一致，
  // 客户端可能二次解压并报 BrotliDecompressionError。
  const unsafeEndToEndHeaders = new Set(['content-encoding', 'content-length']);

  upstream.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    if (unsafeEndToEndHeaders.has(key.toLowerCase())) return;
    headers[key] = value;
  });

  return headers;
}

export interface ProxyRequestOptions {
  targetUrl: string;
  apiKey: string;
  proxy?: string;
  authType: AuthType;
  body: string;
  logMeta: LogMeta;
  plugins?: Plugin[];
  pluginConfigs?: PluginPhaseLog[];
}

function buildLogEvent(
  logMeta: LogMeta,
  targetUrl: string,
  proxyUrl: string | undefined,
  tsEnd: number,
  overrides: Partial<LogEvent>
): LogEvent {
  return {
    request_id: logMeta.requestId,
    ts_start: new Date(logMeta.tsStart).toISOString(),
    ts_end: new Date(tsEnd).toISOString(),
    latency_ms: tsEnd - logMeta.tsStart,
    method: logMeta.method,
    path: logMeta.path,
    route_type: logMeta.routeType,
    route_rule_key: logMeta.routeRuleKey,
    provider: logMeta.provider,
    model_in: logMeta.modelIn,
    model_out: logMeta.modelOut,
    target_url: normalizeUrl(targetUrl),
    proxy_url: proxyUrl ? normalizeUrl(proxyUrl) : null,
    is_stream: logMeta.isStream,
    upstream_status: 0,
    content_type_req: logMeta.contentTypeReq,
    content_type_res: null,
    user_agent: logMeta.userAgent,
    request_headers: logMeta.requestHeaders,
    response_headers: {},
    request_bytes: logMeta.requestBytes,
    response_bytes: null,
    stream_bytes: null,
    provider_request_id: null,
    error_type: null,
    error_message: null,
    ...overrides,
  };
}

function createTempStreamCapturePath(requestId: string): string {
  return join(tmpdir(), `local-router-stream-${requestId}-${Date.now()}.sse.raw`);
}

async function appendTempStreamCapture(filePath: string, chunk: Uint8Array): Promise<void> {
  await appendFile(filePath, chunk);
}

async function flushTempCaptureToLogger(
  tempPath: string,
  requestId: string,
  dateStr: string,
  logger: ReturnType<typeof getLogger>
): Promise<string | null> {
  if (!logger) return null;
  try {
    const text = await readFile(tempPath, 'utf-8').catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    });
    return logger.writeStreamFile(requestId, dateStr, text);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

/**
 * 通用代理职责：
 * 1) 注入上游认证头
 * 2) 执行请求转发
 * 3) 原样透传上游响应（含流式）
 * 4) 记录请求/响应日志（流式使用 tee 分流）
 */
export async function proxyRequest(c: Context, options: ProxyRequestOptions): Promise<Response> {
  const { logMeta, plugins, pluginConfigs } = options;
  const logger = getLogger();
  const shouldLog = logger?.enabled ?? false;
  const hasPlugins = plugins && plugins.length > 0;

  let targetUrl = options.targetUrl;
  let headers = buildUpstreamHeaders(c.req.raw.headers, options.apiKey, options.authType);
  let bodyStr = options.body;

  // 插件请求阶段
  const pluginLogOverrides: Partial<LogEvent> = {};
  if (hasPlugins) {
    const bodyObj = JSON.parse(bodyStr) as Record<string, unknown>;
    const ctx: PluginContext = {
      requestId: logMeta.requestId,
      provider: logMeta.provider,
      modelIn: logMeta.modelIn,
      modelOut: logMeta.modelOut,
      routeType: logMeta.routeType,
      isStream: logMeta.isStream,
    };

    const result = await executeRequestPlugins(plugins, ctx, targetUrl, headers, bodyObj);

    // 记录插件修改
    if (pluginConfigs) {
      pluginLogOverrides.plugins_request = pluginConfigs;
    }
    if (result.url !== targetUrl) {
      targetUrl = result.url;
      pluginLogOverrides.request_url_after_plugins = targetUrl;
    }
    headers = result.headers;
    const newBodyStr = JSON.stringify(result.body);
    if (newBodyStr !== bodyStr) {
      bodyStr = newBodyStr;
      pluginLogOverrides.request_body_after_plugins = result.body;
    }
  }

  const requestBody =
    shouldLog && logger?.bodyPolicy !== 'off' ? JSON.parse(options.body) : undefined;

  const proxy = options.proxy?.trim() ? options.proxy.trim() : undefined;

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: bodyStr,
      ...(proxy ? { proxy } : {}),
      decompress: true,
    });
  } catch (err) {
    if (shouldLog) {
      logger?.writeEvent(
        buildLogEvent(logMeta, targetUrl, proxy, Date.now(), {
          error_type: err instanceof Error ? err.constructor.name : 'UnknownError',
          error_message: err instanceof Error ? err.message : String(err),
          ...(requestBody !== undefined && { request_body: requestBody }),
          ...pluginLogOverrides,
        })
      );
    }
    throw err;
  }

  const responseHeaders = buildResponseHeaders(upstreamRes.headers);

  if (!shouldLog && !hasPlugins) {
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
  }

  const contentTypeRes = upstreamRes.headers.get('content-type');
  const providerRequestId = extractProviderRequestId(upstreamRes.headers);
  const dateStr = new Date(logMeta.tsStart).toISOString().slice(0, 10);

  // 流式响应
  if (logMeta.isStream && upstreamRes.body) {
    // SSE 插件处理
    let sseStatus = upstreamRes.status;
    let sseHeaders = responseHeaders;
    let sseTransform: TransformStream<Uint8Array, Uint8Array> | null = null;

    if (hasPlugins) {
      const ctx: PluginContext = {
        requestId: logMeta.requestId,
        provider: logMeta.provider,
        modelIn: logMeta.modelIn,
        modelOut: logMeta.modelOut,
        routeType: logMeta.routeType,
        isStream: logMeta.isStream,
      };
      const sseResult = await createSSEPluginTransform(
        plugins,
        ctx,
        upstreamRes.status,
        responseHeaders
      );
      sseStatus = sseResult.status;
      sseHeaders = sseResult.headers;
      sseTransform = sseResult.transform;

      if (pluginConfigs) {
        pluginLogOverrides.plugins_response = pluginConfigs;
      }
    }

    if (!shouldLog) {
      // 有插件但无日志
      const outputBody = sseTransform
        ? upstreamRes.body.pipeThrough(sseTransform)
        : upstreamRes.body;
      return new Response(outputBody, {
        status: sseStatus,
        headers: sseHeaders,
      });
    }

    const [clientStream, logStream] = upstreamRes.body.tee();

    (async () => {
      const tempPath = createTempStreamCapturePath(logMeta.requestId);
      let streamBytes = 0;
      let streamFile: string | null = null;

      try {
        const reader = logStream.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          streamBytes += value.byteLength;
          await appendTempStreamCapture(tempPath, value);
        }

        streamFile = await flushTempCaptureToLogger(tempPath, logMeta.requestId, dateStr, logger);
      } catch (err) {
        await unlink(tempPath).catch(() => undefined);
        console.error('[logger] 流式日志处理失败:', err);
      } finally {
        logger?.writeEvent(
          buildLogEvent(logMeta, targetUrl, proxy, Date.now(), {
            upstream_status: sseStatus,
            content_type_res: contentTypeRes,
            response_headers: sseHeaders,
            stream_bytes: streamBytes,
            provider_request_id: providerRequestId,
            ...(streamFile != null && { stream_file: streamFile }),
            ...(requestBody !== undefined && { request_body: requestBody }),
            ...pluginLogOverrides,
          })
        );
      }
    })();

    const outputBody = sseTransform
      ? clientStream.pipeThrough(sseTransform)
      : clientStream;

    return new Response(outputBody, {
      status: sseStatus,
      headers: sseHeaders,
    });
  }

  // 非流式响应
  let responseText = await upstreamRes.text();
  let responseStatus = upstreamRes.status;
  let finalResponseHeaders = responseHeaders;

  // JSON 响应插件处理
  if (hasPlugins) {
    const ctx: PluginContext = {
      requestId: logMeta.requestId,
      provider: logMeta.provider,
      modelIn: logMeta.modelIn,
      modelOut: logMeta.modelOut,
      routeType: logMeta.routeType,
      isStream: logMeta.isStream,
    };
    const result = await executeJsonResponsePlugins(
      plugins,
      ctx,
      upstreamRes.status,
      responseHeaders,
      responseText
    );

    if (pluginConfigs) {
      pluginLogOverrides.plugins_response = pluginConfigs;
    }
    if (result.body !== responseText) {
      if (shouldLog && logger?.bodyPolicy !== 'off') {
        pluginLogOverrides.response_body_before_plugins = responseText;
      }
      pluginLogOverrides.response_body_after_plugins = result.body;
    }
    responseStatus = result.status;
    finalResponseHeaders = result.headers;
    responseText = result.body;
  }

  if (!shouldLog) {
    return new Response(responseText, {
      status: responseStatus,
      headers: finalResponseHeaders,
    });
  }

  // 用最终客户端可见的值计算 response_bytes
  const responseBytes = Buffer.byteLength(responseText, 'utf-8');

  const eventOverrides: Partial<LogEvent> = {
    upstream_status: upstreamRes.status,
    content_type_res: contentTypeRes,
    response_headers: finalResponseHeaders,
    response_bytes: responseBytes,
    provider_request_id: providerRequestId,
    ...pluginLogOverrides,
  };

  if (requestBody !== undefined) {
    eventOverrides.request_body = requestBody;
  }
  if (logger?.bodyPolicy !== 'off') {
    eventOverrides.response_body = responseText;
  }

  logger?.writeEvent(buildLogEvent(logMeta, targetUrl, proxy, Date.now(), eventOverrides));

  return new Response(responseText, {
    status: responseStatus,
    headers: finalResponseHeaders,
  });
}
