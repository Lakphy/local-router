/**
 * PR-4 P1: 运维高频命令
 *
 * - logs tokens   — 客户端聚合 /api/logs/events.stats 中的 token 字段
 * - logs cost     — 同上 + 用户提供的 rate-table 估算费用
 * - logs prune    — 直接清理本地日志目录中过老的事件文件
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, resolveConfigPath, resolveLogBaseDir } from '../../config';
import { CliError } from '../errors';
import { emitResult } from '../output';
import { checkHealth, cleanupIfStale } from '../process';
import { defineSchemaCommand } from '../registry';
import { renderCodeBlock, renderKv, renderTable } from '../render-md';
import { readRuntimeState } from '../runtime';

async function fetchJson(url: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url);
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

async function requireBaseUrl(): Promise<string> {
  await cleanupIfStale();
  const state = readRuntimeState();
  if (!state) throw new CliError('SERVICE_NOT_RUNNING', '服务未运行');
  if (!(await checkHealth(state.baseUrl))) {
    throw new CliError('HEALTH_FAILED', `服务健康检查失败: ${state.baseUrl}`);
  }
  return state.baseUrl;
}

// ─── logs tokens ─────────────────────────────────────────────────────────────

interface TokensFlags {
  window: '1h' | '6h' | '24h';
}

defineSchemaCommand<TokensFlags>({
  name: 'logs tokens',
  summary: 'Token 用量汇总（input/output/cached/reasoning）',
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
    const baseUrl = await requireBaseUrl();
    const { status, json } = await fetchJson(
      `${baseUrl}/api/logs/events?window=${values.window}&limit=1`
    );
    if (status !== 200) {
      throw new CliError('UNKNOWN_ERROR', `查询失败: ${status}`, { details: json });
    }
    const stats = (json as { stats: Record<string, number> }).stats;
    const data = {
      window: values.window,
      requests: stats.total,
      tokenUsageCount: stats.tokenUsageCount,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      totalTokens: stats.totalTokens,
      cachedInputTokens: stats.cachedInputTokens,
      cacheHitRate: stats.cacheHitRate,
      reasoningTokens: stats.reasoningTokens,
      billableInputTokens: stats.billableInputTokens,
      billableOutputTokens: stats.billableOutputTokens,
    };
    emitResult(ctx, {
      command: 'logs.tokens',
      data,
      md: {
        heading: `logs.tokens · ${values.window}`,
        meta: [
          `总请求 ${data.requests} · 含用量 ${data.tokenUsageCount}`,
          `input ${data.inputTokens} · output ${data.outputTokens} · total ${data.totalTokens}`,
        ],
        data: renderKv([
          { key: 'requests', value: data.requests },
          { key: 'tokenUsageCount', value: data.tokenUsageCount },
          { key: 'inputTokens', value: data.inputTokens },
          { key: 'outputTokens', value: data.outputTokens },
          { key: 'totalTokens', value: data.totalTokens },
          { key: 'cachedInputTokens', value: data.cachedInputTokens },
          { key: 'cacheHitRate%', value: data.cacheHitRate?.toFixed?.(2) ?? data.cacheHitRate },
          { key: 'reasoningTokens', value: data.reasoningTokens },
          { key: 'billableInputTokens', value: data.billableInputTokens },
          { key: 'billableOutputTokens', value: data.billableOutputTokens },
        ]),
        hints: ['估算费用: `local-router logs cost --rate-table <json>`'],
      },
    });
  },
});

// ─── logs cost ───────────────────────────────────────────────────────────────

interface CostFlags {
  window: '1h' | '6h' | '24h';
  'rate-table'?: string;
}

interface RateEntry {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
}

defineSchemaCommand<CostFlags>({
  name: 'logs cost',
  summary: '基于 rate-table 估算费用（不入账，仅参考）',
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
    {
      name: 'rate-table',
      type: 'string',
      description: 'JSON：{ "<provider/model>": { inputPerMillion, outputPerMillion, cachedInputPerMillion } }',
    },
  ],
  fn: async ({ values, ctx }) => {
    const baseUrl = await requireBaseUrl();
    let rateTable: Record<string, RateEntry> = {};
    if (values['rate-table']) {
      try {
        rateTable = JSON.parse(values['rate-table']);
      } catch (err) {
        throw new CliError('USAGE_ERROR', `--rate-table 不是合法 JSON: ${(err as Error).message}`);
      }
    }
    // 逐 provider/model 聚合
    const all: Array<{
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      requests: number;
    }> = [];
    let cursor: string | undefined;
    const seen = new Map<string, (typeof all)[number]>();
    do {
      const url = `${baseUrl}/api/logs/events?window=${values.window}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { status, json } = await fetchJson(url);
      if (status !== 200) throw new CliError('UNKNOWN_ERROR', `查询失败: ${status}`);
      const page = json as {
        items: Array<{
          provider: string;
          modelOut: string;
          tokenUsage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
        }>;
        nextCursor: string | null;
        hasMore: boolean;
      };
      for (const e of page.items) {
        const key = `${e.provider}/${e.modelOut}`;
        let row = seen.get(key);
        if (!row) {
          row = {
            provider: e.provider,
            model: e.modelOut,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            requests: 0,
          };
          seen.set(key, row);
          all.push(row);
        }
        row.requests += 1;
        row.inputTokens += e.tokenUsage?.inputTokens ?? 0;
        row.outputTokens += e.tokenUsage?.outputTokens ?? 0;
        row.cachedInputTokens += e.tokenUsage?.cachedInputTokens ?? 0;
      }
      cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);

    const rows = all.map((r) => {
      const rate = rateTable[`${r.provider}/${r.model}`] ?? {};
      const cost =
        ((rate.inputPerMillion ?? 0) * r.inputTokens +
          (rate.outputPerMillion ?? 0) * r.outputTokens +
          (rate.cachedInputPerMillion ?? 0) * r.cachedInputTokens) /
        1_000_000;
      return { ...r, estCostUSD: Number(cost.toFixed(4)) };
    });
    const totalCost = rows.reduce((a, b) => a + b.estCostUSD, 0);
    emitResult(ctx, {
      command: 'logs.cost',
      data: { window: values.window, rows, totalCostUSD: Number(totalCost.toFixed(4)) },
      md: {
        heading: `logs.cost · ${values.window} · ~$${totalCost.toFixed(4)}`,
        meta:
          Object.keys(rateTable).length === 0
            ? ['⚠️ 未提供 --rate-table，cost=0（仅展示 token 聚合）']
            : [`基于 ${Object.keys(rateTable).length} 条费率记录`],
        data: renderTable(
          ['provider/model', 'reqs', 'input', 'output', 'cached', '$est'],
          rows.map((r) => [
            `\`${r.provider}/${r.model}\``,
            r.requests,
            r.inputTokens,
            r.outputTokens,
            r.cachedInputTokens,
            `$${r.estCostUSD.toFixed(4)}`,
          ])
        ),
      },
    });
  },
});

// ─── logs prune ──────────────────────────────────────────────────────────────

function parseDurationToMs(input: string): number {
  const m = input.match(/^(\d+)([dhm])$/);
  if (!m) throw new CliError('USAGE_ERROR', `--older-than 格式: 7d|24h|30m（收到 ${input}）`);
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === 'd') return n * 86400_000;
  if (unit === 'h') return n * 3600_000;
  return n * 60_000;
}

async function* walkFiles(dir: string): AsyncIterable<string> {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(p);
    } else if (e.isFile()) {
      yield p;
    }
  }
}

interface PruneFlags {
  'older-than': string;
  'dry-run'?: boolean;
  config?: string;
  yes?: boolean;
}

defineSchemaCommand<PruneFlags>({
  name: 'logs prune',
  summary: '删除本地日志中早于指定时间的事件 / stream 文件',
  supportsJson: true,
  mutates: true,
  flags: [
    { name: 'older-than', type: 'string', required: true, description: '例: 7d / 24h / 30m' },
    { name: 'dry-run', type: 'boolean', description: '只统计不删除' },
    { name: 'config', type: 'string', description: '配置文件路径' },
    { name: 'yes', type: 'boolean', description: '跳过确认（非交互必填）' },
  ],
  fn: async ({ values, ctx, flags }) => {
    const ageMs = parseDurationToMs(values['older-than']);
    const cutoff = Date.now() - ageMs;
    const path = resolveConfigPath(values.config);
    const config = loadConfig(path);
    const baseDir = resolveLogBaseDir(config.log);
    if (!existsSync(baseDir)) {
      throw new CliError('CONFIG_NOT_FOUND', `日志目录不存在: ${baseDir}`);
    }
    const warnings: string[] = [];
    const state = readRuntimeState();
    if (state) {
      warnings.push('daemon 在运行中；活跃文件 mtime 持续刷新通常不会被删，如有异常请先 stop');
    }
    const targets = [join(baseDir, 'events'), join(baseDir, 'streams')];
    const toDelete: Array<{ path: string; bytes: number; mtime: number }> = [];
    for (const dir of targets) {
      for await (const file of walkFiles(dir)) {
        try {
          const st = await stat(file);
          if (st.mtimeMs < cutoff) {
            toDelete.push({ path: file, bytes: st.size, mtime: st.mtimeMs });
          }
        } catch {}
      }
    }
    const totalBytes = toDelete.reduce((a, b) => a + b.bytes, 0);
    const summary = {
      baseDir,
      olderThan: values['older-than'],
      cutoffISO: new Date(cutoff).toISOString(),
      candidates: toDelete.length,
      totalBytes,
    };

    if (values['dry-run'] || (!values.yes && !flags.yes && process.stdin.isTTY)) {
      emitResult(ctx, {
        command: 'logs.prune',
        data: { ...summary, deleted: 0, dryRun: true },
        warnings: warnings.length > 0 ? warnings : undefined,
        md: {
          heading: `logs.prune · dry-run · ${toDelete.length} 个文件 · ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
          data: renderKv([
            { key: 'baseDir', value: baseDir },
            { key: 'olderThan', value: values['older-than'] },
            { key: 'cutoff', value: summary.cutoffISO },
            { key: 'candidateCount', value: toDelete.length },
            { key: 'totalBytes', value: totalBytes },
          ]),
          hints: ['执行删除: 加 `--yes` 或在非 TTY 设 `--yes`'],
        },
      });
      return;
    }

    let deleted = 0;
    let freed = 0;
    for (const t of toDelete) {
      try {
        rmSync(t.path);
        deleted += 1;
        freed += t.bytes;
      } catch {}
    }
    emitResult(ctx, {
      command: 'logs.prune',
      data: { ...summary, deleted, freedBytes: freed },
      warnings: warnings.length > 0 ? warnings : undefined,
      md: {
        heading: `logs.prune · ✓ 删除 ${deleted} 个 · 释放 ${(freed / 1024 / 1024).toFixed(2)} MB`,
        data: renderKv([
          { key: 'baseDir', value: baseDir },
          { key: 'deleted', value: deleted },
          { key: 'freedBytes', value: freed },
        ]),
      },
      text: `deleted=${deleted} freed=${freed}`,
    });
  },
});
