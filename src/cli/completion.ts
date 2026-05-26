/**
 * Shell completion script generators. Derived from the live registry — re-run
 * after upgrading local-router to refresh completions.
 */
import { listCommands } from './registry';

interface CommandLeaf {
  name: string;
  summary: string;
  flags: Array<{ name: string; type: string; description: string }>;
}

function leaves(): CommandLeaf[] {
  return listCommands(false).map((c) => ({
    name: c.name,
    summary: c.summary,
    flags: (c.flags ?? []).map((f) => ({
      name: f.name,
      type: f.type,
      description: f.description,
    })),
  }));
}

/**
 * Split commands into a path-prefix tree so each shell can complete one
 * segment at a time:
 *
 *   config -> provider -> add
 */
interface TreeNode {
  children: Map<string, TreeNode>;
  leaf?: CommandLeaf;
}

function buildTree(cmds: CommandLeaf[]): TreeNode {
  const root: TreeNode = { children: new Map() };
  for (const cmd of cmds) {
    const parts = cmd.name.split(' ');
    let cur = root;
    for (const p of parts) {
      let next = cur.children.get(p);
      if (!next) {
        next = { children: new Map() };
        cur.children.set(p, next);
      }
      cur = next;
    }
    cur.leaf = cmd;
  }
  return root;
}

function quoteBash(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── bash ────────────────────────────────────────────────────────────────────

export function genBash(): string {
  const cmds = leaves();
  const tree = buildTree(cmds);

  // Build a flat lookup table: cwords-prefix -> next words / flags.
  // Bash function walks COMP_WORDS comparing each level.
  const rows: string[] = [];
  function walk(prefix: string[], node: TreeNode) {
    const subs = [...node.children.keys()];
    const leafFlags = node.leaf?.flags.map((f) => `--${f.name}`) ?? [];
    const completions = [...subs, ...leafFlags];
    const key = prefix.join(' ');
    rows.push(`    ${quoteBash(key)}) opts=${quoteBash(completions.join(' '))} ;;`);
    for (const [name, child] of node.children) walk([...prefix, name], child);
  }
  walk([], tree);

  return `# bash completion for local-router (generated)
_local_router() {
  local cur prev cmd_path i opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"

  # Find the longest registered command-path prefix.
  cmd_path=""
  for (( i=1; i<COMP_CWORD; i++ )); do
    local cand
    if [[ -z "$cmd_path" ]]; then
      cand="\${COMP_WORDS[i]}"
    else
      cand="$cmd_path \${COMP_WORDS[i]}"
    fi
    case "$cand" in
${rows.join('\n')}
      *) break ;;
    esac
    cmd_path="$cand"
  done

  case "$cmd_path" in
${rows.join('\n')}
    *) opts="" ;;
  esac

  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
  return 0
}
complete -F _local_router local-router
`;
}

// ─── zsh ─────────────────────────────────────────────────────────────────────

export function genZsh(): string {
  const cmds = leaves();
  const tree = buildTree(cmds);

  const rows: string[] = [];
  function walk(prefix: string[], node: TreeNode) {
    const childCompletions = [...node.children.entries()].map(([name, child]) => {
      const summary = child.leaf?.summary ?? `${name}…`;
      return `'${name}:${summary.replace(/'/g, "''")}'`;
    });
    const flagCompletions = (node.leaf?.flags ?? []).map(
      (f) => `'--${f.name}[${f.description.replace(/'/g, "''")}]'`
    );
    const completions = [...childCompletions, ...flagCompletions];
    const key = prefix.join(' ');
    rows.push(`    "${key}") _values 'local-router' ${completions.join(' ')} ;;`);
    for (const [name, child] of node.children) walk([...prefix, name], child);
  }
  walk([], tree);

  return `#compdef local-router
# zsh completion for local-router (generated)
_local_router() {
  local cmd_path="" i
  for (( i=2; i<CURRENT; i++ )); do
    local cand
    if [[ -z "$cmd_path" ]]; then
      cand="\${words[i]}"
    else
      cand="$cmd_path \${words[i]}"
    fi
    case "$cand" in
${rows.map((r) => `  ${r}`).join('\n')}
      *) break ;;
    esac
    cmd_path="$cand"
  done

  case "$cmd_path" in
${rows.join('\n')}
    *) _values 'local-router' ${[...tree.children.keys()]
      .map((n) => `'${n}'`)
      .join(' ')} ;;
  esac
}
_local_router "$@"
`;
}

// ─── fish ────────────────────────────────────────────────────────────────────

export function genFish(): string {
  const cmds = leaves();
  const lines: string[] = ['# fish completion for local-router (generated)'];

  // Top-level command names (first path segment) — complete when no subcommand yet.
  const topNames = new Set<string>();
  for (const c of cmds) {
    const first = c.name.split(' ')[0];
    if (first) topNames.add(first);
  }
  for (const t of topNames) {
    lines.push(
      `complete -c local-router -n "__fish_use_subcommand" -a "${t}" -d "${escapeFish(
        cmds.find((c) => c.name === t)?.summary ?? `${t}…`
      )}"`
    );
  }

  // Full path completions + flags
  for (const c of cmds) {
    const segments = c.name.split(' ');
    if (segments.length > 1) {
      const parents = segments.slice(0, -1).join(' ');
      const leaf = segments[segments.length - 1]!;
      lines.push(
        `complete -c local-router -n "__fish_seen_subcommand_from ${parents.replace(/ /g, '; and __fish_seen_subcommand_from ')}" -a "${leaf}" -d "${escapeFish(c.summary)}"`
      );
    }
    for (const f of c.flags) {
      lines.push(
        `complete -c local-router -n "__fish_seen_subcommand_from ${segments[segments.length - 1]}" -l "${f.name}" -d "${escapeFish(f.description)}"`
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function escapeFish(s: string): string {
  return s.replace(/"/g, '\\"');
}

// ─── pwsh ────────────────────────────────────────────────────────────────────

export function genPwsh(): string {
  const cmds = leaves();
  const tree = buildTree(cmds);

  const rows: string[] = [];
  function walk(prefix: string[], node: TreeNode) {
    const subs = [...node.children.entries()].map(
      ([name, child]) =>
        `        [CompletionResult]::new('${name}', '${name}', 'ParameterValue', '${escapePwsh(
          child.leaf?.summary ?? `${name}…`
        )}')`
    );
    const flags = (node.leaf?.flags ?? []).map(
      (f) =>
        `        [CompletionResult]::new('--${f.name}', '--${f.name}', 'ParameterName', '${escapePwsh(f.description)}')`
    );
    const key = prefix.join(' ');
    const items = [...subs, ...flags];
    if (items.length === 0) return;
    rows.push(`      '${key}' {\n${items.join(',\n')}\n      }`);
    for (const [name, child] of node.children) walk([...prefix, name], child);
  }
  walk([], tree);

  return `# pwsh completion for local-router (generated)
Register-ArgumentCompleter -Native -CommandName 'local-router' -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = $commandAst.ToString().Split(' ')
  $path = ''
  for ($i = 1; $i -lt $tokens.Length - 1; $i++) {
    $cand = if ($path -eq '') { $tokens[$i] } else { "$path $($tokens[$i])" }
    if (-not (Get-CompletionPath $cand)) { break }
    $path = $cand
  }
  $items = switch ($path) {
${rows.join('\n')}
      default { @() }
  }
  $items | Where-Object { $_.CompletionText -like "$wordToComplete*" }
}
`;
}

function escapePwsh(s: string): string {
  return s.replace(/'/g, "''");
}
