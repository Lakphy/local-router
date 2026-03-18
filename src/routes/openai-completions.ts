import { Hono } from 'hono';
import type { ConfigStore } from '../config-store';
import type { PluginManager } from '../plugin-loader';
import { createModelRoutingHandler } from './common';

export function createOpenaiCompletionsRoutes(routeType: string, store: ConfigStore, pluginManager?: PluginManager) {
  const routes = new Hono();

  routes.post(
    '/v1/chat/completions',
    createModelRoutingHandler({
      routeType,
      store,
      authType: 'bearer',
      buildTargetUrl: (base) => `${base}/v1/chat/completions`,
      pluginManager,
    })
  );

  return routes;
}
