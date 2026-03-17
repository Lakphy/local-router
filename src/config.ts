import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import JSON5 from 'json5';

const DEFAULT_CONFIG = `{
  // local-router 配置文件
  // 文档: https://github.com/your-org/local-router

  providers: {
    // 示例: OpenAI 兼容接口配置
    // openai: {
    //   type: "openai-completions",
    //   base: "https://api.openai.com/v1",
    //   apiKey: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    //   proxy: "http://127.0.0.1:7890",
    //   models: {
    //     "gpt-4o": { "image-input": true },
    //     "gpt-4o-mini": {},
    //   },
    // },

    // 示例: Anthropic 配置
    // anthropic: {
    //   type: "anthropic-messages",
    //   base: "https://api.anthropic.com",
    //   apiKey: "sk-ant-xxxxx",
    //   proxy: "http://127.0.0.1:7890",
    //   models: {
    //     "claude-sonnet-4-5": { "image-input": true, reasoning: true },
    //     "claude-haiku-4-5": {},
    //   },
    // },
  },

  routes: {
    // 示例: OpenAI 兼容路由
    // "openai-completions": {
    //   "gpt-4o": { provider: "openai", model: "gpt-4o" },
    //   "gpt-4o-mini": { provider: "openai", model: "gpt-4o-mini" },
    //   "*": { provider: "openai", model: "gpt-4o-mini" },
    // },

    // 示例: Anthropic 路由
    // "anthropic-messages": {
    //   "sonnet": { provider: "anthropic", model: "claude-sonnet-4-5" },
    //   "*": { provider: "anthropic", model: "claude-haiku-4-5" },
    // },
  },

  // 日志配置（可选，不配置则不启用日志记录）
  // log: {
  //   enabled: true,
  //   bodyPolicy: "off",       // off | full
  //   streams: {
  //     enabled: true,
  //     maxBytesPerRequest: 10485760,  // 10MB
  //     retainDays: 7,
  //   },
  //   events: {
  //     retainDays: 14,
  //   },
  // },
}`;

export type ProviderType = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export interface RouteTarget {
  provider: string;
  model: string;
}

export interface ModelCapabilities {
  'image-input'?: boolean;
  reasoning?: boolean;
  pricing?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
}

export interface PluginConfig {
  /** npm 包名、本地路径（./relative 或 /absolute）或远程 URL（http:// 或 https://） */
  package: string;
  /** 传递给 create() 的参数 */
  params?: Record<string, unknown>;
}

export interface ProviderConfig {
  type: ProviderType;
  base: string;
  apiKey: string;
  proxy?: string;
  models: Record<string, ModelCapabilities>;
  /** 插件列表，数组顺序 = 洋葱模型外→内层级 */
  plugins?: PluginConfig[];
}

export interface LogConfig {
  enabled?: boolean;
  baseDir?: string;
  events?: {
    retainDays?: number;
  };
  streams?: {
    enabled?: boolean;
    retainDays?: number;
    maxBytesPerRequest?: number;
  };
  bodyPolicy?: 'off' | 'masked' | 'full';
}

export interface AppConfig {
  routes: Record<string, Record<string, RouteTarget>>;
  providers: Record<string, ProviderConfig>;
  log?: LogConfig;
}

export function loadConfig(configPath: string): AppConfig {
  const absolutePath = resolve(configPath);
  const content = readFileSync(absolutePath, 'utf-8');
  const config = JSON5.parse(content) as AppConfig;

  for (const [routeType, modelMap] of Object.entries(config.routes)) {
    if (!modelMap['*']) {
      throw new Error(`路由 "${routeType}" 缺少 "*" 兜底规则，请检查配置文件`);
    }
    for (const target of Object.values(modelMap)) {
      if (!config.providers[target.provider]) {
        throw new Error(`路由 "${routeType}" 引用了不存在的 provider "${target.provider}"`);
      }
    }
  }

  return config;
}

function createDefaultConfig(configPath: string): void {
  const configDir = resolve(configPath, '..');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(configPath, DEFAULT_CONFIG, 'utf-8');
  console.log(`已创建默认配置文件: ${configPath}`);
}

export function writeDefaultConfigFile(
  configPath: string,
  options?: { overwrite?: boolean }
): { path: string; created: boolean } {
  const absolutePath = resolve(configPath);
  if (existsSync(absolutePath) && !options?.overwrite) {
    return { path: absolutePath, created: false };
  }
  createDefaultConfig(absolutePath);
  return { path: absolutePath, created: true };
}

function resolveDefaultConfigPath(): string {
  const localConfig = 'config.json5';
  if (existsSync(localConfig)) {
    return localConfig;
  }

  const globalConfigDir = join(homedir(), '.local-router');
  const globalConfig = join(globalConfigDir, 'config.json5');

  if (!existsSync(globalConfig)) {
    createDefaultConfig(globalConfig);
  }

  return globalConfig;
}

export function resolveConfigPath(configPath?: string): string {
  if (configPath?.trim()) {
    return configPath;
  }
  return resolveDefaultConfigPath();
}

export function ensureConfigFile(configPath: string): { path: string; created: boolean } {
  return writeDefaultConfigFile(configPath);
}

export function parseConfigPath(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--config');
  const fromCli = idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  return resolveConfigPath(fromCli);
}

export function resolveLogBaseDir(logConfig?: LogConfig): string {
  if (logConfig?.baseDir) {
    return resolve(logConfig.baseDir);
  }
  return join(homedir(), '.local-router', 'logs');
}
