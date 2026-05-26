/**
 * PR-4 P0: 闭环 Web 独占能力
 *
 * - config server lan {status,enable,disable}
 * - config provider plugin {list,add,remove,set}
 * - config export
 */
import { loadConfig, type PluginConfig, resolveConfigPath } from '../../config';
import { applyConfigChange } from '../config-apply';
import { CliError } from '../errors';
import { emitResult } from '../output';
import { defineSchemaCommand } from '../registry';
import { renderCodeBlock, renderKv, renderTable } from '../render-md';

// ─── config server lan {status,enable,disable} ───────────────────────────────

interface ServerLanCommonFlags {
  config?: string;
  'dry-run'?: boolean;
}

defineSchemaCommand<ServerLanCommonFlags>({
  name: 'config server lan status',
  summary: '查看 LAN 访问开关',
  supportsJson: true,
  flags: [{ name: 'config', type: 'string', description: '配置文件路径' }],
  fn: ({ values, ctx }) => {
    const path = resolveConfigPath(values.config);
    const config = loadConfig(path);
    const enabled = !!config.server?.lanAccess?.enabled;
    emitResult(ctx, {
      command: 'config.server.lan.status',
      data: { enabled, host: enabled ? '0.0.0.0' : '127.0.0.1', path },
      md: {
        heading: `config.server.lan.status · ${enabled ? '✓ enabled' : '✗ disabled'}`,
        data: renderKv([
          { key: 'enabled', value: enabled },
          { key: 'host', value: enabled ? '0.0.0.0' : '127.0.0.1' },
          { key: 'configPath', value: path },
        ]),
        hints: enabled
          ? ['关闭: `local-router config server lan disable`']
          : ['启用: `local-router config server lan enable`'],
      },
      text: `lanAccess.enabled=${enabled}`,
    });
  },
});

function setLan(enabled: boolean, label: 'enable' | 'disable') {
  return ({ values, ctx }: { values: ServerLanCommonFlags; ctx: import('../output').OutputContext }) => {
    const path = resolveConfigPath(values.config);
    const config = loadConfig(path);
    config.server = config.server ?? {};
    config.server.lanAccess = { enabled };
    const result = applyConfigChange(path, config, { dryRun: values['dry-run'] });
    emitResult(ctx, {
      command: `config.server.lan.${label}`,
      data: { enabled, ...result },
      md: {
        heading: `config.server.lan.${label} · ${result.written ? '✓' : 'dry-run'}`,
        meta: [
          enabled ? '⚠️ LAN 已开启：其他设备可访问' : 'LAN 已关闭：仅本机可访问',
        ],
        data: result.written
          ? `已写入 \`${result.path}\``
          : renderCodeBlock(result.diff, 'diff'),
        hints: result.written
          ? ['重启生效: `local-router restart`']
          : ['执行写入: 去掉 `--dry-run`'],
      },
      text: result.written
        ? `lanAccess.enabled=${enabled} → ${path}`
        : `[dry-run] lanAccess.enabled=${enabled}`,
    });
  };
}

defineSchemaCommand<ServerLanCommonFlags>({
  name: 'config server lan enable',
  summary: '开启 LAN 访问（监听 0.0.0.0）',
  supportsJson: true,
  mutates: true,
  flags: [
    { name: 'config', type: 'string', description: '配置文件路径' },
    { name: 'dry-run', type: 'boolean', description: '只预览，不写入' },
  ],
  fn: setLan(true, 'enable'),
});

defineSchemaCommand<ServerLanCommonFlags>({
  name: 'config server lan disable',
  summary: '关闭 LAN 访问（仅 127.0.0.1）',
  supportsJson: true,
  mutates: true,
  flags: [
    { name: 'config', type: 'string', description: '配置文件路径' },
    { name: 'dry-run', type: 'boolean', description: '只预览，不写入' },
  ],
  fn: setLan(false, 'disable'),
});

