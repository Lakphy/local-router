import { createAppRuntimeFromConfigPath } from './index';

export interface StartServerOptions {
  configPath: string;
  host: string;
  port: number;
  idleTimeoutSeconds?: number;
}

export interface RunningServer {
  host: string;
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_SECONDS = 0;

function resolveIdleTimeoutSeconds(explicit?: number): number {
  let value = DEFAULT_IDLE_TIMEOUT_SECONDS;

  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    value = explicit;
  } else {
    const fromEnv = process.env.LOCAL_ROUTER_IDLE_TIMEOUT;
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        value = parsed;
      }
    }
  }

  return Math.min(value, 255);
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const runtime = await createAppRuntimeFromConfigPath(options.configPath);
  const idleTimeout = resolveIdleTimeoutSeconds(options.idleTimeoutSeconds);
  const server = Bun.serve({
    fetch: runtime.app.fetch,
    hostname: options.host,
    port: options.port,
    idleTimeout,
  });

  const host = server.hostname;
  const port = server.port;
  const baseUrl = `http://${host}:${port}`;

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
