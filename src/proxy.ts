import type { Context } from 'hono';
import type { LogEvent, LogMeta } from './logger';
import { extractProviderRequestId, getLogger, normalizeUrl } from './logger';
import type { Plugin, PluginContext, PluginPhaseLog } from './plugin';
import {
  createSSEPluginTransform,
  executeJsonResponsePlugins,
  executeRequestPlugins,
} from './plugin-engine';
import { createTokenUsageStreamCollector, extractTokenUsageFromResponseText } from './token-usage';

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
  /**
   * 请求体对象。代理路径上以对象形式贯通：仅在调用上游 fetch 之前序列化一次，
   * 避免路由 → 插件 → 日志链路上重复 JSON.parse / JSON.stringify。
   */
  body: Record<string, unknown>;
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

/**
 * 通用代理职责：
 * 1) 注入上游认证头
 * 2) 执行请求转发
 * 3) 原样透传上游响应（含流式）
 * 4) 记录请求/响应日志（流式使用 ReadableStream tap 旁路落盘）
 */
export async function proxyRequest(c: Context, options: ProxyRequestOptions): Promise<Response> {
  const { logMeta, plugins, pluginConfigs } = options;
  const logger = getLogger();
  const shouldLog = logger?.enabled ?? false;
  const hasPlugins = plugins && plugins.length > 0;

  let targetUrl = options.targetUrl;
  let headers = buildUpstreamHeaders(c.req.raw.headers, options.apiKey, options.authType);
  // 整条代理路径以对象形式承载 payload，仅在 fetch 调用前一次性序列化。
  let currentBody: Record<string, unknown> = options.body;

  // 插件上下文一次构造、多处复用；冻结防止插件意外 mutate 共享上下文。
  const pluginCtx: PluginContext = Object.freeze({
    requestId: logMeta.requestId,
    provider: logMeta.provider,
    modelIn: logMeta.modelIn,
    modelOut: logMeta.modelOut,
    routeType: logMeta.routeType,
    isStream: logMeta.isStream,
  });

  // 在调用插件之前对客户端原始请求体做一次"日志快照"：
  // 仅当真的要写完整 body 日志（bodyPolicy != off）时才付一次 stringify+parse 代价。
  // 这样即使插件直接 mutate 入参对象，日志中的 request_body 仍保留客户端原始视图，
  // 与历史 `JSON.parse(options.body)` 路径的语义对齐。
  const wantsBodyLog = shouldLog && logger?.bodyPolicy !== 'off';
  const requestBodySnapshot: unknown = wantsBodyLog
    ? (JSON.parse(JSON.stringify(options.body)) as unknown)
    : undefined;

  // 插件请求阶段
  const pluginLogOverrides: Partial<LogEvent> = {};
  if (hasPlugins) {
    const result = await executeRequestPlugins(plugins, pluginCtx, targetUrl, headers, currentBody);

    // 记录插件修改
    if (pluginConfigs) {
      pluginLogOverrides.plugins_request = pluginConfigs;
    }
    if (result.url !== targetUrl) {
      targetUrl = result.url;
      pluginLogOverrides.request_url_after_plugins = targetUrl;
    }
    headers = result.headers;
    if (result.body !== currentBody) {
      currentBody = result.body;
      pluginLogOverrides.request_body_after_plugins = result.body;
    }
  }

  // 请求体序列化只发生在这里，进入网络一次。
  const wireBody = JSON.stringify(currentBody);

  // 用预先准备好的快照作为日志中的 request_body，避免插件 mutate 入参后污染日志。
  const requestBody = requestBodySnapshot;

  const proxy = options.proxy?.trim() ? options.proxy.trim() : undefined;

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: wireBody,
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
      const sseResult = await createSSEPluginTransform(
        plugins,
        pluginCtx,
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

    // tap：在 pull 阶段同步落盘 + 转发，避免 tee + 临时文件 + 全量回读的内存放大。
    // 落盘的是上游"原始 SSE 字节"，与历史语义一致（不含插件后改写视图）。
    const capture = logger?.openStreamCapture(logMeta.requestId, dateStr) ?? null;
    const tokenUsageCollector = createTokenUsageStreamCollector(
      `${logMeta.provider} ${logMeta.routeType} ${logMeta.modelIn} ${logMeta.modelOut}`
    );
    // 上游字节数：从上游真实读到的总字节数。与磁盘截断无关，与历史 stream_bytes 语义一致。
    let upstreamBytes = 0;
    let writeEventCalled = false;
    const finalizeAndWriteEvent = (): void => {
      if (writeEventCalled) return;
      writeEventCalled = true;
      const captureResult = capture?.finalize() ?? {
        bytesWritten: 0,
        truncated: false,
        filePath: null,
      };
      const tokenUsage = tokenUsageCollector.getUsage();
      logger?.writeEvent(
        buildLogEvent(logMeta, targetUrl, proxy, Date.now(), {
          upstream_status: sseStatus,
          content_type_res: contentTypeRes,
          response_headers: sseHeaders,
          stream_bytes: upstreamBytes,
          provider_request_id: providerRequestId,
          ...(captureResult.filePath != null && { stream_file: captureResult.filePath }),
          ...(captureResult.bytesWritten > 0 && {
            stream_file_bytes: captureResult.bytesWritten,
          }),
          ...(captureResult.truncated && { stream_file_truncated: true }),
          ...(tokenUsage && { token_usage: tokenUsage }),
          ...(requestBody !== undefined && { request_body: requestBody }),
          ...pluginLogOverrides,
        })
      );
    };

    // 用一个手写的 ReadableStream 包装上游：
    //  - 每个 chunk 同步落盘 + 转发给客户端；
    //  - readable 被 cancel 时（客户端断开 / 下游 pipeThrough 失败）也会调用 cancel()，
    //    保证写入 LogEvent 与关闭 fd；
    //  - 上游 reader 在错误情况下被显式 release，避免 fd 泄漏。
    // TODO(memopt): Response 在调用方既不消费也不 cancel 时无人触发 finalize；
    // 生产路径上 HTTP server 在客户端断连时会 cancel response body，覆盖此场景。
    // 若未来出现长时间无活动的孤儿 fd，可在此处补一个超时兜底。
    const upstreamReader = upstreamRes.body.getReader();
    const tappedStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await upstreamReader.read();
          if (done) {
            controller.close();
            finalizeAndWriteEvent();
            return;
          }
          upstreamBytes += value.byteLength;
          tokenUsageCollector.addChunk(value);
          capture?.write(value);
          controller.enqueue(value);
        } catch (err) {
          finalizeAndWriteEvent();
          controller.error(err);
        }
      },
      cancel(reason) {
        // 客户端中途 cancel 或下游异常：仍写出事件，避免 fd 与队列泄漏。
        try {
          upstreamReader.cancel(reason).catch(() => undefined);
        } finally {
          finalizeAndWriteEvent();
        }
      },
    });

    let stream: ReadableStream<Uint8Array> = tappedStream;
    if (sseTransform) stream = stream.pipeThrough(sseTransform);

    return new Response(stream, {
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
    const result = await executeJsonResponsePlugins(
      plugins,
      pluginCtx,
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
  const tokenUsage = extractTokenUsageFromResponseText(
    responseText,
    'response_body',
    `${logMeta.provider} ${logMeta.routeType} ${logMeta.modelIn} ${logMeta.modelOut}`
  );

  const eventOverrides: Partial<LogEvent> = {
    upstream_status: upstreamRes.status,
    content_type_res: contentTypeRes,
    response_headers: finalResponseHeaders,
    response_bytes: responseBytes,
    provider_request_id: providerRequestId,
    ...(tokenUsage && { token_usage: tokenUsage }),
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
