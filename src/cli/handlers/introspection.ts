import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findConfigSchemaUrl, readVersionString } from '../asset-paths';
import { ERROR_DOCS } from '../error-docs';
import { CliError, type CliErrorCode, listErrorCodes } from '../errors';
import { emitResult, runCommand } from '../output';
import { allCommandNames, type CommandDef, defineCommand, listCommands } from '../registry';
import { renderCodeBlock, renderTable } from '../render-md';

const PROVIDER_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
const FEATURES = [
  'markdown',
  'json',
  'ndjson',
  'text',
  'dry-run',
  'envelope-v1',
  'wait-healthy',
  'interactive-required-with-candidates',
];

function commandToData(c: CommandDef): Record<string, unknown> {
  return {
    name: c.name,
    summary: c.summary,
    description: c.description ?? '',
    flags: (c.flags ?? []).map((f) => ({
      name: f.name,
      short: f.short ?? null,
      type: f.type,
      enum: f.enum ?? null,
      required: !!f.required,
      default: f.default ?? null,
      description: f.description,
      multiple: !!f.multiple,
    })),
    positionals: c.positionals ?? [],
    mutates: !!c.mutates,
    requiresRunning: !!c.requiresRunning,
    supportsJson: c.supportsJson !== false,
    examples: c.examples ?? [],
    deprecated: c.deprecated ?? null,
    hidden: !!c.hidden,
  };
}

defineCommand({
  name: 'commands',
  summary: '枚举所有命令（机器可消费）',
  supportsJson: true,
  flags: [{ name: 'all', type: 'boolean', description: '包含 hidden 命令' }],
  handler: async (args, flags) =>
    runCommand({
      command: 'commands',
      flags,
      fn: (ctx) => {
        const parsed = parseArgs({
          args,
          options: { all: { type: 'boolean', default: false } },
          allowPositionals: true,
          strict: false,
        });
        const cmds = listCommands(parsed.values.all).map(commandToData);
        emitResult(ctx, {
          command: 'commands',
          data: cmds,
          md: {
            heading: `commands · ${cmds.length} 个`,
            data: renderTable(
              ['name', 'mutates', 'needs-running', 'json', 'summary'],
              cmds.map((c) => [
                `\`${c.name}\``,
                c.mutates ? '✓' : '',
                c.requiresRunning ? '✓' : '',
                c.supportsJson ? '✓' : '',
                c.summary,
              ])
            ),
            hints: ['详情: `local-router help <cmd> --json`'],
          },
        });
      },
    }),
});

