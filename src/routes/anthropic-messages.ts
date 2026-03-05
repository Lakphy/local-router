import { Hono } from 'hono';
import type { ConfigStore } from '../config-store';
import { createModelRoutingHandler } from './common';

export function createAnthropicMessagesRoutes(routeType: string, store: ConfigStore) {
  const routes = new Hono();

  routes.post(
    '/v1/messages',
    createModelRoutingHandler({
      routeType,
      store,
      authType: 'x-api-key',
      buildTargetUrl: (base) => `${base}/v1/messages`,
    })
  );

  return routes;
}
