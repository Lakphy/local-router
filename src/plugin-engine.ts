import type { Plugin, PluginContext } from './plugin';

/**
 * 请求阶段：正序执行 plugins[0] → plugins[n-1]。
 * 每个插件可修改 url/headers/body，下一个插件拿到上一个的输出。
 */
export async function executeRequestPlugins(
  plugins: Plugin[],
  ctx: PluginContext,
  url: string,
  headers: Headers,
  body: Record<string, unknown>
): Promise<{ url: string; headers: Headers; body: Record<string, unknown> }> {
  let currentUrl = url;
  let currentHeaders = headers;
  let currentBody = body;

  for (const plugin of plugins) {
    if (!plugin.onRequest) continue;
    try {
      const result = await plugin.onRequest({
        ctx,
        url: currentUrl,
        headers: currentHeaders,
        body: currentBody,
      });
      if (result) {
        if (result.url !== undefined) currentUrl = result.url;
        if (result.headers !== undefined) currentHeaders = result.headers;
        if (result.body !== undefined) currentBody = result.body;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      try {
        await plugin.onError?.({ ctx, phase: 'request', error });
      } catch {
        // onError 本身异常静默忽略
      }
    }
  }

  return { url: currentUrl, headers: currentHeaders, body: currentBody };
}

/**
 * JSON 响应阶段：逆序执行 plugins[n-1] → plugins[0]（洋葱模型"先进后出"）。
 */
export async function executeJsonResponsePlugins(
  plugins: Plugin[],
  ctx: PluginContext,
  status: number,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  let currentStatus = status;
  let currentHeaders = headers;
  let currentBody = body;

  // 逆序遍历
  for (let i = plugins.length - 1; i >= 0; i--) {
    const plugin = plugins[i];
    if (!plugin.onResponse) continue;
    try {
      const result = await plugin.onResponse({
        ctx,
        status: currentStatus,
        headers: currentHeaders,
        body: currentBody,
      });
      if (result) {
        if (result.status !== undefined) currentStatus = result.status;
        if (result.headers !== undefined) currentHeaders = result.headers;
        if (result.body !== undefined) currentBody = result.body;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      try {
        await plugin.onError?.({ ctx, phase: 'response', error });
      } catch {
        // onError 本身异常静默忽略
      }
    }
  }

  return { status: currentStatus, headers: currentHeaders, body: currentBody };
}

/**
 * SSE 响应阶段：逆序收集 TransformStream，通过 pipeThrough 串联管道。
 * 同时收集对 status/headers 的修改（逆序）。
 */
export async function createSSEPluginTransform(
  plugins: Plugin[],
  ctx: PluginContext,
  status: number,
  headers: Record<string, string>
): Promise<{
  status: number;
  headers: Record<string, string>;
  transform: TransformStream<Uint8Array, Uint8Array> | null;
}> {
  let currentStatus = status;
  let currentHeaders = headers;
  const transforms: TransformStream<Uint8Array, Uint8Array>[] = [];

  // 逆序遍历
  for (let i = plugins.length - 1; i >= 0; i--) {
    const plugin = plugins[i];
    if (!plugin.onSSEResponse) continue;
    try {
      const result = await plugin.onSSEResponse({
        ctx,
        status: currentStatus,
        headers: currentHeaders,
      });
      if (result) {
        if (result.status !== undefined) currentStatus = result.status;
        if (result.headers !== undefined) currentHeaders = result.headers;
        if (result.transform) transforms.push(result.transform);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      try {
        await plugin.onError?.({ ctx, phase: 'response', error });
      } catch {
        // onError 本身异常静默忽略
      }
    }
  }

  if (transforms.length === 0) {
    return { status: currentStatus, headers: currentHeaders, transform: null };
  }

  if (transforms.length === 1) {
    return { status: currentStatus, headers: currentHeaders, transform: transforms[0] };
  }

  // 串联多个 TransformStream：input → transforms[0] → transforms[1] → ... → output
  // 利用 pipeThrough 的管道语义，构造 passthrough 入口后逐级串联
  const entry = new TransformStream<Uint8Array, Uint8Array>();
  let stream: ReadableStream<Uint8Array> = entry.readable;
  for (const t of transforms) {
    stream = stream.pipeThrough(t);
  }

  return {
    status: currentStatus,
    headers: currentHeaders,
    transform: { writable: entry.writable, readable: stream } as TransformStream<
      Uint8Array,
      Uint8Array
    >,
  };
}
