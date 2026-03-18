import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { createAppRuntimeFromConfigPath } from '../../src/index';

describe('runtime bundled assets', () => {
  test('schema and admin assets resolve from package location instead of cwd', async () => {
    const originalCwd = process.cwd();
    const workdir = mkdtempSync(join(tmpdir(), 'local-router-runtime-cwd-'));
    const configDir = mkdtempSync(join(tmpdir(), 'local-router-runtime-config-'));
    const configPath = join(configDir, 'config.json5');

    writeFileSync(
      configPath,
      `{
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
}`,
      'utf-8'
    );

    process.chdir(workdir);
    const runtime = await createAppRuntimeFromConfigPath(configPath);

    try {
      const schemaRes = await runtime.app.request('http://localhost/api/config/schema');
      expect(schemaRes.status).toBe(200);
      const schema = (await schemaRes.json()) as { properties?: Record<string, unknown> };
      expect(schema.properties).toBeDefined();

      const adminRes = await runtime.app.request('http://localhost/admin/');
      expect(adminRes.status).toBe(200);
      const adminHtml = await adminRes.text();
      expect(adminHtml).toContain('/admin/assets/');
    } finally {
      runtime.dispose();
      process.chdir(originalCwd);
      rmSync(workdir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
