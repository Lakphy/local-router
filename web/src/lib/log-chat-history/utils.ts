export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function safeJsonParse(text: string): { value: unknown | null; error: string | null } {
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'JSON parse failed';
    return { value: null, error: message };
  }
}

export function ensureObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function normalizeRole(value: unknown, fallback: 'user' | 'assistant' | 'system' | 'tool') {
  if (value === 'user' || value === 'assistant' || value === 'system' || value === 'tool') {
    return value;
  }
  return fallback;
}

export function stringifyForDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
