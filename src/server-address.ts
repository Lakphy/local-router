export interface ServerAddressInfo {
  listenHost: string;
  localHost: string;
  port: number;
  listenUrl: string;
  localUrl: string;
}

function formatUrlHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed;
  }
  return trimmed.includes(':') ? `[${trimmed}]` : trimmed;
}

export function resolveLocalAccessHost(listenHost: string): string {
  const host = listenHost.trim().toLowerCase();
  if (host === '0.0.0.0' || host === '') {
    return '127.0.0.1';
  }
  if (host === '::' || host === '[::]') {
    return '::1';
  }
  return listenHost.trim();
}

export function createServerAddressInfo(listenHost: string, port: number): ServerAddressInfo {
  const normalizedListenHost = listenHost.trim() || '0.0.0.0';
  const localHost = resolveLocalAccessHost(normalizedListenHost);

  return {
    listenHost: normalizedListenHost,
    localHost,
    port,
    listenUrl: `http://${formatUrlHost(normalizedListenHost)}:${port}`,
    localUrl: `http://${formatUrlHost(localHost)}:${port}`,
  };
}
