/**
 * Thin shim registrations for the `config ...` subtree so they participate in
 * the registry (commands --json, help, completion, did-you-mean). Execution is
 * still delegated to the imperative dispatcher in `config-command.ts`.
 *
 * TODO(spec-first): forward 模式维持 parseArgs 双写（schema 一遍 + cmdConfig 内部一遍）。
 * 后续应让 cmdConfig 内每个分支也接收 ParsedCommandArgs 而非 string[]，由
 * defineSchemaCommand 直驱。Tracking: docs/cli-extreme-optimization-plan.md PR-1。
 */
import { cmdConfig } from './config-command';
import { defineCommand } from './registry';

const PROVIDER_TYPE_ENUM = ['openai-completions', 'openai-responses', 'anthropic-messages'];

const COMMON_CONFIG_FLAG = { name: 'config', type: 'string', description: '配置文件路径' } as const;
const DRY_RUN_FLAG = {
  name: 'dry-run',
  type: 'boolean',
  description: '只预览 diff，不写入',
} as const;

function forward(prefix: string[]) {
  return async (args: string[], flags: import('./global-flags').GlobalFlags) =>
    cmdConfig([...prefix, ...args], flags);
}

// ─── config show / diff / import / patch / backups / rollback ────────────────

defineCommand({
  name: 'config show',
  summary: '打印当前生效配置（默认遮罩 apiKey）',
  flags: [
    { name: 'show-secrets', type: 'boolean', description: '显示明文密钥' },
    COMMON_CONFIG_FLAG,
  ],
  supportsJson: true,
  handler: forward(['show']),
});

defineCommand({
  name: 'config diff',
  summary: '与备份或指定文件对比',
  flags: [{ name: 'against', type: 'string', description: '备份 id 或路径' }, COMMON_CONFIG_FLAG],
  supportsJson: true,
  handler: forward(['diff']),
});

defineCommand({
  name: 'config import',
  summary: '从 stdin 或文件导入配置（合并/替换）',
  flags: [
    { name: 'file', type: 'string', description: '`-` 读 stdin，或路径' },
    { name: 'merge', type: 'boolean', description: '与当前 deep-merge（默认）' },
    { name: 'replace', type: 'boolean', description: '整体替换' },
    DRY_RUN_FLAG,
    COMMON_CONFIG_FLAG,
  ],
  mutates: true,
  supportsJson: true,
  handler: forward(['import']),
});

defineCommand({
  name: 'config patch',
  summary: 'JSON Patch (RFC6902) 增量更新',
  flags: [
    { name: 'file', type: 'string', description: '`-` 读 stdin，或路径' },
    DRY_RUN_FLAG,
    COMMON_CONFIG_FLAG,
  ],
  mutates: true,
  supportsJson: true,
  handler: forward(['patch']),
});

defineCommand({
  name: 'config backups list',
  summary: '列出配置备份',
  flags: [COMMON_CONFIG_FLAG],
  supportsJson: true,
  handler: forward(['backups', 'list']),
});

defineCommand({
  name: 'config rollback',
  summary: '回滚到指定备份',
  positionals: [{ name: 'backup-id', required: true, description: '备份 id' }],
  flags: [DRY_RUN_FLAG, COMMON_CONFIG_FLAG],
  mutates: true,
  supportsJson: true,
  handler: forward(['rollback']),
});

// ─── config validate / apply / resolve ───────────────────────────────────────

defineCommand({
  name: 'config validate',
  summary: 'JSON Schema 校验配置文件',
  flags: [COMMON_CONFIG_FLAG],
  supportsJson: true,
  handler: forward(['validate']),
});

defineCommand({
  name: 'config apply',
  summary: '通知 daemon 热加载配置',
  supportsJson: true,
  requiresRunning: true,
  handler: forward(['apply']),
});

defineCommand({
  name: 'config resolve',
  summary: '解析路由命中（不发请求）',
  flags: [
    { name: 'entry', type: 'string', required: true, description: '协议入口' },
    { name: 'model', type: 'string', required: true, description: '请求 model' },
    COMMON_CONFIG_FLAG,
  ],
  supportsJson: true,
  handler: forward(['resolve']),
});

