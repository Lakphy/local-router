import { CliError } from '../errors';
import { emitDiagnostic, emitResult, type OutputContext, startStream } from '../output';
import { defineSchemaCommand } from '../registry';
import { renderCodeBlock, renderKv, renderTable } from '../render-md';
import { requireTarget } from '../target';

interface RunningState {
  baseUrl: string;
}

async function requireRunning(ctx: OutputContext): Promise<RunningState> {
  const t = await requireTarget(ctx);
  return { baseUrl: t.baseUrl };
}

async function fetchJson(
  url: string,
  init?: RequestInit
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

interface EventsFlags {
  window: string;
  from?: string;
  to?: string;
  provider?: string;
  'route-type'?: string;
  model?: string;
  'model-in'?: string;
  'model-out'?: string;
  user?: string;
  session?: string;
  'status-class'?: string;
  levels?: string;
  q?: string;
  'has-error'?: boolean;
  sort: string;
  limit: number;
  cursor?: string;
}

defineSchemaCommand<EventsFlags>({
  name: 'logs events',
  summary: '查询事件日志（默认 24h 窗口）',
  supportsJson: true,
  requiresRunning: true,
  flags: [
    {
      name: 'window',
      type: 'enum',
      enum: ['1h', '6h', '24h', '7d', '1mo', '1y'],
      default: '24h',
      description: '时间窗口',
    },
    { name: 'from', type: 'string', description: 'ISO 时间戳（覆盖 window）' },
    { name: 'to', type: 'string', description: 'ISO 时间戳' },
    { name: 'provider', type: 'string', multiple: true, description: '逗号分隔过滤' },
    { name: 'route-type', type: 'string', description: '入口协议' },
    { name: 'model', type: 'string', description: '上游 model' },
    { name: 'model-in', type: 'string', description: '请求 model' },
    { name: 'model-out', type: 'string', description: '上游解析后的 model' },
    { name: 'user', type: 'string', description: 'user 过滤' },
    { name: 'session', type: 'string', description: 'session 过滤' },
    { name: 'status-class', type: 'string', description: '2xx,4xx,5xx,network_error' },
    { name: 'levels', type: 'string', description: 'info,error' },
    { name: 'q', type: 'string', description: '全文检索' },
    { name: 'has-error', type: 'boolean', description: '只看错误' },
    {
      name: 'sort',
      type: 'enum',
      enum: ['time_desc', 'time_asc'],
      default: 'time_desc',
      description: '排序',
    },
    { name: 'limit', type: 'number', default: 50, description: '最大返回数' },
    { name: 'cursor', type: 'string', description: '分页游标' },
  ],
  fn: async ({ values, ctx }) => {
    const { baseUrl } = await requireRunning(ctx);
    const params = new URLSearchParams();
    const set = (k: string, v: unknown) => {
      if (v !== undefined && v !== null && v !== '' && v !== false) {
        params.set(k, String(v));
      }
    };
    set('window', values.window);
    set('from', values.from);
    set('to', values.to);
    set('provider', values.provider);
    set('routeType', values['route-type']);
    set('model', values.model);
    set('modelIn', values['model-in']);
    set('modelOut', values['model-out']);
    set('user', values.user);
    set('session', values.session);
    set('statusClass', values['status-class']);
    set('levels', values.levels);
    set('q', values.q);
    set('sort', values.sort);
    set('limit', values.limit);
    set('cursor', values.cursor);
    if (values['has-error']) set('hasError', 'true');
    const qs = params.toString();
    const { status, json } = await fetchJson(`${baseUrl}/api/logs/events?${qs}`);
    if (status !== 200) {
      throw new CliError('UNKNOWN_ERROR', `查询事件失败: ${status}`, { details: json });
    }
    const data = json as {
      items: Array<{
        id: string;
        ts: string;
        level: string;
        provider: string;
        routeType: string;
        modelIn: string;
        modelOut: string;
        upstreamStatus: number;
        statusClass: string;
        latencyMs: number;
        hasError: boolean;
        errorType: string | null;
        message: string;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      stats: {
        total: number;
        errorCount: number;
        errorRate: number;
        avgLatencyMs: number;
        p95LatencyMs: number;
      };
    };
    emitResult(ctx, {
      command: 'logs.events',
      data,
      md: {
        heading: `logs.events · ${data.items.length} 条 · 总计 ${data.stats.total}`,
        meta: [
          `错误 ${data.stats.errorCount} (${(data.stats.errorRate * 100).toFixed(1)}%) · p95 ${data.stats.p95LatencyMs}ms`,
          data.hasMore ? `下一页 cursor: \`${data.nextCursor ?? '–'}\`` : '已是末页',
        ],
        data: renderTable(
          ['ts', 'level', 'route', 'provider/model', 'status', 'lat', 'msg'],
          data.items.map((e) => [
            e.ts,
            e.level === 'error' ? '✗' : 'ℹ',
            `\`${e.routeType}\``,
            `\`${e.provider}/${e.modelOut}\``,
            e.upstreamStatus || '–',
            `${e.latencyMs}ms`,
            (e.message || '').slice(0, 60),
          ])
        ),
        hints: ['单条详情: `local-router logs event <id>`', '只看错误: 加 `--has-error`'],
      },
    });
  },
});

interface EventFlags {
  'include-stream'?: boolean;
}

defineSchemaCommand<EventFlags>({
  name: 'logs event',
  summary: '查看单条事件详情',
  supportsJson: true,
  requiresRunning: true,
  positionals: [{ name: 'id', required: true, description: '事件 ID' }],
  flags: [{ name: 'include-stream', type: 'boolean', description: '附带原始 SSE 内容' }],
  fn: async ({ values, positionals, ctx }) => {
    const id = positionals[0];
    if (!id) throw new CliError('USAGE_ERROR', '用法: logs event <id>');
    const { baseUrl } = await requireRunning(ctx);
    const params = new URLSearchParams();
    if (values['include-stream']) params.set('includeStream', 'true');
    const { status, json } = await fetchJson(
      `${baseUrl}/api/logs/events/${encodeURIComponent(id)}?${params.toString()}`
    );
    if (status === 404) throw new CliError('ROUTE_NOT_FOUND', `事件不存在: ${id}`);
    if (status !== 200)
      throw new CliError('UNKNOWN_ERROR', `查询失败: ${status}`, { details: json });
    const detail = json as {
      summary: Record<string, unknown>;
      request: Record<string, unknown>;
      response: Record<string, unknown>;
      upstream: { streamContent?: string | null };
    };
    emitResult(ctx, {
      command: 'logs.event',
      data: detail,
      md: {
        heading: `logs.event · ${id}`,
        data: [
          '**summary**',
          renderCodeBlock(JSON.stringify(detail.summary, null, 2), 'json'),
          '**request**',
          renderCodeBlock(JSON.stringify(detail.request, null, 2), 'json'),
          '**response**',
          renderCodeBlock(JSON.stringify(detail.response, null, 2), 'json'),
          detail.upstream.streamContent
            ? `**stream**\n${renderCodeBlock(detail.upstream.streamContent, 'text')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    });
  },
});

interface WindowFlags {
  window: string;
}

defineSchemaCommand<WindowFlags>({
  name: 'logs last-error',
  summary: '最近一条错误事件（AI 调试金钥匙）',
  supportsJson: true,
  requiresRunning: true,
  flags: [
    {
      name: 'window',
      type: 'enum',
      enum: ['1h', '6h', '24h', '7d', '1mo', '1y'],
      default: '24h',
      description: '时间窗口',
    },
  ],
  fn: async ({ values, ctx }) => {
    const { baseUrl } = await requireRunning(ctx);
    const w = values.window ?? '24h';
    const { status, json } = await fetchJson(
      `${baseUrl}/api/logs/events?window=${w}&hasError=true&limit=1&sort=time_desc`
    );
    if (status !== 200)
      throw new CliError('UNKNOWN_ERROR', `查询失败: ${status}`, { details: json });
    const data = json as { items: Array<Record<string, unknown>> };
    if (data.items.length === 0) {
      emitResult(ctx, {
        command: 'logs.last-error',
        data: { found: false, window: w },
        md: { heading: 'logs.last-error · 无错误', meta: [`窗口 ${w}`] },
        text: '近期无错误事件',
      });
      return;
    }
    const e = data.items[0]!;
    emitResult(ctx, {
      command: 'logs.last-error',
      data: { found: true, event: e },
      md: {
        heading: `logs.last-error · ${e.upstreamStatus} · ${e.errorType ?? '–'}`,
        meta: [`${e.routeType}/${e.modelIn} → ${e.provider}/${e.modelOut}`, `ts ${e.ts}`],
        data: renderKv([
          { key: 'eventId', value: e.id as string },
          { key: 'upstreamStatus', value: e.upstreamStatus as number },
          { key: 'latencyMs', value: e.latencyMs as number },
          { key: 'errorType', value: (e.errorType as string) ?? '–' },
          { key: 'message', value: (e.message as string) ?? '' },
        ]),
        hints: [
          `完整详情: \`local-router logs event ${e.id}\``,
          `含原始 SSE: \`local-router logs event ${e.id} --include-stream\``,
        ],
      },
    });
  },
});

defineSchemaCommand<WindowFlags>({
  name: 'logs metrics',
  summary: '错误率 / p95 / 吞吐',
  supportsJson: true,
  requiresRunning: true,
  flags: [
    {
      name: 'window',
      type: 'enum',
      enum: ['1h', '6h', '24h'],
      default: '24h',
      description: '时间窗口',
    },
  ],
  fn: async ({ values, ctx }) => {
    const { baseUrl } = await requireRunning(ctx);
    const w = values.window ?? '24h';
    const { status, json } = await fetchJson(`${baseUrl}/api/metrics/logs?window=${w}`);
    if (status !== 200) {
      throw new CliError('UNKNOWN_ERROR', `获取 metrics 失败: ${status}`, { details: json });
    }
    const data = json as {
      window: string;
      summary: {
        totalRequests: number;
        successRequests: number;
        errorRequests: number;
        successRate: number;
        avgLatencyMs: number;
        p95LatencyMs: number;
        totalRequestBytes: number;
        totalResponseBytes: number;
      };
      topProviders?: Array<{ key: string; requests: number; errorRate: number }>;
      topRouteTypes?: Array<{ key: string; requests: number; errorRate: number }>;
      statusClasses?: Record<string, number>;
    };
    const s = data.summary;
    emitResult(ctx, {
      command: 'logs.metrics',
      data,
      md: {
        heading: `logs.metrics · ${w}`,
        meta: [
          `成功率 ${(s.successRate ?? 0).toFixed(2)}% · p95 ${s.p95LatencyMs}ms · 总请求 ${s.totalRequests}`,
        ],
        data: [
          renderKv([
            { key: 'totalRequests', value: s.totalRequests },
            { key: 'successRequests', value: s.successRequests },
            { key: 'errorRequests', value: s.errorRequests },
            { key: 'successRate', value: `${(s.successRate ?? 0).toFixed(2)}%` },
            { key: 'avgLatencyMs', value: s.avgLatencyMs },
            { key: 'p95LatencyMs', value: s.p95LatencyMs },
          ]),
          data.topProviders && data.topProviders.length > 0
            ? `**Top providers**\n\n${renderTable(
                ['key', 'requests', 'errorRate'],
                data.topProviders.map((t) => [
                  `\`${t.key}\``,
                  t.requests,
                  `${(t.errorRate * 100).toFixed(2)}%`,
                ])
              )}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    });
  },
});

