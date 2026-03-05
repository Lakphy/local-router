import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';

describe('CLI init', () => {
  test('init 会创建空配置文件模板', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-router-cli-init-'));
    const configPath = join(dir, 'config.json5');
    try {
      const proc = Bun.spawnSync(['bun', 'run', 'src/cli.ts', 'init', '--config', configPath], {
        cwd: process.cwd(),
        stderr: 'pipe',
        stdout: 'pipe',
      });
      const stderr = proc.stderr.toString();
      if (proc.exitCode !== 0) {
        throw new Error(`init 失败: ${stderr}`);
      }
      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('providers: {');
      expect(content).toContain('routes: {');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
