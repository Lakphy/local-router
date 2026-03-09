import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import JSON5 from 'json5';

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe('CLI config management', () => {
  test('provider/route/resolve workflow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-router-cli-config-'));
    const configPath = join(dir, 'config.json5');
    writeFileSync(
      configPath,
      `{
  providers: {
    p1: {
      type: "openai-completions",
      base: "https://example.com/v1",
      apiKey: "sk-test-12345",
      models: {
        "m1": {}
      }
    }
  },
  routes: {
    "openai-completions": {
      "*": { provider: "p1", model: "m1" }
    }
  }
}`,
      'utf-8'
    );

    try {
      const list = runCli(['config', 'provider', 'list', '--json', '--config', configPath]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain('p1');

      const addProvider = runCli([
        'config',
        'provider',
        'add',
        'p2',
        '--type',
        'openai-completions',
        '--base',
        'https://example.org/v1',
        '--api-key',
        'sk-abc',
        '--model',
        'boot-model',
        '--config',
        configPath,
      ]);
      expect(addProvider.exitCode).toBe(0);

      const addModel = runCli([
        'config',
        'provider',
        'model',
        'add',
        'p2',
        'gpt-4o-mini',
        '--image-input',
        '--reasoning',
        '--config',
        configPath,
      ]);
      expect(addModel.exitCode).toBe(0);

      const routeSet = runCli([
        'config',
        'route',
        'set',
        'openai-completions',
        'gpt-4o',
        '--provider',
        'p2',
        '--model',
        'gpt-4o-mini',
        '--config',
        configPath,
      ]);
      expect(routeSet.exitCode).toBe(0);

      const resolve = runCli([
        'config',
        'resolve',
        '--entry',
        'openai-completions',
        '--model',
        'gpt-4o',
        '--json',
        '--config',
        configPath,
      ]);
      expect(resolve.exitCode).toBe(0);
      const resolved = JSON.parse(resolve.stdout) as { provider: string; targetModel: string };
      expect(resolved.provider).toBe('p2');
      expect(resolved.targetModel).toBe('gpt-4o-mini');

      const validate = runCli(['config', 'validate', '--config', configPath]);
      expect(validate.exitCode).toBe(0);

      const finalConfig = JSON5.parse(readFileSync(configPath, 'utf-8')) as {
        providers: Record<string, { models: Record<string, { 'image-input'?: boolean; reasoning?: boolean }> }>;
        routes: Record<string, Record<string, { provider: string; model: string }>>;
      };
      expect(finalConfig.routes['openai-completions']['gpt-4o'].provider).toBe('p2');
      expect(finalConfig.providers.p2.models['gpt-4o-mini']['image-input']).toBe(true);
      expect(finalConfig.providers.p2.models['gpt-4o-mini'].reasoning).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('provider remove --force cascades route cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-router-cli-config-force-'));
    const configPath = join(dir, 'config.json5');
    writeFileSync(
      configPath,
      `{
  providers: {
    keep: {
      type: "openai-completions",
      base: "https://example.com/v1",
      apiKey: "keep-key",
      models: {
        "m-keep": {}
      }
    },
    drop: {
      type: "openai-completions",
      base: "https://example.org/v1",
      apiKey: "drop-key",
      models: {
        "m-drop": {}
      }
    }
  },
  routes: {
    "openai-completions": {
      "gpt-4o": { provider: "drop", model: "m-drop" },
      "*": { provider: "keep", model: "m-keep" }
    }
  }
}`,
      'utf-8'
    );

    try {
      const remove = runCli(['config', 'provider', 'remove', 'drop', '--force', '--config', configPath]);
      expect(remove.exitCode).toBe(0);
      expect(remove.stdout).toContain('并清理 1 条关联路由');

      const parsed = JSON5.parse(readFileSync(configPath, 'utf-8')) as {
        providers: Record<string, unknown>;
        routes: Record<string, Record<string, { provider: string; model: string }>>;
      };
      expect(parsed.providers.drop).toBeUndefined();
      expect(parsed.routes['openai-completions']['gpt-4o']).toBeUndefined();
      expect(parsed.routes['openai-completions']['*'].provider).toBe('keep');

      const validate = runCli(['config', 'validate', '--config', configPath]);
      expect(validate.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
