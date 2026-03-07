import { fileURLToPath } from 'node:url';

function resolveBundledAssetPath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export function getBundledSchemaPath(): string {
  return resolveBundledAssetPath('../config.schema.json');
}

export function getBundledWebRoot(): string {
  return resolveBundledAssetPath('../dist/web/');
}
