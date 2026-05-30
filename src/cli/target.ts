/**
 * Target resolution for CLIENT commands: figure out which running local-router
 * to talk to. Priority: explicit flags → env → runtime status.json → default
 * 4099 → OS process discovery → interactive prompt → error.
 *
 * LIFECYCLE commands (start/stop/restart/status) do NOT use this — they manage
 * the daemon recorded in status.json directly.
 */

import { createInterface } from 'node:readline/promises';
import { resolveLocalAccessHost } from '../server-address';
import { CliError } from './errors';
import type { GlobalFlags } from './global-flags';
import { emitDiagnostic, type OutputContext } from './output';
import { isProcessAlive } from './process';
import { readRuntimeState } from './runtime';

export type TargetSource = 'flag' | 'env' | 'runtime' | 'default' | 'discovered' | 'prompt';

export interface ResolvedTarget {
  baseUrl: string;
  host: string;
  port: number;
  version?: string;
  source: TargetSource;
}

export interface DiscoveredRouter {
  port: number;
  version?: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4099;

interface Fingerprint {
  ok: boolean;
  version?: string;
  host?: string;
  port?: number;
}

function normalizeHostForUrl(host: string): string {
  const h = host.trim();
  if (h === '' || h === '0.0.0.0') return '127.0.0.1';
  if (h === '::' || h === '::1') return '[::1]';
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`;
  return h;
}

function buildBaseUrl(host: string, port: number): string {
  return `http://${normalizeHostForUrl(host)}:${port}`;
}

/**
 * Probe a base URL's `/api/health` and confirm it is a local-router. Returns
 * the reported version/host/port when present.
 */
export async function fingerprint(baseUrl: string, timeoutMs = 800): Promise<Fingerprint> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/health`, { method: 'GET', signal: controller.signal });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as {
      service?: string;
      version?: string;
      host?: string;
      port?: number;
    };
    if (body?.service !== 'local-router') return { ok: false };
    return { ok: true, version: body.version, host: body.host, port: body.port };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse listening TCP ports from `lsof -nP -iTCP -sTCP:LISTEN` output. */
export function parseLsofPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split('\n')) {
    if (!line.includes('LISTEN')) continue;
    // NAME column is like *:4099, 127.0.0.1:4099, [::1]:4099
    const m = line.match(/(?:\*|\[[^\]]+\]|[\d.]+):(\d{2,5})\s*\(LISTEN\)/);
    if (!m) continue;
    const port = Number.parseInt(m[1], 10);
    if (Number.isFinite(port)) ports.add(port);
  }
  return [...ports];
}

/** Parse listening TCP ports from `netstat -an` output (macOS `.port`, Linux `:port`). */
export function parseNetstatPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split('\n')) {
    if (!/LISTEN/i.test(line)) continue;
    const m = line.match(/[.:](\d{2,5})\s+\S+\s+LISTEN/i) ?? line.match(/[.:](\d{2,5})\s+LISTEN/i);
    if (!m) continue;
    const port = Number.parseInt(m[1], 10);
    if (Number.isFinite(port)) ports.add(port);
  }
  return [...ports];
}

async function runShellCommand(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } catch {
    return null;
  }
}

/** Enumerate listening ports via lsof, falling back to netstat. */
export async function listListeningPorts(): Promise<number[]> {
  const ports = new Set<number>();
  const lsof = await runShellCommand(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN']);
  if (lsof) {
    for (const p of parseLsofPorts(lsof)) ports.add(p);
  }
  if (ports.size === 0) {
    const netstat = await runShellCommand(['netstat', '-an']);
    if (netstat) {
      for (const p of parseNetstatPorts(netstat)) ports.add(p);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** Discover all local-router instances by enumerating ports then fingerprinting. */
export async function discoverLocalRouters(timeoutMs = 300): Promise<DiscoveredRouter[]> {
  const ports = await listListeningPorts();
  const hits: DiscoveredRouter[] = [];
  const concurrency = 8;
  let idx = 0;
  const worker = async () => {
    while (idx < ports.length) {
      const port = ports[idx++];
      const fp = await fingerprint(buildBaseUrl(DEFAULT_HOST, port), timeoutMs);
      if (fp.ok) hits.push({ port, version: fp.version });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, () => worker()));
  return hits.sort((a, b) => a.port - b.port);
}

async function fromExplicit(
  url: string | undefined,
  host: string | undefined,
  port: number | undefined,
  source: TargetSource
): Promise<ResolvedTarget | null> {
  if (url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new CliError('USAGE_ERROR', `无效 URL: ${url}`, { hint: '形如 http://127.0.0.1:4099' });
    }
    const baseUrl = u.origin;
    const fp = await fingerprint(baseUrl);
    if (!fp.ok) {
      throw new CliError('TARGET_UNREACHABLE', `目标无法连通: ${baseUrl}`, {
        hint: '确认地址正确且 local-router 正在该地址监听',
      });
    }
    const portNum = u.port ? Number.parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80;
    return { baseUrl, host: u.hostname, port: portNum, version: fp.version, source };
  }
  if (port !== undefined || host !== undefined) {
    const h = host ?? DEFAULT_HOST;
    const p = port ?? DEFAULT_PORT;
    const baseUrl = buildBaseUrl(h, p);
    const fp = await fingerprint(baseUrl);
    if (!fp.ok) {
      throw new CliError('TARGET_UNREACHABLE', `目标无法连通: ${baseUrl}`, {
        hint: '确认端口正确且 local-router 正在监听',
      });
    }
    return { baseUrl, host: h, port: p, version: fp.version, source };
  }
  return null;
}

async function promptPort(): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(`未发现 local-router，请输入端口 [${DEFAULT_PORT}]: `)
    ).trim();
    const port = answer === '' ? DEFAULT_PORT : Number.parseInt(answer, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new CliError('USAGE_ERROR', `无效端口: ${answer}`, { hint: '端口范围 1-65535' });
    }
    return port;
  } finally {
    rl.close();
  }
}

async function promptSelectPort(found: DiscoveredRouter[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('发现多个 local-router：');
    found.forEach((f, i) => {
      console.log(`  ${i + 1}) 127.0.0.1:${f.port}${f.version ? ` (v${f.version})` : ''}`);
    });
    const answer = (await rl.question('请输入序号: ')).trim();
    const idx = Number.parseInt(answer, 10) - 1;
    if (!Number.isFinite(idx) || idx < 0 || idx >= found.length) {
      throw new CliError('USAGE_ERROR', `无效序号: ${answer}`);
    }
    return found[idx].port;
  } finally {
    rl.close();
  }
}

function discoveredTarget(found: DiscoveredRouter): ResolvedTarget {
  return {
    baseUrl: buildBaseUrl(DEFAULT_HOST, found.port),
    host: DEFAULT_HOST,
    port: found.port,
    version: found.version,
    source: 'discovered',
  };
}

/**
 * Resolve which running local-router a client command should target.
 * Each resolved candidate is fingerprinted, so the returned target is healthy.
 */
export async function resolveTarget(flags: GlobalFlags): Promise<ResolvedTarget> {
  // 1. explicit flags
  const explicit = await fromExplicit(
    flags.target?.url,
    flags.target?.host,
    flags.target?.port,
    'flag'
  );
  if (explicit) return explicit;

  // 2. environment variables
  const envUrl = process.env.LOCAL_ROUTER_URL?.trim() || undefined;
  const envPortRaw = process.env.LOCAL_ROUTER_PORT?.trim();
  let envPort: number | undefined;
  if (envPortRaw) {
    envPort = Number.parseInt(envPortRaw, 10);
    if (!Number.isFinite(envPort)) {
      throw new CliError('USAGE_ERROR', `无效 LOCAL_ROUTER_PORT: ${envPortRaw}`);
    }
  }
  const env = await fromExplicit(envUrl, undefined, envPort, 'env');
  if (env) return env;

  // 3. runtime status.json (the daemon this machine owns)
  const state = readRuntimeState();
  if (state && isProcessAlive(state.pid)) {
    const fp = await fingerprint(state.baseUrl);
    if (fp.ok) {
      return {
        baseUrl: state.baseUrl,
        host: resolveLocalAccessHost(state.host),
        port: state.port,
        version: fp.version,
        source: 'runtime',
      };
    }
  }

  // 4. default 4099
  const defaultUrl = buildBaseUrl(DEFAULT_HOST, DEFAULT_PORT);
  const defFp = await fingerprint(defaultUrl);
  if (defFp.ok) {
    return {
      baseUrl: defaultUrl,
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      version: defFp.version,
      source: 'default',
    };
  }

  // 5. OS process enumeration
  const found = await discoverLocalRouters();
  if (found.length === 1) {
    return discoveredTarget(found[0]);
  }
  if (found.length > 1) {
    if (flags.yes) return discoveredTarget(found[0]);
    if (flags.noInteractive || !process.stdin.isTTY) {
      throw new CliError('TARGET_NOT_FOUND', '发现多个 local-router，请用 --port 指定', {
        hint: `候选端口: ${found.map((f) => f.port).join(', ')}`,
        details: { candidates: found },
      });
    }
    const picked = await promptSelectPort(found);
    return discoveredTarget(found.find((f) => f.port === picked) ?? { port: picked });
  }

  // 6. interactive prompt
  if (!flags.noInteractive && process.stdin.isTTY) {
    const port = await promptPort();
    const baseUrl = buildBaseUrl(DEFAULT_HOST, port);
    const fp = await fingerprint(baseUrl);
    if (!fp.ok) {
      throw new CliError('TARGET_UNREACHABLE', `端口 ${port} 上没有 local-router`);
    }
    return { baseUrl, host: DEFAULT_HOST, port, version: fp.version, source: 'prompt' };
  }

  // 7. give up
  throw new CliError('TARGET_NOT_FOUND', '找不到可连接的 local-router', {
    hint: '`local-router start` 启动；或用 --port <port> / --url <url> 指定目标',
  });
}

/**
 * Best-guess target for display/env purposes: honors explicit flags, then the
 * owned daemon (status.json), then the default 4099. Does NO network I/O and
 * never prompts or throws — use this for commands that suggest URLs even when
 * nothing is running (e.g. `env`). For commands that actually connect, use
 * resolveTarget.
 */
export function guessTargetUrl(flags: GlobalFlags): {
  baseUrl: string;
  host: string;
  port: number;
  running: boolean;
} {
  if (flags.target?.url) {
    try {
      const u = new URL(flags.target.url);
      const port = u.port ? Number.parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80;
      return { baseUrl: u.origin, host: u.hostname, port, running: false };
    } catch {
      // fall through to other strategies
    }
  }
  if (flags.target?.port !== undefined || flags.target?.host !== undefined) {
    const host = flags.target.host ?? DEFAULT_HOST;
    const port = flags.target.port ?? DEFAULT_PORT;
    return { baseUrl: buildBaseUrl(host, port), host, port, running: false };
  }
  const state = readRuntimeState();
  if (state && isProcessAlive(state.pid)) {
    return {
      baseUrl: state.baseUrl,
      host: resolveLocalAccessHost(state.host),
      port: state.port,
      running: true,
    };
  }
  return {
    baseUrl: buildBaseUrl(DEFAULT_HOST, DEFAULT_PORT),
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    running: false,
  };
}

/** Human-readable meta line for command output, e.g. "→ 127.0.0.1:4099 (v0.5.7) · default". */
export function targetMetaLine(t: ResolvedTarget): string {
  return `→ ${t.host}:${t.port}${t.version ? ` (v${t.version})` : ''} · ${t.source}`;
}

/**
 * Resolve the target for a client command and surface which one was picked as a
 * stderr diagnostic (suppressed by --quiet), so users always know the port.
 */
export async function requireTarget(ctx: OutputContext): Promise<ResolvedTarget> {
  const t = await resolveTarget(ctx.flags);
  emitDiagnostic(ctx, targetMetaLine(t));
  return t;
}
