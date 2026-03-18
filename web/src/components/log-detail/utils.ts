import type { CSSProperties } from 'react';
import type { LogEventDetail } from '@/lib/api';

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export const JSON_VIEW_STYLE = {
  '--w-rjv-font-family':
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  '--w-rjv-background-color': 'transparent',
  '--w-rjv-color': 'var(--foreground)',
  '--w-rjv-border-left': '1px dashed var(--border)',
  '--w-rjv-line-color': 'var(--border)',
  '--w-rjv-arrow-color': 'var(--muted-foreground)',
  '--w-rjv-info-color': 'var(--muted-foreground)',
  '--w-rjv-curlybraces-color': 'var(--foreground)',
  '--w-rjv-brackets-color': 'var(--foreground)',
  '--w-rjv-colon-color': 'var(--muted-foreground)',
  '--w-rjv-key-string': 'var(--foreground)',
  '--w-rjv-type-string-color': 'oklch(0.52 0.16 250)',
  '--w-rjv-type-int-color': 'oklch(0.56 0.16 145)',
  '--w-rjv-type-float-color': 'oklch(0.56 0.16 145)',
  '--w-rjv-type-boolean-color': 'oklch(0.58 0.19 30)',
  '--w-rjv-type-null-color': 'var(--muted-foreground)',
  '--w-rjv-type-undefined-color': 'var(--muted-foreground)',
  '--w-rjv-type-date-color': 'oklch(0.56 0.16 145)',
  '--w-rjv-type-url-color': 'oklch(0.52 0.16 250)',
} as CSSProperties;

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function captureReason(detail: LogEventDetail): string | null {
  if (detail.capture.bodyPolicy === 'off') {
    return 'Body 记录策略为 off，未记录请求/响应 body。';
  }
  if (detail.capture.bodyPolicy === 'full') {
    return 'Body 记录策略为 full，当前展示的是完整内容。';
  }
  if (detail.capture.bodyPolicy === 'masked') {
    return '当前配置中的 bodyPolicy=masked 会按完整内容展示。';
  }
  return null;
}

export function getInterfaceType(routeType: string): string {
  if (routeType.startsWith('openai')) return 'openai';
  if (routeType.startsWith('anthropic')) return 'anthropic';
  return routeType;
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stringifyBody(body: unknown): string | null {
  if (body == null) return null;
  return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
}

function looksLikeJsonContentType(contentType?: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return normalized.includes('application/json') || normalized.includes('+json');
}

function looksLikeJsonText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^(?:\{|\[|"|-?\d|true$|false$|null$)/.test(trimmed);
}

export function parseJsonCandidate(
  value: unknown,
  contentType?: string | null
): {
  kind: 'empty' | 'json-tree' | 'json-primitive' | 'text';
  value?: unknown;
  text?: string;
} {
  if (value == null) return { kind: 'empty' };

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { kind: 'text', text: value };

    if (looksLikeJsonContentType(contentType) || looksLikeJsonText(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed !== null && typeof parsed === 'object') {
          return { kind: 'json-tree', value: parsed };
        }
        return { kind: 'json-primitive', value: parsed };
      } catch {
        return { kind: 'text', text: value };
      }
    }

    return { kind: 'text', text: value };
  }

  if (typeof value === 'object') {
    return { kind: 'json-tree', value };
  }

  return { kind: 'json-primitive', value };
}

function normalizeHeaders(
  headers: Record<string, string>,
  mode: 'local-router' | 'provider'
): Array<[string, string]> {
  const filtered = Object.entries(headers).filter(([key]) => {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'host') return false;
    if (mode === 'provider' && (lower === 'authorization' || lower === 'x-api-key')) return false;
    return true;
  });
  return filtered.sort(([a], [b]) => a.localeCompare(b));
}

function getProviderAuthHeader(routeType: string): [string, string] {
  if (routeType.startsWith('anthropic')) {
    return ['x-api-key', '<PROVIDER_API_KEY>'];
  }
  return ['Authorization', 'Bearer <PROVIDER_API_KEY>'];
}

export function restoreLocalRouterBody(detail: LogEventDetail): unknown {
  const body = detail.request.requestBody;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return {
    ...body,
    model: detail.summary.modelIn,
  };
}

export function buildCurlCommand(detail: LogEventDetail, mode: 'local-router' | 'provider'): string {
  const url =
    mode === 'provider'
      ? detail.upstream.targetUrl
      : new URL(detail.request.path, window.location.origin).toString();
  const body = mode === 'provider' ? detail.request.requestBody : restoreLocalRouterBody(detail);
  const bodyText = stringifyBody(body);
  const headers = normalizeHeaders(detail.request.requestHeaders ?? {}, mode);
  const authHeader = mode === 'provider' ? getProviderAuthHeader(detail.summary.routeType) : null;

  const lines = ['curl', `  -X ${detail.request.method}`, `  ${shellEscape(url)}`];
  headers.forEach(([key, value]) => {
    lines.push(`  -H ${shellEscape(`${key}: ${value}`)}`);
  });

  if (mode === 'provider' && authHeader) {
    lines.push(`  -H ${shellEscape(`${authHeader[0]}: ${authHeader[1]}`)}`);
    lines.push(`  -H ${shellEscape('accept-encoding: identity')}`);
  }

  if (bodyText !== null) {
    lines.push(`  --data-raw ${shellEscape(bodyText)}`);
  }

  return `${lines.join(' \\\n')}`;
}

export type StreamLine =
  | { type: 'json'; lineNo: number; value: unknown }
  | { type: 'raw'; lineNo: number; value: string };

export function parseStreamLines(content: string): StreamLine[] {
  const rawLines = content.split('\n');
  const lines: StreamLine[] = [];

  rawLines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    const lineNo = index + 1;
    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trim();
      if (!payload) return;
      try {
        lines.push({ type: 'json', lineNo, value: JSON.parse(payload) });
      } catch {
        lines.push({ type: 'raw', lineNo, value: trimmed });
      }
      return;
    }

    try {
      lines.push({ type: 'json', lineNo, value: JSON.parse(trimmed) });
    } catch {
      lines.push({ type: 'raw', lineNo, value: trimmed });
    }
  });

  return lines;
}
