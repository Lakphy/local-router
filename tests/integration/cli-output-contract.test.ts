import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runCli(
  args: string[],
  env: Record<string, string> = {}
): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const proc = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function withTempConfig(): { dir: string; configPath: string; runtimeDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lr-output-contract-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'lr-output-runtime-'));
  const configPath = join(dir, 'config.json5');
  writeFileSync(
    configPath,
    `{
  providers: {
    p1: {
      type: "openai-completions",
      base: "https://example.com/v1",
      apiKey: "sk-test-12345",
      models: { "m1": {} }
    }
  },
  routes: {
    "openai-completions": { "*": { provider: "p1", model: "m1" } }
  }
}`,
    'utf-8'
  );
  return { dir, configPath, runtimeDir };
}

describe('CLI output contract', () => {
  test('JSON envelope schema (success)', () => {
    const { dir, configPath, runtimeDir } = withTempConfig();
    try {
      const r = runCli(['config', 'provider', 'list', '--config', configPath, '--output', 'json'], {
        LOCAL_ROUTER_RUNTIME_DIR: runtimeDir,
      });
      expect(r.exitCode).toBe(0);
      const env = JSON.parse(r.stdout) as {
        ok: boolean;
        command: string;
        schema_version: number;
        data: Array<{ name: string }>;
        meta: Record<string, unknown>;
      };
      expect(env.ok).toBe(true);
      expect(env.command).toBe('config.provider.list');
      expect(env.schema_version).toBe(1);
      expect(Array.isArray(env.data)).toBe(true);
      expect(env.data[0]?.name).toBe('p1');
      expect(typeof env.meta.elapsedMs).toBe('number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test('JSON envelope schema (error) with code, hint, exit_code', () => {
    const { dir, configPath, runtimeDir } = withTempConfig();
    try {
      const r = runCli(
        ['config', 'provider', 'remove', 'p1', '--config', configPath, '--output', 'json'],
        { LOCAL_ROUTER_RUNTIME_DIR: runtimeDir }
      );
      expect(r.exitCode).toBe(4);
      const env = JSON.parse(r.stdout) as {
        ok: boolean;
        error: { code: string; hint?: string; details?: { references?: unknown[] } };
        exit_code: number;
      };
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe('PROVIDER_REFERENCED_BY_ROUTE');
      expect(env.exit_code).toBe(4);
      expect(env.error.hint).toBeTruthy();
      expect(Array.isArray(env.error.details?.references)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test('default output is Markdown with stable heading', () => {
    const { dir, configPath, runtimeDir } = withTempConfig();
    try {
      const r = runCli(['config', 'provider', 'list', '--config', configPath], {
        LOCAL_ROUTER_RUNTIME_DIR: runtimeDir,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/^## config\.provider\.list/);
      expect(r.stdout).toContain('### 数据');
      expect(r.stdout).toContain('| name | type | base | models | proxy |');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test('--output text preserves legacy format', () => {
    const { dir, configPath, runtimeDir } = withTempConfig();
    try {
      const r = runCli(['config', 'provider', 'list', '--config', configPath, '--output', 'text'], {
        LOCAL_ROUTER_RUNTIME_DIR: runtimeDir,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('NAME\tTYPE\tMODELS\tBASE');
      expect(r.stdout).toContain('p1\topenai-completions');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test('LOCAL_ROUTER_FORMAT env var equals --output flag', () => {
    const { dir, configPath, runtimeDir } = withTempConfig();
    try {
      const r = runCli(['config', 'provider', 'list', '--config', configPath], {
        LOCAL_ROUTER_RUNTIME_DIR: runtimeDir,
        LOCAL_ROUTER_FORMAT: 'json',
      });
      expect(r.exitCode).toBe(0);
      const env = JSON.parse(r.stdout) as { ok: boolean; data: unknown };
      expect(env.ok).toBe(true);
      expect(Array.isArray(env.data)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test('commands --json includes registered metadata', () => {
    const r = runCli(['commands', '--json']);
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as {
      data: Array<{ name: string; mutates: boolean; supportsJson: boolean }>;
    };
    const status = env.data.find((c) => c.name === 'status');
    expect(status).toBeDefined();
    expect(status?.supportsJson).toBe(true);
  });

  test('schema errors lists all CliError codes', () => {
    const r = runCli(['schema', 'errors', '--json']);
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as { data: Array<{ code: string; exitCode: number }> };
    const codes = env.data.map((d) => d.code);
    expect(codes).toContain('PROVIDER_REFERENCED_BY_ROUTE');
    expect(codes).toContain('TIMEOUT');
    expect(env.data.find((d) => d.code === 'TIMEOUT')?.exitCode).toBe(7);
  });

  test('docs errors <code> returns single doc', () => {
    const r = runCli(['docs', 'errors', 'PROVIDER_REFERENCED_BY_ROUTE', '--json']);
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as {
      data: { code: string; exitCode: number; summary: string; cause: string; fix: string };
    };
    expect(env.data.code).toBe('PROVIDER_REFERENCED_BY_ROUTE');
    expect(env.data.exitCode).toBe(4);
    expect(env.data.summary.length).toBeGreaterThan(0);
  });

  test('config patch (RFC6902) via stdin with --dry-run', () => {
    const { dir, configPath, runtimeDir } = withTempConfig();
    try {
      const proc = Bun.spawnSync(
        [
          'bun',
          'run',
          'src/cli.ts',
          'config',
          'patch',
          '--file',
          '-',
          '--dry-run',
          '--config',
          configPath,
          '--output',
          'json',
        ],
        {
          cwd: process.cwd(),
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: new TextEncoder().encode(
            '[{"op":"add","path":"/providers/demo","value":{"type":"openai-completions","base":"https://x","apiKey":"sk-1","models":{"m":{}}}}]'
          ),
          env: { ...process.env, LOCAL_ROUTER_RUNTIME_DIR: runtimeDir },
        }
      );
      expect(proc.exitCode).toBe(0);
      const env = JSON.parse(proc.stdout.toString()) as {
        ok: boolean;
        data: { written: boolean; ops: number; added: number };
      };
      expect(env.ok).toBe(true);
      expect(env.data.written).toBe(false);
      expect(env.data.ops).toBe(1);
      expect(env.data.added).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test('version reads actual package version (regression for asset-paths)', () => {
    const r = runCli(['version', '--json']);
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as { data: { version: string } };
    expect(env.data.version).not.toBe('unknown');
    expect(env.data.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('unknown top-level command honors --output json (regression)', () => {
    const r = runCli(['definitely-not-a-cmd', '--output', 'json']);
    expect(r.exitCode).toBe(2);
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      error: { code: string };
      exit_code: number;
    };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('USAGE_ERROR');
    expect(env.exit_code).toBe(2);
  });

  test('unknown config subcommand honors --output json (regression)', () => {
    const r = runCli(['config', 'definitely-not-a-sub', '--output', 'json']);
    expect(r.exitCode).toBe(2);
    const env = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('USAGE_ERROR');
  });

  test('schema config returns the JSON Schema (regression for asset-paths)', () => {
    const r = runCli(['schema', 'config', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { $schema?: string; title?: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.title).toBe('Local Router Config');
  });

  test('INTERACTIVE_REQUIRED includes available candidates in details', () => {
    const { dir, configPath, runtimeDir } = withTempConfig();
    try {
      const proc = Bun.spawnSync(
        [
          'bun',
          'run',
          'src/cli.ts',
          'config',
          'route',
          'set',
          'openai-completions',
          'sonnet',
          '--no-interactive',
          '--config',
          configPath,
          '--output',
          'json',
        ],
        {
          cwd: process.cwd(),
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: new TextEncoder().encode(''),
          env: { ...process.env, LOCAL_ROUTER_RUNTIME_DIR: runtimeDir },
        }
      );
      expect(proc.exitCode).toBe(10);
      const env = JSON.parse(proc.stdout.toString()) as {
        ok: boolean;
        error: {
          code: string;
          details?: {
            availableProviders?: string[];
            availableModels?: Record<string, string[]>;
          };
        };
      };
      expect(env.error.code).toBe('INTERACTIVE_REQUIRED');
      expect(env.error.details?.availableProviders).toContain('p1');
      expect(env.error.details?.availableModels?.p1).toContain('m1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
