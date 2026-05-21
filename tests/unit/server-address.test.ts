import { describe, expect, test } from 'bun:test';
import { createServerAddressInfo, resolveLocalAccessHost } from '../../src/server-address';

describe('server address display helpers', () => {
  test('wildcard IPv4 listener uses loopback as local access URL', () => {
    const address = createServerAddressInfo('0.0.0.0', 4099);

    expect(address.listenUrl).toBe('http://0.0.0.0:4099');
    expect(address.localUrl).toBe('http://127.0.0.1:4099');
  });

  test('wildcard IPv6 listener uses bracketed loopback as local access URL', () => {
    const address = createServerAddressInfo('::', 4099);

    expect(address.listenUrl).toBe('http://[::]:4099');
    expect(address.localUrl).toBe('http://[::1]:4099');
  });

  test('specific listener host remains the access host', () => {
    expect(resolveLocalAccessHost('192.168.1.20')).toBe('192.168.1.20');
    expect(createServerAddressInfo('127.0.0.1', 4099).localUrl).toBe('http://127.0.0.1:4099');
  });
});
