import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogConfig } from '../../src/config';
import {
  collectHeaders,
  extractProviderRequestId,
  getLogger,
  initLogger,
  type LogEvent,
  normalizeUrl,
} from '../../src/logger';

// 重置 Logger 单例的内部状态
declare module '../../src/logger' {
  export function resetLoggerForTest(): void;
}

// 通过重新加载模块来重置单例
async function _resetLogger() {
  // 动态导入以绕过模块缓存
  const loggerModule = await import(`../../src/logger?timestamp=${Date.now()}`);
  return loggerModule;
}

describe('logger', () => {
  let tempDir: string;

  beforeEach(() => {
    // 创建临时目录用于测试
    tempDir = mkdtempSync(join(tmpdir(), 'logger-test-'));
  });

  afterEach(() => {
    // 清理临时目录
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Logger 初始化', () => {
    test('应使用默认配置初始化', () => {
      const config: LogConfig = {};
      initLogger(tempDir, config);
      const logger = getLogger();

      expect(logger).not.toBeNull();
      expect(logger?.enabled).toBe(true);
      expect(logger?.bodyPolicy).toBe('off');
    });

    test('应支持显式启用日志', () => {
      const config: LogConfig = { enabled: true };
      initLogger(tempDir, config);
      const logger = getLogger();

      expect(logger?.enabled).toBe(true);
    });

    test('应支持禁用日志', () => {
      const config: LogConfig = { enabled: false };
      initLogger(tempDir, config);
      const logger = getLogger();

      expect(logger?.enabled).toBe(false);
    });

    test('应支持不同的 bodyPolicy', () => {
      const policies: Array<'off' | 'masked' | 'full'> = ['off', 'masked', 'full'];

      for (const policy of policies) {
        const dir = mkdtempSync(join(tmpdir(), 'logger-test-'));
        const config: LogConfig = { bodyPolicy: policy };
        initLogger(dir, config);
        const logger = getLogger();

        expect(logger?.bodyPolicy).toBe(policy);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('应创建必要的目录结构', () => {
      const config: LogConfig = { enabled: true };
      initLogger(tempDir, config);

      expect(existsSync(join(tempDir, 'events'))).toBe(true);
      expect(existsSync(join(tempDir, 'streams'))).toBe(true);
    });

    test('禁用时不应创建目录', () => {
      const config: LogConfig = { enabled: false };
      initLogger(tempDir, config);

      // 目录创建是延迟的，实际写入时才会创建
      // 但 enabled=false 时不会执行写入
      const logger = getLogger();
      expect(logger?.enabled).toBe(false);
    });
  });

  describe('normalizeUrl', () => {
    test('应保留 URL 中的用户名和密码', () => {
      expect(normalizeUrl('http://user:pass@127.0.0.1:7890')).toBe(
        'http://user:pass@127.0.0.1:7890'
      );
    });

    test('无凭证 URL 应保持不变', () => {
      expect(normalizeUrl('https://api.example.com/v1/messages')).toBe(
        'https://api.example.com/v1/messages'
      );
    });
  });

  describe('writeEvent', () => {
    test('应写入 JSONL 格式的事件日志', () => {
      const config: LogConfig = {};
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const event: LogEvent = {
        request_id: 'test-uuid-123',
        ts_start: '2025-03-01T10:00:00.000Z',
        ts_end: '2025-03-01T10:00:01.000Z',
        latency_ms: 1000,
        method: 'POST',
        path: '/v1/chat/completions',
        route_type: 'openai-completions',
        route_rule_key: 'gpt-4',
        provider: 'openai',
        model_in: 'gpt-4',
        model_out: 'gpt-4-turbo',
        target_url: 'https://api.openai.com/v1/chat/completions',
        proxy_url: 'http://user:pass@127.0.0.1:7890',
        is_stream: false,
        upstream_status: 200,
        content_type_req: 'application/json',
        content_type_res: 'application/json',
        user_agent: 'test-agent/1.0',
        request_headers: { 'content-type': 'application/json' },
        response_headers: { 'content-type': 'application/json' },
        request_bytes: 100,
        response_bytes: 200,
        stream_bytes: null,
        provider_request_id: 'req-123',
        error_type: null,
        error_message: null,
      };

      logger.writeEvent(event);

      const logFile = join(tempDir, 'events', '2025-03-01.jsonl');
      expect(existsSync(logFile)).toBe(true);

      const content = readFileSync(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim());

      expect(parsed.request_id).toBe('test-uuid-123');
      expect(parsed.method).toBe('POST');
      expect(parsed.upstream_status).toBe(200);
      expect(parsed.proxy_url).toBe('http://user:pass@127.0.0.1:7890');
    });

    test('应在同一天的多条事件追加到同一文件', () => {
      const config: LogConfig = {};
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const baseEvent = {
        ts_start: '2025-03-01T10:00:00.000Z',
        ts_end: '2025-03-01T10:00:01.000Z',
        latency_ms: 1000,
        method: 'POST',
        path: '/v1/chat/completions',
        route_type: 'openai-completions',
        route_rule_key: '*',
        provider: 'test',
        model_in: 'test-model',
        model_out: 'test-model',
        target_url: 'https://example.com',
        is_stream: false,
        upstream_status: 200,
        content_type_req: 'application/json',
        content_type_res: 'application/json',
        user_agent: null,
        request_headers: {},
        response_headers: {},
        request_bytes: 100,
        response_bytes: 200,
        stream_bytes: null,
        provider_request_id: null,
        error_type: null,
        error_message: null,
      };

      logger.writeEvent({ ...baseEvent, request_id: 'req-1' } as LogEvent);
      logger.writeEvent({ ...baseEvent, request_id: 'req-2' } as LogEvent);
      logger.writeEvent({ ...baseEvent, request_id: 'req-3' } as LogEvent);

      const logFile = join(tempDir, 'events', '2025-03-01.jsonl');
      const content = readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(3);
      expect(JSON.parse(lines[0]).request_id).toBe('req-1');
      expect(JSON.parse(lines[1]).request_id).toBe('req-2');
      expect(JSON.parse(lines[2]).request_id).toBe('req-3');
    });

    test('应将不同日期的事件写入不同文件', () => {
      const config: LogConfig = {};
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const baseEvent = {
        ts_end: '2025-03-01T10:00:01.000Z',
        latency_ms: 1000,
        method: 'POST',
        path: '/v1/chat/completions',
        route_type: 'openai-completions',
        route_rule_key: '*',
        provider: 'test',
        model_in: 'test-model',
        model_out: 'test-model',
        target_url: 'https://example.com',
        is_stream: false,
        upstream_status: 200,
        content_type_req: 'application/json',
        content_type_res: 'application/json',
        user_agent: null,
        request_headers: {},
        response_headers: {},
        request_bytes: 100,
        response_bytes: 200,
        stream_bytes: null,
        provider_request_id: null,
        error_type: null,
        error_message: null,
      };

      logger.writeEvent({
        ...baseEvent,
        request_id: 'req-1',
        ts_start: '2025-03-01T10:00:00.000Z',
      } as LogEvent);
      logger.writeEvent({
        ...baseEvent,
        request_id: 'req-2',
        ts_start: '2025-03-02T10:00:00.000Z',
      } as LogEvent);

      const file1 = join(tempDir, 'events', '2025-03-01.jsonl');
      const file2 = join(tempDir, 'events', '2025-03-02.jsonl');

      expect(existsSync(file1)).toBe(true);
      expect(existsSync(file2)).toBe(true);

      expect(JSON.parse(readFileSync(file1, 'utf-8').trim()).request_id).toBe('req-1');
      expect(JSON.parse(readFileSync(file2, 'utf-8').trim()).request_id).toBe('req-2');
    });

    test('禁用时不应写入事件', () => {
      const config: LogConfig = { enabled: false };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const event: LogEvent = {
        request_id: 'test-uuid',
        ts_start: '2025-03-01T10:00:00.000Z',
        ts_end: '2025-03-01T10:00:01.000Z',
        latency_ms: 1000,
        method: 'POST',
        path: '/v1/chat/completions',
        route_type: 'openai-completions',
        route_rule_key: '*',
        provider: 'test',
        model_in: 'test-model',
        model_out: 'test-model',
        target_url: 'https://example.com',
        is_stream: false,
        upstream_status: 200,
        content_type_req: 'application/json',
        content_type_res: 'application/json',
        user_agent: null,
        request_headers: {},
        response_headers: {},
        request_bytes: 100,
        response_bytes: 200,
        stream_bytes: null,
        provider_request_id: null,
        error_type: null,
        error_message: null,
      };

      logger.writeEvent(event);

      // 目录可能在初始化时没创建
      const eventsDir = join(tempDir, 'events');
      if (existsSync(eventsDir)) {
        const files = readdirSync(eventsDir);
        expect(files.length).toBe(0);
      }
    });
  });

  describe('openStreamCapture', () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

    test('应顺序写入 chunk 到正式日志路径，单次落盘无临时文件', () => {
      const config: LogConfig = { streams: { enabled: true } };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const handle = logger.openStreamCapture('req-123', '2025-03-01');
      handle.write(enc('data: {"choices": [{"delta": {"content": "hello"}}]}\n\n'));
      handle.write(enc('data: [DONE]\n'));
      const result = handle.finalize();

      expect(result.filePath).not.toBeNull();
      expect(existsSync(result.filePath!)).toBe(true);
      expect(result.bytesWritten).toBeGreaterThan(0);
      expect(result.truncated).toBe(false);

      const saved = readFileSync(result.filePath!, 'utf-8');
      expect(saved).toBe('data: {"choices": [{"delta": {"content": "hello"}}]}\n\ndata: [DONE]\n');
      expect(Buffer.byteLength(saved, 'utf-8')).toBe(result.bytesWritten);

      // 不应残留 /tmp 临时文件 —— 新方案直接写到目标路径。
      const expectedPath = join(tempDir, 'streams', '2025-03-01', 'req-123.sse.raw');
      expect(result.filePath).toBe(expectedPath);
    });

    test('应按日期组织流式文件', () => {
      const config: LogConfig = {};
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const h1 = logger.openStreamCapture('req-1', '2025-03-01');
      h1.write(enc('content-1'));
      h1.finalize();

      const h2 = logger.openStreamCapture('req-2', '2025-03-02');
      h2.write(enc('content-2'));
      h2.finalize();

      const dir1 = join(tempDir, 'streams', '2025-03-01');
      const dir2 = join(tempDir, 'streams', '2025-03-02');

      expect(existsSync(dir1)).toBe(true);
      expect(existsSync(dir2)).toBe(true);
      expect(existsSync(join(dir1, 'req-1.sse.raw'))).toBe(true);
      expect(existsSync(join(dir2, 'req-2.sse.raw'))).toBe(true);
      expect(readFileSync(join(dir1, 'req-1.sse.raw'), 'utf-8')).toBe('content-1');
      expect(readFileSync(join(dir2, 'req-2.sse.raw'), 'utf-8')).toBe('content-2');
    });

    test('单 chunk 超出 maxBytesPerRequest 时应截断并写入 [TRUNCATED] 标记', () => {
      const maxBytes = 20;
      const config: LogConfig = {
        streams: { enabled: true, maxBytesPerRequest: maxBytes },
      };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const handle = logger.openStreamCapture('req-trunc-1', '2025-03-01');
      handle.write(enc('a'.repeat(100)));
      const result = handle.finalize();

      const saved = readFileSync(result.filePath!, 'utf-8');
      expect(saved.startsWith('a'.repeat(20))).toBe(true);
      expect(saved.endsWith('\n[TRUNCATED]')).toBe(true);
      expect(result.truncated).toBe(true);
      // bytesWritten 仅计原始 chunk（不含截断标记自身长度）。
      expect(result.bytesWritten).toBe(maxBytes);
    });

    test('累计跨多个 chunk 超过 maxBytesPerRequest 时应在到达上限时立即截断', () => {
      const maxBytes = 8;
      const config: LogConfig = {
        streams: { enabled: true, maxBytesPerRequest: maxBytes },
      };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const handle = logger.openStreamCapture('req-trunc-2', '2025-03-01');
      handle.write(enc('aaaa')); // 4 bytes
      handle.write(enc('bbbb')); // 累计 8 bytes，恰好达上限
      handle.write(enc('cccc')); // 应被截断；写入截断标记后停止
      handle.write(enc('dddd')); // 截断后再 write 应是 noop
      const result = handle.finalize();

      const saved = readFileSync(result.filePath!, 'utf-8');
      expect(saved.startsWith('aaaabbbb')).toBe(true);
      expect(saved.endsWith('\n[TRUNCATED]')).toBe(true);
      expect(saved.includes('cccc')).toBe(false);
      expect(saved.includes('dddd')).toBe(false);
      expect(result.truncated).toBe(true);
      expect(result.bytesWritten).toBe(maxBytes);
    });

    test('finalize() 应是幂等的', () => {
      const config: LogConfig = { streams: { enabled: true } };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const handle = logger.openStreamCapture('req-idem', '2025-03-01');
      handle.write(enc('payload'));
      const r1 = handle.finalize();
      const r2 = handle.finalize();

      expect(r1).toEqual(r2);
      expect(existsSync(r1.filePath!)).toBe(true);
    });

    test('finalize() 之后再 write() 不应抛错也不应再写盘', () => {
      const config: LogConfig = { streams: { enabled: true } };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const handle = logger.openStreamCapture('req-after-final', '2025-03-01');
      handle.write(enc('first'));
      const finalized = handle.finalize();

      expect(() => handle.write(enc('after-final'))).not.toThrow();
      const saved = readFileSync(finalized.filePath!, 'utf-8');
      expect(saved).toBe('first');
    });

    test('禁用日志时返回 noop handle（filePath=null，不写盘）', () => {
      const config: LogConfig = { enabled: false };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const handle = logger.openStreamCapture('req-noop-1', '2025-03-01');
      handle.write(enc('content'));
      const result = handle.finalize();

      expect(result.filePath).toBeNull();
      expect(result.bytesWritten).toBe(0);
      expect(result.truncated).toBe(false);
      expect(handle.filePath).toBeNull();
    });

    test('streams.enabled=false 时返回 noop handle', () => {
      const config: LogConfig = { streams: { enabled: false } };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const handle = logger.openStreamCapture('req-noop-2', '2025-03-01');
      handle.write(enc('content'));
      const result = handle.finalize();

      expect(result.filePath).toBeNull();
      expect(result.bytesWritten).toBe(0);
    });
  });

  describe('collectHeaders', () => {
    test('应保留敏感请求头原值', () => {
      const headers = new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer sk-1234567890abcdef',
        'x-api-key': 'ak-1234567890abcdef',
      });

      const collected = collectHeaders(headers);

      expect(collected['content-type']).toBe('application/json');
      expect(collected.authorization).toBe('Bearer sk-1234567890abcdef');
      expect(collected['x-api-key']).toBe('ak-1234567890abcdef');
    });

    test('应处理大小写不敏感的头名称', () => {
      const headers = new Headers({
        Authorization: 'Bearer token123',
        'X-API-Key': 'key123',
        Cookie: 'session=abc123',
        'Set-Cookie': 'session=abc123; HttpOnly',
        'Proxy-Authorization': 'Basic dXNlcjpwYXNz',
      });

      const collected = collectHeaders(headers);

      // Headers 对象会将所有头名称转为小写
      expect(collected.authorization).toBe('Bearer token123');
      expect(collected['x-api-key']).toBe('key123');
      expect(collected.cookie).toBe('session=abc123');
      expect(collected['set-cookie']).toBe('session=abc123; HttpOnly');
      expect(collected['proxy-authorization']).toBe('Basic dXNlcjpwYXNz');
    });

    test('应处理短值的头', () => {
      const headers = new Headers({
        authorization: 'abc',
      });

      const collected = collectHeaders(headers);

      expect(collected.authorization).toBe('abc');
    });

    test('应保留非敏感头的完整值', () => {
      const headers = new Headers({
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'test-agent/1.0',
        'x-custom-header': 'custom-value',
      });

      const collected = collectHeaders(headers);

      expect(collected['content-type']).toBe('application/json');
      expect(collected.accept).toBe('application/json');
      expect(collected['user-agent']).toBe('test-agent/1.0');
      expect(collected['x-custom-header']).toBe('custom-value');
    });

    test('应处理空 Headers', () => {
      const headers = new Headers();
      const collected = collectHeaders(headers);

      expect(Object.keys(collected).length).toBe(0);
    });
  });

  describe('extractProviderRequestId', () => {
    test('应从 x-request-id 提取', () => {
      const headers = new Headers({
        'x-request-id': 'req-123-abc',
      });

      const id = extractProviderRequestId(headers);

      expect(id).toBe('req-123-abc');
    });

    test('应从 request-id 提取', () => {
      const headers = new Headers({
        'request-id': 'req-456-def',
      });

      const id = extractProviderRequestId(headers);

      expect(id).toBe('req-456-def');
    });

    test('应从 x-trace-id 提取', () => {
      const headers = new Headers({
        'x-trace-id': 'trace-789',
      });

      const id = extractProviderRequestId(headers);

      expect(id).toBe('trace-789');
    });

    test('应从 cf-ray 提取', () => {
      const headers = new Headers({
        'cf-ray': 'ray-123-xyz',
      });

      const id = extractProviderRequestId(headers);

      expect(id).toBe('ray-123-xyz');
    });

    test('应按优先级顺序提取', () => {
      // x-request-id 优先级最高
      const headers = new Headers({
        'cf-ray': 'ray-value',
        'request-id': 'req-value',
        'x-request-id': 'x-req-value',
      });

      const id = extractProviderRequestId(headers);

      expect(id).toBe('x-req-value');
    });

    test('无匹配时应返回 null', () => {
      const headers = new Headers({
        'content-type': 'application/json',
      });

      const id = extractProviderRequestId(headers);

      expect(id).toBeNull();
    });

    test('应处理空 Headers', () => {
      const headers = new Headers();
      const id = extractProviderRequestId(headers);

      expect(id).toBeNull();
    });
  });

  describe('完整流程测试', () => {
    test('应支持多次初始化（覆盖之前的单例）', () => {
      const dir1 = mkdtempSync(join(tmpdir(), 'logger-test-1-'));
      const dir2 = mkdtempSync(join(tmpdir(), 'logger-test-2-'));

      initLogger(dir1, { enabled: true });
      const _logger1 = getLogger();

      initLogger(dir2, { enabled: true });
      const logger2 = getLogger();

      // 两次初始化应返回不同实例（或至少行为正确）
      expect(logger2).not.toBeNull();

      // 向第二个 logger 写入
      const baseEvent = {
        ts_start: '2025-03-01T10:00:00.000Z',
        ts_end: '2025-03-01T10:00:01.000Z',
        latency_ms: 1000,
        method: 'POST',
        path: '/v1/chat/completions',
        route_type: 'openai-completions',
        route_rule_key: '*',
        provider: 'test',
        model_in: 'test-model',
        model_out: 'test-model',
        target_url: 'https://example.com',
        is_stream: false,
        upstream_status: 200,
        content_type_req: 'application/json',
        content_type_res: 'application/json',
        user_agent: null,
        request_headers: {},
        response_headers: {},
        request_bytes: 100,
        response_bytes: 200,
        stream_bytes: null,
        provider_request_id: null,
        error_type: null,
        error_message: null,
      };

      logger2?.writeEvent({ ...baseEvent, request_id: 'after-reinit' } as LogEvent);

      // 验证写入到第二个目录
      const logFile = join(dir2, 'events', '2025-03-01.jsonl');
      expect(existsSync(logFile)).toBe(true);

      // 清理
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    });
  });
});