// ─── config provider plugin {list,add,remove,set} ────────────────────────────

interface PluginListFlags {
  config?: string;
}

defineSchemaCommand<PluginListFlags>({
  name: 'config provider plugin list',
  summary: '列出 provider 的 plugins（洋葱顺序）',
  supportsJson: true,
  positionals: [{ name: 'provider', required: true, description: 'provider 名' }],
  flags: [{ name: 'config', type: 'string', description: '配置文件路径' }],
  fn: ({ positionals, values, ctx }) => {
    const name = positionals[0]!;
    const path = resolveConfigPath(values.config);
    const config = loadConfig(path);
    const p = config.providers[name];
    if (!p) throw new CliError('PROVIDER_NOT_FOUND', `provider 不存在: ${name}`);
    const rows = (p.plugins ?? []).map((pl, i) => ({
      index: i,
      package: pl.package,
      params: pl.params ? JSON.stringify(pl.params) : '',
    }));
    emitResult(ctx, {
      command: 'config.provider.plugin.list',
      data: { provider: name, plugins: p.plugins ?? [] },
      md: {
        heading: `config.provider.plugin.list · ${name} · ${rows.length} 个`,
        data:
          rows.length === 0
            ? '（无 plugin）'
            : renderTable(
                ['#', 'package', 'params'],
                rows.map((r) => [r.index, `\`${r.package}\``, r.params || '–'])
              ),
        hints: ['新增: `local-router config provider plugin add <provider> <package>`'],
      },
    });
  },
});

interface PluginAddFlags {
  params?: string;
  index?: number;
  'dry-run'?: boolean;
  config?: string;
}

defineSchemaCommand<PluginAddFlags>({
  name: 'config provider plugin add',
  summary: '为 provider 添加 plugin（npm/路径/URL）',
  supportsJson: true,
  mutates: true,
  positionals: [
    { name: 'provider', required: true, description: 'provider 名' },
    { name: 'package', required: true, description: 'npm 包名 / 路径 / URL' },
  ],
  flags: [
    { name: 'params', type: 'string', description: 'JSON 字符串，传给 create()' },
    { name: 'index', type: 'number', description: '插入位置（默认追加）' },
    { name: 'dry-run', type: 'boolean', description: '只预览，不写入' },
    { name: 'config', type: 'string', description: '配置文件路径' },
  ],
  fn: ({ positionals, values, ctx }) => {
    const [providerName, pkg] = positionals;
    if (!providerName || !pkg) throw new CliError('USAGE_ERROR', '用法: ... add <provider> <package>');
    const path = resolveConfigPath(values.config);
    const config = loadConfig(path);
    const p = config.providers[providerName];
    if (!p) throw new CliError('PROVIDER_NOT_FOUND', `provider 不存在: ${providerName}`);
    let params: Record<string, unknown> | undefined;
    if (values.params) {
      try {
        params = JSON.parse(values.params);
      } catch (err) {
        throw new CliError('USAGE_ERROR', `--params 不是合法 JSON: ${(err as Error).message}`);
      }
    }
    const plugin: PluginConfig = params ? { package: pkg, params } : { package: pkg };
    p.plugins = p.plugins ?? [];
    const max = p.plugins.length;
    const idx = values.index ?? max;
    if (!Number.isInteger(idx) || idx < 0 || idx > max) {
      throw new CliError('USAGE_ERROR', `--index 越界: ${idx}（有效范围 0-${max}）`);
    }
    p.plugins.splice(idx, 0, plugin);
    const result = applyConfigChange(path, config, { dryRun: values['dry-run'] });
    emitResult(ctx, {
      command: 'config.provider.plugin.add',
      data: { provider: providerName, plugin, index: idx, ...result },
      md: {
        heading: `config.provider.plugin.add · ${providerName} · ${result.written ? '✓' : 'dry-run'}`,
        data: result.written
          ? `已添加 plugin \`${pkg}\` 于 index ${idx}`
          : renderCodeBlock(result.diff, 'diff'),
        hints: result.written ? ['热加载: `local-router config apply`'] : [],
      },
    });
  },
});

