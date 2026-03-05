import { appendFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Context } from 'hono';
import type { LogEvent, LogMeta } from './logger';
import { extractProviderRequestId, getLogger } from './logger';

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
  authType: AuthType;
  body: string;
  logMeta: LogMeta;
}

function buildLogEvent(
  logMeta: LogMeta,
  targetUrl: string,
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
    target_url: targetUrl,
    is_stream: logMeta.isStream,
    upstream_status: 0,
    content_type_req: logMeta.contentTypeReq,
    content_type_res: null,
    user_agent: logMeta.userAgent,
    request_headers_masked: logMeta.requestHeadersMasked,
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
  const { logMeta } = options;
  const logger = getLogger();
  const shouldLog = logger?.enabled ?? false;

  const headers = buildUpstreamHeaders(c.req.raw.headers, options.apiKey, options.authType);

  const requestBody =
    shouldLog && logger?.bodyPolicy !== 'off' ? JSON.parse(options.body) : undefined;

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(options.targetUrl, {
      method: c.req.method,
      headers,
      body: options.body,
      // 显式开启自动解压，避免运行时默认值差异。
      decompress: true,
    });
  } catch (err) {
    if (shouldLog) {
      logger?.writeEvent(
        buildLogEvent(logMeta, options.targetUrl, Date.now(), {
          error_type: err instanceof Error ? err.constructor.name : 'UnknownError',
          error_message: err instanceof Error ? err.message : String(err),
          ...(requestBody !== undefined && { request_body: requestBody }),
        })
      );
    }
    throw err;
  }

  const responseHeaders = buildResponseHeaders(upstreamRes.headers);

  if (!shouldLog) {
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
  }

  const contentTypeRes = upstreamRes.headers.get('content-type');
  const providerRequestId = extractProviderRequestId(upstreamRes.headers);
  const dateStr = new Date(logMeta.tsStart).toISOString().slice(0, 10);

  // 流式响应：tee 分流，一路回客户端，一路写日志
  if (logMeta.isStream && upstreamRes.body) {
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
          buildLogEvent(logMeta, options.targetUrl, Date.now(), {
            upstream_status: upstreamRes.status,
            content_type_res: contentTypeRes,
            response_headers: responseHeaders,
            stream_bytes: streamBytes,
            provider_request_id: providerRequestId,
            ...(streamFile != null && { stream_file: streamFile }),
            ...(requestBody !== undefined && { request_body: requestBody }),
          })
        );
      }
    })();

    return new Response(clientStream, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
  }

  // 非流式响应：读取完整内容后记录
  const responseText = await upstreamRes.text();
  const responseBytes = Buffer.byteLength(responseText, 'utf-8');

  const eventOverrides: Partial<LogEvent> = {
    upstream_status: upstreamRes.status,
    content_type_res: contentTypeRes,
    response_headers: responseHeaders,
    response_bytes: responseBytes,
    provider_request_id: providerRequestId,
  };

  if (requestBody !== undefined) {
    eventOverrides.request_body = requestBody;
  }
  if (logger?.bodyPolicy !== 'off') {
    eventOverrides.response_body = responseText;
  }

  logger?.writeEvent(buildLogEvent(logMeta, options.targetUrl, Date.now(), eventOverrides));

  return new Response(responseText, {
    status: upstreamRes.status,
    headers: responseHeaders,
  });
}
