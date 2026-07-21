import { CliError } from './errors';

export type OutputFormat = 'human' | 'json' | 'ndjson' | 'text' | 'markdown';

export interface GlobalFlags {
  output: OutputFormat;
  quiet: boolean;
  verbose: boolean;
  noColor: boolean;
  noInteractive: boolean;
  yes: boolean;
  /** When true, hints/explanations are amplified for AI agents. */
  explain: boolean;
  /** Explicit server target for client commands (resolved by resolveTarget). */
  target?: { url?: string; host?: string; port?: number };
}

const VALID_OUTPUTS: OutputFormat[] = ['human', 'json', 'ndjson', 'text', 'markdown'];

function pickOutput(raw: string | undefined): OutputFormat | undefined {
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === 'md') return 'markdown';
  if (normalized === 'table' || normalized === 'terminal') return 'human';
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
  let explain = false;
  let targetUrl: string | undefined;
  let targetHost: string | undefined;
  let targetPortRaw: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a === '--output' || a === '-o') {
      const next = args[++i];
      if (next === undefined) {
        throw new CliError('USAGE_ERROR', `${a} 需要参数`, {
          hint: '可选值: human | json | ndjson | text | markdown',
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
    if (a === '--explain') {
      explain = true;
      continue;
    }
    // Client-target flags are recorded but LEFT in argv (pushed to rest), so
    // commands that declare their own --port/--host (start, provider add-lan)
    // still parse them. We only peek the value here.
    if (a === '--url' || a.startsWith('--url=')) {
      targetUrl = a.startsWith('--url=') ? a.slice('--url='.length) : args[i + 1];
      rest.push(a);
      continue;
    }
    if (a === '--host' || a.startsWith('--host=')) {
      targetHost = a.startsWith('--host=') ? a.slice('--host='.length) : args[i + 1];
      rest.push(a);
      continue;
    }
    if (a === '--port' || a.startsWith('--port=')) {
      targetPortRaw = a.startsWith('--port=') ? a.slice('--port='.length) : args[i + 1];
      rest.push(a);
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
        hint: '可选值: human | json | ndjson | text | markdown',
      });
    }
    output = picked;
  } else {
    output = envFormat ?? 'human';
  }

  let targetPort: number | undefined;
  if (targetPortRaw !== undefined) {
    targetPort = Number.parseInt(targetPortRaw, 10);
    if (!Number.isFinite(targetPort) || targetPort <= 0 || targetPort > 65535) {
      throw new CliError('USAGE_ERROR', `无效端口: ${targetPortRaw}`, {
        hint: '端口范围 1-65535',
      });
    }
  }
  const target =
    targetUrl !== undefined || targetHost !== undefined || targetPort !== undefined
      ? { url: targetUrl, host: targetHost, port: targetPort }
      : undefined;

  return {
    flags: {
      output,
      quiet: quiet || process.env.LOCAL_ROUTER_QUIET === '1',
      verbose,
      noColor: noColor || !!process.env.NO_COLOR,
      noInteractive: noInteractive || process.env.LOCAL_ROUTER_NO_INTERACTIVE === '1',
      yes,
      explain: explain || process.env.LOCAL_ROUTER_EXPLAIN === '1',
      target,
    },
    rest,
  };
}

export const DEFAULT_FLAGS: GlobalFlags = {
  output: 'human',
  quiet: false,
  verbose: false,
  noColor: false,
  noInteractive: false,
  yes: false,
  explain: false,
};
