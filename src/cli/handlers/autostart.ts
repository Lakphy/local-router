import { loadConfig, resolveConfigPath } from '../../config';
import { createAutostartManager, getAutostartExecArgs } from '../autostart';
import { CliError } from '../errors';
import { emitResult } from '../output';
import { defineSchemaCommand } from '../registry';
import { renderKv } from '../render-md';

const LABEL = 'com.lakphy.local-router';

function updateConfigAutostart(configPath: string, enabled: boolean): void {
  const { readFileSync, writeFileSync } = require('node:fs');
  const JSON5 = require('json5');
  const content = readFileSync(configPath, 'utf-8');
  const config = JSON5.parse(content);
  if (!config.server) config.server = {};
  config.server.autostart = enabled;
  const output = JSON.stringify(config, null, 2);
  writeFileSync(configPath, output, 'utf-8');
}

interface EnableFlags {
  config?: string;
}

defineSchemaCommand<EnableFlags>({
  name: 'autostart enable',
  summary: '启用开机自启动（用户登录时自动启动 daemon）',
  supportsJson: true,
  mutates: true,
  flags: [{ name: 'config', type: 'string', description: '配置文件路径' }],
  fn: async ({ values, ctx }) => {
    const manager = createAutostartManager();
    if (manager.platform === 'unsupported') {
      throw new CliError('USAGE_ERROR', '当前平台不支持自启动');
    }
    const { execPath, args } = getAutostartExecArgs();
    await manager.install({ execPath, args, label: LABEL });
    const configPath = resolveConfigPath(values.config);
    try {
      updateConfigAutostart(configPath, true);
    } catch {}
    emitResult(ctx, {
      command: 'autostart.enable',
      data: {
        enabled: true,
        platform: manager.platform,
        servicePath: manager.getServicePath(),
        execPath,
      },
      md: {
        heading: 'autostart · ✓ 已启用',
        meta: [`平台: ${manager.platform}`],
        data: renderKv([
          { key: 'servicePath', value: manager.getServicePath() },
          { key: 'execPath', value: execPath },
          { key: 'args', value: args.join(' ') },
        ]),
        hints: [
          '查看状态: `local-router autostart status`',
          '禁用: `local-router autostart disable`',
        ],
      },
      text: `已启用自启动: ${manager.getServicePath()}`,
    });
  },
});

interface DisableFlags {
  config?: string;
}

defineSchemaCommand<DisableFlags>({
  name: 'autostart disable',
  summary: '禁用开机自启动',
  supportsJson: true,
  mutates: true,
  flags: [{ name: 'config', type: 'string', description: '配置文件路径' }],
  fn: async ({ values, ctx }) => {
    const manager = createAutostartManager();
    if (manager.platform === 'unsupported') {
      throw new CliError('USAGE_ERROR', '当前平台不支持自启动');
    }
    await manager.uninstall();
    const configPath = resolveConfigPath(values.config);
    try {
      updateConfigAutostart(configPath, false);
    } catch {}
    emitResult(ctx, {
      command: 'autostart.disable',
      data: {
        enabled: false,
        platform: manager.platform,
        servicePath: manager.getServicePath(),
      },
      md: {
        heading: 'autostart · ✓ 已禁用',
        meta: [`平台: ${manager.platform}`],
        data: renderKv([{ key: 'servicePath', value: manager.getServicePath() }]),
        hints: ['重新启用: `local-router autostart enable`'],
      },
      text: '已禁用自启动',
    });
  },
});

defineSchemaCommand({
  name: 'autostart status',
  summary: '查看自启动配置状态',
  supportsJson: true,
  flags: [{ name: 'config', type: 'string', description: '配置文件路径' }],
  fn: async ({ values, ctx }) => {
    const manager = createAutostartManager();
    const systemInstalled = await manager.isInstalled();
    let configEnabled = false;
    try {
      const configPath = resolveConfigPath((values as { config?: string }).config);
      const config = loadConfig(configPath);
      configEnabled = config.server?.autostart ?? false;
    } catch {}

    const warnings: string[] = [];
    if (configEnabled && !systemInstalled) {
      warnings.push('config 标记已启用但系统未安装服务，运行 `autostart enable` 同步');
    } else if (!configEnabled && systemInstalled) {
      warnings.push('系统已安装服务但 config 标记为禁用，运行 `autostart disable` 同步');
    }

    const data = {
      enabled: configEnabled,
      systemInstalled,
      platform: manager.platform,
      servicePath: manager.getServicePath(),
    };

    emitResult(ctx, {
      command: 'autostart.status',
      data,
      warnings: warnings.length > 0 ? warnings : undefined,
      md: {
        heading: `autostart · ${systemInstalled ? '✓ 已安装' : '✗ 未安装'}`,
        meta: [`平台: ${manager.platform}`],
        data: renderKv([
          { key: 'configEnabled', value: configEnabled },
          { key: 'systemInstalled', value: systemInstalled },
          { key: 'platform', value: manager.platform },
          { key: 'servicePath', value: manager.getServicePath() },
        ]),
        hints: systemInstalled
          ? ['禁用: `local-router autostart disable`']
          : ['启用: `local-router autostart enable`'],
      },
      text: `autostart: config=${configEnabled} system=${systemInstalled} platform=${manager.platform}`,
    });
  },
});
