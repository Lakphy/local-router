import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString(),
  };
}

describe('CLI get-route', () => {
  test('按 route type 输出所有 alias 与默认路由', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-router-cli-get-route-'));
    const configPath = join(dir, 'config.json5');
    writeFileSync(
      configPath,
      `{
  providers: {
    anthropic: {
      type: "anthropic-messages",
      base: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      models: {
        "claude-sonnet-4-5": {},
        "claude-haiku-4-5": {}
      }
    }
  },
  routes: {
    "anthropic-messages": {
      "sonnet": { provider: "anthropic", model: "claude-sonnet-4-5" },
      "haiku": { provider: "anthropic", model: "claude-haiku-4-5" },
      "*": { provider: "anthropic", model: "claude-haiku-4-5" }
    }
  }
}`,
      'utf-8'
    );

    try {
      const result = runCli([
        'get-route',
        '--type',
        'anthropic-messages',
        '--output',
        'text',
        '--config',
        configPath,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        'sonnet : anthropic / claude-sonnet-4-5 | haiku : anthropic / claude-haiku-4-5 | default : anthropic / claude-haiku-4-5'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('按 model-alias 输出单条路由，未命中时回退 default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-router-cli-get-route-alias-'));
    const configPath = join(dir, 'config.json5');
    writeFileSync(
      configPath,
      `{
  providers: {
    anthropic: {
      type: "anthropic-messages",
      base: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      models: {
        "claude-sonnet-4-5": {},
        "claude-haiku-4-5": {}
      }
    }
  },
  routes: {
    "anthropic-messages": {
      "sonnet": { provider: "anthropic", model: "claude-sonnet-4-5" },
      "*": { provider: "anthropic", model: "claude-haiku-4-5" }
    }
  }
}`,
      'utf-8'
    );

    try {
      const exact = runCli([
        'get-route',
        '--type',
        'anthropic-messages',
        '--model-alias',
        'sonnet',
        '--output',
        'text',
        '--config',
        configPath,
      ]);
      expect(exact.exitCode).toBe(0);
      expect(exact.stdout).toBe('anthropic / claude-sonnet-4-5');

      const fallback = runCli([
        'get-route',
        '--type',
        'anthropic-messages',
        '--model-alias',
        'unknown',
        '--output',
        'text',
        '--config',
        configPath,
      ]);
      expect(fallback.exitCode).toBe(0);
      expect(fallback.stdout).toBe('anthropic / claude-haiku-4-5');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
