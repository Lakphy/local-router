import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { AppConfig, ProviderConfig, ProviderType } from '../config';
import { loadConfig, resolveConfigPath } from '../config';
import { validateConfigOrThrow } from '../config-validate';
import { type ApplyResult, applyConfigChange } from './config-apply';
import { CliError } from './errors';
import type { GlobalFlags } from './global-flags';
import { emitResult, runCommand } from './output';
import { checkHealth } from './process';
import { renderCodeBlock, renderKv, renderTable } from './render-md';
import { requireTarget } from './target';

function readConfig(configArg?: string): { path: string; config: AppConfig } {
  const path = resolveConfigPath(configArg);
  return { path, config: loadConfig(path) };
}

function maskApiKey(k: string): string {
  if (k.length <= 8) return '***';
  return `${k.slice(0, 4)}***${k.slice(-4)}`;
}

function providerTypes(): ProviderType[] {
  return ['openai-completions', 'openai-responses', 'anthropic-messages'];
}

function requireProvider(config: AppConfig, name: string): ProviderConfig {
  const p = config.providers[name];
  if (!p) {
    throw new CliError('PROVIDER_NOT_FOUND', `provider 不存在: ${name}`, {
      details: { name, available: Object.keys(config.providers) },
      hint: '运行 `local-router config provider list` 查看可用 provider',
    });
  }
  return p;
}

function parseBool(v?: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new CliError('USAGE_ERROR', `无效布尔值: ${v}`, { hint: '只接受 true | false' });
}

function applyResultToMd(result: ApplyResult, label: string): string {
  if (result.written) {
    return [
      `已写入 \`${result.path}\``,
      result.backupPath ? `备份 → \`${result.backupPath}\`` : '',
      `变更: +${result.added} / -${result.removed}`,
      '',
      `**diff (${label})**`,
      renderCodeBlock(result.diff, 'diff'),
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `**dry-run** · 未写入 \`${result.path}\``,
    `预计变更: +${result.added} / -${result.removed}`,
    '',
    `**diff (${label})**`,
    renderCodeBlock(result.diff, 'diff'),
  ].join('\n');
}

function applyResultToText(result: ApplyResult): string {
  if (result.written) {
    return `已写入: ${result.path} (备份 ${result.backupPath ?? '–'})`;
  }
  return `[dry-run] 未写入 ${result.path}\n${result.diff}`;
}

async function selectFromList(title: string, items: string[]): Promise<string> {
  if (items.length === 0) {
    throw new CliError('USAGE_ERROR', `${title}: 无可选项`);
  }
  console.log(`${title}:`);
  items.forEach((item, i) => {
    console.log(`  ${i + 1}) ${item}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('请输入序号: ');
    const idx = Number.parseInt(answer, 10) - 1;
    if (!Number.isFinite(idx) || idx < 0 || idx >= items.length) {
      throw new CliError('USAGE_ERROR', '无效选择');
    }
    return items[idx]!;
  } finally {
    rl.close();
  }
}

function ensureNoFlag<T>(name: string, value: T | undefined): asserts value {
  if (!value) {
    throw new CliError('USAGE_ERROR', `${name} 必填`);
  }
}

function configHelp(): string {
  return `
local-router config

Commands:
  config provider list [--json] [--config <path>]
  config provider show <name> [--show-secrets] [--config <path>]
  config provider add <name> --type <type> --base <url> --api-key <key> --model <name> [--image-input] [--reasoning] [--proxy <url>] [--dry-run] [--config <path>]
  config provider add-lan <ip> --type <protocol> [--port 4099] [--dry-run] [--config <path>]
  config provider set <name> [--base <url>] [--api-key <key>] [--proxy <url>] [--dry-run] [--config <path>]
  config provider remove <name> [--force] [--dry-run] [--config <path>]
  config provider model list <provider> [--config <path>]
  config provider model add <provider> <model> [--image-input] [--reasoning] [--dry-run] [--config <path>]
  config provider model set <provider> <model> [--image-input <true|false>] [--reasoning <true|false>] [--dry-run] [--config <path>]
  config provider model remove <provider> <model> [--dry-run] [--config <path>]

  config route list [--entry <entry>] [--config <path>]
  config route show <entry> [--config <path>]
  config route set <entry> <match-model> [--provider <name>] [--model <model>] [--interactive] [--dry-run] [--config <path>]
  config route remove <entry> <match-model> [--allow-remove-fallback] [--dry-run] [--config <path>]

  config resolve --entry <entry> --model <request-model> [--config <path>]
  config validate [--config <path>]
  config apply
  config show [--show-secrets] [--config <path>]
  config diff [--against <backup-id|path>] [--config <path>]
  config import [--file - | path] [--merge|--replace] [--dry-run] [--config <path>]
  config patch [--file - | path] [--dry-run] [--config <path>]
  config backups list [--config <path>]
  config rollback <backup-id> [--dry-run] [--config <path>]
  config route plan --entry <e> --model <m> [--config <path>]
`.trim();
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

async function handleProviderList(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.provider.list',
    flags,
    fn: (ctx) => {
      const parsed = parseArgs({
        args,
        options: { config: { type: 'string' } },
        allowPositionals: true,
        strict: false,
      });
      const { config } = readConfig(parsed.values.config);
      const rows = Object.entries(config.providers).map(([name, p]) => ({
        name,
        type: p.type,
        base: p.base,
        models: Object.keys(p.models).length,
        proxy: p.proxy ?? '',
      }));
      const text = [
        'NAME\tTYPE\tMODELS\tBASE',
        ...rows.map((r) => `${r.name}\t${r.type}\t${r.models}\t${r.base}`),
      ].join('\n');
      emitResult(ctx, {
        command: 'config.provider.list',
        data: rows,
        md: {
          heading: `config.provider.list · ${rows.length} 个 provider`,
          data: renderTable(
            ['name', 'type', 'base', 'models', 'proxy'],
            rows.map((r) => [
              `\`${r.name}\``,
              `\`${r.type}\``,
              `\`${r.base}\``,
              r.models,
              r.proxy || '–',
            ])
          ),
          hints: [
            '详情: `local-router config provider show <name>`',
            '新增: `local-router config provider add <name> --type ... --base ... --api-key ... --model ...`',
          ],
        },
        text,
      });
    },
  });
}

