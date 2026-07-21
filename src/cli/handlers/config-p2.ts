/**
 * PR-4 P2: 开发者愉悦命令
 *
 * - config edit      — 在 $EDITOR 中编辑配置，保存后自动 validate
 * - open <target>    — 打开 admin / docs / logs-dir / config
 * - env --export     — 导出推荐环境变量（OPENAI_BASE_URL 等）
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveConfigPath, resolveLogBaseDir } from '../../config';
import { applyConfigChange } from '../config-apply';
import { CliError } from '../errors';
import { emitResult } from '../output';
import { defineSchemaCommand } from '../registry';
import { renderCodeBlock, renderKv } from '../render-md';
import { guessTargetUrl, resolveTarget } from '../target';

// ─── config edit ─────────────────────────────────────────────────────────────

interface ConfigEditFlags {
  editor?: string;
  config?: string;
}

defineSchemaCommand<ConfigEditFlags>({
  name: 'config edit',
  summary: '在 $EDITOR 中编辑配置（保存后自动校验 + 备份）',
  supportsJson: false,
  mutates: true,
  requiresRunning: false,
  flags: [
    { name: 'editor', type: 'string', description: '指定编辑器（默认读 $EDITOR / $VISUAL）' },
    { name: 'config', type: 'string', description: '配置文件路径' },
  ],
  fn: ({ values, ctx }) => {
    const editor =
      values.editor ??
      process.env.VISUAL ??
      process.env.EDITOR ??
      (process.platform === 'win32' ? 'notepad' : 'vi');
    if (!process.stdin.isTTY) {
      throw new CliError('INTERACTIVE_REQUIRED', 'config edit 需要 TTY', {
        hint: '管道场景请用 `local-router config patch` 或 `config import`',
      });
    }
    const path = resolveConfigPath(values.config);
    if (!existsSync(path)) {
      throw new CliError('CONFIG_NOT_FOUND', `配置文件不存在: ${path}`, {
        hint: '`local-router init` 创建默认配置',
      });
    }
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-router-edit-'));
    const tmpFile = join(tmpDir, 'config.json5');
    let keepTmp = false;
    try {
      copyFileSync(path, tmpFile);
      const result = spawnSync(editor, [tmpFile], { stdio: 'inherit' });
      if (result.error || (typeof result.status === 'number' && result.status !== 0)) {
        throw new CliError(
          'UNKNOWN_ERROR',
          `编辑器退出异常: ${result.error?.message ?? result.status}`
        );
      }
      let edited;
      try {
        edited = loadConfig(tmpFile);
      } catch (err) {
        keepTmp = true;
        throw new CliError('CONFIG_INVALID', `编辑后配置解析失败: ${(err as Error).message}`, {
          hint: `已保留临时文件 ${tmpFile}，可手动修复后 \`local-router config import ${tmpFile}\``,
        });
      }
      const apply = applyConfigChange(path, edited, { dryRun: false });
      emitResult(ctx, {
        command: 'config.edit',
        data: { path, editor, ...apply },
        md: {
          heading: `config.edit · ${apply.written ? '✓' : '⚠️ 无变更'}`,
          data: apply.written
            ? `已写入 \`${apply.path}\`${apply.backupPath ? `（备份 \`${apply.backupPath}\`）` : ''}`
            : '无变更',
          hints: apply.written ? ['重载: `local-router config apply` 或 `restart`'] : [],
        },
        text: apply.written ? `edited=${path}` : 'no-change',
      });
    } finally {
      if (!keepTmp) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    }
  },
});

// ─── open <target> ───────────────────────────────────────────────────────────

interface OpenFlags {
  config?: string;
}

function platformOpen(target: string): { ok: boolean; cmd: string } {
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [target];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', target];
  } else {
    cmd = 'xdg-open';
    args = [target];
  }
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return {
    ok: !r.error && (typeof r.status !== 'number' || r.status === 0),
    cmd: `${cmd} ${args.join(' ')}`,
  };
}

defineSchemaCommand<OpenFlags>({
  name: 'open',
  summary: '在系统默认应用中打开 admin / docs / logs-dir / config',
  supportsJson: true,
  positionals: [
    {
      name: 'target',
      required: true,
      description: 'admin | docs | logs-dir | config',
    },
  ],
  flags: [{ name: 'config', type: 'string', description: '配置文件路径' }],
  fn: async ({ positionals, values, ctx }) => {
    const target = positionals[0];
    if (!target) {
      throw new CliError('USAGE_ERROR', '用法: open <admin|docs|logs-dir|config>');
    }
    let url: string;
    let label: string;
    if (target === 'admin') {
      const resolved = await resolveTarget(ctx.flags);
      url = `${resolved.baseUrl}/admin/`;
      label = 'Web Admin';
    } else if (target === 'docs') {
      url = 'https://github.com/lakphy/local-router#readme';
      label = '在线文档';
    } else if (target === 'logs-dir') {
      const path = resolveConfigPath(values.config);
      const config = loadConfig(path);
      url = resolveLogBaseDir(config.log);
      label = '日志目录';
    } else if (target === 'config') {
      url = resolveConfigPath(values.config);
      label = '配置文件';
    } else {
      throw new CliError('USAGE_ERROR', `未知 target: ${target}`, {
        hint: '支持: admin | docs | logs-dir | config',
      });
    }
    const r = platformOpen(url);
    emitResult(ctx, {
      command: 'open',
      data: { target, url, label, cmd: r.cmd, ok: r.ok },
      md: {
        heading: `open · ${label} · ${r.ok ? '✓' : '✗'}`,
        data: renderKv([
          { key: 'target', value: target },
          { key: 'url', value: url },
          { key: 'cmd', value: r.cmd },
          { key: 'ok', value: r.ok },
        ]),
        hints: r.ok ? [] : ['手动打开: `' + r.cmd + '`'],
      },
      text: r.ok ? `opened: ${url}` : `failed: ${r.cmd}`,
    });
  },
});

// ─── env --export ────────────────────────────────────────────────────────────

interface EnvFlags {
  export?: boolean;
  shell: 'sh' | 'fish' | 'pwsh';
  config?: string;
}

defineSchemaCommand<EnvFlags>({
  name: 'env',
  summary: '推荐环境变量（OPENAI_BASE_URL / ANTHROPIC_BASE_URL）',
  supportsJson: true,
  flags: [
    { name: 'export', type: 'boolean', description: '生成可 eval 的 export 语句' },
    {
      name: 'shell',
      type: 'enum',
      enum: ['sh', 'fish', 'pwsh'],
      default: 'sh',
      description: '目标 shell 语法',
    },
    { name: 'config', type: 'string', description: '配置文件路径' },
  ],
  fn: ({ values, ctx }) => {
    const guess = guessTargetUrl(ctx.flags);
    const baseUrl = guess.baseUrl;
    const running = guess.running;
    const entries: Array<{ key: string; value: string; desc: string }> = [
      {
        key: 'OPENAI_BASE_URL',
        value: `${baseUrl}/openai-completions/v1`,
        desc: 'OpenAI SDK 兼容入口',
      },
      {
        key: 'OPENAI_API_KEY',
        value: 'sk-local-router',
        desc: '占位 token（local-router 不校验）',
      },
      {
        key: 'ANTHROPIC_BASE_URL',
        value: `${baseUrl}/anthropic-messages`,
        desc: 'Anthropic SDK 兼容入口',
      },
      {
        key: 'ANTHROPIC_API_KEY',
        value: 'sk-local-router',
        desc: '占位 token',
      },
    ];
    let script = '';
    if (values.shell === 'fish') {
      script = entries.map((e) => `set -gx ${e.key} ${JSON.stringify(e.value)}`).join('\n');
    } else if (values.shell === 'pwsh') {
      script = entries.map((e) => `$env:${e.key} = ${JSON.stringify(e.value)}`).join('\n');
    } else {
      script = entries.map((e) => `export ${e.key}=${JSON.stringify(e.value)}`).join('\n');
    }
    if (
      values.export &&
      (ctx.flags.output === 'human' ||
        ctx.flags.output === 'text' ||
        ctx.flags.output === 'markdown')
    ) {
      process.stdout.write(`${script}\n`);
      return;
    }
    emitResult(ctx, {
      command: 'env',
      data: {
        baseUrl,
        shell: values.shell,
        running,
        entries,
        script,
      },
      md: {
        heading: `env · ${running ? '✓ 运行中' : '✗ 未运行（使用默认 4099）'}`,
        meta: [`baseUrl: \`${baseUrl}\``],
        data: [
          renderKv(entries.map((e) => ({ key: e.key, value: e.value }))),
          `**${values.shell} 脚本**`,
          renderCodeBlock(script, values.shell === 'pwsh' ? 'powershell' : values.shell),
        ].join('\n\n'),
        hints: [
          '一键 eval（bash/zsh）: `eval "$(local-router env --export)"`',
          'fish: `local-router env --export --shell fish | source`',
          'pwsh: `local-router env --export --shell pwsh | iex`',
        ],
      },
      text: script,
    });
  },
});
