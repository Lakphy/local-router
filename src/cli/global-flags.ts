import { CliError } from './errors';

export type OutputFormat = 'markdown' | 'json' | 'ndjson' | 'text';

export interface GlobalFlags {
  output: OutputFormat;
  quiet: boolean;
  verbose: boolean;
  noColor: boolean;
  noInteractive: boolean;
  yes: boolean;
}

const VALID_OUTPUTS: OutputFormat[] = ['markdown', 'json', 'ndjson', 'text'];

function pickOutput(raw: string | undefined): OutputFormat | undefined {
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === 'md') return 'markdown';
  return VALID_OUTPUTS.includes(normalized as OutputFormat)
    ? (normalized as OutputFormat)
    : undefined;
}

/**
 * Strip global flags from argv and return both. Supports both space and = forms.
 *
 * Recognized: --output|-o, --output=, --json, --quiet|-q, --verbose|-v,
 * --no-color, --no-interactive, --yes.
 *
 * Env fallbacks: LOCAL_ROUTER_FORMAT, LOCAL_ROUTER_QUIET, NO_COLOR,
 * LOCAL_ROUTER_NO_INTERACTIVE.
 */
export function extractGlobalFlags(args: string[]): { flags: GlobalFlags; rest: string[] } {
  const rest: string[] = [];
  let outputFlag: string | undefined;
  let quiet = false;
  let verbose = false;
  let noColor = false;
  let noInteractive = false;
  let yes = false;
  let jsonAlias = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a === '--output' || a === '-o') {
      const next = args[++i];
      if (next === undefined) {
        throw new CliError('USAGE_ERROR', `${a} 需要参数`, {
          hint: '可选值: markdown | json | ndjson | text',
        });
      }
      outputFlag = next;
      continue;
    }
    if (a.startsWith('--output=')) {
      outputFlag = a.slice('--output='.length);
      continue;
    }
    if (a === '--json') {
      jsonAlias = true;
      continue;
    }
    if (a === '--quiet' || a === '-q') {
      quiet = true;
      continue;
    }
    if (a === '--verbose' || a === '-v') {
      verbose = true;
      continue;
    }
    if (a === '--no-color') {
      noColor = true;
      continue;
    }
    if (a === '--no-interactive') {
      noInteractive = true;
      continue;
    }
    if (a === '--yes') {
      yes = true;
      continue;
    }
    rest.push(a);
  }

  const envFormat = pickOutput(process.env.LOCAL_ROUTER_FORMAT);
  let output: OutputFormat;
  if (jsonAlias) {
    output = 'json';
  } else if (outputFlag !== undefined) {
    const picked = pickOutput(outputFlag);
    if (!picked) {
      throw new CliError('USAGE_ERROR', `无效的 --output 值: ${outputFlag}`, {
        hint: '可选值: markdown | json | ndjson | text',
      });
    }
    output = picked;
  } else {
    output = envFormat ?? 'markdown';
  }

  return {
    flags: {
      output,
      quiet: quiet || process.env.LOCAL_ROUTER_QUIET === '1',
      verbose,
      noColor: noColor || !!process.env.NO_COLOR,
      noInteractive: noInteractive || process.env.LOCAL_ROUTER_NO_INTERACTIVE === '1',
      yes,
    },
    rest,
  };
}

export const DEFAULT_FLAGS: GlobalFlags = {
  output: 'markdown',
  quiet: false,
  verbose: false,
  noColor: false,
  noInteractive: false,
  yes: false,
};