defineCommand({
  name: 'capabilities',
  summary: 'CLI / 服务的能力清单',
  supportsJson: true,
  handler: async (_args, flags) =>
    runCommand({
      command: 'capabilities',
      flags,
      fn: async (ctx) => {
        const version = await readVersionString();
        const data = {
          version,
          schemaVersion: 1,
          providerTypes: [...PROVIDER_TYPES],
          routeEntries: [...PROVIDER_TYPES],
          features: FEATURES,
          commands: allCommandNames(),
          envVars: [
            'LOCAL_ROUTER_FORMAT',
            'LOCAL_ROUTER_QUIET',
            'LOCAL_ROUTER_NO_INTERACTIVE',
            'LOCAL_ROUTER_RUNTIME_DIR',
            'LOCAL_ROUTER_CONFIG',
            'LOCAL_ROUTER_IDLE_TIMEOUT',
            'NO_COLOR',
          ],
        };
        emitResult(ctx, {
          command: 'capabilities',
          data,
          md: {
            heading: `capabilities · ${version}`,
            data: [
              `**provider 类型**: ${PROVIDER_TYPES.map((t) => `\`${t}\``).join(', ')}`,
              `**features**: ${FEATURES.map((f) => `\`${f}\``).join(', ')}`,
              `**命令数**: ${data.commands.length}`,
              `**env vars**: ${data.envVars.map((v) => `\`${v}\``).join(', ')}`,
            ].join('\n\n'),
          },
        });
      },
    }),
});

defineCommand({
  name: 'schema',
  summary: '导出 schema：config | cli | errors',
  supportsJson: true,
  positionals: [{ name: 'kind', required: true, description: 'config | cli | errors' }],
  handler: async (args, flags) => {
    const [kind] = args;
    if (!kind || !['config', 'cli', 'errors'].includes(kind)) {
      return runCommand({
        command: 'schema',
        flags,
        fn: () => {
          throw new CliError('USAGE_ERROR', '用法: schema <config|cli|errors>');
        },
      });
    }
    return runCommand({
      command: `schema.${kind}`,
      flags,
      fn: async (ctx) => {
        if (kind === 'config') {
          const schemaUrl = await findConfigSchemaUrl();
          if (!schemaUrl) {
            throw new CliError('CONFIG_NOT_FOUND', 'config.schema.json 未找到（包文件缺失？）', {
              hint: '请确认 npm 包完整性，或开发模式下从源码运行',
            });
          }
          const text = readFileSync(fileURLToPath(schemaUrl), 'utf-8');
          const data = JSON.parse(text);
          emitResult(ctx, {
            command: 'schema.config',
            data,
            md: {
              heading: 'schema.config',
              data: renderCodeBlock(text, 'json'),
            },
            text,
          });
          return;
        }
        if (kind === 'cli') {
          const cmds = listCommands(true).map(commandToData);
          const data = { schema_version: 1, commands: cmds };
          emitResult(ctx, {
            command: 'schema.cli',
            data,
            md: {
              heading: `schema.cli · ${cmds.length} 个命令`,
              data: renderCodeBlock(JSON.stringify(data, null, 2), 'json'),
            },
            text: JSON.stringify(data, null, 2),
          });
          return;
        }
        // errors
        const codes = listErrorCodes();
        const data = codes.map((c) => ({
          code: c.code,
          exitCode: c.exitCode,
          summary: ERROR_DOCS[c.code as CliErrorCode]?.summary ?? '',
        }));
        emitResult(ctx, {
          command: 'schema.errors',
          data,
          md: {
            heading: `schema.errors · ${data.length} 个`,
            data: renderTable(
              ['code', 'exit', 'summary'],
              data.map((d) => [`\`${d.code}\``, d.exitCode, d.summary])
            ),
          },
          text: data.map((d) => `${d.code}\t${d.exitCode}\t${d.summary}`).join('\n'),
        });
      },
    });
  },
});

defineCommand({
  name: 'docs errors',
  summary: '错误码文档（可选传 code）',
  supportsJson: true,
  positionals: [{ name: 'code', description: '错误码（可选）' }],
  handler: async (args, flags) =>
    runCommand({
      command: 'docs.errors',
      flags,
      fn: (ctx) => {
        const [code] = args;
        if (code) {
          const c = code as CliErrorCode;
          const doc = ERROR_DOCS[c];
          if (!doc) {
            throw new CliError('USAGE_ERROR', `未知错误码: ${code}`, {
              hint: '运行 `local-router schema errors` 查看全部',
            });
          }
          const exitCode = listErrorCodes().find((e) => e.code === c)?.exitCode ?? 1;
          const data = { code: c, exitCode, ...doc };
          emitResult(ctx, {
            command: 'docs.errors',
            data,
            md: {
              heading: `docs.errors · ${c}`,
              meta: [`exit ${exitCode}`],
              data: [
                `**摘要**: ${doc.summary}`,
                `**触发条件**: ${doc.cause}`,
                `**修复**: ${doc.fix}`,
              ].join('\n\n'),
            },
            text: [
              `${c} (exit ${exitCode})`,
              `摘要: ${doc.summary}`,
              `触发: ${doc.cause}`,
              `修复: ${doc.fix}`,
            ].join('\n'),
          });
          return;
        }
        const all = listErrorCodes().map((e) => ({
          code: e.code,
          exitCode: e.exitCode,
          ...ERROR_DOCS[e.code as CliErrorCode],
        }));
        emitResult(ctx, {
          command: 'docs.errors',
          data: all,
          md: {
            heading: `docs.errors · ${all.length} 个错误码`,
            data: renderTable(
              ['code', 'exit', 'summary', 'fix'],
              all.map((e) => [`\`${e.code}\``, e.exitCode, e.summary, e.fix])
            ),
            hints: ['查看单条详情: `local-router docs errors <code>`'],
          },
        });
      },
    }),
});

