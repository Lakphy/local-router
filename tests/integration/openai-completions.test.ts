import { describe, expect, test } from 'bun:test';
import { config, postJson, postJsonStream } from '../setup';

describe('OpenAI Completions', () => {
  const hasRoute = !!config.routes['openai-completions'];

  if (hasRoute) {
    describe('非流式', () => {
      test('应成功转发请求并返回响应', async () => {
        const { res, json, text } = await postJson('/openai-completions/v1/chat/completions', {
          model: 'test-model',
          messages: [{ role: 'user', content: '请只回复 ok' }],
          stream: false,
          max_tokens: 16,
        });

        expect(res.ok, `请求失败: status=${res.status}, body=${text}`).toBe(true);
        expect(typeof (json as { id?: string }).id).toBe('string');
      });
    });

    describe('流式', () => {
      test('应成功转发流式请求并返回 SSE 响应', async () => {
        const { res, body } = await postJsonStream('/openai-completions/v1/chat/completions', {
          model: 'test-model',
          messages: [{ role: 'user', content: '请只回复 ok' }],
          stream: true,
          max_tokens: 16,
        });

        expect(res.ok).toBe(true);
        // SSE 响应应该包含 data: 开头的行
        expect(body).toContain('data:');
      });
    });
  }
});
