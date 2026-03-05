import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';

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

describe('CLI daemon lifecycle', () => {
  test('start --daemon / status --json / stop', async () => {
    const preStatus = runCli(['status', '--json']);
    if (preStatus.exitCode === 0) {
      try {
        const parsed = JSON.parse(preStatus.stdout) as { running?: boolean };
        if (parsed.running) {
          // 避免影响已在本机运行的实例，跳过该测试。
          expect(true).toBe(true);
          return;
        }
      } catch {
        // ignore parse error and continue
      }
    }

    const dir = mkdtempSync(join(tmpdir(), 'local-router-cli-daemon-'));
    const configPath = join(dir, 'config.json5');
    const port = 43120 + Math.floor(Math.random() * 200);
    const minimalConfig = `{
  providers: {
    mock: {
      type: "openai-completions",
      base: "https://example.com/v1",
      apiKey: "dummy",
      models: {
        "m": {}
      }
    }
  },
  routes: {
    "openai-completions": {
      "*": { provider: "mock", model: "m" }
    }
  }
}`;
    writeFileSync(configPath, minimalConfig, 'utf-8');

    try {
      const start = runCli(['start', '--daemon', '--config', configPath, '--port', String(port)]);
      expect(start.exitCode).toBe(0);

      const status = runCli(['status', '--json']);
      expect(status.exitCode).toBe(0);
      const statusJson = JSON.parse(status.stdout) as {
        running: boolean;
        mode: string;
        port: number;
        uptimeSeconds: number | null;
      };
      expect(statusJson.running).toBe(true);
      expect(statusJson.mode).toBe('daemon');
      expect(statusJson.port).toBe(port);
      expect(statusJson.uptimeSeconds === null || statusJson.uptimeSeconds >= 0).toBe(true);

      const stop = runCli(['stop']);
      expect(stop.exitCode).toBe(0);
    } finally {
      runCli(['stop']);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
