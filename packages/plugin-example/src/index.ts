import type { PluginDefinition, Plugin, PluginContext } from '@lakphy/local-router/plugin';

interface ExamplePluginParams {
  tag?: string;
}

const definition: PluginDefinition = {
  name: 'example',
  version: '0.1.0',

  create(params: Record<string, unknown>): Plugin {
    const { tag = 'example' } = params as ExamplePluginParams;
    let requestCount = 0;

    return {
      async onRequest({ ctx, url, headers, body }) {
        requestCount++;
        // 在请求头中注入自定义标记
        headers.set('x-plugin-timestamp', new Date().toISOString());
        headers.set('x-plugin-tag', tag);
        console.log(
          `[plugin:example] onRequest #${requestCount} provider=${ctx.provider} model=${ctx.modelOut}`
        );
        return { headers };
      },

      async onResponse({ ctx, status, headers, body }) {
        // 在 JSON 响应中注入元数据字段
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          parsed._plugin_meta = {
            plugin: 'example',
            tag,
            processed_at: new Date().toISOString(),
          };
          return { body: JSON.stringify(parsed) };
        } catch {
          // 非 JSON 响应则不修改
          return;
        }
      },

      async onSSEResponse({ ctx, status, headers }) {
        // 返回一个 TransformStream，在 SSE 流中追加注释行
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            // 每个 chunk 后追加一行 SSE 注释
            const comment = `: plugin-example tag=${tag} ts=${new Date().toISOString()}\n`;
            controller.enqueue(encoder.encode(comment));
          },
        });
        return { transform };
      },

      async onError({ ctx, phase, error }) {
        console.error(
          `[plugin:example] onError phase=${phase} provider=${ctx.provider}: ${error.message}`
        );
      },

      dispose() {
        console.log(
          `[plugin:example] disposed after handling ${requestCount} requests`
        );
      },
    };
  },
};

export default definition;
