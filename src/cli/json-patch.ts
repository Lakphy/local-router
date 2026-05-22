/**
 * Minimal RFC6902 JSON Patch implementation: add / remove / replace / move /
 * copy / test. Operates on a deep-cloned input and returns the patched value;
 * throws on unsupported ops or invalid paths.
 */

export interface PatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

function tokenize(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) {
    throw new Error(`无效的 JSON Pointer (必须以 / 开头): ${path}`);
  }
  return path
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getAt(obj: unknown, tokens: string[]): unknown {
  let cur: unknown = obj;
  for (const tok of tokens) {
    if (cur === null || typeof cur !== 'object') {
      throw new Error(`路径不存在: /${tokens.join('/')}`);
    }
    cur = (cur as Record<string, unknown>)[tok];
  }
  return cur;
}

function setAt(obj: unknown, tokens: string[], value: unknown): void {
  if (tokens.length === 0) {
    throw new Error('禁止替换根值');
  }
  let cur: Record<string, unknown> = obj as Record<string, unknown>;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i]!;
    if (cur[tok] === undefined || cur[tok] === null) {
      cur[tok] = {};
    }
    cur = cur[tok] as Record<string, unknown>;
  }
  cur[tokens[tokens.length - 1]!] = value;
}

function removeAt(obj: unknown, tokens: string[]): void {
  if (tokens.length === 0) throw new Error('禁止删除根值');
  let cur: Record<string, unknown> = obj as Record<string, unknown>;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i]!;
    if (cur[tok] === undefined) throw new Error(`路径不存在: /${tokens.join('/')}`);
    cur = cur[tok] as Record<string, unknown>;
  }
  delete cur[tokens[tokens.length - 1]!];
}

export function applyJsonPatch<T>(doc: T, ops: PatchOp[]): T {
  const result = JSON.parse(JSON.stringify(doc)) as T;
  for (const p of ops) {
    const tokens = tokenize(p.path);
    switch (p.op) {
      case 'add':
      case 'replace':
        setAt(result, tokens, p.value);
        break;
      case 'remove':
        removeAt(result, tokens);
        break;
      case 'move': {
        const fromTokens = tokenize(p.from ?? '');
        const v = getAt(result, fromTokens);
        removeAt(result, fromTokens);
        setAt(result, tokens, v);
        break;
      }
      case 'copy': {
        const fromTokens = tokenize(p.from ?? '');
        setAt(result, tokens, getAt(result, fromTokens));
        break;
      }
      case 'test': {
        const v = getAt(result, tokens);
        if (JSON.stringify(v) !== JSON.stringify(p.value)) {
          throw new Error(`patch test 失败 at ${p.path}`);
        }
        break;
      }
      default:
        throw new Error(`不支持的 op: ${(p as PatchOp).op}`);
    }
  }
  return result;
}
