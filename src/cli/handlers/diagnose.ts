import { existsSync } from 'node:fs';
import { type AppConfig, loadConfig, resolveConfigPath } from '../../config';
import { validateConfigOrThrow } from '../../config-validate';
import { CliError } from '../errors';
import { emitResult, startStream } from '../output';
import { checkHealth, cleanupIfStale } from '../process';
import { defineSchemaCommand } from '../registry';
import { renderCodeBlock, renderKv, renderTable } from '../render-md';
import { readRuntimeState } from '../runtime';

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  errorCode?: string;
}

function tryRead(configArg: string | undefined): {
  path: string;
  config: AppConfig | null;
  error: string | null;
} {
  try {
    const path = resolveConfigPath(configArg);
    if (!existsSync(path)) {
      return { path, config: null, error: `配置文件不存在: ${path}` };
    }
    const config = loadConfig(path);
    return { path, config, error: null };
  } catch (err) {
    return {
      path: configArg ?? '',
      config: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeUrl(
  url: string,
  timeoutMs = 3000
): Promise<{ ok: boolean; status: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    return { ok: res.status > 0 && res.status < 500, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: -1,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

interface DoctorFlags {
  config?: string;
  'skip-providers'?: boolean;
  fix?: boolean;
}

defineSchemaCommand<DoctorFlags>({
  name: 'doctor',
  summary: '环境自检（配置 / 端口 / 服务 / 上游可达性）',
  supportsJson: true,
  flags: [
    { name: 'config', type: 'string', description: '指定配置文件' },
    { name: 'skip-providers', type: 'boolean', description: '跳过 provider HEAD 探测' },
    {
      name: 'fix',
      type: 'boolean',
      description: '尝试自动修复（创建默认配置 / 清理 stale runtime / 启动 daemon）',
    },
  ],
  fn: async ({ values, ctx }) => {
    const fixes: string[] = [];
    const checks: DoctorCheck[] = [];
    let { path, config, error: configErr } = tryRead(values.config);
    if (configErr || !config) {
      if (values.fix) {
        const { writeDefaultConfigFile } = await import('../../config');
        const written = writeDefaultConfigFile(path, { overwrite: false });
        fixes.push(`已写入默认配置: ${written.path}`);
        const reread = tryRead(values.config);
        path = reread.path;
        config = reread.config;
        configErr = reread.error;
      }
    }
    if (configErr || !config) {
      checks.push({
        name: '配置文件',
        ok: false,
        detail: configErr ?? '未知',
        errorCode: 'CONFIG_NOT_FOUND',
      });
    } else {
      checks.push({ name: '配置文件', ok: true, detail: path });
      try {
        validateConfigOrThrow(config);
        checks.push({ name: '配置校验', ok: true, detail: 'schema OK' });
      } catch (err) {
        checks.push({
          name: '配置校验',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          errorCode: 'CONFIG_INVALID',
        });
      }
    }

    await cleanupIfStale();
    let state = readRuntimeState();
    if (!state && values.fix) {
      const { startDaemon } = await import('../process');
      try {
        await startDaemon({ config: path });
        fixes.push('已启动 daemon');
        await cleanupIfStale();
        state = readRuntimeState();
      } catch (err) {
        fixes.push(`daemon 启动失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (state) {
      const healthy = await checkHealth(state.baseUrl);
      checks.push({
        name: '服务运行',
        ok: healthy,
        detail: healthy
          ? `pid ${state.pid} · ${state.baseUrl}`
          : `pid ${state.pid}, 但健康检查失败 (${state.baseUrl}/api/health)`,
        errorCode: healthy ? undefined : 'HEALTH_FAILED',
      });
    } else {
      checks.push({
        name: '服务运行',
        ok: false,
        detail: '未运行（status.json 缺失）',
        errorCode: 'SERVICE_NOT_RUNNING',
      });
    }

    if (config && !values['skip-providers']) {
      for (const [name, p] of Object.entries(config.providers)) {
        const probe = await probeUrl(p.base);
        checks.push({
          name: `provider \`${name}\` 可达`,
          ok: probe.ok,
          detail: probe.ok
            ? `HEAD ${p.base} → ${probe.status}`
            : `HEAD ${p.base} → ${probe.error ?? probe.status}`,
          errorCode: probe.ok ? undefined : 'UPSTREAM_UNREACHABLE',
        });
      }
    }

    const passed = checks.filter((c) => c.ok).length;
    const total = checks.length;
    const allOk = passed === total;
    emitResult(ctx, {
      command: 'doctor',
      data: { ok: allOk, passed, total, checks, fixes },
      md: {
        heading: `doctor · ${passed}/${total} 通过${fixes.length ? ` · 已修复 ${fixes.length} 项` : ''}`,
        meta: [`${allOk ? '✓ 全部通过' : `✗ ${total - passed} 项失败`}`],
        data: [
          renderTable(
            ['检查', '结果', '详情'],
            checks.map((c) => [c.name, c.ok ? '✓' : '✗', c.detail])
          ),
          fixes.length > 0 ? `**已应用修复**\n\n${fixes.map((f) => `- ${f}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        hints: allOk
          ? []
          : [
              ...(values.fix ? [] : ['尝试自动修复: `local-router doctor --fix`']),
              ...checks
                .filter((c) => !c.ok && c.errorCode)
                .map(
                  (c) => `\`${c.errorCode}\`: 详情见 \`local-router docs errors ${c.errorCode}\``
                ),
            ],
      },
      text: checks.map((c) => `${c.ok ? '[OK]' : '[FAIL]'} ${c.name}: ${c.detail}`).join('\n'),
    });
  },
});

interface ExplainRouteFlags {
  entry: string;
  model: string;
  config?: string;
}

defineSchemaCommand<ExplainRouteFlags>({
  name: 'explain route',
  summary: '路由命中追踪（包含 fallback 标记）',
  supportsJson: true,
  flags: [
    { name: 'entry', type: 'string', required: true, description: '协议入口' },
    { name: 'model', type: 'string', required: true, description: '请求 model 名' },
    { name: 'config', type: 'string', description: '配置文件路径' },
  ],
  fn: ({ values, ctx }) => {
    const { entry, model: reqModel } = values;
    const path = resolveConfigPath(values.config);
    const config = loadConfig(path);
    const modelMap = config.routes[entry];
    if (!modelMap) {
      throw new CliError('ROUTE_NOT_FOUND', `route entry 不存在: ${entry}`, {
        details: { available: Object.keys(config.routes) },
      });
    }
    const exact = modelMap[reqModel];
    const fallback = modelMap['*'];
    const target = exact ?? fallback;
    if (!target) {
      throw new CliError('ROUTE_NOT_FOUND', `未命中且缺少 * 兜底: ${entry}`);
    }
    const provider = config.providers[target.provider];
    if (!provider) {
      throw new CliError('PROVIDER_NOT_FOUND', `路由目标 provider 不存在: ${target.provider}`);
    }
    const upstreamPathByType: Record<string, string> = {
      'openai-completions': '/v1/chat/completions',
      'openai-responses': '/v1/responses',
      'anthropic-messages': '/v1/messages',
    };
    const upstreamUrl = `${provider.base.replace(/\/+$/, '')}${upstreamPathByType[provider.type] ?? ''}`;
    const data = {
      entry,
      requestModel: reqModel,
      matchedRule: `${entry}.${exact ? reqModel : '*'}`,
      fallbackUsed: !exact && !!fallback,
      provider: target.provider,
      targetModel: target.model,
      providerType: provider.type,
      providerBase: provider.base,
      upstreamUrl,
    };
    emitResult(ctx, {
      command: 'explain.route',
      data,
      md: {
        heading: `explain.route · ${entry}.${reqModel}`,
        meta: [
          `匹配 \`${data.matchedRule}\`${data.fallbackUsed ? ' (fallback)' : ''}`,
          `→ \`${data.provider}/${data.targetModel}\``,
        ],
        data: renderKv([
          { key: 'matchedRule', value: data.matchedRule },
          { key: 'fallbackUsed', value: data.fallbackUsed },
          { key: 'provider', value: data.provider },
          { key: 'targetModel', value: data.targetModel },
          { key: 'providerType', value: data.providerType },
          { key: 'providerBase', value: data.providerBase },
          { key: 'upstreamUrl', value: data.upstreamUrl },
        ]),
        hints: [
          `本地直发: \`local-router try --entry ${entry} --model ${reqModel} --prompt ping\``,
        ],
      },
    });
  },
});

interface TryPayload {
  url: string;
  body: Record<string, unknown>;
  parseSample(json: unknown): string;
}

function buildTryPayload(
  entry: string,
  model: string,
  prompt: string,
  baseUrl: string
): TryPayload {
  const stripped = baseUrl.replace(/\/+$/, '');
  if (entry === 'openai-completions') {
    return {
      url: `${stripped}/openai-completions/v1/chat/completions`,
      body: { model, messages: [{ role: 'user', content: prompt }] },
      parseSample: (j) => {
        const obj = j as { choices?: Array<{ message?: { content?: string } }> };
        return obj.choices?.[0]?.message?.content ?? JSON.stringify(j).slice(0, 200);
      },
    };
  }
  if (entry === 'openai-responses') {
    return {
      url: `${stripped}/openai-responses/v1/responses`,
      body: { model, input: prompt },
      parseSample: (j) => JSON.stringify(j).slice(0, 200),
    };
  }
  if (entry === 'anthropic-messages') {
    return {
      url: `${stripped}/anthropic-messages/v1/messages`,
      body: {
        model,
        max_tokens: 64,
        messages: [{ role: 'user', content: prompt }],
      },
      parseSample: (j) => {
        const obj = j as { content?: Array<{ text?: string }> };
        return obj.content?.[0]?.text ?? JSON.stringify(j).slice(0, 200);
      },
    };
  }
  throw new CliError('USAGE_ERROR', `未知 entry: ${entry}`, {
    hint: '支持: openai-completions / openai-responses / anthropic-messages',
  });
}

interface TryFlags {
  entry: string;
  model: string;
  prompt: string;
  stream?: boolean;
  timeout: number;
}

defineSchemaCommand<TryFlags>({
  name: 'try',
  summary: '端到端最小请求验证（需要服务运行）',
  supportsJson: true,
  requiresRunning: true,
  flags: [
    { name: 'entry', type: 'string', required: true, description: '入口协议' },
    { name: 'model', type: 'string', required: true, description: '请求 model 名' },
    { name: 'prompt', type: 'string', default: 'ping', description: '提示词' },
    { name: 'stream', type: 'boolean', description: 'NDJSON 流式输出' },
    { name: 'timeout', type: 'number', default: 30, description: '请求超时秒数' },
  ],
  fn: async ({ values, ctx }) => {
    const { entry, model, prompt, stream: streamMode, timeout: timeoutSec } = values;

    await cleanupIfStale();
    const state = readRuntimeState();
    if (!state) {
      throw new CliError('SERVICE_NOT_RUNNING', '服务未运行', {
        hint: '`local-router start --daemon`',
      });
    }
    const payload = buildTryPayload(entry, model, prompt, state.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
    const startedAt = Date.now();

    if (streamMode) {
      const stream = startStream(ctx, 'try');
      try {
        const res = await fetch(payload.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ ...payload.body, stream: true }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          stream.error(
            new CliError('UPSTREAM_UNREACHABLE', `请求失败: ${res.status}`, {
              details: { status: res.status, url: payload.url },
            })
          );
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let chunkIdx = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          for (const line of chunk.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            stream.event('chunk', { idx: chunkIdx++, raw: trimmed });
          }
        }
        stream.end({ status: res.status, latencyMs: Date.now() - startedAt });
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    try {
      const res = await fetch(payload.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {}
      const latencyMs = Date.now() - startedAt;
      const data = {
        ok: res.ok,
        status: res.status,
        latencyMs,
        url: payload.url,
        sample: res.ok
          ? payload.parseSample(json)
          : typeof json === 'string'
            ? json
            : JSON.stringify(json),
        response: json,
      };
      if (!res.ok) {
        throw new CliError('UPSTREAM_UNREACHABLE', `请求失败: ${res.status}`, {
          details: { status: res.status, body: json, latencyMs },
        });
      }
      emitResult(ctx, {
        command: 'try',
        data,
        md: {
          heading: `try · ✓ ${res.status} · ${latencyMs}ms`,
          meta: [`route: ${entry}.${model}`, `URL: \`${payload.url}\``],
          data: [
            `**响应样本**: ${data.sample}`,
            renderKv([
              { key: 'status', value: res.status },
              { key: 'latencyMs', value: latencyMs },
              { key: 'url', value: payload.url },
            ]),
          ].join('\n\n'),
        },
        text: `OK ${res.status} ${latencyMs}ms\n${data.sample}`,
      });
    } finally {
      clearTimeout(timer);
    }
  },
});

interface PingFlags {
  config?: string;
}

defineSchemaCommand<PingFlags>({
  name: 'ping',
  summary: '探测某 provider 的 base URL 可达性',
  supportsJson: true,
  positionals: [{ name: 'provider', required: true, description: 'provider 名' }],
  flags: [{ name: 'config', type: 'string', description: '配置文件路径' }],
  fn: async ({ values, positionals, ctx }) => {
    const name = positionals[0];
    if (!name) {
      throw new CliError('USAGE_ERROR', '用法: ping <provider>');
    }
    const path = resolveConfigPath(values.config);
    const config = loadConfig(path);
    const provider = config.providers[name];
    if (!provider) {
      throw new CliError('PROVIDER_NOT_FOUND', `provider 不存在: ${name}`, {
        details: { available: Object.keys(config.providers) },
      });
    }
    const probe = await probeUrl(provider.base);
    const data = {
      provider: name,
      base: provider.base,
      ok: probe.ok,
      status: probe.status,
      error: probe.error ?? null,
    };
    if (!probe.ok) {
      throw new CliError(
        'UPSTREAM_UNREACHABLE',
        `provider \`${name}\` 不可达: ${probe.error ?? probe.status}`,
        { details: data }
      );
    }
    emitResult(ctx, {
      command: 'ping',
      data,
      md: {
        heading: `ping · \`${name}\` · ✓`,
        data: renderCodeBlock(`HEAD ${provider.base} → ${probe.status}`),
      },
      text: `OK ${probe.status} ${provider.base}`,
    });
  },
});
