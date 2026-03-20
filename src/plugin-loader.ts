import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import type { PluginConfig, ProviderConfig } from './config';
import type { Plugin, PluginDefinition } from './plugin';

interface LoadedPlugin {
  config: PluginConfig;
  definition: PluginDefinition;
  instance: Plugin;
}

function isLocalPath(pkg: string): boolean {
  return (
    pkg.startsWith('./') ||
    pkg.startsWith('../') ||
    pkg.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(pkg) // Windows 绝对路径 (e.g. C:\plugins\x.ts)
  );
}

function isRemoteUrl(pkg: string): boolean {
  return pkg.startsWith('http://') || pkg.startsWith('https://');
}

/** 根据 URL 路径或 Content-Type 推断文件扩展名 */
function inferExtension(url: string, contentType?: string | null): string {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('.ts') || pathname.endsWith('.tsx')) return '.ts';
  if (pathname.endsWith('.mjs')) return '.mjs';
  if (pathname.endsWith('.cjs')) return '.cjs';
  if (contentType?.includes('typescript')) return '.ts';
  return '.js';
}

/** 远程临时文件目录，进程退出时统一清理 */
let remoteTmpDir: string | null = null;
const remoteTmpFiles: string[] = [];

async function ensureRemoteTmpDir(): Promise<string> {
  if (!remoteTmpDir) {
    remoteTmpDir = await mkdtemp(join(tmpdir(), 'local-router-plugins-'));
  }
  return remoteTmpDir;
}

/** 下载远程插件到临时文件并返回本地路径 */
async function fetchRemotePlugin(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载远程插件失败: HTTP ${response.status} ${response.statusText} (${url})`);
  }

  const content = await response.text();
  const ext = inferExtension(url, response.headers.get('content-type'));
  const dir = await ensureRemoteTmpDir();
  const fileName = `plugin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const filePath = join(dir, fileName);

  await writeFile(filePath, content, 'utf-8');
  remoteTmpFiles.push(filePath);

  return filePath;
}

/** 清理远程插件临时文件 */
export async function cleanupRemoteTmpFiles(): Promise<void> {
  if (remoteTmpDir) {
    try {
      await rm(remoteTmpDir, { recursive: true, force: true });
    } catch {
      // 静默忽略清理失败
    }
    remoteTmpDir = null;
    remoteTmpFiles.length = 0;
  }
}

async function importPlugin(pkg: string, configDir: string): Promise<PluginDefinition> {
  let modulePath: string;

  if (isRemoteUrl(pkg)) {
    // 远程 URL：下载到临时文件后 import（Bun 原生支持 .ts 转译）
    const localPath = await fetchRemotePlugin(pkg);
    modulePath = `${localPath}?t=${Date.now()}`;
  } else if (isLocalPath(pkg)) {
    const absolutePath = resolve(configDir, pkg);
    // 追加 ?t=Date.now() 绕过 Bun 模块缓存，支持热重载
    modulePath = `${absolutePath}?t=${Date.now()}`;
  } else {
    modulePath = pkg;
  }

  const mod = (await import(modulePath)) as Record<string, unknown>;
  const definition = (mod.default ?? mod) as PluginDefinition;

  if (!definition || typeof definition.name !== 'string' || typeof definition.create !== 'function') {
    throw new Error(
      `插件 "${pkg}" 导出格式不正确，需导出包含 name 和 create 的 PluginDefinition`
    );
  }

  return definition;
}

