import { Hono } from 'hono';
import type { ConfigStore } from '../config-store';
import { createModelRoutingHandler } from './common';

export function createOpenaiResponsesRoutes(routeType: string, store: ConfigStore) {
  const routes = new Hono();

  routes.post(
    '/v1/responses',
    createModelRoutingHandler({
      routeType,
      store,
      authType: 'bearer',
      buildTargetUrl: (base) => `${base}/v1/responses`,
    })
  );

  return routes;
}
