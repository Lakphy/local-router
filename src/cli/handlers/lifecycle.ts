import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ensureConfigFile, resolveConfigPath, writeDefaultConfigFile } from '../../config';
import { readVersionString } from '../asset-paths';
import { CliError } from '../errors';
import { emitDiagnostic, emitResult, runCommand } from '../output';
import { checkHealth, cleanupIfStale, readLogDelta } from '../process';
import { defineCommand } from '../registry';
import { renderKv } from '../render-md';
import { getRuntimeFiles, readRuntimeState, resolveConfigArgPath } from '../runtime';
import { waitFor } from '../wait';

function fmtUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

defineCommand({
  name: 'version',
  summary: '打印 local-router 版本',
  supportsJson: true,
  handler: async (_args, flags) =>
    runCommand({
      command: 'version',
      flags,
      fn: async (ctx) => {
        const version = await readVersionString();
        emitResult(ctx, {
          command: 'version',
          data: { version },
          md: {
            heading: `version · ${version}`,
            data: renderKv([{ key: 'version', value: version }]),
          },
          text: version,
        });
      },
    }),
});

defineCommand({
  name: 'status',
  summary: '查看 local-router 运行状态',
  supportsJson: true,
  flags: [
    {
      name: 'wait-running',
      type: 'boolean',
      description: '阻塞直到服务运行 + 健康，或超时',
    },
    {
      name: 'wait-stopped',
      type: 'boolean',
      description: '阻塞直到服务停止',
    },
    {
      name: 'timeout',
      type: 'number',
      default: 10,
      description: '阻塞模式下的超时秒数',
    },
  ],
  examples: [
    { title: '一次性查询', cmd: 'local-router status' },
    { title: 'JSON 输出', cmd: 'local-router status --json' },
    { title: '阻塞等待启动', cmd: 'local-router status --wait-running --timeout 10' },
  ],
  handler: async (args, flags) =>
    runCommand({
      command: 'status',
      flags,
      fn: async (ctx) => {
        const parsed = parseArgs({
          args,
          options: {
            'wait-running': { type: 'boolean', default: false },
            'wait-stopped': { type: 'boolean', default: false },
            timeout: { type: 'string' },
          },
          allowPositionals: true,
          strict: false,
        });
        const timeoutSec = parsed.values.timeout ? Number.parseInt(parsed.values.timeout, 10) : 10;
        if (!Number.isFinite(timeoutSec) || timeoutSec < 0) {
          throw new CliError('USAGE_ERROR', `无效 timeout: ${parsed.values.timeout}`);
        }

        if (parsed.values['wait-running']) {
          await waitFor({
            check: async () => {
              const s = readRuntimeState();
              if (!s) return false;
              return await checkHealth(s.baseUrl);
            },
            timeoutMs: timeoutSec * 1000,
            message: `等待服务启动超时 (${timeoutSec}s)`,
          });
        }
        if (parsed.values['wait-stopped']) {
          await waitFor({
            check: () => readRuntimeState() === null,
            timeoutMs: timeoutSec * 1000,
            message: `等待服务停止超时 (${timeoutSec}s)`,
          });
        }

        await cleanupIfStale();
        const state = readRuntimeState();
        if (!state) {
          emitResult(ctx, {
            command: 'status',
            data: { running: false },
            md: {
              heading: 'status · 未运行',
              meta: ['✗ 服务未启动'],
              hints: ['启动: `local-router start --daemon`'],
            },
            text: '未运行',
          });
          return;
        }

        const healthy = await checkHealth(state.baseUrl);
        const checkedAt = new Date().toISOString();
        const startedAtMs = Date.parse(state.startedAt);
        const uptimeSeconds = Number.isFinite(startedAtMs)
          ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
          : null;
        const data = {
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

        const textLines: string[] = [];
        textLines.push(`状态: ${data.running ? 'running' : 'unhealthy'}`);
        textLines.push(`PID: ${data.pid}`);
        textLines.push(`模式: ${data.mode}`);
        textLines.push(`地址: ${data.baseUrl}`);
        textLines.push(`配置: ${data.configPath}`);
        textLines.push(`启动时间: ${data.startedAt}`);
        if (uptimeSeconds !== null) textLines.push(`运行时长: ${uptimeSeconds}s`);
        textLines.push(`健康检查时间: ${data.checkedAt}`);
        if (data.logFile) textLines.push(`日志: ${data.logFile}`);

        emitResult(ctx, {
          command: 'status',
          data,
          md: {
            heading: `status · ${healthy ? 'running' : 'unhealthy'}`,
            meta: [
              `${healthy ? '✓ healthy' : '✗ unhealthy'} · pid ${data.pid} · 模式 ${data.mode}` +
                (uptimeSeconds !== null ? ` · 运行 ${fmtUptime(uptimeSeconds)}` : ''),
              `地址 ${data.baseUrl} · 配置 ${data.configPath}`,
            ],
            data: renderKv([
              { key: 'baseUrl', value: data.baseUrl },
              { key: 'host', value: data.host },
              { key: 'port', value: data.port },
              { key: 'pid', value: data.pid },
              { key: 'startedAt', value: data.startedAt },
              { key: 'uptimeSeconds', value: uptimeSeconds ?? '–' },
              { key: 'logFile', value: data.logFile ?? '–' },
            ]),
            hints: ['实时事件: `local-router logs tail`', `配置面板: ${data.baseUrl}/admin`],
          },
          text: textLines.join('\n'),
        });
      },
    }),
});

defineCommand({
  name: 'health',
  summary: '健康检查（需要服务运行）',
  supportsJson: true,
  requiresRunning: true,
  flags: [
    { name: 'retry', type: 'number', default: 1, description: '失败重试次数' },
    { name: 'retry-interval', type: 'number', default: 1, description: '重试间隔秒数' },
  ],
  handler: async (args, flags) =>
    runCommand({
      command: 'health',
      flags,
      fn: async (ctx) => {
        const parsed = parseArgs({
          args,
          options: {
            retry: { type: 'string', default: '1' },
            'retry-interval': { type: 'string', default: '1' },
          },
          allowPositionals: true,
          strict: false,
        });
        const retry = Math.max(1, Number.parseInt(parsed.values.retry ?? '1', 10) || 1);
        const interval = Math.max(
          0,
          Number.parseInt(parsed.values['retry-interval'] ?? '1', 10) || 1
        );
        await cleanupIfStale();
        const state = readRuntimeState();
        if (!state) {
          throw new CliError('SERVICE_NOT_RUNNING', '服务未运行', {
            hint: '启动: `local-router start --daemon`',
          });
        }
        let ok = false;
        for (let i = 0; i < retry; i++) {
          ok = await checkHealth(state.baseUrl);
          if (ok) break;
          if (i < retry - 1) await sleep(interval * 1000);
        }
        if (!ok) {
          throw new CliError('HEALTH_FAILED', `健康检查失败: ${state.baseUrl}/api/health`, {
            details: { baseUrl: state.baseUrl, retries: retry },
          });
        }
        emitResult(ctx, {
          command: 'health',
          data: { ok: true, baseUrl: state.baseUrl },
          md: {
            heading: 'health · ✓ ok',
            meta: [`地址 ${state.baseUrl}`],
          },
          text: `健康检查通过: ${state.baseUrl}`,
        });
      },
    }),
});

defineCommand({
  name: 'init',
  summary: '初始化配置文件',
  supportsJson: true,
  mutates: true,
  flags: [
    { name: 'config', type: 'string', description: '指定配置文件路径' },
    { name: 'force', type: 'boolean', description: '已存在时覆盖' },
  ],
  handler: async (args, flags) =>
    runCommand({
      command: 'init',
      flags,
      fn: async (ctx) => {
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
          emitResult(ctx, {
            command: 'init',
            data: { path: result.path, reset: true, created: false },
            md: {
              heading: 'init · 已重置',
              data: `已重置配置: \`${result.path}\``,
            },
            text: `已重置配置: ${result.path}`,
          });
          return;
        }
        const result = ensureConfigFile(configPath);
        emitResult(ctx, {
          command: 'init',
          data: { path: result.path, created: result.created, reset: false },
          md: {
            heading: result.created ? 'init · 已创建' : 'init · 已存在',
            data: `${result.created ? '已初始化配置' : '配置已存在'}: \`${result.path}\``,
          },
          text: result.created ? `已初始化配置: ${result.path}` : `配置已存在: ${result.path}`,
        });
      },
    }),
});