defineCommand({
  name: 'agents-md',
  summary: '生成给 AI agent 看的 cheatsheet（Markdown）',
  supportsJson: false,
  handler: async (_args, flags) =>
    runCommand({
      command: 'agents-md',
      flags,
      fn: async (ctx) => {
        const version = await readVersionString();
        const cmds = listCommands(false);
        const errorRows = listErrorCodes().map((e) => ({
          code: e.code,
          exitCode: e.exitCode,
          summary: ERROR_DOCS[e.code as CliErrorCode]?.summary ?? '',
        }));

        const md = [
          `# local-router · AGENTS.md`,
          ``,
          `> 生成时间: ${new Date().toISOString()} · 版本: ${version}`,
          `> 此文档专为 AI agent 编写。所有命令默认输出 Markdown，可加 \`--output json\` 获得 envelope。`,
          ``,
          `## 输出契约`,
          ``,
          `- 默认: 结构化 Markdown，顶部 \`## <command>\` 标题、blockquote meta、\`### 数据\`、\`### 提示\`。`,
          `- \`--output json\`: \`{ ok, command, schema_version, data, meta }\`；错误为 \`{ ok:false, error:{code,message,hint,doc,details}, exit_code }\`。`,
          `- \`--output ndjson\`: 流式命令每行一个事件 (\`type:"event"|"end"|"error"\`)。`,
          `- \`--output text\`: 旧字符串文案，零破坏兼容。`,
          `- env: \`LOCAL_ROUTER_FORMAT=json\` 全局切换。`,
          ``,
          `## 退出码`,
          ``,
          `| code | 含义 |`,
          `|---|---|`,
          `| 0 | OK |`,
          `| 1 | 未知错误 |`,
          `| 2 | 用法错误 |`,
          `| 3 | 服务未运行 |`,
          `| 4 | 状态冲突（端口占用 / 已运行 / 被引用） |`,
          `| 5 | 配置校验失败 |`,
          `| 6 | 资源不存在 |`,
          `| 7 | 超时 |`,
          `| 8 | 健康检查失败 / apply 失败 |`,
          `| 9 | 上游不可达 |`,
          `| 10 | 需要交互终端 |`,
          ``,
          `## 命令清单`,
          ``,
          `| 命令 | 说明 | mutates | needs-running |`,
          `|---|---|---|---|`,
          ...cmds.map(
            (c) =>
              `| \`${c.name}\` | ${c.summary} | ${c.mutates ? '✓' : ''} | ${c.requiresRunning ? '✓' : ''} |`
          ),
          ``,
          `## 常见 workflow`,
          ``,
          `### 1. 准备 + 健康自检`,
          ``,
          '```sh',
          'local-router doctor --json',
          'local-router status --wait-running --timeout 10 --json',
          '```',
          ``,
          `### 2. 加 provider + 路由 + 端到端验证`,
          ``,
          '```sh',
          'local-router config provider add openai \\',
          '  --type openai-completions --base https://api.openai.com/v1 \\',
          '  --api-key $OPENAI_API_KEY --model gpt-4o-mini --dry-run --json',
          '# 看 diff 满意后去掉 --dry-run',
          'local-router config provider add openai ... --json',
          'local-router config route set openai-completions \\* --provider openai --model gpt-4o-mini --json',
          'local-router config apply --json',
          'local-router try --entry openai-completions --model gpt-4o-mini --prompt ping --json',
          '```',
          ``,
          `### 3. 排查上次失败请求`,
          ``,
          '```sh',
          'local-router logs last-error --json',
          'local-router logs event <id> --include-stream',
          '```',
          ``,
          `## 错误码`,
          ``,
          `| code | exit | 含义 |`,
          `|---|---|---|`,
          ...errorRows.map((r) => `| \`${r.code}\` | ${r.exitCode} | ${r.summary} |`),
          ``,
          `详情: \`local-router docs errors <code>\``,
          ``,
          `## 自描述命令`,
          ``,
          `- \`local-router commands --json\`: 全部命令元信息`,
          `- \`local-router help <cmd> --json\`: 单命令 flags / examples`,
          `- \`local-router schema config|cli|errors --json\`: schema 导出`,
          `- \`local-router capabilities --json\`: 版本 + provider 类型 + 特性`,
          ``,
        ].join('\n');

        if (ctx.flags.output === 'json' || ctx.flags.output === 'ndjson') {
          emitResult(ctx, {
            command: 'agents-md',
            data: { markdown: md },
          });
          return;
        }
        process.stdout.write(`${md}\n`);
      },
    }),
});
