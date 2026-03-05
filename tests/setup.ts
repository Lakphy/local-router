import { loadConfig } from '../src/config';
import { createAppFromConfigPath } from '../src/index';

export const configPath = process.env.TEST_CONFIG_PATH ?? 'config.json5';
export const config = loadConfig(configPath);
export const app = createAppFromConfigPath(configPath);

export interface RequestResult {
  res: Response;
  text: string;
  json: unknown;
}

export async function postJson(
  path: string,
  payload: Record<string, unknown>,
  timeoutMs = 10000
): Promise<RequestResult> {
  const res = await app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  // 设置读取超时
  const timeoutPromise = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error('Read timeout')), timeoutMs)
  );

  try {
    const text = await Promise.race([res.text(), timeoutPromise]);
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 某些异常响应可能不是 JSON
    }
    return { res, text, json };
  } catch (_e) {
    // 超时但仍返回响应，让测试可以检查 status
    return { res, text: '', json: null };
  }
}

export async function postJsonStream(
  path: string,
  payload: Record<string, unknown>
): Promise<{ res: Response; body: string }> {
  // 使用 AbortController 设置超时
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await app.request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    clearTimeout(timeout);

    // 流式响应可能很长，只读取前一部分
    const reader = res.body?.getReader();
    if (!reader) {
      return { res, body: '' };
    }

    // 只读取前 10 个 chunk 用于验证
    let body = '';
    for (let i = 0; i < 10; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      body += new TextDecoder().decode(value);
      if (body.length > 1000) break; // 最多读取 1000 字符
    }
    reader.releaseLock();

    return { res, body };
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}