// ─── config provider {list,show,add,set,remove} ──────────────────────────────

defineCommand({
  name: 'config provider list',
  summary: '列出所有 provider',
  flags: [COMMON_CONFIG_FLAG],
  supportsJson: true,
  handler: forward(['provider', 'list']),
});

defineCommand({
  name: 'config provider show',
  summary: '查看单个 provider',
  positionals: [{ name: 'name', required: true, description: 'provider 名' }],
  flags: [
    { name: 'show-secrets', type: 'boolean', description: '显示明文密钥' },
    COMMON_CONFIG_FLAG,
  ],
  supportsJson: true,
  handler: forward(['provider', 'show']),
});

defineCommand({
  name: 'config provider add',
  summary: '新增 provider',
  positionals: [{ name: 'name', required: true, description: 'provider 名' }],
  flags: [
    {
      name: 'type',
      type: 'enum',
      enum: [...PROVIDER_TYPE_ENUM],
      required: true,
      description: 'provider 类型',
    },
    { name: 'base', type: 'string', required: true, description: 'base URL' },
    { name: 'api-key', type: 'string', required: true, description: 'API key' },
    { name: 'model', type: 'string', required: true, description: '初始 model' },
    { name: 'image-input', type: 'boolean', description: '初始 model 支持图片输入' },
    { name: 'reasoning', type: 'boolean', description: '初始 model 支持 reasoning' },
    { name: 'proxy', type: 'string', description: 'HTTP(S) 代理' },
    DRY_RUN_FLAG,
    COMMON_CONFIG_FLAG,
  ],
  mutates: true,
  supportsJson: true,
  handler: forward(['provider', 'add']),
});

defineCommand({
  name: 'config provider add-lan',
  summary: '从局域网内其他 local-router 嗅探并新增 provider',
  positionals: [{ name: 'ip', required: true, description: '对端 IP' }],
  flags: [
    {
      name: 'type',
      type: 'enum',
      enum: [...PROVIDER_TYPE_ENUM],
      required: true,
      description: '协议类型',
    },
    { name: 'port', type: 'string', description: '对端端口（默认 4099）' },
    DRY_RUN_FLAG,
    COMMON_CONFIG_FLAG,
  ],
  mutates: true,
  supportsJson: true,
  handler: forward(['provider', 'add-lan']),
});

defineCommand({
  name: 'config provider set',
  summary: '修改 provider 字段',
  positionals: [{ name: 'name', required: true, description: 'provider 名' }],
  flags: [
    { name: 'base', type: 'string', description: '新 base URL' },
    { name: 'api-key', type: 'string', description: '新 API key' },
    { name: 'proxy', type: 'string', description: '新 proxy' },
    DRY_RUN_FLAG,
    COMMON_CONFIG_FLAG,
  ],
  mutates: true,
  supportsJson: true,
  handler: forward(['provider', 'set']),
});

defineCommand({
  name: 'config provider remove',
  summary: '删除 provider（被路由引用需要 --force）',
  positionals: [{ name: 'name', required: true, description: 'provider 名' }],
  flags: [
    { name: 'force', type: 'boolean', description: '联动清理引用此 provider 的路由' },
    DRY_RUN_FLAG,
    COMMON_CONFIG_FLAG,
  ],
  mutates: true,
  supportsJson: true,
  handler: forward(['provider', 'remove']),
});

// ─── config provider model {list,add,set,remove} ─────────────────────────────

defineCommand({
  name: 'config provider model list',
  summary: '列出 provider 的 models',
  positionals: [{ name: 'provider', required: true, description: 'provider 名' }],
  flags: [COMMON_CONFIG_FLAG],
  supportsJson: true,
  handler: forward(['provider', 'model', 'list']),
});

