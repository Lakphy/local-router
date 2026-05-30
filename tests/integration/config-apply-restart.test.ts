import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import {
  type AppRuntime,
  createAppRuntimeFromConfigPath,
  type ServerControl,
} from '../../src/index';
import { resetLogger } from '../../src/logger';

interface ConfigShape {
  providers: Record<string, unknown>;
  routes: Record<string, unknown>;
  server?: { host?: string; port?: number; idleTimeout?: number };
}

function writeConfig(dir: string, config: ConfigShape): string {
  const configPath = join(dir, 'config.json5');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function patchServer(configPath: string, server: ConfigShape['server']): void {
  const current = JSON.parse(readFileSync(configPath, 'utf-8')) as ConfigShape;
  current.server = { ...current.server, ...server };
  writeFileSync(configPath, JSON.stringify(current, null, 2));
}

async function applyConfig(app: Hono): Promise<Record<string, unknown>> {
  const res = await app.request('http://localhost/api/config/apply', { method: 'POST' });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('config apply restart detection', () => {
  let tempDir: string;
  let configPath: string;
  let runtime: AppRuntime;
  let app: Hono;
  let restartCalls: number;

  const baseConfig: ConfigShape = {
    providers: {},
    routes: {},
    server: { host: '0.0.0.0', port: 4099, idleTimeout: 0 },
  };

  function createServerControl(): ServerControl {
    return {
      requestRestart: () => {
        restartCalls += 1;
      },
      current: { host: '0.0.0.0', port: 4099, idleTimeout: 0 },
    };
  }

  beforeEach(async () => {
    restartCalls = 0;
    tempDir = mkdtempSync(join(tmpdir(), 'apply-restart-test-'));
    configPath = writeConfig(tempDir, baseConfig);
    runtime = await createAppRuntimeFromConfigPath(
      configPath,
      { host: '0.0.0.0', port: 4099 },
      createServerControl()
    );
    app = runtime.app;
  });

  afterEach(() => {
    runtime?.dispose();
    resetLogger();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('未改监听地址时 restartRequired 为 false', async () => {
    patchServer(configPath, { port: 4099 });
    const data = await applyConfig(app);
    expect(data.restartRequired).toBe(false);
    expect(data.listen).toBeUndefined();
  });

  test('改端口时返回 restartRequired 与新监听地址，但不直接重启', async () => {
    patchServer(configPath, { port: 5005 });
    const data = await applyConfig(app);
    expect(data.restartRequired).toBe(true);
    expect(data.canRestart).toBe(true);
    expect(data.listen).toEqual({ host: '0.0.0.0', port: 5005 });
    // apply 自身不触发重启，须由客户端确认后调用 /api/restart
    expect(restartCalls).toBe(0);
  });

  test('改 host 与 idleTimeout 同样判定为需要重启', async () => {
    patchServer(configPath, { host: '127.0.0.1', idleTimeout: 30 });
    const data = await applyConfig(app);
    expect(data.restartRequired).toBe(true);
  });

  test('基线为实际绑定地址：连续两次 apply 端口不变时仍判定为需要重启', async () => {
    patchServer(configPath, { port: 5005 });
    const first = await applyConfig(app);
    expect(first.restartRequired).toBe(true);
    // 第二次 apply：内存配置已是 5005，但进程仍绑定 4099，应继续判定需要重启
    const second = await applyConfig(app);
    expect(second.restartRequired).toBe(true);
    expect(second.listen).toEqual({ host: '0.0.0.0', port: 5005 });
  });

  test('POST /api/restart 触发 requestRestart 并返回目标监听地址', async () => {
    patchServer(configPath, { port: 5005 });
    await applyConfig(app);
    const res = await app.request('http://localhost/api/restart', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.listen).toEqual({ host: '0.0.0.0', port: 5005 });
    expect(restartCalls).toBe(1);
  });
});

describe('config apply without server control', () => {
  let tempDir: string;
  let configPath: string;
  let runtime: AppRuntime;
  let app: Hono;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'apply-norestart-test-'));
    configPath = writeConfig(tempDir, {
      providers: {},
      routes: {},
      server: { host: '0.0.0.0', port: 4099 },
    });
    runtime = await createAppRuntimeFromConfigPath(configPath, { host: '0.0.0.0', port: 4099 });
    app = runtime.app;
  });

  afterEach(() => {
    runtime?.dispose();
    resetLogger();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('无 serverControl 时改端口仍报告 restartRequired 但 canRestart 为 false', async () => {
    patchServer(configPath, { port: 5005 });
    const res = await app.request('http://localhost/api/config/apply', { method: 'POST' });
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.restartRequired).toBe(true);
    expect(data.canRestart).toBe(false);
  });

  test('POST /api/restart 在无 serverControl 时返回 501', async () => {
    const res = await app.request('http://localhost/api/restart', { method: 'POST' });
    expect(res.status).toBe(501);
  });
});
