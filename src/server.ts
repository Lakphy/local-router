import { createAppRuntimeFromConfigPath } from './index';

export interface StartServerOptions {
  configPath: string;
  host: string;
  port: number;
}

export interface RunningServer {
  host: string;
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

export function startServer(options: StartServerOptions): RunningServer {
  const runtime = createAppRuntimeFromConfigPath(options.configPath);
  const server = Bun.serve({
    fetch: runtime.app.fetch,
    hostname: options.host,
    port: options.port,
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
