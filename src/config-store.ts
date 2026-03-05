import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import JSON5 from 'json5';
import type { AppConfig } from './config';
import { loadConfig } from './config';

/**
 * 可变配置持有者，支持热重载。
 * JS 单线程保证 get/reload 之间不会出现竞态，
 * 已经进入 proxyRequest 的请求已拿到解析后的参数，不受后续 reload 影响。
 */
export class ConfigStore {
  private config: AppConfig;
  private readonly absolutePath: string;

  constructor(configPath: string) {
    this.absolutePath = resolve(configPath);
    this.config = loadConfig(this.absolutePath);
  }

  get(): AppConfig {
    return this.config;
  }

  getPath(): string {
    return this.absolutePath;
  }

  reload(): AppConfig {
    this.config = loadConfig(this.absolutePath);
    return this.config;
  }

  save(newConfig: AppConfig): void {
    const content = JSON5.stringify(newConfig, { space: 2, quote: '"' });
    writeFileSync(this.absolutePath, content, 'utf-8');
  }

  /**
   * 校验配置合法性（不写入文件，不更新内存）。
   * 抛出 Error 说明校验失败。
   */
  validate(config: AppConfig): void {
    for (const [routeType, modelMap] of Object.entries(config.routes)) {
      if (!modelMap['*']) {
        throw new Error(`路由 "${routeType}" 缺少 "*" 兜底规则`);
      }
      for (const target of Object.values(modelMap)) {
        if (!config.providers[target.provider]) {
          throw new Error(`路由 "${routeType}" 引用了不存在的 provider "${target.provider}"`);
        }
      }
    }
  }
}