interface PluginRemoveFlags {
  'dry-run'?: boolean;
  config?: string;
}

defineSchemaCommand<PluginRemoveFlags>({
  name: 'config provider plugin remove',
  summary: '按 index 或 package 名删除 plugin',
  supportsJson: true,
  mutates: true,
  positionals: [
    { name: 'provider', required: true, description: 'provider 名' },
    { name: 'index-or-package', required: true, description: '索引（数字）或包名' },
  ],
  flags: [
    { name: 'dry-run', type: 'boolean', description: '只预览，不写入' },
    { name: 'config', type: 'string', description: '配置文件路径' },
  ],
  fn: ({ positionals, values, ctx }) => {
    const [providerName, target] = positionals;
    if (!providerName || !target) {
      throw new CliError('USAGE_ERROR', '用法: ... remove <provider> <index|package>');
    }
    const path = resolveConfigPath(values.config);
    const config = loadConfig(path);
    const p = config.providers[providerName];
    if (!p) throw new CliError('PROVIDER_NOT_FOUND', `provider 不存在: ${providerName}`);
    if (!p.plugins || p.plugins.length === 0) {
      throw new CliError('USAGE_ERROR', `provider ${providerName} 无 plugin`);
    }
    const idxAsNumber = Number(target);
    let removed: PluginConfig | undefined;
    if (Number.isInteger(idxAsNumber) && idxAsNumber >= 0 && idxAsNumber < p.plugins.length) {
      removed = p.plugins.splice(idxAsNumber, 1)[0];
    } else {
      const matchIdx = p.plugins.findIndex((pl) => pl.package === target);
      if (matchIdx < 0) {
        throw new CliError('USAGE_ERROR', `未找到 plugin: ${target}`, {
          details: { available: p.plugins.map((pl) => pl.package) },
        });
      }
      removed = p.plugins.splice(matchIdx, 1)[0];
    }
    const result = applyConfigChange(path, config, { dryRun: values['dry-run'] });
    emitResult(ctx, {
      command: 'config.provider.plugin.remove',
      data: { provider: providerName, removed, ...result },
      md: {
        heading: `config.provider.plugin.remove · ${providerName} · ${result.written ? '✓' : 'dry-run'}`,
        data: result.written
          ? `已删除: \`${removed?.package ?? target}\``
          : renderCodeBlock(result.diff, 'diff'),
      },
    });
  },
});

interface PluginSetFlags {
  params?: string;
  'dry-run'?: boolean;
  config?: string;
}

defineSchemaCommand<PluginSetFlags>({
  name: 'config provider plugin set',
  summary: '修改指定 index 的 plugin params',
  supportsJson: true,
  mutates: true,
  positionals: [
    { name: 'provider', required: true, description: 'provider 名' },
    { name: 'index', required: true, description: '插件索引（0-based）' },
  ],
  flags: [
    { name: 'params', type: 'string', description: '新的 JSON params（整体替换）' },
    { name: 'dry-run', type: 'boolean', description: '只预览，不写入' },
    { name: 'config', type: 'string', description: '配置文件路径' },
  ],
  fn: ({ positionals, values, ctx }) => {
    const [providerName, idxStr] = positionals;
    if (!providerName || !idxStr) throw new CliError('USAGE_ERROR', '用法: ... set <provider> <index>');
    const idx = Number(idxStr);
    if (!Number.isInteger(idx)) throw new CliError('USAGE_ERROR', `无效 index: ${idxStr}`);
    const path = resolveConfigPath(values.config);
    const config = loadConfig(path);
    const p = config.providers[providerName];
    if (!p) throw new CliError('PROVIDER_NOT_FOUND', `provider 不存在: ${providerName}`);
    const plugin = p.plugins?.[idx];
    if (!plugin) throw new CliError('USAGE_ERROR', `plugin index 越界: ${idx}`);
    if (values.params) {
      try {
        plugin.params = JSON.parse(values.params);
      } catch (err) {
        throw new CliError('USAGE_ERROR', `--params 不是合法 JSON: ${(err as Error).message}`);
      }
    }
    const result = applyConfigChange(path, config, { dryRun: values['dry-run'] });
    emitResult(ctx, {
      command: 'config.provider.plugin.set',
      data: { provider: providerName, index: idx, plugin, ...result },
      md: {
        heading: `config.provider.plugin.set · ${providerName}[${idx}] · ${result.written ? '✓' : 'dry-run'}`,
        data: result.written ? `已更新 plugin[${idx}]` : renderCodeBlock(result.diff, 'diff'),
      },
    });
  },
});

