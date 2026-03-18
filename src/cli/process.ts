import { closeSync, openSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ensureConfigFile, resolveConfigPath } from '../config';
import { startServer, type RunningServer } from '../server';
import {
  clearRuntimeFiles,
  ensureRuntimeDirs,
  getRuntimeFiles,
  readRuntimeState,
  resolveConfigArgPath,
  writeRuntimeState,
} from './runtime';

export interface CliSharedFlags {
  config?: string;
  host?: string;
  port?: number;
  idleTimeoutSeconds?: number;
}

export function parseSharedFlags(args: string[]): CliSharedFlags {
  const parsed = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'idle-timeout': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });
  const portRaw = parsed.values.port;
  const port = portRaw ? Number.parseInt(portRaw, 10) : undefined;
  if (portRaw && !Number.isFinite(port)) {
    throw new Error(`无效端口: ${portRaw}`);
  }

  const idleTimeoutRaw = parsed.values['idle-timeout'];
  const idleTimeoutSeconds = idleTimeoutRaw ? Number.parseInt(idleTimeoutRaw, 10) : undefined;
  if (idleTimeoutRaw && (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds < 0)) {
    throw new Error(`无效 idle-timeout: ${idleTimeoutRaw}`);
  }
  return {
    config: parsed.values.config,
    host: parsed.values.host,
    port,
    idleTimeoutSeconds,
  };
}

export async function checkHealth(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupIfStale(): Promise<void> {
  const state = readRuntimeState();
  if (!state) return;
  if (isProcessAlive(state.pid)) return;
  clearRuntimeFiles();
}

export async function runServerProcess(opts: {
  mode: 'daemon' | 'foreground';
  config?: string;
  host?: string;
  port?: number;
  idleTimeoutSeconds?: number;
  logFile?: string;
}): Promise<never> {
  await cleanupIfStale();
  const configPath = resolveConfigPath(opts.config);
  const ensured = ensureConfigFile(configPath);
  if (ensured.created) {
    console.log(`首次启动已创建配置文件: ${ensured.path}`);
  }

  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const port = opts.port ?? Number.parseInt(process.env.PORT ?? '4099', 10);
  if (!Number.isFinite(port)) {
    throw new Error(`无效端口: ${opts.port ?? process.env.PORT}`);
  }

  const idleTimeoutSeconds =
    opts.idleTimeoutSeconds ?? Number.parseInt(process.env.LOCAL_ROUTER_IDLE_TIMEOUT ?? '', 10);

  let running: RunningServer;
  try {
    running = await startServer({
      configPath: ensured.path,
      host,
      port,
      idleTimeoutSeconds: Number.isFinite(idleTimeoutSeconds) ? idleTimeoutSeconds : undefined,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'EADDRINUSE' || message.toLowerCase().includes('address already in use')) {
      throw new Error(
        `端口 ${port} 已被占用。\n` +
          `请换端口重试: local-router start --port ${port + 1}\n` +
          '或先停止占用该端口的进程。'
      );
    }
    throw err;
  }

  writeRuntimeState({
    pid: process.pid,
    mode: opts.mode,
    host: running.host,
    port: running.port,
    baseUrl: running.baseUrl,
    configPath: ensured.path,
    startedAt: new Date().toISOString(),
    logFile: opts.logFile,
  });

  console.log(`local-router 已启动: ${running.baseUrl}`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`收到 ${signal}，正在停止 local-router...`);
    try {
      await running.stop();
    } finally {
      clearRuntimeFiles();
      process.exit(0);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  // 持续运行，直到接收到退出信号
  while (true) {
    await sleep(60_000);
  }
}

export async function startDaemon(flags: CliSharedFlags): Promise<void> {
  await cleanupIfStale();
  const current = readRuntimeState();
  if (current && isProcessAlive(current.pid) && (await checkHealth(current.baseUrl))) {
    throw new Error(`服务已在运行: pid=${current.pid}, url=${current.baseUrl}`);
  }
  if (current && !isProcessAlive(current.pid)) {
    clearRuntimeFiles();
  }

  ensureRuntimeDirs();
  const files = getRuntimeFiles();

  const stdoutFd = openSync(files.daemonLog, 'a');
  const stderrFd = openSync(files.daemonLog, 'a');
  const childArgs = [
    process.argv[1] ?? 'src/cli.ts',
    '__run-server',
    '--mode',
    'daemon',
  ];
  if (flags.config) {
    childArgs.push('--config', resolveConfigArgPath(flags.config));
  }
  if (flags.host) {
    childArgs.push('--host', flags.host);
  }
  if (typeof flags.port === 'number') {
    childArgs.push('--port', String(flags.port));
  }
  if (typeof flags.idleTimeoutSeconds === 'number') {
    childArgs.push('--idle-timeout', String(flags.idleTimeoutSeconds));
  }
  childArgs.push('--log-file', files.daemonLog);

  const child = Bun.spawn([process.execPath, ...childArgs], {
    stdin: 'ignore',
    stdout: stdoutFd,
    stderr: stderrFd,
    detached: true,
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  child.unref();

  for (let i = 0; i < 24; i += 1) {
    await sleep(250);
    const state = readRuntimeState();
    if (!state) continue;
    if (isProcessAlive(state.pid) && (await checkHealth(state.baseUrl))) {
      console.log(`已在后台启动: pid=${state.pid}, url=${state.baseUrl}`);
      console.log(`日志文件: ${files.daemonLog}`);
      return;
    }
  }

  let tail = '';
  try {
    const content = readFileSync(files.daemonLog, 'utf-8');
    tail = content.split('\n').slice(-20).join('\n');
  } catch {
    // ignore
  }
  throw new Error(`后台启动失败，请检查日志: ${files.daemonLog}\n${tail}`);
}

export async function stopProcess(graceMs = 8000): Promise<boolean> {
  await cleanupIfStale();
  const state = readRuntimeState();
  if (!state) return false;
  if (!isProcessAlive(state.pid)) {
    clearRuntimeFiles();
    return false;
  }

  process.kill(state.pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid)) {
      clearRuntimeFiles();
      return true;
    }
    await sleep(200);
  }

  process.kill(state.pid, 'SIGKILL');
  await sleep(200);
  clearRuntimeFiles();
  return true;
}

export function readLogDelta(filePath: string, offset: number): { content: string; nextOffset: number } {
  try {
    const stats = statSync(filePath);
    if (stats.size <= offset) {
      return { content: '', nextOffset: offset };
    }
    const full = readFileSync(filePath, 'utf-8');
    const content = full.slice(offset);
    return { content, nextOffset: full.length };
  } catch {
    return { content: '', nextOffset: offset };
  }
}
