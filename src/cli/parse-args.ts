import { parseArgs as nodeParseArgs } from 'node:util';
import { CliError } from './errors';
import type { CommandDef, CommandFlag } from './registry';

/**
 * Global client-target flags (see global-flags.ts). They are recorded into
 * flags.target before dispatch but left in argv, so every command parser must
 * tolerate them (as value-taking options) even when it doesn't declare them.
 * Commands that DO declare them (e.g. `start --port`) keep their own spec.
 */
const GLOBAL_TARGET_FLAG_NAMES = ['url', 'host', 'port'];

/**
 * Map a CommandFlag to node:util parseArgs option spec. Numbers/enums are
 * still parsed as strings at this layer; conversion happens in normalize().
 */
function toParseArgsOptions(
  flags: CommandFlag[] | undefined
): Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> {
  const out: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> =
    {};
  if (!flags) return out;
  for (const f of flags) {
    out[f.name] = {
      type: f.type === 'boolean' ? 'boolean' : 'string',
      ...(f.short ? { short: f.short } : {}),
      ...(f.multiple ? { multiple: true } : {}),
    };
  }
  return out;
}

function parseNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new CliError('USAGE_ERROR', `--${name} 需要数字: 收到 \`${raw}\``);
  }
  return n;
}

function normalizeOne(flag: CommandFlag, raw: unknown): unknown {
  if (raw === undefined) {
    if (flag.default !== undefined) return flag.default;
    return undefined;
  }
  if (flag.type === 'boolean') return Boolean(raw);
  if (flag.type === 'number') {
    if (flag.multiple && Array.isArray(raw)) {
      return raw.map((v) => parseNumber(flag.name, String(v)));
    }
    return parseNumber(flag.name, String(raw));
  }
  if (flag.type === 'enum') {
    const s = String(raw);
    if (flag.enum && !flag.enum.includes(s)) {
      throw new CliError('USAGE_ERROR', `--${flag.name} 无效值: \`${s}\``, {
        hint: `可选: ${flag.enum.map((v) => `\`${v}\``).join(' | ')}`,
      });
    }
    return s;
  }
  // string
  if (flag.multiple && Array.isArray(raw)) return raw.map((v) => String(v));
  return String(raw);
}

export interface ParsedCommandArgs<TValues = Record<string, unknown>> {
  values: TValues;
  positionals: string[];
}

/**
 * Parse a command's args using its declarative `flags` spec. Performs:
 *
 * - parseArgs with `strict: false` (we own validation)
 * - default substitution
 * - type coercion (number, enum)
 * - required-flag check
 * - did-you-mean for unknown long flags
 *
 * Throws `CliError(USAGE_ERROR)` on any violation so the caller's
 * `runCommand` wrapper renders it consistently.
 */
export function parseCommandArgs(def: CommandDef, args: string[]): ParsedCommandArgs {
  const options = toParseArgsOptions(def.flags);
  // Tolerate global client-target flags the command doesn't declare, so they
  // are consumed as values (not stray positionals) and don't trip did-you-mean.
  for (const g of GLOBAL_TARGET_FLAG_NAMES) {
    if (!(g in options)) options[g] = { type: 'string' };
  }
  let parsed: ReturnType<typeof nodeParseArgs>;
  try {
    parsed = nodeParseArgs({
      args,
      options,
      allowPositionals: true,
      strict: false,
    });
  } catch (err) {
    throw new CliError('USAGE_ERROR', err instanceof Error ? err.message : String(err));
  }

  // Detect unknown long flags and offer did-you-mean.
  const known = new Set([...(def.flags?.map((f) => f.name) ?? []), ...GLOBAL_TARGET_FLAG_NAMES]);
  for (const a of args) {
    if (!a.startsWith('--')) continue;
    const name = a.slice(2).split('=')[0];
    if (!name || known.has(name)) continue;
    // Allow `--no-foo` style if `foo` known boolean? Out of scope here.
    const suggestion = nearestKnownFlag(name, [...known]);
    throw new CliError('USAGE_ERROR', `未知 flag: --${name}`, {
      hint: suggestion ? `也许是 \`--${suggestion}\`?` : `可用 flags: ${listKnownFlags(def)}`,
    });
  }

  const values: Record<string, unknown> = {};
  for (const f of def.flags ?? []) {
    const raw = (parsed.values as Record<string, unknown>)[f.name];
    const normalized = normalizeOne(f, raw);
    if (normalized !== undefined) values[f.name] = normalized;
    if (f.required && normalized === undefined) {
      throw new CliError('USAGE_ERROR', `--${f.name} 必填`, {
        hint: f.description ? `${f.description}` : undefined,
      });
    }
  }

  return {
    values,
    positionals: parsed.positionals as string[],
  };
}

function listKnownFlags(def: CommandDef): string {
  const items = (def.flags ?? []).map((f) => `--${f.name}`);
  return items.length > 0 ? items.join(' ') : '(无)';
}

function nearestKnownFlag(input: string, known: string[]): string | undefined {
  return nearest(input, known, 2);
}

export function nearest(
  input: string,
  candidates: string[],
  threshold?: number
): string | undefined {
  const maxDist = threshold ?? Math.max(2, Math.floor(input.length / 3));
  let best: { name: string; dist: number } | undefined;
  for (const name of candidates) {
    const d = levenshtein(input, name);
    if (d <= maxDist && (!best || d < best.dist)) {
      best = { name, dist: d };
    }
  }
  return best?.name;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j - 1], dp[j]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}
