/**
 * Tiny line-level diff (LCS-based) producing a unified-style body.
 * No hunk headers; each line is prefixed with `+`, `-`, or ` `.
 *
 * Acceptable for config files (≤ ~500 lines). O(n*m) memory.
 */
export function computeLineDiff(before: string, after: string): string {
  const aLines = before.split('\n');
  const bLines = after.split('\n');
  const m = aLines.length;
  const n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aLines[i - 1] === bLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  const ops: Array<{ kind: '+' | '-' | ' '; line: string }> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (aLines[i - 1] === bLines[j - 1]) {
      ops.push({ kind: ' ', line: aLines[i - 1]! });
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      ops.push({ kind: '-', line: aLines[i - 1]! });
      i--;
    } else {
      ops.push({ kind: '+', line: bLines[j - 1]! });
      j--;
    }
  }
  while (i > 0) {
    i--;
    ops.push({ kind: '-', line: aLines[i]! });
  }
  while (j > 0) {
    j--;
    ops.push({ kind: '+', line: bLines[j]! });
  }
  ops.reverse();
  return ops.map((op) => `${op.kind}${op.line}`).join('\n');
}

export function summarizeDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}
