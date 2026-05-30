import { createAppRuntimeFromConfigPath } from './index';
import type { LogRealtimeWebSocketData } from './log-realtime';
import { REMOTE_ADDRESS_ENV_KEY } from './network-access';
import { createServerAddressInfo } from './server-address';

export interface StartServerOptions {
  configPath: string;
  host: string;
  port: number;
  idleTimeoutSeconds?: number;
  /** Triggers a full process restart (re-binds Bun.serve with the latest config). */
  requestRestart?: () => void;
}

export interface RunningServer {
  host: string;
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_SECONDS = 0;

interface ServerWithRequestIp {
  requestIP(request: Request): { address: string } | null;
  upgrade(request: Request, options: { data: LogRealtimeWebSocketData }): boolean;
}

function resolveIdleTimeoutSeconds(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }

  const fromEnv = process.env.LOCAL_ROUTER_IDLE_TIMEOUT;
  if (!fromEnv) {
    return DEFAULT_IDLE_TIMEOUT_SECONDS;
  }

  const parsed = Number.parseInt(fromEnv, 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  return DEFAULT_IDLE_TIMEOUT_SECONDS;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const idleTimeout = resolveIdleTimeoutSeconds(options.idleTimeoutSeconds);
  const requestRestart = options.requestRestart;
  const runtime = await createAppRuntimeFromConfigPath(
    options.configPath,
    {
      host: options.host,
      port: options.port,
    },
    requestRestart
      ? {
          requestRestart,
          current: { host: options.host, port: options.port, idleTimeout },
        }
      : undefined
  );
  const server = Bun.serve({
    fetch: (request: Request, server: ServerWithRequestIp) => {
      const remoteAddress = server.requestIP(request)?.address ?? null;
      const realtimeUpgrade = runtime.logRealtime.upgrade(request, server, remoteAddress);
      if (realtimeUpgrade.handled) {
        if (realtimeUpgrade.upgraded) {
          return undefined as unknown as Response;
        }
        return (
          realtimeUpgrade.response ?? new Response('WebSocket Upgrade failed', { status: 400 })
        );
      }
      return runtime.app.fetch(request, {
        [REMOTE_ADDRESS_ENV_KEY]: remoteAddress,
      });
    },
    websocket: runtime.logRealtime.websocket,
    hostname: options.host,
    port: options.port,
    idleTimeout,
  });

  const host = server.hostname;
  const port = server.port;
  const baseUrl = createServerAddressInfo(host, port).localUrl;

  return {
    host,
    port,
    baseUrl,
    stop: async () => {
      server.stop(true);
      runtime.dispose();
    },
  };
}
