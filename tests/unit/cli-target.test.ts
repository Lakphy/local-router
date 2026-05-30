import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FLAGS, extractGlobalFlags, type GlobalFlags } from '../../src/cli/global-flags';
import {
  parseLsofPorts,
  parseNetstatPorts,
  resolveTarget,
  targetMetaLine,
} from '../../src/cli/target';

describe('parseLsofPorts', () => {
  test('解析 lsof LISTEN 行（IPv4 / IPv6 / 通配）', () => {
    const sample = [
      'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'bun     12345 me   20u  IPv4 0x1234567890abcdef      0t0  TCP *:4099 (LISTEN)',
      'bun     12345 me   21u  IPv6 0xabcdef1234567890      0t0  TCP [::1]:4170 (LISTEN)',
      'node    23456 me   22u  IPv4 0x0000000000000000      0t0  TCP 127.0.0.1:5500 (LISTEN)',
      'rapportd 999 me    5u  IPv4 0x0                        0t0  TCP *:1234 (LISTEN)',
      'foo      111 me   10u  IPv4 0x0                        0t0  TCP 1.2.3.4:443->5.6.7.8:80 (ESTABLISHED)',
    ].join('\n');
    expect(parseLsofPorts(sample).sort((a, b) => a - b)).toEqual([1234, 4099, 4170, 5500]);
  });

  test('无 LISTEN 行返回空', () => {
    expect(parseLsofPorts('header only\nTCP 1.2.3.4:80 (ESTABLISHED)')).toEqual([]);
  });
});

describe('parseNetstatPorts', () => {
  test('解析 macOS 风格（.port）', () => {
    const sample = [
      'Active Internet connections',
      'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)',
      'tcp4       0      0  127.0.0.1.4099         *.*                    LISTEN',
      'tcp6       0      0  ::1.4170               *.*                    LISTEN',
      'tcp4       0      0  1.2.3.4.51000          5.6.7.8.443            ESTABLISHED',
    ].join('\n');
    expect(parseNetstatPorts(sample).sort((a, b) => a - b)).toEqual([4099, 4170]);
  });
});

describe('extractGlobalFlags target', () => {
  test('--port/--host/--url 记录到 flags.target 且保留在 rest', () => {
    const { flags, rest } = extractGlobalFlags(['logs', '--port', '4170', '--host', '127.0.0.1']);
    expect(flags.target).toEqual({ url: undefined, host: '127.0.0.1', port: 4170 });
    // 必须保留在 rest，供 start/provider 等自带 --port 的命令解析
    expect(rest).toEqual(['logs', '--port', '4170', '--host', '127.0.0.1']);
  });

  test('--url= 形式', () => {
    const { flags } = extractGlobalFlags(['target', '--url=http://127.0.0.1:4099']);
    expect(flags.target?.url).toBe('http://127.0.0.1:4099');
  });

  test('非法端口抛错', () => {
    expect(() => extractGlobalFlags(['logs', '--port', 'abc'])).toThrow();
  });

  test('无 target flag 时 target 为 undefined', () => {
    const { flags } = extractGlobalFlags(['logs']);
    expect(flags.target).toBeUndefined();
  });
});

describe('targetMetaLine', () => {
  test('包含 host:port、版本与来源', () => {
    expect(
      targetMetaLine({
        baseUrl: 'http://127.0.0.1:4099',
        host: '127.0.0.1',
        port: 4099,
        version: '1.2.3',
        source: 'default',
      })
    ).toBe('→ 127.0.0.1:4099 (v1.2.3) · default');
  });
});

describe('resolveTarget priority', () => {
  let runtimeDir: string;
  let originalFetch: typeof fetch;
  let prevRuntimeEnv: string | undefined;
  let prevUrlEnv: string | undefined;
  let prevPortEnv: string | undefined;

  const flags = (overrides: Partial<GlobalFlags> = {}): GlobalFlags => ({
    ...DEFAULT_FLAGS,
    noInteractive: true,
    ...overrides,
  });

  // Respond with a healthy local-router fingerprint only for the allowed ports.
  const mockFetchForPorts = (ports: number[]) => {
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/:(\d+)\//);
      const port = match ? Number.parseInt(match[1], 10) : Number.NaN;
      if (ports.includes(port)) {
        return new Response(
          JSON.stringify({ status: 'ok', service: 'local-router', version: '9.9.9', port }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error('connection refused');
    }) as typeof fetch;
  };

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'lr-target-'));
    prevRuntimeEnv = process.env.LOCAL_ROUTER_RUNTIME_DIR;
    prevUrlEnv = process.env.LOCAL_ROUTER_URL;
    prevPortEnv = process.env.LOCAL_ROUTER_PORT;
    process.env.LOCAL_ROUTER_RUNTIME_DIR = runtimeDir; // empty → no status.json
    delete process.env.LOCAL_ROUTER_URL;
    delete process.env.LOCAL_ROUTER_PORT;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (prevRuntimeEnv === undefined) delete process.env.LOCAL_ROUTER_RUNTIME_DIR;
    else process.env.LOCAL_ROUTER_RUNTIME_DIR = prevRuntimeEnv;
    if (prevUrlEnv === undefined) delete process.env.LOCAL_ROUTER_URL;
    else process.env.LOCAL_ROUTER_URL = prevUrlEnv;
    if (prevPortEnv === undefined) delete process.env.LOCAL_ROUTER_PORT;
    else process.env.LOCAL_ROUTER_PORT = prevPortEnv;
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  test('显式 --port 命中 → source flag', async () => {
    mockFetchForPorts([5999]);
    const t = await resolveTarget(flags({ target: { port: 5999 } }));
    expect(t.source).toBe('flag');
    expect(t.port).toBe(5999);
    expect(t.version).toBe('9.9.9');
  });

  test('显式 --port 不可达 → TARGET_UNREACHABLE', async () => {
    mockFetchForPorts([]); // 所有端口都失败
    await expect(resolveTarget(flags({ target: { port: 5999 } }))).rejects.toThrow();
  });

  test('环境变量 LOCAL_ROUTER_PORT → source env', async () => {
    process.env.LOCAL_ROUTER_PORT = '6001';
    mockFetchForPorts([6001]);
    const t = await resolveTarget(flags());
    expect(t.source).toBe('env');
    expect(t.port).toBe(6001);
  });

  test('无显式/无 runtime，默认 4099 命中 → source default', async () => {
    mockFetchForPorts([4099]);
    const t = await resolveTarget(flags());
    expect(t.source).toBe('default');
    expect(t.port).toBe(4099);
  });

  test('全部不可达 + 非交互 → TARGET_NOT_FOUND', async () => {
    mockFetchForPorts([]); // fingerprint 永远失败，发现结果必为空
    await expect(resolveTarget(flags())).rejects.toThrow();
  });
});
