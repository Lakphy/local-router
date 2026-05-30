import type { CliErrorCode } from './errors';

export interface ErrorDoc {
  code: CliErrorCode;
  exitCode: number;
  summary: string;
  cause: string;
  fix: string;
}

export const ERROR_DOCS: Record<CliErrorCode, Omit<ErrorDoc, 'code' | 'exitCode'>> = {
  USAGE_ERROR: {
    summary: '命令用法错误',
    cause: '缺少必填参数、参数值无效，或使用了未知子命令。',
    fix: '运行 `local-router help <cmd>` 查看正确用法；或 `local-router commands --json` 列出全部命令。',
  },
  CONFIG_NOT_FOUND: {
    summary: '配置文件不存在',
    cause: '`--config` 指向的文件缺失，或默认路径下没有 config。',
    fix: '运行 `local-router init` 初始化默认配置。',
  },
  CONFIG_INVALID: {
    summary: '配置不通过 schema 校验',
    cause:
      '修改后的字段不满足 `config.schema.json` 约束（例如缺少 `*` 兜底、provider 引用空字符串）。',
    fix: '运行 `local-router schema config` 查看 schema；或 `local-router config validate` 看具体校验报错。',
  },
  PROVIDER_NOT_FOUND: {
    summary: '引用的 provider 不存在',
    cause: '命令中传入的 provider 名称未在 `providers` 字段下注册。',
    fix: '`local-router config provider list` 查看现有；或 `local-router config provider add ...` 新建。',
  },
  PROVIDER_EXISTS: {
    summary: 'provider 已存在',
    cause: '同名 provider 已经注册。',
    fix: '使用 `local-router config provider set <name>` 修改字段，而不是再次 `add`。',
  },
  PROVIDER_REFERENCED_BY_ROUTE: {
    summary: 'provider 仍被某些路由引用，不能直接删除',
    cause: '`routes.<entry>.<match>.provider` 仍指向待删除的 provider。',
    fix: '加 `--force` 联动清理路由，或先 `local-router config route remove <entry> <match>`。',
  },
  MODEL_NOT_FOUND: {
    summary: 'provider 下不存在该 model',
    cause: '`providers.<name>.models` 没有该 key。',
    fix: '`local-router config provider model list <provider>` 查看；或 `... model add <provider> <model>` 新建。',
  },
  MODEL_EXISTS: {
    summary: 'model 已存在',
    cause: '同名 model 已注册到 provider。',
    fix: '使用 `... provider model set` 修改字段，而不是再次 `add`。',
  },
  ROUTE_NOT_FOUND: {
    summary: '路由 entry / match 不存在',
    cause: '`routes` 下没有匹配的 entry 或 match。',
    fix: '`local-router config route list` 查看；或 `... route set <entry> <match> ...` 新建。',
  },
  ROUTE_FALLBACK_PROTECTED: {
    summary: '禁止删除 `*` 兜底规则',
    cause: '每个 entry 必须保留 `*` 规则，否则未匹配的请求将无目标。',
    fix: '如果确认要清空，加 `--allow-remove-fallback` 显式确认。',
  },
  SERVICE_NOT_RUNNING: {
    summary: '服务未运行',
    cause: '当前命令需要 daemon，但 `~/.local-router/run/status.json` 不存在或对应进程已退出。',
    fix: '`local-router start --daemon` 启动；或 `local-router status` 检查状态。',
  },
  SERVICE_ALREADY_RUNNING: {
    summary: '服务已经在运行',
    cause: '`status.json` 显示已有活动进程并且健康检查通过。',
    fix: '`local-router status` 查看；如需重启使用 `local-router restart`。',
  },
  PORT_IN_USE: {
    summary: '端口已被占用',
    cause: '指定（或默认）端口已被其它进程监听。',
    fix: '换端口: `local-router start --port <new>`；或先停止占用进程。',
  },
  HEALTH_FAILED: {
    summary: '健康检查失败',
    cause: '`/api/health` 没有返回 2xx，可能是进程刚崩溃或 apply 之后状态不一致。',
    fix: '查看日志: `local-router logs daemon`；必要时 `local-router restart`。',
  },
  APPLY_FAILED: {
    summary: '配置热加载失败',
    cause: '`POST /api/config/apply` 返回非 2xx，通常是新配置不通过校验。',
    fix: '`local-router config validate` 先离线校验；修复后再 apply。',
  },
  UPSTREAM_UNREACHABLE: {
    summary: '上游 API 不可达',
    cause: 'provider 的 `base` 在网络层无法连通（DNS/TLS/代理）。',
    fix: '`local-router ping <provider>`；检查 `proxy` 字段；试试 `curl -v <base>`。',
  },
  TIMEOUT: {
    summary: '阻塞等待超时',
    cause: '`--wait-running / --wait-stopped / --wait-healthy` 在指定秒数内未达到目标状态。',
    fix: '加大 `--timeout`；或独立诊断（`local-router status`、`local-router logs daemon`）。',
  },
  INTERACTIVE_REQUIRED: {
    summary: '需要交互式终端',
    cause: '命令缺少必填 flag，本应弹出选择器但当前 stdin 不是 TTY 或显式 `--no-interactive`。',
    fix: '在错误的 `details` 里查看候选项，显式补 `--provider/--model` 等。',
  },
  TARGET_NOT_FOUND: {
    summary: '找不到可连接的 local-router',
    cause: '默认端口 4099 上没有 local-router，OS 进程枚举也未发现其它实例。',
    fix: '`local-router start` 启动；或用 `--port <port>` / `--url <url>` 指定目标。',
  },
  TARGET_UNREACHABLE: {
    summary: '指定的目标无法连通',
    cause: '`--port` / `--url`（或环境变量）指向的地址没有响应 `/api/health` 或不是 local-router。',
    fix: '确认目标端口/地址正确且 local-router 正在该地址监听。',
  },
  UNKNOWN_ERROR: {
    summary: '未知错误',
    cause: '没有匹配到任何 CliError 类型。',
    fix: '加 `--verbose` 重试，或附 stderr 上报 issue。',
  },
};

export function getErrorDocs(): ErrorDoc[] {
  return (Object.keys(ERROR_DOCS) as CliErrorCode[]).map((code) => {
    const entry = ERROR_DOCS[code];
    // exitCode 由 errors.ts 的 listErrorCodes 提供
    return { code, exitCode: -1, summary: entry.summary, cause: entry.cause, fix: entry.fix };
  });
}
