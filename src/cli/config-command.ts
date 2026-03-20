import { createInterface } from 'node:readline/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import JSON5 from 'json5';
import type { AppConfig, ProviderConfig, ProviderType } from '../config';
import { loadConfig, resolveConfigPath } from '../config';
import { validateConfigOrThrow } from '../config-validate';
import {
  buildImportResult,
  ccsDbExists,
  getDefaultCCSDbPath,
  isAlreadyImported,
  mergeImportIntoConfig,
  readCCSProviders,
  validateString,
} from '../ccs-import';
import { cleanupIfStale, checkHealth } from './process';
import { readRuntimeState } from './runtime';

function readConfig(configArg?: string): { path: string; config: AppConfig } {
  const path = resolveConfigPath(configArg);
  return { path, config: loadConfig(path) };
}

function saveConfig(path: string, config: AppConfig): void {
  validateConfigOrThrow(config);
  const backupDir = join(dirname(path), '.backups');
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `config-${Date.now()}.json5`);
  writeFileSync(backupPath, readFileSync(path, 'utf-8'), 'utf-8');
  const content = JSON5.stringify(config, { space: 2, quote: '"' });
  writeFileSync(path, content, 'utf-8');
}

function maskApiKey(k: string): string {
  if (k.length <= 8) return '***';
  return `${k.slice(0, 4)}***${k.slice(-4)}`;
}

function providerTypes(): ProviderType[] {
  return ['openai-completions', 'openai-responses', 'anthropic-messages'];
}

