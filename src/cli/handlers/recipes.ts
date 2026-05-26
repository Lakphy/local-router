/**
 * PR-5 AI 友好性升级：recipes
 *
 * 列出常见运维 / 调试场景下的命令组合，方便 AI agent 一次性获取多步骤参考。
 */
import { CliError } from '../errors';
import { emitResult } from '../output';
import { defineSchemaCommand } from '../registry';

interface Recipe {
  name: string;
  title: string;
  description: string;
  steps: Array<{ cmd: string; why: string }>;
  tags: string[];
}

const RECIPES: Recipe[] = [
  {
    name: 'first-run',
    title: '首次启动 local-router',
    description: '从零开始：写入默认配置 → 启动 daemon → 健康自检 → 端到端探活',
    steps: [
      { cmd: 'local-router init', why: '生成默认 config.json5' },
      { cmd: 'local-router start --daemon', why: '后台启动服务' },
      { cmd: 'local-router doctor', why: '自检：端口 / 配置 / 上游可达性' },
      { cmd: 'local-router try --entry openai-completions --model gpt-4o --prompt ping', why: '端到端探活一次小请求' },
    ],
    tags: ['onboarding', 'lifecycle'],
  },
  {
    name: 'troubleshoot-upstream',
    title: '上游 provider 不可达排查',
    description: '探活 → 看日志 → 解析路由 → 重试',
    steps: [
      { cmd: 'local-router doctor', why: '全局自检快速定位' },
      { cmd: 'local-router ping <provider>', why: 'HEAD 探活某 provider' },
      { cmd: 'local-router explain route --entry <entry> --model <model>', why: '查看路由命中目标' },
      { cmd: 'local-router logs errors --window 1h', why: '近期错误聚类' },
      { cmd: 'local-router try --entry <entry> --model <model> --prompt ping --stream', why: '流式端到端复现' },
    ],
    tags: ['debug', 'upstream'],
  },
  {
    name: 'cost-audit',
    title: 'Token / 费用复盘',
    description: '汇总 token 用量 → 估算费用 → 导出原始事件',
    steps: [
      { cmd: 'local-router logs tokens --window 24h', why: 'input/output/cached/total 全量汇总' },
      { cmd: 'local-router logs cost --window 24h --rate-table \'{"openai/gpt-4o":{"inputPerMillion":5,"outputPerMillion":15}}\'', why: '逐 provider/model 估算' },
      { cmd: 'local-router logs export --window 24h --format ndjson > usage.ndjson', why: '导出原始事件用于离线分析' },
    ],
    tags: ['ops', 'cost'],
  },
  {
    name: 'plugin-management',
    title: 'Provider plugin 配置',
    description: '列出 → 新增 → 调整 params → 删除',
    steps: [
      { cmd: 'local-router config provider plugin list <provider>', why: '查看当前洋葱顺序' },
      { cmd: 'local-router config provider plugin add <provider> <package> --params \'{"key":"value"}\' --dry-run', why: '预览新增' },
      { cmd: 'local-router config provider plugin add <provider> <package> --params \'{"key":"value"}\'', why: '执行新增' },
      { cmd: 'local-router config apply', why: '热加载到运行中的 daemon' },
    ],
    tags: ['config', 'plugin'],
  },
  {
    name: 'log-cleanup',
    title: '日志清理 / 归档',
    description: '查看磁盘占用 → 预览删除 → 执行清理',
    steps: [
      { cmd: 'local-router logs prune --older-than 7d --dry-run', why: '预览将删除的文件数与大小' },
      { cmd: 'local-router logs prune --older-than 7d --yes', why: '确认后删除' },
    ],
    tags: ['ops', 'logs'],
  },
  {
    name: 'agent-bootstrap',
    title: 'AI agent 接入 local-router',
    description: '配置环境变量 → 列命令 → 取 schema',
    steps: [
      { cmd: 'eval "$(local-router env --export)"', why: '注入 OPENAI/ANTHROPIC base url' },
      { cmd: 'local-router commands -o json', why: '获取全部命令 + flag 元数据' },
      { cmd: 'local-router schema -o json', why: '获取命令 / 错误的 JSON schema' },
      { cmd: 'local-router agents-md > AGENTS.md', why: '生成 AI 协作指南' },
    ],
    tags: ['ai', 'integration'],
  },
];

interface RecipesFlags {
  tag?: string;
}

defineSchemaCommand<RecipesFlags>({
  name: 'recipes',
  summary: '常见运维 / 调试 / 接入场景的多步骤指令组合（AI 友好）',
  supportsJson: true,
  positionals: [{ name: 'name', required: false, description: '指定 recipe 名（缺省列出全部）' }],
  flags: [{ name: 'tag', type: 'string', description: '按 tag 过滤（debug, ops, ai, ...）' }],
  fn: ({ positionals, values, ctx }) => {
    const name = positionals[0];
    if (name) {
      const recipe = RECIPES.find((r) => r.name === name);
      if (!recipe) {
        throw new CliError('USAGE_ERROR', `未知 recipe: ${name}`, {
          details: { available: RECIPES.map((r) => r.name) },
        });
      }
      emitResult(ctx, {
        command: 'recipes',
        data: recipe,
        md: {
          heading: `recipe · ${recipe.title}`,
          meta: [recipe.description, `tags: ${recipe.tags.map((t) => `\`${t}\``).join(', ')}`],
          data: recipe.steps
            .map((s, i) => `${i + 1}. \`${s.cmd}\`\n   _${s.why}_`)
            .join('\n'),
        },
        text: recipe.steps.map((s) => s.cmd).join('\n'),
      });
      return;
    }
    const filtered = values.tag ? RECIPES.filter((r) => r.tags.includes(values.tag!)) : RECIPES;
    emitResult(ctx, {
      command: 'recipes',
      data: { count: filtered.length, recipes: filtered.map((r) => ({ name: r.name, title: r.title, tags: r.tags, stepCount: r.steps.length })) },
      md: {
        heading: `recipes · ${filtered.length} 个`,
        meta: values.tag ? [`tag=\`${values.tag}\``] : [],
        data: filtered.map((r) => `- \`${r.name}\` — ${r.title} (${r.steps.length} 步)`).join('\n'),
        hints: ['查看详情: `local-router recipes <name>`'],
      },
    });
  },
});