async function handleProviderShow(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.provider.show',
    flags,
    fn: (ctx) => {
      const [name, ...flagArgs] = args;
      ensureNoFlag('name', name);
      const parsed = parseArgs({
        args: flagArgs,
        options: {
          'show-secrets': { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const { config } = readConfig(parsed.values.config);
      const p = requireProvider(config, name);
      const showSecrets = parsed.values['show-secrets'] || flags.output === 'json';
      const out = {
        ...p,
        apiKey: showSecrets ? p.apiKey : maskApiKey(p.apiKey),
      };
      const kv = [
        { key: 'name', value: name },
        { key: 'type', value: out.type },
        { key: 'base', value: out.base },
        { key: 'apiKey', value: out.apiKey },
        { key: 'proxy', value: out.proxy ?? '–' },
        { key: 'models', value: Object.keys(out.models).length },
      ];
      emitResult(ctx, {
        command: 'config.provider.show',
        data: out,
        md: {
          heading: `config.provider.show · ${name}`,
          data: renderKv(kv),
          hints: showSecrets ? [] : ['查看密钥原文: `--show-secrets`'],
        },
        text: JSON.stringify(out, null, 2),
      });
    },
  });
}

async function handleProviderAdd(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.provider.add',
    flags,
    fn: (ctx) => {
      const [name, ...flagArgs] = args;
      ensureNoFlag('name', name);
      const parsed = parseArgs({
        args: flagArgs,
        options: {
          type: { type: 'string' },
          base: { type: 'string' },
          'api-key': { type: 'string' },
          model: { type: 'string' },
          'image-input': { type: 'boolean', default: false },
          reasoning: { type: 'boolean', default: false },
          proxy: { type: 'string' },
          'dry-run': { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const { path, config } = readConfig(parsed.values.config);
      if (config.providers[name]) {
        throw new CliError('PROVIDER_EXISTS', `provider 已存在: ${name}`, {
          hint: '使用 `config provider set` 修改字段',
        });
      }
      const type = parsed.values.type as ProviderType | undefined;
      if (!type || !providerTypes().includes(type)) {
        throw new CliError(
          'USAGE_ERROR',
          'type 必填且必须是 openai-completions/openai-responses/anthropic-messages',
          { details: { acceptable: providerTypes() } }
        );
      }
      const base = parsed.values.base;
      const apiKey = parsed.values['api-key'];
      const firstModel = parsed.values.model;
      if (!base || !apiKey || !firstModel) {
        throw new CliError('USAGE_ERROR', 'base/api-key/model 必填');
      }
      config.providers[name] = {
        type,
        base,
        apiKey,
        models: {
          [firstModel]: {
            'image-input': parsed.values['image-input'],
            reasoning: parsed.values.reasoning,
          },
        },
        ...(parsed.values.proxy ? { proxy: parsed.values.proxy } : {}),
      };
      const result = applyConfigChange(path, config, { dryRun: parsed.values['dry-run'] });
      emitResult(ctx, {
        command: 'config.provider.add',
        data: { provider: name, ...result },
        md: {
          heading: `config.provider.add · ${name} · ${result.written ? '✓' : 'dry-run'}`,
          data: applyResultToMd(result, `provider ${name}`),
          hints: result.written
            ? ['热加载: `local-router config apply`']
            : ['执行写入: 去掉 `--dry-run`'],
        },
        text: result.written ? `已添加 provider: ${name}` : applyResultToText(result),
      });
    },
  });
}

async function handleProviderAddLan(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.provider.add-lan',
    flags,
    fn: async (ctx) => {
      const [ip, ...flagArgs] = args;
      ensureNoFlag('ip', ip);
      if (!ip) {
        throw new CliError('USAGE_ERROR', 'ip 必填', {
          hint: '用法: config provider add-lan <ip> --type <protocol> [--port 4099]',
        });
      }
      const parsed = parseArgs({
        args: flagArgs,
        options: {
          type: { type: 'string' },
          port: { type: 'string', default: '4099' },
          'dry-run': { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const type = parsed.values.type as ProviderType | undefined;
      if (!type || !providerTypes().includes(type)) {
        throw new CliError(
          'USAGE_ERROR',
          'type 必填且必须是 openai-completions/openai-responses/anthropic-messages',
          { details: { acceptable: providerTypes() } }
        );
      }
      const portStr = parsed.values.port ?? '4099';
      const port = Number(portStr);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new CliError('USAGE_ERROR', `端口无效: ${portStr}（必须是 1-65535 的整数）`);
      }
      const name = `${ip}-${type}`;
      const { path, config } = readConfig(parsed.values.config);
      if (config.providers[name]) {
        throw new CliError('PROVIDER_EXISTS', `provider 已存在: ${name}`, {
          hint: '使用 `config provider set` 修改字段',
        });
      }

      const url = `http://${ip}:${port}/api/models?protocol=${encodeURIComponent(type)}`;
      let models: string[];
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new CliError('UPSTREAM_UNREACHABLE', `对端返回错误: ${body.error ?? res.status}`, {
            details: { url },
          });
        }
        const data = (await res.json()) as { models?: string[] };
        models = Array.isArray(data.models) ? data.models : [];
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CliError(
          'UPSTREAM_UNREACHABLE',
          `无法连接对端 local-router: ${err instanceof Error ? err.message : err}`,
          { details: { url } }
        );
      }

      if (models.length === 0) {
        throw new CliError(
          'USAGE_ERROR',
          `对端在协议 "${type}" 下没有可用的模型路由，无法创建 provider`,
          { hint: '确认对端已为该协议配置了具体模型路由（而非仅 * 兜底）' }
        );
      }

      const modelMap: Record<string, { 'image-input': boolean; reasoning: boolean }> = {};
      for (const m of models) {
        modelMap[m] = { 'image-input': false, reasoning: false };
      }
      config.providers[name] = {
        type,
        base: `http://${ip}:${port}/${type}`,
        apiKey: 'no_key',
        models: modelMap,
      };
      const result = applyConfigChange(path, config, { dryRun: parsed.values['dry-run'] });
      emitResult(ctx, {
        command: 'config.provider.add-lan',
        data: { provider: name, models: models.length, ...result },
        md: {
          heading: `config.provider.add-lan · ${name} · ${result.written ? '✓' : 'dry-run'}`,
          data: applyResultToMd(result, `provider ${name} (${models.length} 个模型)`),
          hints: result.written
            ? ['热加载: `local-router config apply`']
            : ['执行写入: 去掉 `--dry-run`'],
        },
        text: result.written
          ? `已添加 provider: ${name}（嗅探到 ${models.length} 个模型）`
          : applyResultToText(result),
      });
    },
  });
}

async function handleProviderSet(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.provider.set',
    flags,
    fn: (ctx) => {
      const [name, ...flagArgs] = args;
      ensureNoFlag('name', name);
      const parsed = parseArgs({
        args: flagArgs,
        options: {
          base: { type: 'string' },
          'api-key': { type: 'string' },
          proxy: { type: 'string' },
          'dry-run': { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const { path, config } = readConfig(parsed.values.config);
      const p = requireProvider(config, name);
      if (parsed.values.base) p.base = parsed.values.base;
      if (parsed.values['api-key']) p.apiKey = parsed.values['api-key'];
      if (parsed.values.proxy !== undefined) p.proxy = parsed.values.proxy;
      const result = applyConfigChange(path, config, { dryRun: parsed.values['dry-run'] });
      emitResult(ctx, {
        command: 'config.provider.set',
        data: { provider: name, ...result },
        md: {
          heading: `config.provider.set · ${name} · ${result.written ? '✓' : 'dry-run'}`,
          data: applyResultToMd(result, `provider ${name}`),
        },
        text: result.written ? `已更新 provider: ${name}` : applyResultToText(result),
      });
    },
  });
}

async function handleProviderRemove(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.provider.remove',
    flags,
    fn: (ctx) => {
      const [name, ...flagArgs] = args;
      ensureNoFlag('name', name);
      const parsed = parseArgs({
        args: flagArgs,
        options: {
          force: { type: 'boolean', default: false },
          'dry-run': { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const { path, config } = readConfig(parsed.values.config);
      requireProvider(config, name);
      const referencedRoutes: Array<{ entry: string; match: string }> = [];
      for (const [entry, modelMap] of Object.entries(config.routes)) {
        for (const [match, target] of Object.entries(modelMap)) {
          if (target.provider === name) {
            referencedRoutes.push({ entry, match });
          }
        }
      }

      if (referencedRoutes.length > 0 && !parsed.values.force) {
        throw new CliError(
          'PROVIDER_REFERENCED_BY_ROUTE',
          `provider ${name} 被路由引用 (${referencedRoutes.length} 条)`,
          {
            hint: '加 `--force` 联动清理或先删除路由',
            details: { provider: name, references: referencedRoutes },
            doc: '`local-router docs errors PROVIDER_REFERENCED_BY_ROUTE`',
          }
        );
      }

      if (parsed.values.force) {
        for (const ref of referencedRoutes) {
          delete config.routes[ref.entry]?.[ref.match];
        }
        for (const [entry, modelMap] of Object.entries(config.routes)) {
          if (Object.keys(modelMap).length === 0) {
            delete config.routes[entry];
          }
        }
      }

      delete config.providers[name];
      const result = applyConfigChange(path, config, { dryRun: parsed.values['dry-run'] });
      const cleanedCount = referencedRoutes.length;
      emitResult(ctx, {
        command: 'config.provider.remove',
        data: { provider: name, cleanedRoutes: referencedRoutes, ...result },
        md: {
          heading: `config.provider.remove · ${name} · ${result.written ? '✓' : 'dry-run'}`,
          meta:
            cleanedCount > 0 && parsed.values.force
              ? [`并清理 ${cleanedCount} 条关联路由`]
              : undefined,
          data: applyResultToMd(result, `remove provider ${name}`),
        },
        text: result.written
          ? cleanedCount > 0 && parsed.values.force
            ? `已删除 provider: ${name}，并清理 ${cleanedCount} 条关联路由`
            : `已删除 provider: ${name}`
          : applyResultToText(result),
      });
    },
  });
}

async function handleProviderModel(args: string[], flags: GlobalFlags): Promise<number> {
  const [action, provider, model, ...flagArgs] = args;
  if (!action)
    throw new CliError('USAGE_ERROR', '用法: config provider model <list|add|set|remove> ...');
  if (!provider) throw new CliError('USAGE_ERROR', 'provider 必填');

  if (action === 'list') {
    return runCommand({
      command: 'config.provider.model.list',
      flags,
      fn: (ctx) => {
        const parsed = parseArgs({
          args: flagArgs,
          options: { config: { type: 'string' } },
          allowPositionals: true,
          strict: false,
        });
        const { config } = readConfig(parsed.values.config);
        const p = requireProvider(config, provider);
        const rows = Object.entries(p.models).map(([name, caps]) => ({
          name,
          'image-input': Boolean(caps['image-input']),
          reasoning: Boolean(caps.reasoning),
        }));
        const text = rows
          .map((r) => `${r.name}\timage-input=${r['image-input']}\treasoning=${r.reasoning}`)
          .join('\n');
        emitResult(ctx, {
          command: 'config.provider.model.list',
          data: rows,
          md: {
            heading: `config.provider.model.list · ${provider} · ${rows.length} 个 model`,
            data: renderTable(
              ['model', 'image-input', 'reasoning'],
              rows.map((r) => [
                `\`${r.name}\``,
                r['image-input'] ? '✓' : '–',
                r.reasoning ? '✓' : '–',
              ])
            ),
          },
          text,
        });
      },
    });
  }

  if (!model) throw new CliError('USAGE_ERROR', 'model 必填');

  if (action === 'add') {
    return runCommand({
      command: 'config.provider.model.add',
      flags,
      fn: (ctx) => {
        const parsed = parseArgs({
          args: flagArgs,
          options: {
            'image-input': { type: 'boolean', default: false },
            reasoning: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            config: { type: 'string' },
          },
          allowPositionals: true,
          strict: false,
        });
        const { path, config } = readConfig(parsed.values.config);
        const p = requireProvider(config, provider);
        if (p.models[model]) {
          throw new CliError('MODEL_EXISTS', `model 已存在: ${provider}/${model}`);
        }
        p.models[model] = {
          'image-input': parsed.values['image-input'],
          reasoning: parsed.values.reasoning,
        };
        const result = applyConfigChange(path, config, { dryRun: parsed.values['dry-run'] });
        emitResult(ctx, {
          command: 'config.provider.model.add',
          data: { provider, model, ...result },
          md: {
            heading: `config.provider.model.add · ${provider}/${model} · ${result.written ? '✓' : 'dry-run'}`,
            data: applyResultToMd(result, `provider model ${provider}/${model}`),
          },
          text: result.written ? `已添加 model: ${provider}/${model}` : applyResultToText(result),
        });
      },
    });
  }

  if (action === 'set') {
    return runCommand({
      command: 'config.provider.model.set',
      flags,
      fn: (ctx) => {
        const parsed = parseArgs({
          args: flagArgs,
          options: {
            'image-input': { type: 'string' },
            reasoning: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            config: { type: 'string' },
          },
          allowPositionals: true,
          strict: false,
        });
        const { path, config } = readConfig(parsed.values.config);
        const p = requireProvider(config, provider);
        if (!p.models[model]) {
          throw new CliError('MODEL_NOT_FOUND', `model 不存在: ${provider}/${model}`);
        }
        if (parsed.values['image-input'] !== undefined) {
          p.models[model]!['image-input'] = parseBool(parsed.values['image-input']);
        }
        if (parsed.values.reasoning !== undefined) {
          p.models[model]!.reasoning = parseBool(parsed.values.reasoning);
        }
        const result = applyConfigChange(path, config, { dryRun: parsed.values['dry-run'] });
        emitResult(ctx, {
          command: 'config.provider.model.set',
          data: { provider, model, ...result },
          md: {
            heading: `config.provider.model.set · ${provider}/${model} · ${result.written ? '✓' : 'dry-run'}`,
            data: applyResultToMd(result, `provider model ${provider}/${model}`),
          },
          text: result.written ? `已更新 model: ${provider}/${model}` : applyResultToText(result),
        });
      },
    });
  }

  if (action === 'remove') {
    return runCommand({
      command: 'config.provider.model.remove',
      flags,
      fn: (ctx) => {
        const parsed = parseArgs({
          args: flagArgs,
          options: {
            'dry-run': { type: 'boolean', default: false },
            config: { type: 'string' },
          },
          allowPositionals: true,
          strict: false,
        });
        const { path, config } = readConfig(parsed.values.config);
        const p = requireProvider(config, provider);
        if (!p.models[model]) {
          throw new CliError('MODEL_NOT_FOUND', `model 不存在: ${provider}/${model}`);
        }
        delete p.models[model];
        const result = applyConfigChange(path, config, { dryRun: parsed.values['dry-run'] });
        emitResult(ctx, {
          command: 'config.provider.model.remove',
          data: { provider, model, ...result },
          md: {
            heading: `config.provider.model.remove · ${provider}/${model} · ${result.written ? '✓' : 'dry-run'}`,
            data: applyResultToMd(result, `remove model ${provider}/${model}`),
          },
          text: result.written ? `已删除 model: ${provider}/${model}` : applyResultToText(result),
        });
      },
    });
  }

  throw new CliError('USAGE_ERROR', `未知子命令: provider model ${action}`);
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

function renderRouteRows(
  config: AppConfig,
  entry?: string
): Array<{ entry: string; match: string; provider: string; model: string }> {
  const rows: Array<{ entry: string; match: string; provider: string; model: string }> = [];
  for (const [entryName, modelMap] of Object.entries(config.routes)) {
    if (entry && entryName !== entry) continue;
    for (const [match, target] of Object.entries(modelMap)) {
      rows.push({ entry: entryName, match, provider: target.provider, model: target.model });
    }
  }
  return rows;
}

async function handleRouteList(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.route.list',
    flags,
    fn: (ctx) => {
      const parsed = parseArgs({
        args,
        options: {
          entry: { type: 'string' },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const { config } = readConfig(parsed.values.config);
      const rows = renderRouteRows(config, parsed.values.entry);
      const text = [
        'ENTRY\tMATCH\tTARGET',
        ...rows.map((r) => `${r.entry}\t${r.match}\t${r.provider}/${r.model}`),
      ].join('\n');
      emitResult(ctx, {
        command: 'config.route.list',
        data: rows,
        md: {
          heading: `config.route.list · ${rows.length} 条`,
          data: renderTable(
            ['entry', 'match', 'provider', 'model'],
            rows.map((r) => [
              `\`${r.entry}\``,
              `\`${r.match}\``,
              `\`${r.provider}\``,
              `\`${r.model}\``,
            ])
          ),
          hints: ['解析: `local-router config resolve --entry <e> --model <m>`'],
        },
        text,
      });
    },
  });
}

async function handleRouteShow(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.route.show',
    flags,
    fn: (ctx) => {
      const [entry, ...flagArgs] = args;
      ensureNoFlag('entry', entry);
      const parsed = parseArgs({
        args: flagArgs,
        options: { config: { type: 'string' } },
        allowPositionals: true,
        strict: false,
      });
      const { config } = readConfig(parsed.values.config);
      const modelMap = config.routes[entry];
      if (!modelMap) {
        throw new CliError('ROUTE_NOT_FOUND', `route entry 不存在: ${entry}`, {
          details: { entry, available: Object.keys(config.routes) },
        });
      }
      const rows = Object.entries(modelMap).map(([match, target]) => ({
        match,
        provider: target.provider,
        model: target.model,
        isFallback: match === '*',
      }));
      const text = rows.map((r) => `${entry}.${r.match} -> ${r.provider}/${r.model}`).join('\n');
      emitResult(ctx, {
        command: 'config.route.show',
        data: { entry, rows },
        md: {
          heading: `config.route.show · ${entry}`,
          data: renderTable(
            ['match', 'provider', 'model'],
            rows.map((r) => [
              r.isFallback ? `\`*\` (fallback)` : `\`${r.match}\``,
              `\`${r.provider}\``,
              `\`${r.model}\``,
            ])
          ),
        },
        text,
      });
    },
  });
}

async function handleRouteSet(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.route.set',
    flags,
    fn: async (ctx) => {
      const [entry, matchModel, ...flagArgs] = args;
      if (!entry || !matchModel) {
        throw new CliError(
          'USAGE_ERROR',
          '用法: config route set <entry> <match-model> [--provider] [--model]'
        );
      }
      const parsed = parseArgs({
        args: flagArgs,
        options: {
          provider: { type: 'string' },
          model: { type: 'string' },
          interactive: { type: 'boolean', default: false },
          'dry-run': { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const { path, config } = readConfig(parsed.values.config);

      let provider = parsed.values.provider;
      let model = parsed.values.model;
      const shouldInteractive = parsed.values.interactive || (!provider && !model);
      if (shouldInteractive) {
        const providerNames = Object.keys(config.providers);
        const availableModels: Record<string, string[]> = {};
        for (const [pname, p] of Object.entries(config.providers)) {
          availableModels[pname] = Object.keys(p.models);
        }
        if (flags.noInteractive || !process.stdin.isTTY) {
          throw new CliError('INTERACTIVE_REQUIRED', '需要 --provider 与 --model', {
            hint: '请显式传 --provider 与 --model；或在 TTY 中省略以启用交互选择器',
            details: { availableProviders: providerNames, availableModels },
          });
        }
        if (providerNames.length === 0) {
          throw new CliError('PROVIDER_NOT_FOUND', '当前没有 provider', {
            hint: '先执行: `local-router config provider add <name> ...`',
          });
        }
        provider = await selectFromList('请选择 provider', providerNames);
        const p = requireProvider(config, provider);
        const models = Object.keys(p.models);
        if (models.length === 0) {
          throw new CliError('MODEL_NOT_FOUND', `provider ${provider} 没有可选 model`, {
            hint: `先执行: \`local-router config provider model add ${provider} <model>\``,
          });
        }
        model = await selectFromList(`请选择 ${provider} 的 model`, models);
      }

      if (!provider || !model) {
        throw new CliError('USAGE_ERROR', 'provider/model 必填', {
          hint: '通过 --provider/--model 指定，或使用交互模式',
        });
      }
      const p = requireProvider(config, provider);
      if (!p.models[model]) {
        throw new CliError('MODEL_NOT_FOUND', `model 不存在: ${provider}/${model}`, {
          details: { provider, model, available: Object.keys(p.models) },
        });
      }

      if (!config.routes[entry]) config.routes[entry] = {};
      config.routes[entry]![matchModel] = { provider, model };
      const result = applyConfigChange(path, config, { dryRun: parsed.values['dry-run'] });
      emitResult(ctx, {
        command: 'config.route.set',
        data: { entry, match: matchModel, provider, model, ...result },
        md: {
          heading: `config.route.set · ${entry}.${matchModel} · ${result.written ? '✓' : 'dry-run'}`,
          meta: [`→ \`${provider}/${model}\``],
          data: applyResultToMd(result, `route ${entry}.${matchModel}`),
        },
        text: result.written
          ? `已设置路由: ${entry}.${matchModel} -> ${provider}/${model}`
          : applyResultToText(result),
      });
    },
  });
}

async function handleRouteRemove(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.route.remove',
    flags,
    fn: (ctx) => {
      const [entry, matchModel, ...flagArgs] = args;
      if (!entry || !matchModel) {
        throw new CliError(
          'USAGE_ERROR',
          '用法: config route remove <entry> <match-model> [--allow-remove-fallback]'
        );
      }
      const parsed = parseArgs({
        args: flagArgs,
        options: {
          'allow-remove-fallback': { type: 'boolean', default: false },
          'dry-run': { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const { path, config } = readConfig(parsed.values.config);
      const modelMap = config.routes[entry];
      if (!modelMap || !modelMap[matchModel]) {
        throw new CliError('ROUTE_NOT_FOUND', `路由不存在: ${entry}.${matchModel}`);
      }
      if (matchModel === '*' && !parsed.values['allow-remove-fallback']) {
        throw new CliError('ROUTE_FALLBACK_PROTECTED', '禁止删除 * 兜底规则', {
          hint: '如需删除请加 `--allow-remove-fallback`',
        });
      }
      delete modelMap[matchModel];
      const result = applyConfigChange(path, config, { dryRun: parsed.values['dry-run'] });
      emitResult(ctx, {
        command: 'config.route.remove',
        data: { entry, match: matchModel, ...result },
        md: {
          heading: `config.route.remove · ${entry}.${matchModel} · ${result.written ? '✓' : 'dry-run'}`,
          data: applyResultToMd(result, `remove route ${entry}.${matchModel}`),
        },
        text: result.written ? `已删除路由: ${entry}.${matchModel}` : applyResultToText(result),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// resolve / validate / apply
// ---------------------------------------------------------------------------

async function handleResolve(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.resolve',
    flags,
    fn: (ctx) => {
      const parsed = parseArgs({
        args,
        options: {
          entry: { type: 'string' },
          model: { type: 'string' },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const entry = parsed.values.entry;
      const reqModel = parsed.values.model;
      if (!entry || !reqModel) {
        throw new CliError(
          'USAGE_ERROR',
          '用法: config resolve --entry <entry> --model <request-model>'
        );
      }
      const { config } = readConfig(parsed.values.config);
      const modelMap = config.routes[entry];
      if (!modelMap) {
        throw new CliError('ROUTE_NOT_FOUND', `route entry 不存在: ${entry}`, {
          details: { entry, available: Object.keys(config.routes) },
        });
      }
      const hit = modelMap[reqModel] ? reqModel : '*';
      const target = modelMap[hit];
      if (!target) {
        throw new CliError('ROUTE_NOT_FOUND', `未命中路由且缺少兜底: ${entry}`);
      }
      const provider = requireProvider(config, target.provider);
      const data = {
        matchedRule: `${entry}.${hit}`,
        provider: target.provider,
        targetModel: target.model,
        providerType: provider.type,
        providerBase: provider.base,
        fallbackUsed: hit === '*' && reqModel !== '*',
      };
      const text = [
        `匹配规则: ${data.matchedRule}`,
        `命中 provider: ${data.provider}`,
        `转发 model: ${data.targetModel}`,
        `provider: ${data.providerType} ${data.providerBase}`,
      ].join('\n');
      emitResult(ctx, {
        command: 'config.resolve',
        data,
        md: {
          heading: `config.resolve · ${entry}.${reqModel}`,
          meta: [
            `匹配规则 \`${data.matchedRule}\`${data.fallbackUsed ? ' (fallback)' : ''}`,
            `→ \`${data.provider}/${data.targetModel}\``,
          ],
          data: renderKv([
            { key: 'matchedRule', value: data.matchedRule },
            { key: 'provider', value: data.provider },
            { key: 'targetModel', value: data.targetModel },
            { key: 'providerType', value: data.providerType },
            { key: 'providerBase', value: data.providerBase },
            { key: 'fallbackUsed', value: data.fallbackUsed },
          ]),
        },
        text,
      });
    },
  });
}

async function handleValidate(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.validate',
    flags,
    fn: (ctx) => {
      const parsed = parseArgs({
        args,
        options: { config: { type: 'string' } },
        allowPositionals: true,
        strict: false,
      });
      const { config, path } = readConfig(parsed.values.config);
      try {
        validateConfigOrThrow(config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CliError('CONFIG_INVALID', `配置校验失败: ${msg}`, {
          details: { path },
          cause: err,
        });
      }
      emitResult(ctx, {
        command: 'config.validate',
        data: { ok: true, path },
        md: {
          heading: 'config.validate · ✓ 校验通过',
          data: `配置: \`${path}\``,
        },
        text: `配置校验通过: ${path}`,
      });
    },
  });
}

async function handleApply(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'config.apply',
    flags,
    fn: async (ctx) => {
      const target = await requireTarget(ctx);
      const res = await fetch(`${target.baseUrl}/api/config/apply`, { method: 'POST' });
      if (!res.ok) {
        const text = await res.text();
        throw new CliError('APPLY_FAILED', `apply 失败: ${res.status} ${text}`, {
          details: { status: res.status, baseUrl: target.baseUrl },
        });
      }
      const healthy = await checkHealth(target.baseUrl);
      if (!healthy) {
        throw new CliError('HEALTH_FAILED', `apply 后健康检查失败: ${target.baseUrl}`);
      }
      emitResult(ctx, {
        command: 'config.apply',
        data: { ok: true, baseUrl: target.baseUrl },
        md: {
          heading: 'config.apply · ✓',
          data: `已应用: \`${target.baseUrl}\``,
        },
        text: `配置已应用: ${target.baseUrl}`,
      });
      void args;
    },
  });
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

async function handleProvider(args: string[], flags: GlobalFlags): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return handleProviderList(rest, flags);
    case 'show':
      return handleProviderShow(rest, flags);
    case 'add':
      return handleProviderAdd(rest, flags);
    case 'add-lan':
      return handleProviderAddLan(rest, flags);
    case 'set':
      return handleProviderSet(rest, flags);
    case 'remove':
      return handleProviderRemove(rest, flags);
    case 'model':
      return handleProviderModel(rest, flags);
    default:
      throw new CliError('USAGE_ERROR', `未知子命令: provider ${sub ?? ''}`);
  }
}

async function handleRoute(args: string[], flags: GlobalFlags): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return handleRouteList(rest, flags);
    case 'show':
      return handleRouteShow(rest, flags);
    case 'set':
      return handleRouteSet(rest, flags);
    case 'remove':
      return handleRouteRemove(rest, flags);
    default:
      throw new CliError('USAGE_ERROR', `未知子命令: route ${sub ?? ''}`);
  }
}

export async function cmdConfig(args: string[], flags: GlobalFlags): Promise<number> {
  const [group, ...rest] = args;
  try {
    return await dispatchConfig(group, rest, flags);
  } catch (err) {
    const { emitError, createOutputContext } = await import('./output');
    // 透传用户的 --output 选择，避免 USAGE 错误强制 Markdown
    return emitError(createOutputContext(flags), `config${group ? `.${group}` : ''}`, err);
  }
}

async function dispatchConfig(
  group: string | undefined,
  rest: string[],
  flags: GlobalFlags
): Promise<number> {
  switch (group) {
    case 'provider':
      return handleProvider(rest, flags);
    case 'route':
      // route plan 子命令走 config-extra
      if (rest[0] === 'plan') {
        const { configRoutePlan } = await import('./handlers/config-extra');
        return configRoutePlan(rest.slice(1), flags);
      }
      return handleRoute(rest, flags);
    case 'resolve':
      return handleResolve(rest, flags);
    case 'validate':
      return handleValidate(rest, flags);
    case 'apply':
      return handleApply(rest, flags);
    case 'show': {
      const { configShow } = await import('./handlers/config-extra');
      return configShow(rest, flags);
    }
    case 'diff': {
      const { configDiff } = await import('./handlers/config-extra');
      return configDiff(rest, flags);
    }
    case 'import': {
      const { configImport } = await import('./handlers/config-extra');
      return configImport(rest, flags);
    }
    case 'patch': {
      const { configPatch } = await import('./handlers/config-extra');
      return configPatch(rest, flags);
    }
    case 'backups': {
      if (rest[0] === 'list') {
        const { configBackupsList } = await import('./handlers/config-extra');
        return configBackupsList(rest.slice(1), flags);
      }
      throw new CliError('USAGE_ERROR', '用法: config backups list');
    }
    case 'rollback': {
      const { configRollback } = await import('./handlers/config-extra');
      return configRollback(rest, flags);
    }
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      // Plain help text to stderr; result envelope to stdout.
      return runCommand({
        command: 'config.help',
        flags,
        fn: (ctx) => {
          emitResult(ctx, {
            command: 'config.help',
            data: { help: configHelp() },
            md: {
              heading: 'config · 帮助',
              data: renderCodeBlock(configHelp()),
            },
            text: configHelp(),
          });
        },
      });
    default:
      throw new CliError('USAGE_ERROR', `未知 config 命令: ${group}`, {
        hint: '运行 `local-router config help`',
      });
  }
}
