import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { Database } from 'bun:sqlite';
import type { AppConfig, ModelCapabilities, ProviderConfig, ProviderType, RouteTarget } from './config';

export interface CCSProvider {
  id: string;
  name: string;
  settingsConfig: Record<string, unknown>;
  meta?: Record<string, unknown>;
  isCurrent: boolean;
}

export interface ImportedProvider {
  key: string;
  name: string;
  type: ProviderType;
  base: string;
  apiKey: string;
  models: Record<string, ModelCapabilities>;
}

export interface ImportResult {
  providers: Record<string, ProviderConfig>;
  routes: Record<string, Record<string, RouteTarget>>;
}

const DEFAULT_CCS_DB_PATH = join(homedir(), '.cc-switch', 'cc-switch.db');
const DEFAULT_CLAUDE_MODELS = ['sonnet', 'haiku', 'opus'] as const;

export function validateString(value: unknown, defaultValue = ''): string {
  return typeof value === 'string' ? value : defaultValue;
}

function validateDbPath(path: string): void {
  const homeDir = homedir();
  const isAllowedPath =
    path.startsWith(homeDir) ||
    path.startsWith('/tmp/') ||
    path.startsWith('/private/tmp/');
  if (!isAllowedPath) {
    throw new Error('数据库路径必须在用户目录或临时目录下');
  }
  const ext = basename(path).split('.').pop()?.toLowerCase();
  if (ext !== 'db' && ext !== 'sqlite') {
    throw new Error('数据库文件必须是 .db 或 .sqlite 格式');
  }
}

function toKebabCase(name: string): string {
  return name
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_/]+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function resolveProviderType(meta?: Record<string, unknown>): ProviderType {
  const apiFormat = meta?.apiFormat;
  if (apiFormat === 'openai_chat') return 'openai-completions';
  if (apiFormat === 'openai_responses') return 'openai-responses';
  return 'anthropic-messages';
}

function extractModels(env: Record<string, unknown>, settingsConfig?: Record<string, unknown>): string[] {
  const modelKeys = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_REASONING_MODEL',
  ];
  const seen = new Set<string>();
  for (const key of modelKeys) {
    const val = env[key];
    if (typeof val === 'string' && val.trim()) {
      seen.add(val.trim());
    }
  }
  // Also extract from settings_config.models array (e.g. QuickSilver format)
  if (Array.isArray(settingsConfig?.models)) {
    for (const m of settingsConfig.models as Array<Record<string, unknown>>) {
      if (typeof m?.id === 'string' && m.id.trim()) {
        seen.add(m.id.trim());
      }
    }
  }
  return Array.from(seen);
}

function uniqueKey(base: string, existingKeys: Set<string>): string {
  if (!existingKeys.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existingKeys.has(candidate)) return candidate;
  }
}

export function getDefaultCCSDbPath(): string {
  return DEFAULT_CCS_DB_PATH;
}

export function ccsDbExists(dbPath?: string): boolean {
  const path = dbPath ? resolve(dbPath) : DEFAULT_CCS_DB_PATH;
  try {
    if (dbPath) validateDbPath(path);
  } catch {
    return false;
  }
  return existsSync(path);
}

export function readCCSProviders(dbPath?: string): CCSProvider[] {
  const path = dbPath ? resolve(dbPath) : DEFAULT_CCS_DB_PATH;
  if (dbPath) validateDbPath(path);

  if (!existsSync(path)) {
    throw new Error(`CCS 数据库不存在: ${path}`);
  }

  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const rows = db
      .query<
        { id: string; name: string; settings_config: string; meta: string | null; is_current: number },
        []
      >("SELECT id, name, settings_config, meta, is_current FROM providers WHERE app_type = 'claude'")
      .all();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      settingsConfig: JSON.parse(row.settings_config) as Record<string, unknown>,
      meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined,
      isCurrent: row.is_current === 1,
    }));
  } finally {
    if (db) {
      try {
        db.close();
      } catch (err) {
        console.error('关闭数据库连接失败:', err);
      }
    }
  }
}

export function convertCCSProvider(ccs: CCSProvider): ImportedProvider | null {
  const env = (ccs.settingsConfig?.env ?? {}) as Record<string, unknown>;
  const base = validateString(env.ANTHROPIC_BASE_URL);
  const apiKey = validateString(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? ccs.settingsConfig?.apiKey);

  if (!base.trim()) return null;

  const type = resolveProviderType(ccs.meta);
  const modelNames = extractModels(env, ccs.settingsConfig);

  // If no models configured, use Claude Code default model aliases (passthrough mode)
  const effectiveModels = modelNames.length > 0 ? modelNames : [...DEFAULT_CLAUDE_MODELS];

  const models: Record<string, ModelCapabilities> = {};
  for (const m of effectiveModels) {
    models[m] = {};
  }

  return {
    key: toKebabCase(ccs.name) || `ccs-${ccs.id.slice(0, 8)}`,
    name: ccs.name,
    type,
    base,
    apiKey,
    models,
  };
}

export function buildImportResult(selected: CCSProvider[], existingKeys?: Set<string>): ImportResult {
  const usedKeys = new Set(existingKeys ?? []);
  const providers: Record<string, ProviderConfig> = {};
  const routes: Record<string, Record<string, RouteTarget>> = {};

  for (const ccs of selected) {
    const converted = convertCCSProvider(ccs);
    if (!converted) continue;

    const key = uniqueKey(converted.key, usedKeys);
    usedKeys.add(key);

    providers[key] = {
      type: converted.type,
      base: converted.base,
      apiKey: converted.apiKey,
      models: converted.models,
    };

    const modelNames = Object.keys(converted.models);
    const defaultModel = modelNames[0];
    if (defaultModel) {
      const routeType = converted.type;
      if (!routes[routeType]) routes[routeType] = {};
      // Only set wildcard route for the first provider of each type
      if (!routes[routeType]['*']) {
        routes[routeType]['*'] = { provider: key, model: defaultModel };
      }
    }
  }

  return { providers, routes };
}

export function mergeImportIntoConfig(config: AppConfig, result: ImportResult): {
  config: AppConfig;
  imported: string[];
  skipped: string[];
} {
  const imported: string[] = [];
  const skipped: string[] = [];

  for (const [key, provider] of Object.entries(result.providers)) {
    if (config.providers[key]) {
      skipped.push(key);
      continue;
    }
    config.providers[key] = provider;
    imported.push(key);
  }

  for (const [routeType, modelMap] of Object.entries(result.routes)) {
    if (!config.routes[routeType]) {
      config.routes[routeType] = {};
    }
    for (const [match, target] of Object.entries(modelMap)) {
      if (config.routes[routeType][match]) continue;
      if (!imported.includes(target.provider)) continue;
      config.routes[routeType][match] = target;
    }
  }

  return { config, imported, skipped };
}

export function isAlreadyImported(
  config: AppConfig,
  ccs: CCSProvider
): boolean {
  const env = (ccs.settingsConfig?.env ?? {}) as Record<string, unknown>;
  const base = validateString(env.ANTHROPIC_BASE_URL);
  const apiKey = validateString(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? ccs.settingsConfig?.apiKey);

  if (!base.trim()) return false;

  for (const provider of Object.values(config.providers)) {
    if (provider.base === base && provider.apiKey === apiKey) {
      return true;
    }
  }
  return false;
}
