import { describe, expect, test } from 'bun:test';
import { config, postJson, postJsonStream } from '../setup';

describe('Anthropic Messages', () => {
  const hasRoute = !!config.routes['anthropic-messages'];

  if (hasRoute) {
    describe('非流式', () => {
      test('应成功转发请求并返回响应', async () => {
        const { res, json, text } = await postJson('/anthropic-messages/v1/messages', {
          model: 'sonnet',
          max_tokens: 32,
          messages: [{ role: 'user', content: '请只回复 ok' }],
        });

        expect(res.ok, `请求失败: status=${res.status}, body=${text}`).toBe(true);
        expect(typeof (json as { id?: string }).id).toBe('string');
      });
    });

    describe('流式', () => {
      test('应成功转发流式请求并返回 SSE 响应', async () => {
        const { res, body } = await postJsonStream('/anthropic-messages/v1/messages', {
          model: 'sonnet',
          max_tokens: 32,
          messages: [{ role: 'user', content: '请只回复 ok' }],
          stream: true,
        });

        expect(res.ok).toBe(true);
        // SSE 响应应该包含 event: 或 data: 开头的行
        expect(body.includes('event:') || body.includes('data:')).toBe(true);
      });
    });
  }
});
