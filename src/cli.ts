#!/usr/bin/env bun

import './cli/config-registrations';
import { CliError } from './cli/errors';
import { extractGlobalFlags, type GlobalFlags } from './cli/global-flags';
import './cli/handlers/autostart';
import './cli/handlers/chat';
import './cli/handlers/config-p0';
import './cli/handlers/config-p2';
import './cli/handlers/diagnose';
import './cli/handlers/introspection';
import './cli/handlers/lifecycle';
import './cli/handlers/logs';
import './cli/handlers/logs-extra';
import './cli/handlers/recipes';
import './cli/handlers/server';
import './cli/handlers/target';
import { createOutputContext, emitError, emitResult, runCommand } from './cli/output';
import { nearest } from './cli/parse-args';
import {
  allCommandNames,
  defineCommand,
  getCommand,
  listCommands,
  matchCommand,
} from './cli/registry';
import { renderTable } from './cli/render-md';
import { loadConfig, type RouteTarget, resolveConfigPath } from './config';

async function printHelpFallback(flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'help',
    flags,
    fn: (ctx) => {
      const cmds = listCommands(false);
      const rows = cmds.map((c) => [
        `\`${c.name}\``,
        c.summary,
        c.mutates ? '✓' : '',
        c.requiresRunning ? '✓' : '',
      ]);
      emitResult(ctx, {
        command: 'help',
        data: cmds.map((c) => ({
          name: c.name,
          summary: c.summary,
          mutates: !!c.mutates,
          requiresRunning: !!c.requiresRunning,
          supportsJson: c.supportsJson !== false,
          deprecated: c.deprecated ?? null,
        })),
        md: {
          heading: 'local-router · 命令清单',
          meta: ['默认输出 Markdown · `-o json` 切换 envelope · `-o text` 兜底'],
          data: renderTable(['命令', '说明', '改写?', '需运行?'], rows),
          hints: [
            '查看命令详情: `local-router help <cmd>`',
            '机器格式: `local-router commands --json`',
            '全局 flags: `-o markdown|json|ndjson|text` `--quiet` `--verbose` `--no-color` `--no-interactive` `--yes` `--config` `--timeout`',
          ],
        },
        text: [
          'local-router CLI',
          '',
          'Commands:',
          ...cmds.map((c) => `  ${c.name.padEnd(28)} ${c.summary}`),
          '',
          "Run 'local-router help <cmd>' for details.",
        ].join('\n'),
      });
    },
  });
}

function formatRouteTarget(target: RouteTarget): string {
  return `${target.provider} / ${target.model}`;
}