// ─── config export ───────────────────────────────────────────────────────────

interface ExportFlags {
  'mask-secrets'?: boolean;
  format: 'json' | 'json5' | 'yaml';
  config?: string;
}

function maskApiKey(k: string): string {
  if (!k || k.length <= 8) return '***';
  return `${k.slice(0, 4)}***${k.slice(-4)}`;
}

function toYaml(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') {
    if (/[:#\n]/.test(obj)) return JSON.stringify(obj);
    return obj;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj
      .map((v) => {
        const rendered = toYaml(v, indent + 1);
        if (typeof v === 'object' && v !== null) {
          const lines = rendered.split('\n');
          const first = lines[0];
          const rest = lines.slice(1);
          return `${pad}- ${first?.trimStart() ?? ''}\n${rest.map((l) => `${pad}  ${l.replace(new RegExp(`^${pad}`), '')}`).join('\n')}`;
        }
        return `${pad}- ${rendered}`;
      })
      .join('\n');
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return entries
    .map(([k, v]) => {
      const rendered = toYaml(v, indent + 1);
      if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0) {
        return `${pad}${k}:\n${rendered}`;
      }
      if (Array.isArray(v) && v.length > 0 && v.some((x) => typeof x === 'object')) {
        return `${pad}${k}:\n${rendered}`;
      }
      return `${pad}${k}: ${rendered}`;
    })
    .join('\n');
}

defineSchemaCommand<ExportFlags>({
  name: 'config export',
  summary: '导出完整配置（默认 mask 密钥）',
  supportsJson: false,
  flags: [
    { name: 'mask-secrets', type: 'boolean', description: '遮罩 apiKey（默认开启）' },
    {
      name: 'format',
      type: 'enum',
      enum: ['json', 'json5', 'yaml'],
      default: 'json',
      description: '输出格式',
    },
    { name: 'config', type: 'string', description: '配置文件路径' },
  ],
  fn: ({ values, ctx }) => {
    const path = resolveConfigPath(values.config);
    const config = JSON.parse(JSON.stringify(loadConfig(path))) as import('../../config').AppConfig;
    const mask = values['mask-secrets'] !== false; // default true
    if (mask) {
      for (const p of Object.values(config.providers)) {
        if (p.apiKey) p.apiKey = maskApiKey(p.apiKey);
      }
    }
    let payload = '';
    if (values.format === 'yaml') payload = `${toYaml(config)}\n`;
    else if (values.format === 'json5') {
      // Bare-bones JSON5: just unquoted keys via JSON-as-fallback (json5 dep already used elsewhere)
      const JSON5 = require('json5');
      payload = `${JSON5.stringify(config, { space: 2, quote: '"' })}\n`;
    } else payload = `${JSON.stringify(config, null, 2)}\n`;
    if (ctx.flags.output === 'json' || ctx.flags.output === 'ndjson') {
      emitResult(ctx, {
        command: 'config.export',
        data: { format: values.format, masked: mask, content: payload },
      });
      return;
    }
    process.stdout.write(payload);
  },
});
