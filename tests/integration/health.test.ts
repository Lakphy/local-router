import { describe, expect, test } from 'bun:test';
import { app } from '../setup';

describe('健康检查', () => {
  test('GET / 应返回服务运行状态', async () => {
    const res = await app.request('http://localhost/');
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('local-router is running');
  });
});