defineCommand({
  name: 'config provider model add',
  summary: '为 provider 新增 model',
  positionals: [
    { name: 'provider', required: true, description: 'provider 名' },
    { name: 'model', required: true, description: 'model 名' },
  ],
  flags: [
    { name: 'image-input', type: 'boolean', description: '支持图片输入' },
    { name: 'reasoning', type: 'boolean', description: '支持 reasoning' },
    DRY_RUN_FLAG,
    COMMON_CONFIG_FLAG,
  ],
  mutates: true,
  supportsJson: true,
  handler: forward(['provider', 'model', 'add']),
});

defineCommand({
  name: 'config provider model set',
  summary: '修改 model 能力位（true/false）',
  positionals: [
    { name: 'provider', required: true, description: 'provider 名' },
    { name: 'model', required: true, description: 'model 名' },
  ],
  flags: [
    { name: 'image-input', type: 'string', description: 'true 或 false' },
    { name: 'reasoning', type: 'string', description: 'true 或 false' },
    DRY_RUN_FLAG,
    COMMON_CONFIG_FLAG,
  ],
  mutates: true,
  supportsJson: true,
  handler: forward(['provider', 'model', 'set']),
});

defineCommand({
  name: 'config provider model remove',
  summary: '从 provider 删除 model',
  positionals: [
    { name: 'provider', required: true, description: 'provider 名' },
    { name: 'model', required: true, description: 'model 名' },
  ],
  flags: [DRY_RUN_FLAG, COMMON_CONFIG_FLAG],
  mutates: true,
  supportsJson: true,
  handler: forward(['provider', 'model', 'remove']),
});

// ─── config route {list,show,set,remove,plan} ────────────────────────────────

defineCommand({
  name: 'config route list',
  summary: '列出所有路由',
  flags: [{ name: 'entry', type: 'string', description: '只看某入口' }, COMMON_CONFIG_FLAG],
  supportsJson: true,
  handler: forward(['route', 'list']),
});

defineCommand({
  name: 'config route show',
  summary: '查看某入口下的所有路由',
  positionals: [{ name: 'entry', required: true, description: '协议入口' }],
  flags: [COMMON_CONFIG_FLAG],
  supportsJson: true,
  handler: forward(['route', 'show']),
});

defineCommand({
  name: 'config route set',
  summary: '设置路由（缺 provider/model 时进入交互选择）',
  positionals: [
    { name: 'entry', required: true, description: '协议入口' },
    { name: 'match-model', required: true, description: '请求 model 匹配（含 `*`）' },
  ],
  flags: [
    { name: 'provider', type: 'string', description: '目标 provider' },
    { name: 'model', type: 'string', description: '目标 model' },
    { name: 'interactive', type: 'boolean', description: '强制交互选择' },
    DRY_RUN_FLAG,
    COMMON_CONFIG_FLAG,
  ],
  mutates: true,
  supportsJson: true,
  handler: forward(['route', 'set']),
});

defineCommand({
  name: 'config route remove',
  summary: '删除路由（删 * 兜底需要 --allow-remove-fallback）',
  positionals: [
    { name: 'entry', required: true, description: '协议入口' },
    { name: 'match-model', required: true, description: '请求 model 匹配' },
  ],
  flags: [
    { name: 'allow-remove-fallback', type: 'boolean', description: '允许删除 * 兜底' },
    DRY_RUN_FLAG,
    COMMON_CONFIG_FLAG,
  ],
  mutates: true,
  supportsJson: true,
  handler: forward(['route', 'remove']),
});

defineCommand({
  name: 'config route plan',
  summary: '解析路由命中（多步追踪）',
  flags: [
    { name: 'entry', type: 'string', required: true, description: '协议入口' },
    { name: 'model', type: 'string', required: true, description: '请求 model' },
    COMMON_CONFIG_FLAG,
  ],
  supportsJson: true,
  handler: forward(['route', 'plan']),
});

// ─── help fallback ───────────────────────────────────────────────────────────

defineCommand({
  name: 'config',
  summary: 'config 子命令组（不带子命令打印帮助）',
  supportsJson: true,
  handler: forward([]),
});
