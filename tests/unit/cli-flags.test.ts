import { describe, expect, test } from 'bun:test';
import { parseSharedFlags } from '../../src/cli/process';

describe('CLI shared flags', () => {
  test('解析 config/host/port/idle-timeout', () => {
    const flags = parseSharedFlags([
      '--config',
      '/tmp/a.json5',
      '--host',
      '0.0.0.0',
      '--port',
      '5123',
      '--idle-timeout',
      '60',
    ]);
    expect(flags.config).toBe('/tmp/a.json5');
    expect(flags.host).toBe('0.0.0.0');
    expect(flags.port).toBe(5123);
    expect(flags.idleTimeoutSeconds).toBe(60);
  });

  test('端口非法时抛错', () => {
    expect(() => parseSharedFlags(['--port', 'abc'])).toThrow();
  });

  test('idle-timeout 非法时抛错', () => {
    expect(() => parseSharedFlags(['--idle-timeout', '-1'])).toThrow();
  });
});
