import { CliError } from '../errors';
import { emitDiagnostic, emitResult } from '../output';
import {
  type CliSharedFlags,
  checkHealth,
  cleanupIfStale,
  runServerProcess,
  startDaemon,
  stopProcess,
} from '../process';
import { defineSchemaCommand } from '../registry';
import { renderKv } from '../render-md';
import { readRuntimeState } from '../runtime';
import { waitFor } from '../wait';

interface StartFlags {
  daemon?: boolean;
  foreground?: boolean;
  config?: string;
  host?: string;
  port?: number;
  'idle-timeout'?: number;
  'wait-healthy'?: boolean;
  timeout: number;
  print?: 'json' | 'url' | 'state';
}

function toShared(v: {
  config?: string;
  host?: string;
  port?: number;
  'idle-timeout'?: number;
}): CliSharedFlags {
  return {
    config: v.config,
    host: v.host,
    port: v.port,
    idleTimeoutSeconds: v['idle-timeout'],
  };
}

defineSchemaCommand<StartFlags>({
  name: 'start',
  summary: '启动 local-router（默认后台 daemon，--foreground 前台）',
  supportsJson: true,
  mutates: false,
  flags: [
    { name: 'daemon', type: 'boolean', default: true, description: '后台运行（默认）' },
    { name: 'foreground', type: 'boolean', description: '前台运行（Ctrl+C 退出）' },
    { name: 'config', type: 'string', description: '配置文件路径' },
    { name: 'host', type: 'string', description: '监听地址' },
    { name: 'port', type: 'number', description: '监听端口' },
    { name: 'idle-timeout', type: 'number', description: 'Bun 连接空闲超时秒数' },
    { name: 'wait-healthy', type: 'boolean', description: '--daemon 模式下阻塞至健康' },
    { name: 'timeout', type: 'number', default: 10, description: '阻塞等待超时秒数' },
    {
      name: 'print',
      type: 'enum',
      enum: ['json', 'url', 'state'],
      description: '--daemon 后控制 stdout 内容',
    },
  ],
  fn: async ({ values, ctx }) => {
    const shared = toShared(values);
    const isDaemon = !values.foreground;
    if (isDaemon) {
      await startDaemon(shared);
      if (values['wait-healthy']) {
        const sec = values.timeout || 10;
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
      if (values.print === 'url') {
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
    emitDiagnostic(ctx, 'foreground 模式: Ctrl+C 退出');
    await runServerProcess({
      mode: 'foreground',
      config: shared.config,
      host: shared.host,
      port: shared.port,
      idleTimeoutSeconds: shared.idleTimeoutSeconds,
    });
  },
});

interface StopFlags {
  wait?: boolean;
  timeout: number;
}

defineSchemaCommand<StopFlags>({
  name: 'stop',
  summary: '停止 local-router',
  supportsJson: true,
  flags: [
    { name: 'wait', type: 'boolean', description: '阻塞至进程消失' },
    { name: 'timeout', type: 'number', default: 10, description: '等待超时秒数' },
  ],
  fn: async ({ values, ctx }) => {
    const stopped = await stopProcess();
    if (values.wait) {
      const sec = values.timeout || 10;
      await waitFor({
        check: () => readRuntimeState() === null,
        timeoutMs: sec * 1000,
        message: `等待停止超时 (${sec}s)`,
      });
    }
    emitResult(ctx, {
      command: 'stop',
      data: { stopped },
      md: { heading: stopped ? 'stop · ✓ 已停止' : 'stop · 服务未运行' },
      text: stopped ? '服务已停止' : '服务未运行',
    });
  },
});

interface RestartFlags extends StartFlags {}

defineSchemaCommand<RestartFlags>({
  name: 'restart',
  summary: '重启 local-router',
  supportsJson: true,
  flags: [
    { name: 'daemon', type: 'boolean', default: true, description: '后台运行（默认）' },
    { name: 'foreground', type: 'boolean', description: '前台运行' },
    { name: 'config', type: 'string', description: '配置文件路径' },
    { name: 'host', type: 'string', description: '监听地址' },
    { name: 'port', type: 'number', description: '监听端口' },
    { name: 'idle-timeout', type: 'number', description: 'Bun 连接空闲超时秒数' },
    { name: 'wait-healthy', type: 'boolean', description: '--daemon 模式下阻塞至健康' },
    { name: 'timeout', type: 'number', default: 10, description: '阻塞等待超时秒数' },
    {
      name: 'print',
      type: 'enum',
      enum: ['json', 'url', 'state'],
      description: '--daemon 后控制 stdout 内容',
    },
  ],
  fn: async ({ positionals, values, flags, ctx }) => {
    await stopProcess();
    const startCmd = (await import('../registry')).getCommand('start');
    if (!startCmd) throw new CliError('UNKNOWN_ERROR', 'start 命令未注册');
    const argv: string[] = [...positionals];
    if (values.foreground) argv.push('--foreground');
    if (values.config) argv.push('--config', values.config);
    if (values.host) argv.push('--host', values.host);
    if (values.port !== undefined) argv.push('--port', String(values.port));
    if (values['idle-timeout'] !== undefined)
      argv.push('--idle-timeout', String(values['idle-timeout']));
    if (values['wait-healthy']) argv.push('--wait-healthy');
    if (values.timeout !== undefined) argv.push('--timeout', String(values.timeout));
    if (values.print) argv.push('--print', values.print);
    const code = await startCmd.handler(argv, flags);
    if (code !== 0) {
      throw new CliError('UNKNOWN_ERROR', `restart 阶段二启动失败 (exit ${code})`);
    }
    emitDiagnostic(ctx, 'restart 完成');
  },
});

interface RunServerFlags {
  mode?: string;
  config?: string;
  host?: string;
  port?: number;
  'idle-timeout'?: number;
  'log-file'?: string;
}

defineSchemaCommand<RunServerFlags>({
  name: '__run-server',
  hidden: true,
  summary: '内部使用：daemon 子进程入口',
  supportsJson: false,
  flags: [
    { name: 'mode', type: 'string', description: 'daemon 或 foreground' },
    { name: 'config', type: 'string', description: '配置路径' },
    { name: 'host', type: 'string', description: '监听 host' },
    { name: 'port', type: 'number', description: '监听 port' },
    { name: 'idle-timeout', type: 'number', description: '空闲超时' },
    { name: 'log-file', type: 'string', description: '日志文件路径' },
  ],
  fn: async ({ values }) => {
    const mode = values.mode === 'daemon' ? 'daemon' : 'foreground';
    await runServerProcess({
      mode,
      config: values.config,
      host: values.host,
      port: values.port,
      idleTimeoutSeconds: values['idle-timeout'],
      logFile: values['log-file'],
    });
  },
});
