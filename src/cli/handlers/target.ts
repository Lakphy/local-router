/**
 * `local-router target` — show which running local-router client commands will
 * talk to, and how that target was resolved. With --verbose, list every
 * local-router discovered via OS process enumeration.
 */
import { emitResult } from '../output';
import { defineSchemaCommand } from '../registry';
import { renderKv, renderTable } from '../render-md';
import { discoverLocalRouters, resolveTarget } from '../target';

const SOURCE_LABEL: Record<string, string> = {
  flag: '命令行 --port/--url/--host',
  env: '环境变量 LOCAL_ROUTER_URL/PORT',
  runtime: '本机 daemon (status.json)',
  default: '默认端口 4099',
  discovered: 'OS 进程枚举发现',
  prompt: '交互输入',
};

defineSchemaCommand({
  name: 'target',
  summary: '显示当前解析到的 local-router 目标（端口/来源/版本）',
  supportsJson: true,
  requiresRunning: false,
  flags: [],
  fn: async ({ ctx }) => {
    const t = await resolveTarget(ctx.flags);

    const candidates = ctx.flags.verbose ? await discoverLocalRouters() : [];

    emitResult(ctx, {
      command: 'target',
      data: {
        baseUrl: t.baseUrl,
        host: t.host,
        port: t.port,
        version: t.version ?? null,
        source: t.source,
        candidates: ctx.flags.verbose
          ? candidates.map((c) => ({ port: c.port, version: c.version ?? null }))
          : undefined,
      },
      md: {
        heading: `target · ${t.host}:${t.port}${t.version ? ` (v${t.version})` : ''}`,
        meta: [`来源: ${SOURCE_LABEL[t.source] ?? t.source}`],
        data: [
          renderKv([
            { key: 'baseUrl', value: t.baseUrl },
            { key: 'host', value: t.host },
            { key: 'port', value: t.port },
            { key: 'version', value: t.version ?? 'unknown' },
            { key: 'source', value: t.source },
          ]),
          ctx.flags.verbose
            ? `**发现的实例**\n\n${
                candidates.length > 0
                  ? renderTable(
                      ['port', 'version'],
                      candidates.map((c) => [String(c.port), c.version ?? '?'])
                    )
                  : '（未发现其它实例）'
              }`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      text: t.baseUrl,
    });
  },
});
