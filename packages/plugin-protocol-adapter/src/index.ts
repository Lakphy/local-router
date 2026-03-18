/**
 * 协议适配器插件（通用版）：anthropic-messages ↔ openai-completions ↔ openai-responses 三协议互转
 *
 * 这是一个通用入口，通过 params.targetFormat 指定目标格式。
 * 如果只需要特定方向的转换，推荐使用对应的专用插件包（零配置）。
 *
 * 配置示例：
 *   { "package": "./packages/plugin-protocol-adapter", "params": { "targetFormat": "openai-completions" } }
 */
import type { PluginDefinition, Plugin } from '@lakphy/local-router/plugin';
import { type ProtocolFormat, convertRequestBody } from './convert-request';
import { convertResponseBody } from './convert-response';
import { createStreamTransform } from './convert-stream';
import { rewriteUrl, convertAuthHeaders, URL_PATH_MAP } from './shared';

const VALID_FORMATS = new Set<string>(Object.keys(URL_PATH_MAP));

const definition: PluginDefinition = {
  name: 'protocol-adapter',
  version: '0.2.0',

  create(params: Record<string, unknown>): Plugin {
    const targetFormat = params.targetFormat as ProtocolFormat;

    if (!targetFormat || !VALID_FORMATS.has(targetFormat)) {
      throw new Error(
        `[protocol-adapter] 无效的 targetFormat: "${targetFormat}"。` +
          `支持的值: ${[...VALID_FORMATS].join(', ')}`,
      );
    }

    return {
      async onRequest({ ctx, url, headers, body }) {
        const sourceFormat = ctx.routeType as ProtocolFormat;
        if (sourceFormat === targetFormat || !VALID_FORMATS.has(sourceFormat)) return;

        const newUrl = rewriteUrl(url, sourceFormat, targetFormat);
        convertAuthHeaders(headers, sourceFormat, targetFormat);
        const newBody = convertRequestBody(body, sourceFormat, targetFormat);

        return { url: newUrl, headers, body: newBody };
      },

      async onResponse({ ctx, status, headers, body }) {
        const sourceFormat = ctx.routeType as ProtocolFormat;
        if (sourceFormat === targetFormat || !VALID_FORMATS.has(sourceFormat)) return;

        return { status, headers, body: convertResponseBody(body, sourceFormat, targetFormat) };
      },

      async onSSEResponse({ ctx, status, headers }) {
        const sourceFormat = ctx.routeType as ProtocolFormat;
        if (sourceFormat === targetFormat || !VALID_FORMATS.has(sourceFormat)) return;

        const transform = createStreamTransform(sourceFormat, targetFormat, ctx.modelOut);
        if (!transform) return;

        return { status, headers, transform };
      },

      async onError({ ctx, phase, error }) {
        console.error(
          `[plugin:protocol-adapter] onError phase=${phase} provider=${ctx.provider}: ${error.message}`,
        );
      },

      dispose() {},
    };
  },
};

export default definition;
