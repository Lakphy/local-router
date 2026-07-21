import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], configPath: string, runtimeDir: string): CliResult {
  const proc = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      LOCAL_ROUTER_FORMAT: '',
      LOCAL_ROUTER_CONFIG: configPath,
      LOCAL_ROUTER_RUNTIME_DIR: runtimeDir,
      LOCAL_ROUTER_NO_INTERACTIVE: '1',
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function expectNoMarkdownSource(output: string): void {
  expect(output).not.toMatch(/^#{1,6}\s/m);
  expect(output).not.toMatch(/^>\s/m);
  expect(output).not.toMatch(/^\|.*\|$/m);
  expect(output).not.toContain('```');
  expect(output).not.toMatch(/\*\*[^*]+\*\*/);
  expect(output).not.toContain('<!--');
  expect(output).not.toMatch(/`[^`]+`/);
}

describe('CLI human output coverage', () => {
  let dir: string;
  let runtimeDir: string;
  let configPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lr-human-output-'));
    runtimeDir = mkdtempSync(join(tmpdir(), 'lr-human-runtime-'));
    configPath = join(dir, 'config.json5');
    writeFileSync(
      configPath,
      `{
  providers: {
    p1: {
      type: "openai-completions",
      base: "https://example.com/v1",
      apiKey: "sk-test",
      models: { m1: {} }
    }
  },
  routes: {
    "openai-completions": { "*": { provider: "p1", model: "m1" } }
  }
}`
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  test('every registered command has Markdown-free default help', () => {
    const commandResult = runCli(['commands', '--output', 'json'], configPath, runtimeDir);
    expect(commandResult.exitCode).toBe(0);
    const envelope = JSON.parse(commandResult.stdout) as { data: Array<{ name: string }> };

    for (const command of envelope.data) {
      const result = runCli(['help', ...command.name.split(' ')], configPath, runtimeDir);
      expect(result.exitCode).toBe(0);
      expectNoMarkdownSource(result.stdout);
    }
  }, 15_000);

  test('representative successful commands across every output family are Markdown-free', () => {
    const commands = [
      [],
      ['version'],
      ['commands'],
      ['capabilities'],
      ['schema', 'errors'],
      ['docs', 'errors', 'TIMEOUT'],
      ['recipes'],
      ['recipes', 'first-run'],
      ['status'],
      ['config', 'show', '--config', configPath],
      ['config', 'provider', 'list', '--config', configPath],
      ['config', 'provider', 'show', 'p1', '--config', configPath],
      ['config', 'provider', 'model', 'list', 'p1', '--config', configPath],
      ['config', 'route', 'list', '--config', configPath],
      ['config', 'route', 'show', 'openai-completions', '--config', configPath],
      ['config', 'validate', '--config', configPath],
    ];

    for (const args of commands) {
      const result = runCli(args, configPath, runtimeDir);
      expect(result.exitCode).toBe(0);
      expectNoMarkdownSource(result.stdout);
    }
  });

  test('default errors from command parsing and runtime checks are Markdown-free', () => {
    for (const args of [
      ['definitely-not-a-command'],
      ['config', 'provider', 'show', '--config', configPath],
      ['health', '--url', 'http://127.0.0.1:1'],
      ['logs', 'metrics', '--url', 'http://127.0.0.1:1'],
    ]) {
      const result = runCli(args, configPath, runtimeDir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expectNoMarkdownSource(result.stderr);
    }
  });

  test('raw artifact commands remain undecorated by the human renderer', () => {
    const completion = runCli(['completion', 'zsh'], configPath, runtimeDir);
    expect(completion.exitCode).toBe(0);
    expect(completion.stdout).toContain('#compdef local-router');
    expect(completion.stdout).not.toContain('completion ·');

    const exported = runCli(
      ['config', 'export', '--format', 'json', '--config', configPath],
      configPath,
      runtimeDir
    );
    expect(exported.exitCode).toBe(0);
    expect(() => JSON.parse(exported.stdout)).not.toThrow();

    const envScript = runCli(['env', '--export'], configPath, runtimeDir);
    expect(envScript.exitCode).toBe(0);
    expect(envScript.stdout).toMatch(/^export OPENAI_BASE_URL=/);
    expect(envScript.stdout).not.toContain('env ·');
  });
});
