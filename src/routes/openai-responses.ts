import { Hono } from 'hono';
import type { ConfigStore } from '../config-store';
import type { PluginManager } from '../plugin-loader';
import { createModelRoutingHandler } from './common';

export function createOpenaiResponsesRoutes(routeType: string, store: ConfigStore, pluginManager?: PluginManager) {
  const routes = new Hono();

  routes.post(
    '/v1/responses',
    createModelRoutingHandler({
      routeType,
      store,
      authType: 'bearer',
      buildTargetUrl: (base) => `${base}/v1/responses`,
      pluginManager,
    })
  );

  return routes;
}
