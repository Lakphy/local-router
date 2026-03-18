/**
 * 剔除请求体中 context_management 字段的插件
 *
 * 配置示例：
 *   { "package": "./packages/plugin-strip-context-management" }
 */
import type { PluginDefinition, Plugin } from '@lakphy/local-router/plugin';

const definition: PluginDefinition = {
  name: 'strip-context-management',
  version: '0.1.0',

  create(): Plugin {
    return {
      async onRequest({ body }) {
        if ('context_management' in body) {
          delete body.context_management;
          return { body };
        }
      },
    };
  },
};

export default definition;