function readLastLines(filePath: string, lines: number): { content: string; offset: number } {
  if (!existsSync(filePath)) {
    return { content: '', offset: 0 };
  }
  const full = readFileSync(filePath, 'utf-8');
  const rendered = full.split('\n').slice(-lines).join('\n');
  return { content: rendered, offset: full.length };
}

defineCommand({
  name: 'logs daemon',
  summary: 'daemon 日志（stdout/stderr）',
  supportsJson: false,
  flags: [
    { name: 'follow', type: 'boolean', description: '持续跟随' },
    { name: 'lines', type: 'number', default: 100, description: '尾部行数' },
  ],
  handler: async (args, flags) =>
    runCommand({
      command: 'logs.daemon',
      flags,
      fn: async (ctx) => {
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
        const initial = readLastLines(files.daemonLog, Number.isFinite(lines) ? lines : 100);

        if (!existsSync(files.daemonLog)) {
          emitResult(ctx, {
            command: 'logs.daemon',
            data: { exists: false, path: files.daemonLog, lines: [] },
            md: {
              heading: 'logs.daemon · 文件不存在',
              data: `路径: \`${files.daemonLog}\``,
            },
            text: `日志文件不存在: ${files.daemonLog}`,
          });
          return;
        }

        if (!parsed.values.follow) {
          if (ctx.flags.output === 'json') {
            emitResult(ctx, {
              command: 'logs.daemon',
              data: {
                exists: true,
                path: files.daemonLog,
                lines: initial.content.split('\n').filter((l) => l.length > 0),
              },
            });
            return;
          }
          if (initial.content.trim()) {
            process.stdout.write(initial.content);
            if (!initial.content.endsWith('\n')) process.stdout.write('\n');
          }
          return;
        }

        // follow mode → emit raw stream regardless of format (no MD/JSON wrap)
        if (initial.content.trim()) {
          process.stdout.write(initial.content);
          if (!initial.content.endsWith('\n')) process.stdout.write('\n');
        }
        emitDiagnostic(ctx, '--- follow mode ---');
        let offset = initial.offset;
        while (true) {
          await sleep(1000);
          const delta = readLogDelta(files.daemonLog, offset);
          offset = delta.nextOffset;
          if (delta.content) {
            process.stdout.write(delta.content);
          }
        }
      },
    }),
});
