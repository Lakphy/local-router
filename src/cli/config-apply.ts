import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import JSON5 from 'json5';
import type { AppConfig } from '../config';
import { validateConfigOrThrow } from '../config-validate';
import { computeLineDiff, summarizeDiff } from './diff';

export interface ApplyOptions {
  dryRun?: boolean;
}

export interface ApplyResult {
  written: boolean;
  path: string;
  backupPath: string | null;
  diff: string;
  added: number;
  removed: number;
  before: string;
  after: string;
}

/**
 * Validate, render JSON5, optionally write (with backup), and always return a
 * unified-style line diff. Used by all `--dry-run` enabled mutators.
 */
export function applyConfigChange(
  path: string,
  config: AppConfig,
  options: ApplyOptions = {}
): ApplyResult {
  validateConfigOrThrow(config);
  const before = readFileSync(path, 'utf-8');
  const after = JSON5.stringify(config, { space: 2, quote: '"' });
  const diff = computeLineDiff(before, after);
  const { added, removed } = summarizeDiff(diff);
  if (options.dryRun) {
    return { written: false, path, backupPath: null, diff, added, removed, before, after };
  }
  const backupDir = join(dirname(path), '.backups');
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `config-${Date.now()}.json5`);
  writeFileSync(backupPath, before, 'utf-8');
  writeFileSync(path, after, 'utf-8');
  return { written: true, path, backupPath, diff, added, removed, before, after };
}
