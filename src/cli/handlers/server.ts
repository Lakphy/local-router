import { parseArgs } from 'node:util';
import { CliError } from '../errors';
import { emitDiagnostic, emitResult, runCommand } from '../output';
import {
  type CliSharedFlags,
  checkHealth,
  cleanupIfStale,
  parseSharedFlags,
  runServerProcess,
  startDaemon,
  stopProcess,
} from '../process';
import { defineCommand } from '../registry';
import { renderKv } from '../render-md';
import { readRuntimeState } from '../runtime';
import { waitFor } from '../wait';

defineCommand({
  name: 'start',
  summary: '启动 local-router（前台或 --daemon）',
  supportsJson: true,
  mutates: false,
  flags: [
    { name: 'daemon', type: 'boolean', description: '后台运行' },
    { name: 'config', type: 'string', description: '配置文件路径' },
    { name: 'host', type: 'string', description: '监听地址' },
    { name: 'port', type: 'number', description: '监听端口' },
    { name: 'idle-timeout', type: 'number', description: 'Bun 连接空闲超时秒数' },
    {
      name: 'wait-healthy',
      type: 'boolean',
      description: '--daemon 模式下阻塞至健康',
    },
    {
      name: 'timeout',
      type: 'number',
      default: 10,
      description: '阻塞等待超时秒数',
    },
    {
      name: 'print',
      type: 'enum',
      enum: ['json', 'url', 'state'],
      description: '--daemon 后控制 stdout 内容',
    },
  ],
  handler: async (args, flags) =>
    runCommand({
      command: 'start',
      flags,
      fn: async (ctx) => {
        const parsed = parseArgs({
          args,
          options: {
            daemon: { type: 'boolean', default: false },
            'wait-healthy': { type: 'boolean', default: false },
            timeout: { type: 'string' },
            print: { type: 'string' },
          },
          allowPositionals: true,
          strict: false,
        });
        const shared: CliSharedFlags = parseSharedFlags(args);
        if (parsed.values.daemon) {
          await startDaemon(shared);
          if (parsed.values['wait-healthy']) {
            const sec = parsed.values.timeout ? Number.parseInt(parsed.values.timeout, 10) : 10;
            await waitFor({
              check: async () => {
                const s = readRuntimeState();
                return s ? await checkHealth(s.baseUrl) : false;
              },
              timeoutMs: sec * 1000,
              message: `等待健康超时 (${sec}s)`,
            });
          }
          await cleanupIfStale();
          const state = readRuntimeState();
          if (!state) {
            throw new CliError('SERVICE_NOT_RUNNING', 'daemon 启动失败');
          }
          if (parsed.values.print === 'url') {
            process.stdout.write(`${state.baseUrl}\n`);
            return;
          }
          emitResult(ctx, {
            command: 'start',
            data: state,
            md: {
              heading: 'start · ✓ daemon',
              meta: [`pid ${state.pid} · ${state.baseUrl}`],
              data: renderKv([
                { key: 'baseUrl', value: state.baseUrl },
                { key: 'pid', value: state.pid },
                { key: 'configPath', value: state.configPath },
                { key: 'logFile', value: state.logFile ?? '–' },
              ]),
              hints: ['查看状态: `local-router status`', '实时事件: `local-router logs tail`'],
            },
            text: `已在后台启动: pid=${state.pid}, url=${state.baseUrl}`,
          });
          return;
        }
        // foreground: blocks indefinitely
        emitDiagnostic(ctx, 'foreground 模式: Ctrl+C 退出');
        await runServerProcess({
          mode: 'foreground',
          config: shared.config,
          host: shared.host,
          port: shared.port,
          idleTimeoutSeconds: shared.idleTimeoutSeconds,
        });
      },
    }),
});

defineCommand({
  name: 'stop',
  summary: '停止 local-router',
  supportsJson: true,
  flags: [
    { name: 'wait', type: 'boolean', description: '阻塞至进程消失' },
    { name: 'timeout', type: 'number', default: 10, description: '等待超时秒数' },
  ],
  handler: async (args, flags) =>
    runCommand({
      command: 'stop',
      flags,
      fn: async (ctx) => {
        const parsed = parseArgs({
          args,
          options: {
            wait: { type: 'boolean', default: false },
            timeout: { type: 'string' },
          },
          allowPositionals: true,
          strict: false,
        });
        const stopped = await stopProcess();
        if (parsed.values.wait) {
          const sec = parsed.values.timeout ? Number.parseInt(parsed.values.timeout, 10) : 10;
          await waitFor({
            check: () => readRuntimeState() === null,
            timeoutMs: sec * 1000,
            message: `等待停止超时 (${sec}s)`,
          });
        }
        emitResult(ctx, {
          command: 'stop',
          data: { stopped },
          md: {
            heading: stopped ? 'stop · ✓ 已停止' : 'stop · 服务未运行',
          },
          text: stopped ? '服务已停止' : '服务未运行',
        });
      },
    }),
});

defineCommand({
  name: 'restart',
  summary: '重启 local-router',
  supportsJson: true,
  flags: [
    { name: 'daemon', type: 'boolean', description: '后台运行' },
    { name: 'config', type: 'string' },
    { name: 'host', type: 'string' },
    { name: 'port', type: 'number' },
    { name: 'idle-timeout', type: 'number' },
    { name: 'wait-healthy', type: 'boolean' },
    { name: 'timeout', type: 'number', default: 10 },
  ] as never,
  handler: async (args, flags) =>
    runCommand({
      command: 'restart',
      flags,
      fn: async (ctx) => {
        await stopProcess();
        const startCmd = (await import('../registry')).getCommand('start');
        if (!startCmd) throw new CliError('UNKNOWN_ERROR', 'start 命令未注册');
        // Re-invoke start handler directly (bypass exit-code wrapping; we want to bubble)
        const code = await startCmd.handler(args, flags);
        if (code !== 0) {
          throw new CliError('UNKNOWN_ERROR', `restart 阶段二启动失败 (exit ${code})`);
        }
        // start handler emits its own result; nothing extra to emit here
        emitDiagnostic(ctx, 'restart 完成');
      },
    }),
});

defineCommand({
  name: '__run-server',
  hidden: true,
  summary: '内部使用：daemon 子进程入口',
  supportsJson: false,
  handler: async (args, flags) =>
    runCommand({
      command: '__run-server',
      flags,
      fn: async () => {
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
        const idleRaw = parsed.values['idle-timeout'];
        const idleTimeoutSeconds = idleRaw ? Number.parseInt(idleRaw, 10) : undefined;
        await runServerProcess({
          mode,
          config: parsed.values.config,
          host: parsed.values.host,
          port,
          idleTimeoutSeconds: Number.isFinite(idleTimeoutSeconds) ? idleTimeoutSeconds : undefined,
          logFile: parsed.values['log-file'],
        });
      },
    }),
});
