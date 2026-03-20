#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ensureConfigFile, loadConfig, resolveConfigPath, type RouteTarget, writeDefaultConfigFile } from './config';
import {
  checkHealth,
  cleanupIfStale,
  parseSharedFlags,
  readLogDelta,
  runServerProcess,
  startDaemon,
  stopProcess,
} from './cli/process';
import { getRuntimeFiles, readRuntimeState, resolveConfigArgPath } from './cli/runtime';
import { cmdConfig } from './cli/config-command';

function printHelp(): void {
  console.log(`
local-router CLI

Usage:
  local-router <command> [options]

Commands:
  start [--daemon] [--config <path>] [--host <host>] [--port <port>] [--idle-timeout <sec>]
  stop
  restart [--daemon] [--config <path>] [--host <host>] [--port <port>] [--idle-timeout <sec>]
  status [--json]
  logs [--follow] [--lines <n>]
  init [--config <path>] [--force]
  config <subcommand> [...args]
  config import-ccs [--db <path>] [--config <path>] [--yes]
  get-route --type <route-type> [--model-alias <alias>] [--config <path>]
  health
  version

Hidden commands:
  __run-server --mode <daemon|foreground> [--config] [--host] [--port] [--idle-timeout] [--log-file]
`);
}

async function printVersion(): Promise<void> {
  try {
    const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json();
    const version = typeof pkg.version === 'string' ? pkg.version : 'unknown';
    console.log(version);
  } catch {
    console.log('unknown');
  }
}

async function cmdStart(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      daemon: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const flags = parseSharedFlags(args);
  if (parsed.values.daemon) {
    await startDaemon(flags);
    return;
  }
  await runServerProcess({
    mode: 'foreground',
    config: flags.config,
    host: flags.host,
    port: flags.port,
    idleTimeoutSeconds: flags.idleTimeoutSeconds,
  });
}

async function cmdStop(): Promise<void> {
  const stopped = await stopProcess();
  if (!stopped) {
    console.log('服务未运行');
    return;
  }
  console.log('服务已停止');
}

async function cmdRestart(args: string[]): Promise<void> {
  await cmdStop();
  await cmdStart(args);
}