export interface ReloadResult {
  ok: boolean;
  failures: { provider: string; package: string; error: string }[];
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin[]>();
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  private async loadPluginsForProvider(
    providerName: string,
    providerConfig: ProviderConfig,
    pluginConfigs: PluginConfig[]
  ): Promise<{ loaded: LoadedPlugin[]; failures: { provider: string; package: string; error: string }[] }> {
    const loaded: LoadedPlugin[] = [];
    const failures: { provider: string; package: string; error: string }[] = [];

    for (const config of pluginConfigs) {
      try {
        const definition = await importPlugin(config.package, this.configDir);
        const params = { ...(config.params ?? {}) };

        // 通用 protocol-adapter 在未显式配置 targetFormat 时，默认使用 provider.type。
        if (definition.name === 'protocol-adapter' && params.targetFormat === undefined) {
          params.targetFormat = providerConfig.type;
        }

        const instance = await definition.create(params);
        loaded.push({ config, definition, instance });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[plugin] 加载插件 "${config.package}" 失败 (provider: ${providerName}):`,
          errorMsg
        );
        failures.push({ provider: providerName, package: config.package, error: errorMsg });
      }
    }

    return { loaded, failures };
  }

  /**
   * 原子热重载：先在临时容器中完成所有新插件的加载。
   * 按 provider 粒度判断：如果某个 provider 的新插件全部加载成功，
   * 则替换为新插件链；如果有任何失败，则保留该 provider 的旧插件链。
   * 旧实例延迟 dispose 以保护 in-flight 请求。
   */
  async reloadAll(
    providers: Record<string, ProviderConfig>
  ): Promise<ReloadResult> {
    const newPlugins = new Map<string, LoadedPlugin[]>();
    const allFailures: { provider: string; package: string; error: string }[] = [];
    const oldPluginsToDispose: LoadedPlugin[] = [];

    // 阶段 1：在临时容器中加载所有新插件
    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (providerConfig.plugins && providerConfig.plugins.length > 0) {
        const { loaded, failures } = await this.loadPluginsForProvider(
          providerName,
          providerConfig,
          providerConfig.plugins
        );
        allFailures.push(...failures);

        if (failures.length > 0) {
          // 该 provider 有加载失败，保留旧插件链，dispose 刚加载的新实例
          console.warn(
            `[plugin] provider "${providerName}" 有插件加载失败，保留旧插件链`
          );
          const oldLoaded = this.plugins.get(providerName);
          if (oldLoaded) {
            newPlugins.set(providerName, oldLoaded);
          }
          // 刚加载成功的新实例需要清理
          for (const { instance, config } of loaded) {
            try {
              await instance.dispose?.();
            } catch (err) {
              console.error(
                `[plugin] 回滚销毁插件 "${config.package}" 失败:`,
                err instanceof Error ? err.message : err
              );
            }
          }
        } else {
          // 全部成功，使用新插件链
          newPlugins.set(providerName, loaded);
          // 标记旧实例待 dispose
          const oldLoaded = this.plugins.get(providerName);
          if (oldLoaded) {
            oldPluginsToDispose.push(...oldLoaded);
          }
        }
      }
      // 如果新配置中该 provider 没有 plugins，不保留旧的
    }

    // 对于旧 map 中有但新配置中没有 plugins 的 provider，也需要 dispose
    for (const [providerName, oldLoaded] of this.plugins) {
      if (!newPlugins.has(providerName)) {
        oldPluginsToDispose.push(...oldLoaded);
      }
    }

    // 阶段 2：原子替换 map
    this.plugins = newPlugins;

    // 阶段 3：延迟 dispose 旧实例，保护 in-flight 请求
    if (oldPluginsToDispose.length > 0) {
      setTimeout(() => {
        this.disposePluginList(oldPluginsToDispose).catch((err) => {
          console.error('[plugin] 旧插件销毁失败:', err);
        });
      }, 5000);
    }

    if (allFailures.length > 0) {
      console.warn(
        `[plugin] 热重载完成，但有 ${allFailures.length} 个插件加载失败:`,
        allFailures.map((f) => `${f.provider}/${f.package}`).join(', ')
      );
    }

    return { ok: allFailures.length === 0, failures: allFailures };
  }

  getPlugins(providerName: string): Plugin[] {
    const loaded = this.plugins.get(providerName);
    if (!loaded) return [];
    return loaded.map((l) => l.instance);
  }

  getLoadedPlugins(providerName: string): LoadedPlugin[] {
    return this.plugins.get(providerName) ?? [];
  }

  async disposeAll(): Promise<void> {
    const allPlugins: LoadedPlugin[] = [];
    for (const [, loadedPlugins] of this.plugins) {
      allPlugins.push(...loadedPlugins);
    }
    this.plugins.clear();
    await this.disposePluginList(allPlugins);
    await cleanupRemoteTmpFiles();
  }

  private async disposePluginList(plugins: LoadedPlugin[]): Promise<void> {
    for (const { instance, config } of plugins) {
      try {
        await instance.dispose?.();
      } catch (err) {
        console.error(
          `[plugin] 销毁插件 "${config.package}" 失败:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  private async disposePluginMap(pluginMap: Map<string, LoadedPlugin[]>): Promise<void> {
    const allPlugins: LoadedPlugin[] = [];
    for (const [, loadedPlugins] of pluginMap) {
      allPlugins.push(...loadedPlugins);
    }
    await this.disposePluginList(allPlugins);
  }
}
