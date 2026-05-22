import type { GlobalFlags } from './global-flags';

export type FlagType = 'string' | 'boolean' | 'number' | 'enum';

export interface CommandFlag {
  /** Flag name without the `--` prefix. */
  name: string;
  short?: string;
  type: FlagType;
  enum?: string[];
  required?: boolean;
  default?: string | boolean | number;
  description: string;
  /** Repeatable flag (e.g., `--filter foo --filter bar`). */
  multiple?: boolean;
}

export interface CommandPositional {
  name: string;
  required?: boolean;
  variadic?: boolean;
  description: string;
}

export interface CommandExample {
  title: string;
  cmd: string;
  /** When set, only show this example in --output text help. */
  textOnly?: boolean;
}

export interface CommandDef {
  /** Space-separated path: `status`, `config provider add`. */
  name: string;
  summary: string;
  description?: string;
  flags?: CommandFlag[];
  positionals?: CommandPositional[];
  /** Whether the command writes config / state. Used by `commands --json`. */
  mutates?: boolean;
  /** Whether the command needs the daemon running. */
  requiresRunning?: boolean;
  /** Whether the command supports `--output json` envelope (default: true). */
  supportsJson?: boolean;
  examples?: CommandExample[];
  /** Hidden from `commands` listing (e.g., `__run-server`, deprecated aliases). */
  hidden?: boolean;
  /** Mark deprecated; help still shown but with a notice. */
  deprecated?: { since?: string; replaceWith?: string };
  handler: (args: string[], flags: GlobalFlags) => Promise<number> | number;
}

const REGISTRY = new Map<string, CommandDef>();
const ORDER: string[] = [];

export function defineCommand(def: CommandDef): CommandDef {
  if (REGISTRY.has(def.name)) {
    throw new Error(`重复注册命令: ${def.name}`);
  }
  REGISTRY.set(def.name, def);
  ORDER.push(def.name);
  return def;
}

export function getCommand(name: string): CommandDef | undefined {
  return REGISTRY.get(name);
}

export function listCommands(includeHidden = false): CommandDef[] {
  const out: CommandDef[] = [];
  for (const name of ORDER) {
    const c = REGISTRY.get(name);
    if (!c) continue;
    if (!includeHidden && c.hidden) continue;
    out.push(c);
  }
  return out;
}

/**
 * Match a command path against an argv array. Returns the longest matching
 * command and the remaining (unmatched) tail. E.g. for `config provider list
 * --json`, finds `config provider list` if registered, returning `['--json']`.
 */
export function matchCommand(argv: string[]): { command: CommandDef; rest: string[] } | null {
  let best: { command: CommandDef; rest: string[] } | null = null;
  for (let i = argv.length; i >= 1; i--) {
    const candidate = argv.slice(0, i).join(' ');
    const cmd = REGISTRY.get(candidate);
    if (cmd) {
      best = { command: cmd, rest: argv.slice(i) };
      break;
    }
  }
  return best;
}

/** All registered names, lexically sorted; useful for completion. */
export function allCommandNames(): string[] {
  return [...ORDER].sort();
}
