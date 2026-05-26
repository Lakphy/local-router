import { describe, expect, test } from 'bun:test';

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

const EXPECTED_COMMANDS = new Set([
  'init',
  'start',
  'stop',
  'restart',
  'status',
  'health',
  'version',
  'doctor',
  'ping',
  'try',
  'chat',
  'logs daemon',
  'logs events',
  'logs tail',
  'logs metrics',
  'logs storage',
  'logs export',
  'logs prune',
  'logs tokens',
  'logs cost',
  'logs last-error',
  'recipes',
  'commands',
  'schema',
  'agents-md',
  'completion',
  'open',
  'env',
  'config apply',
  'config edit',
]);

describe('CLI command surface stability', () => {
  test('commands --json includes the agreed surface', () => {
    const { stdout, exitCode } = runCli(['commands', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout) as { data: Array<{ name: string }> };
    const names = new Set(env.data.map((c) => c.name));
    const missing = [...EXPECTED_COMMANDS].filter((n) => !names.has(n));
    expect(missing).toEqual([]);
  });

  test('commands --json envelope has schema_version 2', () => {
    const { stdout } = runCli(['commands', '--output', 'json']);
    const env = JSON.parse(stdout) as { schema_version: number };
    expect(env.schema_version).toBe(2);
  });

  test('agents-md contains stable section headings', () => {
    const { stdout, exitCode } = runCli(['agents-md']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('# local-router · AGENTS.md');
    expect(stdout).toContain('## 输出契约');
    expect(stdout).toContain('## 退出码');
    expect(stdout).toContain('local-router commands --json');
  });

  test('schema cli lists declarative metadata', () => {
    const { stdout, exitCode } = runCli(['schema', 'cli', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout) as { data: { schema_version: number; commands: unknown[] } };
    expect(env.data.schema_version).toBeGreaterThanOrEqual(1);
    expect(env.data.commands.length).toBeGreaterThan(20);
  });
});
