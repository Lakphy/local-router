import { createDefaultAppRuntimeFromProcessArgs } from './index';
import type { LogRealtimeWebSocketData } from './log-realtime';
import { REMOTE_ADDRESS_ENV_KEY } from './network-access';

const runtime = await createDefaultAppRuntimeFromProcessArgs();

export default {
  hostname: process.env.HOST ?? '0.0.0.0',
  port: Number.parseInt(process.env.PORT ?? '4099', 10),
  fetch(
    request: Request,
    server: {
      requestIP(request: Request): { address: string } | null;
      upgrade(request: Request, options: { data: LogRealtimeWebSocketData }): boolean;
    }
  ) {
    const remoteAddress = server.requestIP(request)?.address ?? null;
    const realtimeUpgrade = runtime.logRealtime.upgrade(request, server, remoteAddress);
    if (realtimeUpgrade.handled) {
      if (realtimeUpgrade.upgraded) {
        return undefined as unknown as Response;
      }
      return realtimeUpgrade.response ?? new Response('WebSocket Upgrade failed', { status: 400 });
    }
    return runtime.app.fetch(request, {
      [REMOTE_ADDRESS_ENV_KEY]: remoteAddress,
    });
  },
  websocket: runtime.logRealtime.websocket,
};