async function cmdStatus(args: string[]): Promise<void> {
  await cleanupIfStale();
  const parsed = parseArgs({
    args,
    options: {
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const state = readRuntimeState();
  if (!state) {
    if (parsed.values.json) {
      console.log(JSON.stringify({ running: false }, null, 2));
    } else {
      console.log('未运行');
    }
    return;
  }

  const healthy = await checkHealth(state.baseUrl);
  const checkedAt = new Date().toISOString();
  const startedAtMs = Date.parse(state.startedAt);
  const uptimeSeconds = Number.isFinite(startedAtMs)
    ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
    : null;
  const payload = {
    running: healthy,
    healthy,
    pid: state.pid,
    mode: state.mode,
    baseUrl: state.baseUrl,
    host: state.host,
    port: state.port,
    configPath: state.configPath,
    startedAt: state.startedAt,
    uptimeSeconds,
    checkedAt,
    logFile: state.logFile,
  };
  if (parsed.values.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`状态: ${payload.running ? 'running' : 'unhealthy'}`);
  console.log(`PID: ${payload.pid}`);
  console.log(`模式: ${payload.mode}`);
  console.log(`地址: ${payload.baseUrl}`);
  console.log(`配置: ${payload.configPath}`);
  console.log(`启动时间: ${payload.startedAt}`);
  if (payload.uptimeSeconds !== null) {
    console.log(`运行时长: ${payload.uptimeSeconds}s`);
  }
  console.log(`健康检查时间: ${payload.checkedAt}`);
  if (payload.logFile) {
    console.log(`日志: ${payload.logFile}`);
  }
}

function printLastLines(filePath: string, lines: number): number {
  if (!existsSync(filePath)) {
    console.log(`日志文件不存在: ${filePath}`);
    return 0;
  }
  const full = readFileSync(filePath, 'utf-8');
  const rendered = full.split('\n').slice(-lines).join('\n');
  if (rendered.trim()) {
    console.log(rendered);
  }
  return full.length;
}

async function cmdLogs(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      follow: { type: 'boolean', default: false },
      lines: { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });
  const files = getRuntimeFiles();
  const linesRaw = parsed.values.lines ?? '100';
  const lines = Number.parseInt(linesRaw, 10);
  const initialOffset = printLastLines(files.daemonLog, Number.isFinite(lines) ? lines : 100);

  if (!parsed.values.follow) return;

  let offset = initialOffset;
  console.log('--- follow mode ---');
  while (true) {
    await sleep(1000);
    const delta = readLogDelta(files.daemonLog, offset);
    offset = delta.nextOffset;
    if (delta.content) {
      process.stdout.write(delta.content);
    }
  }
}

async function cmdInit(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const configPath = resolveConfigPath(parsed.values.config);
  if (parsed.values.force) {
    const path = resolveConfigArgPath(configPath);
    const result = writeDefaultConfigFile(path, { overwrite: true });
    console.log(`已重置配置: ${result.path}`);
    return;
  }
  const result = ensureConfigFile(configPath);
  console.log(result.created ? `已初始化配置: ${result.path}` : `配置已存在: ${result.path}`);
}

function formatRouteTarget(target: RouteTarget): string {
  return `${target.provider} / ${target.model}`;
}

async function cmdGetRoute(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      type: { type: 'string' },
      'model-alias': { type: 'string' },
      model: { type: 'string' },
      config: { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  const routeType = parsed.values.type;
  if (!routeType) {
    throw new Error('用法: local-router get-route --type <route-type> [--model-alias <alias>] [--config <path>]');
  }

  const configPath = resolveConfigPath(parsed.values.config);
  const config = loadConfig(configPath);
  const modelMap = config.routes[routeType];
  if (!modelMap) {
    throw new Error(`route type 不存在: ${routeType}`);
  }

  const modelAlias = parsed.values['model-alias'] ?? parsed.values.model;
  if (modelAlias) {
    const target = modelMap[modelAlias] ?? modelMap['*'];
    if (!target) {
      throw new Error(`未命中路由且缺少兜底: ${routeType}`);
    }
    console.log(formatRouteTarget(target));
    return;
  }

  const chunks: string[] = [];
  for (const [alias, target] of Object.entries(modelMap)) {
    if (alias === '*') continue;
    chunks.push(`${alias} : ${formatRouteTarget(target)}`);
  }
  const fallback = modelMap['*'];
  if (fallback) {
    chunks.push(`default : ${formatRouteTarget(fallback)}`);
  }
  console.log(chunks.join(' | '));
}

async function cmdHealth(): Promise<void> {
  await cleanupIfStale();
  const state = readRuntimeState();
  if (!state) {
    console.log('服务未运行');
    process.exit(1);
  }
  const ok = await checkHealth(state.baseUrl);
  if (!ok) {
    console.log(`健康检查失败: ${state.baseUrl}/api/health`);
    process.exit(1);
  }
  console.log(`健康检查通过: ${state.baseUrl}`);
}

async function cmdRunServer(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      mode: { type: 'string' },
      config: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'idle-timeout': { type: 'string' },
      'log-file': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });
  const mode = parsed.values.mode === 'daemon' ? 'daemon' : 'foreground';
  const portRaw = parsed.values.port;
  const port = portRaw ? Number.parseInt(portRaw, 10) : undefined;
  const idleTimeoutRaw = parsed.values['idle-timeout'];
  const idleTimeoutSeconds = idleTimeoutRaw ? Number.parseInt(idleTimeoutRaw, 10) : undefined;
  await runServerProcess({
    mode,
    config: parsed.values.config,
    host: parsed.values.host,
    port,
    idleTimeoutSeconds: Number.isFinite(idleTimeoutSeconds) ? idleTimeoutSeconds : undefined,
    logFile: parsed.values['log-file'],
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'start':
      await cmdStart(rest);
      return;
    case 'stop':
      await cmdStop();
      return;
    case 'restart':
      await cmdRestart(rest);
      return;
    case 'status':
      await cmdStatus(rest);
      return;
    case 'logs':
      await cmdLogs(rest);
      return;
    case 'init':
      await cmdInit(rest);
      return;
    case 'health':
      await cmdHealth();
      return;
    case 'config':
      await cmdConfig(rest);
      return;
    case 'get-route':
      await cmdGetRoute(rest);
      return;
    case 'version':
      await printVersion();
      return;
    case '__run-server':
      await cmdRunServer(rest);
      return;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      return;
    default:
      console.error(`未知命令: ${command}`);
      printHelp();
      process.exit(1);
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
