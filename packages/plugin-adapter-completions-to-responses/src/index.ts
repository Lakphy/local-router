/**
 * OpenAI Completions → OpenAI Responses 适配器
 *
 * 客户端使用 OpenAI Chat Completions 协议 (/v1/chat/completions)，
 * 上游 provider 使用 OpenAI Responses 协议 (/v1/responses)。
 *
 * 配置示例（零参数）：
 *   { "package": "./packages/plugin-adapter-completions-to-responses" }
 */
import type { PluginDefinition, Plugin } from '@lakphy/local-router/plugin';
import { convertRequestBody } from '../../plugin-protocol-adapter/src/convert-request';
import { convertResponseBody } from '../../plugin-protocol-adapter/src/convert-response';
import { createStreamTransform } from '../../plugin-protocol-adapter/src/convert-stream';
import { rewriteUrl, convertAuthHeaders } from '../../plugin-protocol-adapter/src/shared';

const SOURCE = 'openai-completions' as const;
const TARGET = 'openai-responses' as const;

const definition: PluginDefinition = {
  name: 'adapter-completions-to-responses',
  version: '0.1.0',

  create(): Plugin {
    return {
      async onRequest({ ctx, url, headers, body }) {
        if (ctx.routeType !== SOURCE) return;
        const newUrl = rewriteUrl(url, SOURCE, TARGET);
        convertAuthHeaders(headers, SOURCE, TARGET);
        const newBody = convertRequestBody(body, SOURCE, TARGET);
        return { url: newUrl, headers, body: newBody };
      },

      async onResponse({ ctx, status, headers, body }) {
        if (ctx.routeType !== SOURCE) return;
        return { status, headers, body: convertResponseBody(body, SOURCE, TARGET) };
      },

      async onSSEResponse({ ctx, status, headers }) {
        if (ctx.routeType !== SOURCE) return;
        const transform = createStreamTransform(SOURCE, TARGET, ctx.modelOut);
        if (!transform) return;
        return { status, headers, transform };
      },

      async onError({ ctx, phase, error }) {
        console.error(`[plugin:${SOURCE}->${TARGET}] ${phase}: ${error.message}`);
      },

      dispose() {},
    };
  },
};

export default definition;
