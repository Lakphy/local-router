import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CLI daemon lifecycle', () => {
  test('start --daemon / status --json / stop', async () => {
    // 用独立 LOCAL_ROUTER_RUNTIME_DIR 隔离开发机上已运行的实例，避免覆盖 status.json
    const dir = mkdtempSync(join(tmpdir(), 'local-router-cli-daemon-'));
    const runtimeDir = mkdtempSync(join(tmpdir(), 'local-router-cli-runtime-'));
    const env = { ...process.env, LOCAL_ROUTER_RUNTIME_DIR: runtimeDir };
    const runCli = (args: string[]): { exitCode: number; stdout: string; stderr: string } => {
      const proc = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
        env,
      });
      return {
        exitCode: proc.exitCode,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
      };
    };

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
      const envelope = JSON.parse(status.stdout) as {
        ok: boolean;
        data: {
          running: boolean;
          mode: string;
          port: number;
          baseUrl: string;
          uptimeSeconds: number | null;
        };
      };
      expect(envelope.ok).toBe(true);
      const statusJson = envelope.data;
      expect(statusJson.running).toBe(true);
      expect(statusJson.mode).toBe('daemon');
      expect(statusJson.port).toBe(port);
      expect(statusJson.baseUrl).toBe(`http://127.0.0.1:${port}`);
      expect(statusJson.uptimeSeconds === null || statusJson.uptimeSeconds >= 0).toBe(true);

      const stop = runCli(['stop']);
      expect(stop.exitCode).toBe(0);
    } finally {
      runCli(['stop']);
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