defineSchemaCommand({
  name: 'logs storage',
  summary: '日志磁盘占用',
  supportsJson: true,
  requiresRunning: true,
  fn: async ({ ctx }) => {
    const { baseUrl } = await requireRunning(ctx);
    const { status, json } = await fetchJson(`${baseUrl}/api/logs/storage`);
    if (status !== 200) {
      throw new CliError('UNKNOWN_ERROR', `获取 storage 失败: ${status}`, { details: json });
    }
    emitResult(ctx, {
      command: 'logs.storage',
      data: json,
      md: { heading: 'logs.storage', data: renderCodeBlock(JSON.stringify(json, null, 2), 'json') },
    });
  },
});

interface SessionsFlags {
  window: string;
  user?: string;
  limit: number;
}

defineSchemaCommand<SessionsFlags>({
  name: 'logs sessions',
  summary: '按 session 聚合',
  supportsJson: true,
  requiresRunning: true,
  flags: [
    {
      name: 'window',
      type: 'enum',
      enum: ['1h', '6h', '24h', '7d', '1mo', '1y'],
      default: '24h',
      description: '时间窗口',
    },
    { name: 'user', type: 'string', description: 'user 过滤' },
    { name: 'limit', type: 'number', default: 50, description: '最大 session 数' },
  ],
  fn: async ({ values, ctx }) => {
    const { baseUrl } = await requireRunning(ctx);
    const params = new URLSearchParams();
    params.set('window', values.window ?? '24h');
    if (values.user) params.set('user', values.user);
    if (values.limit) params.set('limit', String(values.limit));
    const { status, json } = await fetchJson(`${baseUrl}/api/logs/sessions?${params}`);
    if (status !== 200) {
      throw new CliError('UNKNOWN_ERROR', `查询 sessions 失败: ${status}`, { details: json });
    }
    emitResult(ctx, {
      command: 'logs.sessions',
      data: json,
      md: {
        heading: 'logs.sessions',
        data: renderCodeBlock(JSON.stringify(json, null, 2), 'json'),
      },
    });
  },
});