async function selectFromList(title: string, items: string[]): Promise<string> {
  if (items.length === 0) throw new Error(`${title}: 无可选项`);
  console.log(`${title}:`);
  items.forEach((item, i) => console.log(`  ${i + 1}) ${item}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('请输入序号: ');
    const idx = Number.parseInt(answer, 10) - 1;
    if (!Number.isFinite(idx) || idx < 0 || idx >= items.length) {
      throw new Error('无效选择');
    }
    return items[idx] as string;
  } finally {
    rl.close();
  }
}

function printConfigHelp(): void {
  console.log(`
local-router config

Commands:
  config provider list [--json] [--config <path>]
  config provider show <name> [--show-secrets] [--json] [--config <path>]
  config provider add <name> --type <type> --base <url> --api-key <key> --model <name> [--image-input] [--reasoning] [--config <path>]
  config provider set <name> [--base <url>] [--api-key <key>] [--proxy <url>] [--config <path>]
  config provider remove <name> [--force] [--config <path>]
  config provider model list <provider> [--json] [--config <path>]
  config provider model add <provider> <model> [--image-input] [--reasoning] [--config <path>]
  config provider model set <provider> <model> [--image-input <true|false>] [--reasoning <true|false>] [--config <path>]
  config provider model remove <provider> <model> [--config <path>]

  config route list [--entry <entry>] [--json] [--config <path>]
  config route show <entry> [--json] [--config <path>]
  config route set <entry> <match-model> [--provider <name>] [--model <model>] [--interactive] [--config <path>]
  config route remove <entry> <match-model> [--allow-remove-fallback] [--config <path>]

  config resolve --entry <entry> --model <request-model> [--json] [--config <path>]
  config validate [--config <path>]
  config apply
  config import-ccs [--db <path>] [--config <path>] [--yes]
`);
}

function parseBool(v?: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`无效布尔值: ${v}`);
}

function requireProvider(config: AppConfig, name: string): ProviderConfig {
  const p = config.providers[name];
  if (!p) throw new Error(`provider 不存在: ${name}`);
  return p;
}

async function handleProvider(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const parsed = parseArgs({ args: rest, options: { json: { type: 'boolean', default: false }, config: { type: 'string' } }, allowPositionals: true, strict: false });
    const { config } = readConfig(parsed.values.config);
    const rows = Object.entries(config.providers).map(([name, p]) => ({ name, type: p.type, base: p.base, models: Object.keys(p.models).length, proxy: p.proxy ?? '' }));
    if (parsed.values.json) return void console.log(JSON.stringify(rows, null, 2));
    console.log('NAME\tTYPE\tMODELS\tBASE');
    rows.forEach((r) => console.log(`${r.name}\t${r.type}\t${r.models}\t${r.base}`));
    return;
  }
  if (sub === 'show') {
    const [name, ...flagArgs] = rest;
    if (!name) throw new Error('用法: config provider show <name>');
    const parsed = parseArgs({ args: flagArgs, options: { json: { type: 'boolean', default: false }, 'show-secrets': { type: 'boolean', default: false }, config: { type: 'string' } }, allowPositionals: true, strict: false });
    const { config } = readConfig(parsed.values.config);
    const p = requireProvider(config, name);
    const out = { ...p, apiKey: parsed.values['show-secrets'] ? p.apiKey : maskApiKey(p.apiKey) };
    if (parsed.values.json) return void console.log(JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (sub === 'add') {
    const [name, ...flagArgs] = rest;
    if (!name) throw new Error('用法: config provider add <name> --type <type> --base <url> --api-key <key> --model <name>');
    const parsed = parseArgs({ args: flagArgs, options: { type: { type: 'string' }, base: { type: 'string' }, 'api-key': { type: 'string' }, model: { type: 'string' }, 'image-input': { type: 'boolean', default: false }, reasoning: { type: 'boolean', default: false }, proxy: { type: 'string' }, config: { type: 'string' } }, allowPositionals: true, strict: false });
    const { path, config } = readConfig(parsed.values.config);
    if (config.providers[name]) throw new Error(`provider 已存在: ${name}`);
    const type = parsed.values.type as ProviderType | undefined;
    if (!type || !providerTypes().includes(type)) throw new Error('type 必填且必须是 openai-completions/openai-responses/anthropic-messages');
    const base = parsed.values.base;
    const apiKey = parsed.values['api-key'];
    const firstModel = parsed.values.model;
    if (!base || !apiKey || !firstModel) throw new Error('base/api-key/model 必填');
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
    saveConfig(path, config);
    console.log(`已添加 provider: ${name}`);
    return;
  }
  if (sub === 'set') {
    const [name, ...flagArgs] = rest;
    if (!name) throw new Error('用法: config provider set <name> [--base] [--api-key] [--proxy]');
    const parsed = parseArgs({ args: flagArgs, options: { base: { type: 'string' }, 'api-key': { type: 'string' }, proxy: { type: 'string' }, config: { type: 'string' } }, allowPositionals: true, strict: false });
    const { path, config } = readConfig(parsed.values.config);
    const p = requireProvider(config, name);
    if (parsed.values.base) p.base = parsed.values.base;
    if (parsed.values['api-key']) p.apiKey = parsed.values['api-key'];
    if (parsed.values.proxy !== undefined) p.proxy = parsed.values.proxy;
    saveConfig(path, config);
    console.log(`已更新 provider: ${name}`);
    return;
  }
  if (sub === 'remove') {
    const [name, ...flagArgs] = rest;
    if (!name) throw new Error('用法: config provider remove <name> [--force]');
    const parsed = parseArgs({ args: flagArgs, options: { force: { type: 'boolean', default: false }, config: { type: 'string' } }, allowPositionals: true, strict: false });
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
      const first = referencedRoutes[0];
      throw new Error(`provider ${name} 被路由引用: ${first?.entry}.${first?.match}，如需删除并联动清理路由请加 --force`);
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
    saveConfig(path, config);
    if (parsed.values.force && referencedRoutes.length > 0) {
      console.log(`已删除 provider: ${name}，并清理 ${referencedRoutes.length} 条关联路由`);
    } else {
      console.log(`已删除 provider: ${name}`);
    }
    return;
  }
  if (sub === 'model') {
    const [action, provider, model, ...flagArgs] = rest;
    if (!action) throw new Error('用法: config provider model <list|add|set|remove> ...');
    if (!provider) throw new Error('provider 必填');

    if (action === 'list') {
      const parsed = parseArgs({
        args: flagArgs,
        options: { config: { type: 'string' }, json: { type: 'boolean', default: false } },
        allowPositionals: true,
        strict: false,
      });
      const { config } = readConfig(parsed.values.config);
      const p = requireProvider(config, provider);
      const rows = Object.entries(p.models).map(([name, caps]) => ({ name, ...caps }));
      if (parsed.values.json) return void console.log(JSON.stringify(rows, null, 2));
      rows.forEach((r) =>
        console.log(`${r.name}	image-input=${Boolean(r['image-input'])}	reasoning=${Boolean(r.reasoning)}`)
      );
      return;
    }

    if (!model) throw new Error('model 必填');

    if (action === 'add') {
      const parsed = parseArgs({
        args: flagArgs,
        options: {
          'image-input': { type: 'boolean', default: false },
          reasoning: { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const { path, config } = readConfig(parsed.values.config);
      const p = requireProvider(config, provider);
      p.models[model] = {
        'image-input': parsed.values['image-input'],
        reasoning: parsed.values.reasoning,
      };
      saveConfig(path, config);
      console.log(`已添加 model: ${provider}/${model}`);
      return;
    }

    if (action === 'set') {
      const parsed = parseArgs({
        args: flagArgs,
        options: {
          'image-input': { type: 'string' },
          reasoning: { type: 'string' },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const { path, config } = readConfig(parsed.values.config);
      const p = requireProvider(config, provider);
      if (!p.models[model]) throw new Error(`model 不存在: ${provider}/${model}`);
      if (parsed.values['image-input'] !== undefined) {
        p.models[model]['image-input'] = parseBool(parsed.values['image-input']);
      }
      if (parsed.values.reasoning !== undefined) {
        p.models[model].reasoning = parseBool(parsed.values.reasoning);
      }
      saveConfig(path, config);
      console.log(`已更新 model: ${provider}/${model}`);
      return;
    }

    if (action === 'remove') {
      const parsed = parseArgs({
        args: flagArgs,
        options: { config: { type: 'string' } },
        allowPositionals: true,
        strict: false,
      });
      const { path, config } = readConfig(parsed.values.config);
      const p = requireProvider(config, provider);
      delete p.models[model];
      saveConfig(path, config);
      console.log(`已删除 model: ${provider}/${model}`);
      return;
    }

    throw new Error(`未知子命令: provider model ${action}`);
  }

  throw new Error(`未知子命令: provider ${sub ?? ''}`);
}

function renderRouteRows(config: AppConfig, entry?: string): Array<{ entry: string; match: string; provider: string; model: string }> {
  const rows: Array<{ entry: string; match: string; provider: string; model: string }> = [];
  for (const [entryName, modelMap] of Object.entries(config.routes)) {
    if (entry && entryName !== entry) continue;
    for (const [match, target] of Object.entries(modelMap)) {
      rows.push({ entry: entryName, match, provider: target.provider, model: target.model });
    }
  }
  return rows;
}

async function handleRoute(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const parsed = parseArgs({ args: rest, options: { entry: { type: 'string' }, json: { type: 'boolean', default: false }, config: { type: 'string' } }, allowPositionals: true, strict: false });
    const { config } = readConfig(parsed.values.config);
    const rows = renderRouteRows(config, parsed.values.entry);
    if (parsed.values.json) return void console.log(JSON.stringify(rows, null, 2));
    console.log('ENTRY\tMATCH\tTARGET');
    rows.forEach((r) => console.log(`${r.entry}\t${r.match}\t${r.provider}/${r.model}`));
    return;
  }
  if (sub === 'show') {
    const [entry, ...flagArgs] = rest;
    if (!entry) throw new Error('用法: config route show <entry>');
    const parsed = parseArgs({ args: flagArgs, options: { json: { type: 'boolean', default: false }, config: { type: 'string' } }, allowPositionals: true, strict: false });
    const { config } = readConfig(parsed.values.config);
    const modelMap = config.routes[entry];
    if (!modelMap) throw new Error(`route entry 不存在: ${entry}`);
    if (parsed.values.json) return void console.log(JSON.stringify(modelMap, null, 2));
    Object.entries(modelMap).forEach(([match, target]) => console.log(`${entry}.${match} -> ${target.provider}/${target.model}`));
    return;
  }
  if (sub === 'set') {
    const [entry, matchModel, ...flagArgs] = rest;
    if (!entry || !matchModel) throw new Error('用法: config route set <entry> <match-model> [--provider] [--model]');
    const parsed = parseArgs({ args: flagArgs, options: { provider: { type: 'string' }, model: { type: 'string' }, interactive: { type: 'boolean', default: false }, config: { type: 'string' } }, allowPositionals: true, strict: false });
    const { path, config } = readConfig(parsed.values.config);

    let provider = parsed.values.provider;
    let model = parsed.values.model;
    const shouldInteractive = parsed.values.interactive || (!provider && !model);
    if (shouldInteractive) {
      if (!process.stdin.isTTY) {
        throw new Error('请在非交互环境下使用 --provider 与 --model，或在 TTY 中运行以启用选择器');
      }
      const providerNames = Object.keys(config.providers);
      if (providerNames.length === 0) {
        throw new Error('当前没有 provider，请先执行: local-router config provider add <name> ...');
      }
      provider = await selectFromList('请选择 provider', providerNames);
      const p = requireProvider(config, provider);
      const models = Object.keys(p.models);
      if (models.length === 0) {
        throw new Error(`provider ${provider} 没有可选 model，请先执行: local-router config provider model add ${provider} <model>`);
      }
      model = await selectFromList(`请选择 ${provider} 的 model`, models);
    }

    if (!provider || !model) throw new Error('provider/model 必填；可通过 --provider/--model 指定，或使用交互模式');
    const p = requireProvider(config, provider);
    if (!p.models[model]) throw new Error(`model 不存在于 provider: ${provider}/${model}`);

    if (!config.routes[entry]) config.routes[entry] = {};
    config.routes[entry][matchModel] = { provider, model };
    saveConfig(path, config);
    console.log(`已设置路由: ${entry}.${matchModel} -> ${provider}/${model}`);
    return;
  }
  if (sub === 'remove') {
    const [entry, matchModel, ...flagArgs] = rest;
    if (!entry || !matchModel) throw new Error('用法: config route remove <entry> <match-model> [--allow-remove-fallback]');
    const parsed = parseArgs({ args: flagArgs, options: { 'allow-remove-fallback': { type: 'boolean', default: false }, config: { type: 'string' } }, allowPositionals: true, strict: false });
    const { path, config } = readConfig(parsed.values.config);
    const modelMap = config.routes[entry];
    if (!modelMap || !modelMap[matchModel]) throw new Error(`路由不存在: ${entry}.${matchModel}`);
    if (matchModel === '*' && !parsed.values['allow-remove-fallback']) {
      throw new Error('禁止删除 * 兜底规则，如需删除请加 --allow-remove-fallback');
    }
    delete modelMap[matchModel];
    saveConfig(path, config);
    console.log(`已删除路由: ${entry}.${matchModel}`);
    return;
  }
  throw new Error(`未知子命令: route ${sub ?? ''}`);
}

async function handleResolve(args: string[]): Promise<void> {
  const parsed = parseArgs({ args, options: { entry: { type: 'string' }, model: { type: 'string' }, json: { type: 'boolean', default: false }, config: { type: 'string' } }, allowPositionals: true, strict: false });
  const entry = parsed.values.entry;
  const reqModel = parsed.values.model;
  if (!entry || !reqModel) throw new Error('用法: config resolve --entry <entry> --model <request-model>');
  const { config } = readConfig(parsed.values.config);
  const modelMap = config.routes[entry];
  if (!modelMap) throw new Error(`route entry 不存在: ${entry}`);
  const hit = modelMap[reqModel] ? reqModel : '*';
  const target = modelMap[hit];
  if (!target) throw new Error(`未命中路由且缺少兜底: ${entry}`);
  const provider = requireProvider(config, target.provider);
  const payload = { matchedRule: `${entry}.${hit}`, provider: target.provider, targetModel: target.model, providerType: provider.type, providerBase: provider.base };
  if (parsed.values.json) return void console.log(JSON.stringify(payload, null, 2));
  console.log(`匹配规则: ${payload.matchedRule}`);
  console.log(`命中 provider: ${payload.provider}`);
  console.log(`转发 model: ${payload.targetModel}`);
  console.log(`provider: ${payload.providerType} ${payload.providerBase}`);
}

async function handleValidate(args: string[]): Promise<void> {
  const parsed = parseArgs({ args, options: { config: { type: 'string' } }, allowPositionals: true, strict: false });
  const { config, path } = readConfig(parsed.values.config);
  validateConfigOrThrow(config);
  console.log(`配置校验通过: ${path}`);
}

async function handleApply(): Promise<void> {
  await cleanupIfStale();
  const state = readRuntimeState();
  if (!state) throw new Error('服务未运行，无法 apply');
  const res = await fetch(`${state.baseUrl}/api/config/apply`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`apply 失败: ${res.status} ${text}`);
  }
  const healthy = await checkHealth(state.baseUrl);
  if (!healthy) throw new Error(`apply 后健康检查失败: ${state.baseUrl}`);
  console.log(`配置已应用: ${state.baseUrl}`);
}

function maskApiKeyShort(k: string): string {
  if (k.length <= 8) return '***';
  return `${k.slice(0, 4)}***${k.slice(-4)}`;
}

async function handleImportCCS(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      config: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const dbPath = parsed.values.db ?? getDefaultCCSDbPath();
  if (!ccsDbExists(dbPath)) {
    throw new Error(`CCS 数据库不存在: ${dbPath}\n请确认已安装并使用过 CC Switch (https://github.com/farion1231/cc-switch)`);
  }

  const ccsProviders = readCCSProviders(dbPath);
  if (ccsProviders.length === 0) {
    console.log('CCS 数据库中未找到 Claude 供应商配置');
    return;
  }

  console.log(`\n找到 ${ccsProviders.length} 个 CCS 供应商:\n`);
  ccsProviders.forEach((p, i) => {
    const env = (p.settingsConfig?.env ?? {}) as Record<string, unknown>;
    const base = validateString(env.ANTHROPIC_BASE_URL) || '(未设置)';
    const current = p.isCurrent ? ' [当前活跃]' : '';
    console.log(`  ${i + 1}) ${p.name}${current}`);
    console.log(`     Base URL: ${base}`);
  });
  console.log();

  let selected = ccsProviders;
  if (!parsed.values.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('请输入要导入的序号（逗号分隔，* 导入全部，q 取消）: ');
      const trimmed = answer.trim();
      if (trimmed === 'q' || trimmed === '') {
        console.log('已取消');
        return;
      }
      if (trimmed !== '*') {
        const indices = trimmed
          .split(',')
          .map((s) => Number.parseInt(s.trim(), 10) - 1)
          .filter((i) => !Number.isNaN(i) && i >= 0 && i < ccsProviders.length);
        selected = indices.map((i) => ccsProviders[i]!);
        if (selected.length === 0) {
          console.log('未选择有效的供应商');
          return;
        }
      }
    } finally {
      rl.close();
    }
  }

  const { path, config } = readConfig(parsed.values.config);

  // Filter out providers already imported (by base + apiKey match)
  const notYetImported = selected.filter((p) => !isAlreadyImported(config, p));
  if (notYetImported.length < selected.length) {
    const skippedCount = selected.length - notYetImported.length;
    console.log(`跳过 ${skippedCount} 个已导入的供应商（base + apiKey 匹配）`);
  }
  if (notYetImported.length === 0) {
    console.log('所有选中的供应商均已导入，无需重复操作');
    return;
  }

  const existingKeys = new Set(Object.keys(config.providers));
  const importResult = buildImportResult(notYetImported, existingKeys);

  if (Object.keys(importResult.providers).length === 0) {
    console.log('没有可导入的供应商（可能缺少 Base URL 配置）');
    return;
  }

  console.log('\n将要导入以下供应商:');
  for (const [key, p] of Object.entries(importResult.providers)) {
    console.log(`  - ${key} (${p.type}) -> ${p.base}`);
    console.log(`    API Key: ${maskApiKeyShort(p.apiKey)}`);
    console.log(`    Models: ${Object.keys(p.models).join(', ') || '(无)'}`);
  }
  console.log();

  const { imported, skipped } = mergeImportIntoConfig(config, importResult);
  saveConfig(path, config);

  if (imported.length > 0) {
    console.log(`已导入 ${imported.length} 个供应商: ${imported.join(', ')}`);
  }
  if (skipped.length > 0) {
    console.log(`跳过 ${skipped.length} 个已存在的供应商: ${skipped.join(', ')}`);
  }
  console.log(`配置已保存: ${path}`);
}

export async function cmdConfig(args: string[]): Promise<void> {
  const [group, ...rest] = args;
  switch (group) {
    case 'provider':
      await handleProvider(rest);
      return;
    case 'route':
      await handleRoute(rest);
      return;
    case 'resolve':
      await handleResolve(rest);
      return;
    case 'validate':
      await handleValidate(rest);
      return;
    case 'apply':
      await handleApply();
      return;
    case 'import-ccs':
      await handleImportCCS(rest);
      return;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printConfigHelp();
      return;
    default:
      throw new Error(`未知 config 命令: ${group}`);
  }
}
