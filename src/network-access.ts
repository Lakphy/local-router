import type { Context, Next } from 'hono';
import type { ServerConfig } from './config';
import type { ConfigStore } from './config-store';

export const REMOTE_ADDRESS_ENV_KEY = 'LOCAL_ROUTER_REMOTE_ADDRESS';

export interface NetworkAccessDecision {
  allowed: boolean;
  remoteAddress: string | null;
  reason?: 'lan-disabled' | 'non-lan-address';
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const value = Number.parseInt(part, 10);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });

  return octets.every(Number.isFinite) ? octets : null;
}

function normalizeIpAddress(raw: string): string {
  let address = raw.trim().toLowerCase();
  if (address.startsWith('[')) {
    const end = address.indexOf(']');
    if (end !== -1) address = address.slice(1, end);
  }

  const mappedIpv4 = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4) {
    return mappedIpv4[1];
  }

  return address;
}

export function isLoopbackAddress(raw?: string | null): boolean {
  if (!raw) return false;
  const address = normalizeIpAddress(raw);
  const ipv4 = parseIpv4(address);
  if (ipv4) return ipv4[0] === 127;
  return address === '::1';
}

export function isLanAddress(raw?: string | null): boolean {
  if (!raw) return false;
  const address = normalizeIpAddress(raw);
  const ipv4 = parseIpv4(address);

  if (ipv4) {
    const [a, b] = ipv4;
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }

  return address.startsWith('fc') || address.startsWith('fd') || /^fe[89ab]/.test(address);
}

export function decideNetworkAccess(
  serverConfig: ServerConfig | undefined,
  rawRemoteAddress: string | null | undefined
): NetworkAccessDecision {
  const remoteAddress = rawRemoteAddress ? normalizeIpAddress(rawRemoteAddress) : null;

  if (!remoteAddress || isLoopbackAddress(remoteAddress)) {
    return { allowed: true, remoteAddress };
  }

  const lanEnabled = serverConfig?.lanAccess?.enabled === true;
  if (!lanEnabled) {
    return { allowed: false, remoteAddress, reason: 'lan-disabled' };
  }

  if (!isLanAddress(remoteAddress)) {
    return { allowed: false, remoteAddress, reason: 'non-lan-address' };
  }

  return { allowed: true, remoteAddress };
}

export function getRemoteAddressFromContext(c: Context): string | null {
  const env = c.env as Record<string, unknown> | undefined;
  const value = env?.[REMOTE_ADDRESS_ENV_KEY];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function createNetworkAccessMiddleware(store: ConfigStore) {
  return async (c: Context, next: Next) => {
    const decision = decideNetworkAccess(store.get().server, getRemoteAddressFromContext(c));
    if (!decision.allowed) {
      return c.json(
        {
          error:
            decision.reason === 'lan-disabled'
              ? '局域网服务未开启，已拒绝非本机请求'
              : '仅允许本机或局域网来源访问',
          remoteAddress: decision.remoteAddress,
        },
        403
      );
    }

    await next();
  };
}