defineSchemaCommand({
  name: 'logs tail',
  summary: '实时事件流（NDJSON）',
  supportsJson: true,
  requiresRunning: true,
  fn: async ({ ctx }) => {
    const { baseUrl } = await requireRunning(ctx);
    const stream = startStream(ctx, 'logs.tail');
    const res = await fetch(`${baseUrl}/api/logs/tail`, {
      headers: { accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) {
      stream.error(new CliError('UNKNOWN_ERROR', `tail 失败: ${res.status}`));
      return;
    }
    emitDiagnostic(ctx, '订阅 SSE 事件流，Ctrl+C 退出');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          stream.event('event', obj);
        } catch {
          stream.event('raw', { line: payload });
        }
      }
    }
    stream.end();
  },
});

interface ExportFlags {
  format: 'json' | 'csv' | 'jsonl';
  window: string;
  from?: string;
  to?: string;
}

defineSchemaCommand<ExportFlags>({
  name: 'logs export',
  summary: '导出日志（json/csv/jsonl）',
  supportsJson: false,
  requiresRunning: true,
  flags: [
    {
      name: 'format',
      type: 'enum',
      enum: ['json', 'csv', 'jsonl'],
      default: 'jsonl',
      description: '导出格式',
    },
    {
      name: 'window',
      type: 'enum',
      enum: ['1h', '6h', '24h', '7d', '1mo', '1y'],
      default: '24h',
      description: '时间窗口',
    },
    { name: 'from', type: 'string', description: 'ISO 起点' },
    { name: 'to', type: 'string', description: 'ISO 终点' },
  ],
  fn: async ({ values, ctx }) => {
    const { baseUrl } = await requireRunning(ctx);
    const params = new URLSearchParams();
    params.set('format', values.format ?? 'jsonl');
    params.set('window', values.window ?? '24h');
    if (values.from) params.set('from', values.from);
    if (values.to) params.set('to', values.to);
    const res = await fetch(`${baseUrl}/api/logs/export?${params}`);
    if (!res.ok || !res.body) throw new CliError('UNKNOWN_ERROR', `导出失败: ${res.status}`);
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      process.stdout.write(value);
    }
  },
});

