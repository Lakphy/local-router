import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import JSON5 from 'json5';
import { type AppConfig, loadConfig, type ProviderConfig, resolveConfigPath } from '../../config';
import { applyConfigChange } from '../config-apply';
import { computeLineDiff, summarizeDiff } from '../diff';
import { CliError } from '../errors';
import { applyJsonPatch, type PatchOp } from '../json-patch';
import { emitResult, runCommand } from '../output';
import { renderCodeBlock, renderKv, renderTable } from '../render-md';

function maskApiKey(k: string): string {
  if (k.length <= 8) return '***';
  return `${k.slice(0, 4)}***${k.slice(-4)}`;
}

function maskConfig(config: AppConfig): AppConfig {
  const masked: AppConfig = JSON.parse(JSON.stringify(config));
  for (const p of Object.values(masked.providers) as ProviderConfig[]) {
    if (p.apiKey) p.apiKey = maskApiKey(p.apiKey);
  }
  return masked;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(source)) {
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      target[k] !== null &&
      typeof target[k] === 'object' &&
      !Array.isArray(target[k])
    ) {
      deepMerge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// `config show`
// ---------------------------------------------------------------------------

export async function configShow(
  args: string[],
  flags: import('../global-flags').GlobalFlags
): Promise<number> {
  return runCommand({
    command: 'config.show',
    flags,
    fn: (ctx) => {
      const parsed = parseArgs({
        args,
        options: {
          'show-secrets': { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const path = resolveConfigPath(parsed.values.config);
      const config = loadConfig(path);
      const showSecrets = parsed.values['show-secrets'] || ctx.flags.output === 'json';
      const out = showSecrets ? config : maskConfig(config);
      const text = JSON5.stringify(out, { space: 2, quote: '"' });
      emitResult(ctx, {
        command: 'config.show',
        data: out,
        md: {
          heading: `config.show · ${path}`,
          meta: [showSecrets ? '⚠ 已显示密钥原文' : '密钥已掩码（加 --show-secrets 看原文）'],
          data: renderCodeBlock(text, 'json5'),
        },
        text,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// `config diff`
// ---------------------------------------------------------------------------

export async function configDiff(
  args: string[],
  flags: import('../global-flags').GlobalFlags
): Promise<number> {
  return runCommand({
    command: 'config.diff',
    flags,
    fn: (ctx) => {
      const parsed = parseArgs({
        args,
        options: {
          against: { type: 'string' },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const path = resolveConfigPath(parsed.values.config);
      if (!existsSync(path)) {
        throw new CliError('CONFIG_NOT_FOUND', `配置不存在: ${path}`);
      }
      const after = readFileSync(path, 'utf-8');
      const against = parsed.values.against;
      let beforePath: string;
      if (!against) {
        const backupDir = join(dirname(path), '.backups');
        if (!existsSync(backupDir)) {
          throw new CliError('CONFIG_NOT_FOUND', '没有备份可对比', {
            hint: '指定 --against <path|backup-id>',
          });
        }
        const files = readdirSync(backupDir)
          .filter((f) => f.startsWith('config-') && f.endsWith('.json5'))
          .sort()
          .reverse();
        if (files.length === 0) {
          throw new CliError('CONFIG_NOT_FOUND', '备份目录为空');
        }
        beforePath = join(backupDir, files[0]!);
      } else if (existsSync(against)) {
        beforePath = against;
      } else {
        const backupDir = join(dirname(path), '.backups');
        const candidate = join(backupDir, `config-${against}.json5`);
        if (existsSync(candidate)) beforePath = candidate;
        else if (existsSync(join(backupDir, against))) beforePath = join(backupDir, against);
        else {
          throw new CliError('CONFIG_NOT_FOUND', `--against 不存在: ${against}`);
        }
      }
      const before = readFileSync(beforePath, 'utf-8');
      const diff = computeLineDiff(before, after);
      const { added, removed } = summarizeDiff(diff);
      emitResult(ctx, {
        command: 'config.diff',
        data: { beforePath, afterPath: path, added, removed, diff },
        md: {
          heading: `config.diff · +${added}/-${removed}`,
          meta: [`before \`${beforePath}\``, `after \`${path}\``],
          data: renderCodeBlock(diff, 'diff'),
        },
        text: diff,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// `config import`
// ---------------------------------------------------------------------------

export async function configImport(
  args: string[],
  flags: import('../global-flags').GlobalFlags
): Promise<number> {
  return runCommand({
    command: 'config.import',
    flags,
    fn: async (ctx) => {
      const parsed = parseArgs({
        args,
        options: {
          file: { type: 'string' },
          merge: { type: 'boolean', default: false },
          replace: { type: 'boolean', default: false },
          'dry-run': { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      if (!parsed.values.merge && !parsed.values.replace) {
        throw new CliError('USAGE_ERROR', '需指定 --merge 或 --replace');
      }
      if (parsed.values.merge && parsed.values.replace) {
        throw new CliError('USAGE_ERROR', '--merge 与 --replace 互斥');
      }
      const file = parsed.values.file;
      let raw: string;
      if (!file || file === '-') {
        raw = await readStdin();
      } else {
        if (!existsSync(file)) {
          throw new CliError('CONFIG_NOT_FOUND', `输入文件不存在: ${file}`);
        }
        raw = readFileSync(file, 'utf-8');
      }
      let parsedInput: unknown;
      try {
        parsedInput = JSON5.parse(raw);
      } catch (err) {
        throw new CliError(
          'CONFIG_INVALID',
          `输入不是合法 JSON5: ${err instanceof Error ? err.message : err}`
        );
      }

      const path = resolveConfigPath(parsed.values.config);
      const current = existsSync(path) ? loadConfig(path) : null;

      let next: AppConfig;
      if (parsed.values.replace || !current) {
        next = parsedInput as AppConfig;
      } else {
        next = JSON.parse(JSON.stringify(current));
        deepMerge(
          next as unknown as Record<string, unknown>,
          parsedInput as Record<string, unknown>
        );
      }

      const result = applyConfigChange(path, next, { dryRun: parsed.values['dry-run'] });
      emitResult(ctx, {
        command: 'config.import',
        data: { mode: parsed.values.replace ? 'replace' : 'merge', ...result },
        md: {
          heading: `config.import · ${parsed.values.replace ? 'replace' : 'merge'} · ${result.written ? '✓' : 'dry-run'}`,
          meta: [`+${result.added} / -${result.removed}`],
          data: [
            result.written
              ? `已写入 \`${result.path}\`${result.backupPath ? ` · 备份 \`${result.backupPath}\`` : ''}`
              : `**dry-run** · 未写入 \`${result.path}\``,
            renderCodeBlock(result.diff, 'diff'),
          ].join('\n\n'),
        },
        text: result.written ? `已 import: ${result.path}` : `[dry-run]\n${result.diff}`,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// `config patch`
// ---------------------------------------------------------------------------

export async function configPatch(
  args: string[],
  flags: import('../global-flags').GlobalFlags
): Promise<number> {
  return runCommand({
    command: 'config.patch',
    flags,
    fn: async (ctx) => {
      const parsed = parseArgs({
        args,
        options: {
          file: { type: 'string' },
          'dry-run': { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const file = parsed.values.file;
      let raw: string;
      if (!file || file === '-') {
        raw = await readStdin();
      } else {
        if (!existsSync(file)) {
          throw new CliError('CONFIG_NOT_FOUND', `patch 文件不存在: ${file}`);
        }
        raw = readFileSync(file, 'utf-8');
      }
      let ops: PatchOp[];
      try {
        const parsedJson = JSON.parse(raw);
        if (!Array.isArray(parsedJson)) {
          throw new Error('patch 必须是数组（RFC6902）');
        }
        ops = parsedJson as PatchOp[];
      } catch (err) {
        throw new CliError(
          'USAGE_ERROR',
          `无效 JSON Patch: ${err instanceof Error ? err.message : err}`,
          {
            doc: 'https://www.rfc-editor.org/rfc/rfc6902',
          }
        );
      }

      const path = resolveConfigPath(parsed.values.config);
      const current = loadConfig(path);
      let next: AppConfig;
      try {
        next = applyJsonPatch(current, ops);
      } catch (err) {
        throw new CliError('USAGE_ERROR', err instanceof Error ? err.message : String(err));
      }
      const result = applyConfigChange(path, next, { dryRun: parsed.values['dry-run'] });
      emitResult(ctx, {
        command: 'config.patch',
        data: { ops: ops.length, ...result },
        md: {
          heading: `config.patch · ${ops.length} ops · ${result.written ? '✓' : 'dry-run'}`,
          meta: [`+${result.added} / -${result.removed}`],
          data: [
            result.written
              ? `已写入 \`${result.path}\`${result.backupPath ? ` · 备份 \`${result.backupPath}\`` : ''}`
              : `**dry-run** · 未写入 \`${result.path}\``,
            renderCodeBlock(result.diff, 'diff'),
          ].join('\n\n'),
        },
        text: result.written ? `已 patch: ${result.path}` : `[dry-run]\n${result.diff}`,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// `config backups list/show` + `config rollback`
// ---------------------------------------------------------------------------

interface BackupEntry {
  id: string;
  path: string;
  size: number;
  mtime: string;
}

function listBackups(configPath: string): BackupEntry[] {
  const dir = join(dirname(configPath), '.backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('config-') && f.endsWith('.json5'))
    .map((f) => {
      const full = join(dir, f);
      const st = statSync(full);
      return {
        id: f.replace(/^config-/, '').replace(/\.json5$/, ''),
        path: full,
        size: st.size,
        mtime: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

export async function configBackupsList(
  args: string[],
  flags: import('../global-flags').GlobalFlags
): Promise<number> {
  return runCommand({
    command: 'config.backups.list',
    flags,
    fn: (ctx) => {
      const parsed = parseArgs({
        args,
        options: { config: { type: 'string' } },
        allowPositionals: true,
        strict: false,
      });
      const path = resolveConfigPath(parsed.values.config);
      const backups = listBackups(path);
      emitResult(ctx, {
        command: 'config.backups.list',
        data: backups,
        md: {
          heading: `config.backups.list · ${backups.length} 个`,
          data: renderTable(
            ['id', 'mtime', 'size', 'path'],
            backups.map((b) => [`\`${b.id}\``, b.mtime, b.size, `\`${b.path}\``])
          ),
          hints: ['回滚: `local-router config rollback <id>`'],
        },
      });
    },
  });
}

export async function configRollback(
  args: string[],
  flags: import('../global-flags').GlobalFlags
): Promise<number> {
  return runCommand({
    command: 'config.rollback',
    flags,
    fn: (ctx) => {
      const parsed = parseArgs({
        args,
        options: {
          'dry-run': { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const id = parsed.positionals[0];
      if (!id) throw new CliError('USAGE_ERROR', '用法: config rollback <backup-id>');
      const path = resolveConfigPath(parsed.values.config);
      const backups = listBackups(path);
      const target = backups.find((b) => b.id === id);
      if (!target) {
        throw new CliError('CONFIG_NOT_FOUND', `备份不存在: ${id}`, {
          details: { available: backups.map((b) => b.id) },
        });
      }
      const text = readFileSync(target.path, 'utf-8');
      let parsedConfig: AppConfig;
      try {
        parsedConfig = JSON5.parse(text) as AppConfig;
      } catch (err) {
        throw new CliError(
          'CONFIG_INVALID',
          `备份不是合法 JSON5: ${err instanceof Error ? err.message : err}`
        );
      }
      const result = applyConfigChange(path, parsedConfig, { dryRun: parsed.values['dry-run'] });
      emitResult(ctx, {
        command: 'config.rollback',
        data: { from: target.path, ...result },
        md: {
          heading: `config.rollback · ${id} · ${result.written ? '✓' : 'dry-run'}`,
          meta: [`+${result.added} / -${result.removed}`],
          data: [
            result.written
              ? `已恢复自 \`${target.path}\` → \`${result.path}\``
              : `**dry-run** · 未写入`,
            renderCodeBlock(result.diff, 'diff'),
          ].join('\n\n'),
        },
        text: result.written ? `已回滚: ${path}` : `[dry-run]\n${result.diff}`,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// `config route plan`
// ---------------------------------------------------------------------------

export async function configRoutePlan(
  args: string[],
  flags: import('../global-flags').GlobalFlags
): Promise<number> {
  return runCommand({
    command: 'config.route.plan',
    flags,
    fn: (ctx) => {
      const parsed = parseArgs({
        args,
        options: {
          entry: { type: 'string' },
          model: { type: 'string' },
          config: { type: 'string' },
        },
        allowPositionals: true,
        strict: false,
      });
      const entry = parsed.values.entry;
      const reqModel = parsed.values.model;
      if (!entry || !reqModel) {
        throw new CliError('USAGE_ERROR', '用法: config route plan --entry <e> --model <m>');
      }
      const path = resolveConfigPath(parsed.values.config);
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
      const data = {
        entry,
        requestModel: reqModel,
        matchedRule: `${entry}.${exact ? reqModel : '*'}`,
        fallbackUsed: !exact && !!fallback,
        provider: target.provider,
        targetModel: target.model,
        providerType: provider.type,
        providerBase: provider.base,
        chain: [
          ...(exact
            ? [
                {
                  rule: `${entry}.${reqModel}`,
                  target: { provider: target.provider, model: target.model },
                },
              ]
            : []),
          ...(fallback
            ? [
                {
                  rule: `${entry}.*`,
                  target: { provider: fallback.provider, model: fallback.model },
                },
              ]
            : []),
        ],
      };
      emitResult(ctx, {
        command: 'config.route.plan',
        data,
        md: {
          heading: `config.route.plan · ${entry}.${reqModel}`,
          meta: [
            `匹配 \`${data.matchedRule}\`${data.fallbackUsed ? ' (fallback)' : ''}`,
            `→ \`${data.provider}/${data.targetModel}\``,
          ],
          data: [
            renderKv([
              { key: 'matchedRule', value: data.matchedRule },
              { key: 'fallbackUsed', value: data.fallbackUsed },
              { key: 'provider', value: data.provider },
              { key: 'targetModel', value: data.targetModel },
            ]),
            '**chain**',
            renderTable(
              ['rule', 'target'],
              data.chain.map((c) => [`\`${c.rule}\``, `\`${c.target.provider}/${c.target.model}\``])
            ),
          ].join('\n\n'),
        },
      });
    },
  });
}