async function cmdGetRoute(args: string[], flags: GlobalFlags): Promise<number> {
  return runCommand({
    command: 'get-route',
    flags,
    fn: async (ctx) => {
      const { parseArgs } = await import('node:util');
      const parsed = parseArgs({
        args,
        options: {
          type: { type: 'string' },
          'model-alias': { type: 'string' },
          model: { type: 'string' },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });

      const routeType = parsed.values.type;
      if (!routeType) {
        throw new CliError(
          'USAGE_ERROR',
          '用法: local-router get-route --type <route-type> [--model-alias <alias>] [--config <path>]'
        );
      }

      const configPath = resolveConfigPath(parsed.values.config);
      const config = loadConfig(configPath);
      const modelMap = config.routes[routeType];
      if (!modelMap) {
        throw new CliError('ROUTE_NOT_FOUND', `route type 不存在: ${routeType}`, {
          details: { routeType, availableEntries: Object.keys(config.routes) },
        });
      }

      const modelAlias = parsed.values['model-alias'] ?? parsed.values.model;
      if (modelAlias) {
        const target = modelMap[modelAlias] ?? modelMap['*'];
        if (!target) {
          throw new CliError('ROUTE_NOT_FOUND', `未命中路由且缺少兜底: ${routeType}`);
        }
        const text = formatRouteTarget(target);
        emitResult(ctx, {
          command: 'get-route',
          data: { entry: routeType, match: modelAlias, ...target },
          md: {
            heading: `get-route · ${routeType}.${modelAlias}`,
            data: `→ \`${target.provider}\` / \`${target.model}\``,
          },
          text,
        });
        return;
      }

      const items: Array<{ alias: string; provider: string; model: string }> = [];
      for (const [alias, target] of Object.entries(modelMap)) {
        if (alias === '*') continue;
        items.push({ alias, provider: target.provider, model: target.model });
      }
      const fallback = modelMap['*'];
      if (fallback) {
        items.push({ alias: 'default', provider: fallback.provider, model: fallback.model });
      }
      const text = items.map((it) => `${it.alias} : ${it.provider} / ${it.model}`).join(' | ');
      emitResult(ctx, {
        command: 'get-route',
        data: { entry: routeType, items },
        md: {
          heading: `get-route · ${routeType}`,
          data: renderTable(
            ['alias', 'provider', 'model'],
            items.map((it) => [it.alias, it.provider, it.model])
          ),
        },
        text,
      });
    },
  });
}

defineCommand({
  name: 'get-route',
  summary: '查询路由命中（旧 CLI 兼容）',
  flags: [
    { name: 'type', type: 'string', required: true, description: '协议入口' },
    { name: 'model-alias', type: 'string', description: '请求 model 别名' },
    { name: 'model', type: 'string', description: '请求 model（同 --model-alias）' },
    { name: 'config', type: 'string', description: '配置文件路径' },
  ],
  supportsJson: true,
  handler: cmdGetRoute,
});

function isLogsSubcommand(arg: string | undefined): boolean {
  if (!arg) return false;
  // Derived from the registry so new `logs <x>` commands auto-participate.
  return allCommandNames().includes(`logs ${arg}`);
}

function nearestCommand(input: string, names: string[]): string | undefined {
  return nearest(input, names);
}

async function dispatch(argv: string[]): Promise<number> {
  let flags: GlobalFlags;
  let rest: string[];
  try {
    const extracted = extractGlobalFlags(argv);
    flags = extracted.flags;
    rest = extracted.rest;
  } catch (err) {
    return emitError(null, 'cli', err);
  }

  if (rest.length === 0) {
    return await printHelpFallback(flags);
  }
  if (rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') {
    if (rest.length === 1) return await printHelpFallback(flags);
    const target = rest.slice(1).join(' ');
    const cmd = getCommand(target);
    if (!cmd) {
      const suggestion = nearestCommand(target, allCommandNames());
      return emitError(
        createOutputContext(flags),
        'help',
        new CliError('USAGE_ERROR', `未知命令: ${target}`, {
          hint: suggestion
            ? `也许是 \`${suggestion}\`? · 全部: \`local-router commands\``
            : `已注册: ${allCommandNames().slice(0, 12).join(', ')}…`,
        })
      );
    }
    return runCommand({
      command: `help ${target}`,
      flags,
      fn: (ctx) => {
        emitResult(ctx, {
          command: `help ${target}`,
          data: {
            name: cmd.name,
            summary: cmd.summary,
            description: cmd.description ?? '',
            flags: cmd.flags ?? [],
            positionals: cmd.positionals ?? [],
            mutates: !!cmd.mutates,
            requiresRunning: !!cmd.requiresRunning,
            supportsJson: cmd.supportsJson !== false,
            examples: cmd.examples ?? [],
            deprecated: cmd.deprecated ?? null,
          },
          md: {
            heading: `help · ${cmd.name}`,
            meta: [cmd.summary],
            data: [
              cmd.flags && cmd.flags.length > 0
                ? `**Flags**\n\n${renderTable(
                    ['flag', 'type', 'default', 'desc'],
                    cmd.flags.map((f) => [
                      `--${f.name}${f.short ? `, -${f.short}` : ''}`,
                      f.type + (f.enum ? `(${f.enum.join('|')})` : ''),
                      f.default !== undefined ? `\`${f.default}\`` : '',
                      f.description,
                    ])
                  )}`
                : '',
              cmd.examples && cmd.examples.length > 0
                ? `**示例**\n\n${cmd.examples.map((e) => `- ${e.title}: \`${e.cmd}\``).join('\n')}`
                : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        });
      },
    });
  }

  // Backward-compat: `logs` 单独使用时映射到 `logs daemon`
  if (rest[0] === 'logs' && !isLogsSubcommand(rest[1])) {
    rest = ['logs', 'daemon', ...rest.slice(1)];
  }

  const matched = matchCommand(rest);
  if (!matched) {
    const guess = rest.slice(0, Math.min(3, rest.length)).join(' ');
    const suggestion = nearestCommand(guess, allCommandNames());
    return emitError(
      createOutputContext(flags),
      rest.join(' '),
      new CliError('USAGE_ERROR', `未知命令: ${rest.join(' ')}`, {
        hint: suggestion
          ? `也许是 \`${suggestion}\`? · 全部: \`local-router commands\``
          : `运行 \`local-router help\` 查看可用命令`,
        details: { available: allCommandNames() },
      })
    );
  }
  return await matched.command.handler(matched.rest, flags);
}

void dispatch(process.argv.slice(2)).then((code) => {
  if (code !== 0) process.exit(code);
});
