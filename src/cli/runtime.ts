import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface RuntimeState {
  pid: number;
  mode: 'daemon' | 'foreground';
  host: string;
  port: number;
  baseUrl: string;
  configPath: string;
  startedAt: string;
  logFile?: string;
}

export function getRuntimeDirs(): { root: string; run: string; logs: string } {
  const root = join(homedir(), '.local-router');
  return {
    root,
    run: join(root, 'run'),
    logs: join(root, 'logs'),
  };
}

export function getRuntimeFiles(): { pid: string; state: string; daemonLog: string } {
  const dirs = getRuntimeDirs();
  return {
    pid: join(dirs.run, 'local-router.pid'),
    state: join(dirs.run, 'status.json'),
    daemonLog: join(dirs.logs, 'daemon.log'),
  };
}

export function ensureRuntimeDirs(): void {
  const dirs = getRuntimeDirs();
  mkdirSync(dirs.root, { recursive: true });
  mkdirSync(dirs.run, { recursive: true });
  mkdirSync(dirs.logs, { recursive: true });
}

export function writeRuntimeState(state: RuntimeState): void {
  ensureRuntimeDirs();
  const files = getRuntimeFiles();
  writeFileSync(files.pid, `${state.pid}\n`, 'utf-8');
  writeFileSync(files.state, JSON.stringify(state, null, 2), 'utf-8');
}

export function readRuntimeState(): RuntimeState | null {
  const files = getRuntimeFiles();
  if (!existsSync(files.state)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(files.state, 'utf-8')) as RuntimeState;
  } catch {
    return null;
  }
}

export function readPid(): number | null {
  const files = getRuntimeFiles();
  if (!existsSync(files.pid)) {
    return null;
  }
  const content = readFileSync(files.pid, 'utf-8').trim();
  const pid = Number.parseInt(content, 10);
  return Number.isFinite(pid) ? pid : null;
}

export function clearRuntimeFiles(): void {
  const files = getRuntimeFiles();
  rmSync(files.pid, { force: true });
  rmSync(files.state, { force: true });
}

export function resolveConfigArgPath(pathValue: string): string {
  return resolve(pathValue);
}
