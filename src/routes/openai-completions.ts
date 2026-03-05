import { Hono } from 'hono';
import type { ConfigStore } from '../config-store';
import { createModelRoutingHandler } from './common';

export function createOpenaiCompletionsRoutes(routeType: string, store: ConfigStore) {
  const routes = new Hono();

  routes.post(
    '/v1/chat/completions',
    createModelRoutingHandler({
      routeType,
      store,
      authType: 'bearer',
      buildTargetUrl: (base) => `${base}/v1/chat/completions`,
    })
  );

  return routes;
}
