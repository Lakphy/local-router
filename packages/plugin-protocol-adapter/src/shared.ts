/**
 * 协议适配器共享工具：URL 重写 + 认证头转换。
 *
 * 供各方向适配器插件复用。
 */

import type { ProtocolFormat } from './convert-request';

// ─── URL 路径映射 ─────────────────────────────────────────────────────────────

export const URL_PATH_MAP: Record<ProtocolFormat, string> = {
  'openai-completions': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  'anthropic-messages': '/v1/messages',
};

export function rewriteUrl(url: string, from: ProtocolFormat, to: ProtocolFormat): string {
  const fromPath = URL_PATH_MAP[from];
  const toPath = URL_PATH_MAP[to];
  if (url.includes(fromPath)) {
    return url.replace(fromPath, toPath);
  }
  const fromSuffix = fromPath.split('/').pop()!;
  const idx = url.lastIndexOf(`/${fromSuffix}`);
  if (idx !== -1) {
    return url.slice(0, idx) + toPath;
  }
  return url.replace(/\/[^/]+$/, toPath);
}

// ─── 认证头转换 ────────────────────────────────────────────────────────────────

export function convertAuthHeaders(headers: Headers, from: ProtocolFormat, to: ProtocolFormat): void {
  if (
    from === 'anthropic-messages' &&
    (to === 'openai-completions' || to === 'openai-responses')
  ) {
    const apiKey = headers.get('x-api-key');
    if (apiKey) {
      headers.delete('x-api-key');
      headers.set('Authorization', `Bearer ${apiKey}`);
    }
    headers.delete('anthropic-version');
    headers.delete('anthropic-beta');
  } else if (
    (from === 'openai-completions' || from === 'openai-responses') &&
    to === 'anthropic-messages'
  ) {
    const auth = headers.get('Authorization');
    if (auth?.startsWith('Bearer ')) {
      const apiKey = auth.slice(7);
      headers.delete('Authorization');
      headers.set('x-api-key', apiKey);
    }
    if (!headers.has('anthropic-version')) {
      headers.set('anthropic-version', '2023-06-01');
    }
  }
}
