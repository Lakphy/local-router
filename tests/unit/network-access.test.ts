import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { ConfigStore } from '../../src/config-store';
import {
  createNetworkAccessMiddleware,
  decideNetworkAccess,
  isLanAddress,
  isLoopbackAddress,
  REMOTE_ADDRESS_ENV_KEY,
} from '../../src/network-access';

describe('network access control', () => {
  test('默认关闭局域网服务时允许本机来源', () => {
    expect(decideNetworkAccess(undefined, '127.0.0.1').allowed).toBe(true);
    expect(decideNetworkAccess(undefined, '::1').allowed).toBe(true);
    expect(decideNetworkAccess(undefined, '::ffff:127.0.0.1').allowed).toBe(true);
  });

  test('默认关闭局域网服务时拒绝局域网来源', () => {
    const decision = decideNetworkAccess(undefined, '192.168.1.24');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('lan-disabled');
  });

  test('开启局域网服务后允许私有网段与链路本地来源', () => {
    const config = { lanAccess: { enabled: true } };
    expect(decideNetworkAccess(config, '10.0.0.8').allowed).toBe(true);
    expect(decideNetworkAccess(config, '172.20.1.8').allowed).toBe(true);
    expect(decideNetworkAccess(config, '192.168.1.8').allowed).toBe(true);
    expect(decideNetworkAccess(config, '169.254.10.20').allowed).toBe(true);
    expect(decideNetworkAccess(config, 'fc00::1').allowed).toBe(true);
    expect(decideNetworkAccess(config, 'fe80::1').allowed).toBe(true);
  });

  test('开启局域网服务后仍拒绝公网来源', () => {
    const decision = decideNetworkAccess({ lanAccess: { enabled: true } }, '8.8.8.8');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('non-lan-address');
  });

  test('IP 分类应处理常见地址格式', () => {
    expect(isLoopbackAddress('[::1]:4099')).toBe(true);
    expect(isLanAddress('::ffff:192.168.1.8')).toBe(true);
    expect(isLanAddress('172.15.0.1')).toBe(false);
    expect(isLanAddress('172.16.0.1')).toBe(true);
    expect(isLanAddress('172.31.255.255')).toBe(true);
    expect(isLanAddress('172.32.0.1')).toBe(false);
  });

  test('中间件应按 Hono env 中的真实来源地址拒绝局域网请求', async () => {
    const app = new Hono();
    const store = {
      get: () => ({ routes: {}, providers: {}, server: { lanAccess: { enabled: false } } }),
    } as unknown as ConfigStore;

    app.use('*', createNetworkAccessMiddleware(store));
    app.get('/', (c) => c.text('ok'));

    const res = await app.request(
      'http://local-router/',
      {},
      { [REMOTE_ADDRESS_ENV_KEY]: '192.168.1.20' }
    );

    expect(res.status).toBe(403);
  });

  test('中间件应在开启局域网服务后放行局域网请求', async () => {
    const app = new Hono();
    const store = {
      get: () => ({ routes: {}, providers: {}, server: { lanAccess: { enabled: true } } }),
    } as unknown as ConfigStore;

    app.use('*', createNetworkAccessMiddleware(store));
    app.get('/', (c) => c.text('ok'));

    const res = await app.request(
      'http://local-router/',
      {},
      { [REMOTE_ADDRESS_ENV_KEY]: '192.168.1.20' }
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