interface ReplayFlags {
  'dry-run'?: boolean;
}

defineSchemaCommand<ReplayFlags>({
  name: 'logs replay',
  summary: '用同样参数对当前路由再发一次（基于事件详情重建请求）',
  supportsJson: true,
  requiresRunning: true,
  positionals: [{ name: 'event-id', required: true, description: '事件 ID' }],
  flags: [{ name: 'dry-run', type: 'boolean', description: '只输出将发送的请求，不实际发出' }],
  fn: async ({ values, positionals, ctx }) => {
    const id = positionals[0];
    if (!id) throw new CliError('USAGE_ERROR', '用法: logs replay <event-id>');
    const { baseUrl } = await requireRunning(ctx);
    const detailRes = await fetchJson(`${baseUrl}/api/logs/events/${encodeURIComponent(id)}`);
    if (detailRes.status === 404) throw new CliError('ROUTE_NOT_FOUND', `事件不存在: ${id}`);
    if (detailRes.status !== 200) {
      throw new CliError('UNKNOWN_ERROR', `获取事件失败: ${detailRes.status}`);
    }
    const detail = detailRes.json as {
      request: { method: string; path: string; requestBody: unknown };
      summary: { routeType: string; modelIn: string };
    };
    const url = `${baseUrl}${detail.request.path}`;
    const body = detail.request.requestBody;
    if (values['dry-run']) {
      emitResult(ctx, {
        command: 'logs.replay',
        data: { url, method: detail.request.method, body, dryRun: true },
        md: {
          heading: `logs.replay · dry-run · ${detail.summary.routeType}/${detail.summary.modelIn}`,
          data: [
            `**请求**: \`${detail.request.method} ${url}\``,
            renderCodeBlock(JSON.stringify(body, null, 2), 'json'),
          ].join('\n\n'),
        },
      });
      return;
    }
    const startedAt = Date.now();
    const res = await fetch(url, {
      method: detail.request.method,
      headers: { 'content-type': 'application/json' },
      body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {}
    const latencyMs = Date.now() - startedAt;
    emitResult(ctx, {
      command: 'logs.replay',
      data: { url, status: res.status, latencyMs, response: json },
      md: {
        heading: `logs.replay · ${res.status} · ${latencyMs}ms`,
        data: renderCodeBlock(JSON.stringify(json, null, 2).slice(0, 800), 'json'),
      },
    });
  },
});
