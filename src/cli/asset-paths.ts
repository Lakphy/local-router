/**
 * Resolve runtime-loaded files (package.json, config.schema.json) so they work
 * BOTH in dev (`bun src/cli.ts` — handler files at `src/cli/handlers/*.ts`)
 * AND post-bundle (`dist/cli.js`).
 *
 * The bundler inlines `import.meta.url` resolution at runtime to point at the
 * bundled file. So we need to try multiple candidate URLs and use whichever
 * actually exists.
 */

async function findExisting(...candidates: URL[]): Promise<URL | null> {
  for (const url of candidates) {
    try {
      // Bun.file().exists() is async and never throws for missing files.
      const exists = await Bun.file(url).exists();
      if (exists) return url;
    } catch {
      // ignore and try next
    }
  }
  return null;
}

export async function readPackageJson(): Promise<{ version?: string } | null> {
  const url = await findExisting(
    new URL('../../package.json', import.meta.url), // src/cli/asset-paths.ts → root
    new URL('../package.json', import.meta.url), // dist/cli.js → root
    new URL('../../../package.json', import.meta.url) // src/cli/handlers/*.ts (legacy callers)
  );
  if (!url) return null;
  try {
    return await Bun.file(url).json();
  } catch {
    return null;
  }
}

export async function findConfigSchemaUrl(): Promise<URL | null> {
  return findExisting(
    new URL('../../config.schema.json', import.meta.url),
    new URL('../config.schema.json', import.meta.url),
    new URL('../../../config.schema.json', import.meta.url)
  );
}

export async function readVersionString(): Promise<string> {
  const pkg = await readPackageJson();
  return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
}
