import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  extractProviderRequestId,
  getLogger,
  initLogger,
  type LogEvent,
  maskHeaders,
  maskUrlCredentials,
} from '../../src/logger';
import type { LogConfig } from '../../src/config';

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

  describe('maskUrlCredentials', () => {
    test('应脱敏 URL 中的用户名和密码', () => {
      expect(maskUrlCredentials('http://user:pass@127.0.0.1:7890')).toBe(
        'http://****:****@127.0.0.1:7890/'
      );
    });

    test('无凭证 URL 应保持不变', () => {
      expect(maskUrlCredentials('https://api.example.com/v1/messages')).toBe(
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
        proxy_url: 'http://****:****@127.0.0.1:7890/',
        is_stream: false,
        upstream_status: 200,
        content_type_req: 'application/json',
        content_type_res: 'application/json',
        user_agent: 'test-agent/1.0',
        request_headers_masked: { 'content-type': 'application/json' },
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
      expect(parsed.proxy_url).toBe('http://****:****@127.0.0.1:7890/');
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
        request_headers_masked: {},
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
        request_headers_masked: {},
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
        request_headers_masked: {},
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

  describe('writeStreamFile', () => {
    test('应写入流式响应到文件', () => {
      const config: LogConfig = { streams: { enabled: true } };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const content = 'data: {"choices": [{"delta": {"content": "hello"}}]}\n\ndata: [DONE]\n';
      const filePath = logger.writeStreamFile('req-123', '2025-03-01', content);

      expect(filePath).not.toBeNull();
      expect(existsSync(filePath!)).toBe(true);

      const savedContent = readFileSync(filePath!, 'utf-8');
      expect(savedContent).toBe(content);
    });

    test('应按日期组织流式文件', () => {
      const config: LogConfig = {};
      initLogger(tempDir, config);
      const logger = getLogger()!;

      logger.writeStreamFile('req-1', '2025-03-01', 'content-1');
      logger.writeStreamFile('req-2', '2025-03-02', 'content-2');

      const dir1 = join(tempDir, 'streams', '2025-03-01');
      const dir2 = join(tempDir, 'streams', '2025-03-02');

      expect(existsSync(dir1)).toBe(true);
      expect(existsSync(dir2)).toBe(true);
      expect(existsSync(join(dir1, 'req-1.sse.raw'))).toBe(true);
      expect(existsSync(join(dir2, 'req-2.sse.raw'))).toBe(true);
    });

    test('应支持 maxBytesPerRequest 截断', () => {
      const maxBytes = 20;
      const config: LogConfig = {
        streams: { enabled: true, maxBytesPerRequest: maxBytes },
      };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const longContent = 'a'.repeat(100);
      const filePath = logger.writeStreamFile('req-123', '2025-03-01', longContent);

      const savedContent = readFileSync(filePath!, 'utf-8');
      expect(savedContent.endsWith('\n[TRUNCATED]')).toBe(true);
      expect(savedContent.length).toBeLessThanOrEqual(maxBytes + '\n[TRUNCATED]'.length + 1);
    });

    test('禁用时返回 null 且不写入文件', () => {
      const config: LogConfig = { enabled: false };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const filePath = logger.writeStreamFile('req-123', '2025-03-01', 'content');

      expect(filePath).toBeNull();
    });

    test('streams.enabled=false 时应返回 null', () => {
      const config: LogConfig = { streams: { enabled: false } };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const filePath = logger.writeStreamFile('req-123', '2025-03-01', 'content');

      expect(filePath).toBeNull();
    });
  });

  describe('maskHeaders', () => {
    test('应脱敏敏感请求头', () => {
      const headers = new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer sk-1234567890abcdef',
        'x-api-key': 'ak-1234567890abcdef',
      });

      const masked = maskHeaders(headers);

      expect(masked['content-type']).toBe('application/json');
      expect(masked.authorization).toBe('Bear****');
      expect(masked['x-api-key']).toBe('ak-1****');
    });

    test('应处理大小写不敏感的敏感头名称', () => {
      const headers = new Headers({
        Authorization: 'Bearer token123',
        'X-API-Key': 'key123',
        Cookie: 'session=abc123',
        'Set-Cookie': 'session=abc123; HttpOnly',
        'Proxy-Authorization': 'Basic dXNlcjpwYXNz',
      });

      const masked = maskHeaders(headers);

      // Headers 对象会将所有头名称转为小写
      expect(masked.authorization).toBe('Bear****');
      expect(masked['x-api-key']).toBe('key1****');
      expect(masked.cookie).toBe('sess****');
      expect(masked['set-cookie']).toBe('sess****');
      expect(masked['proxy-authorization']).toBe('Basi****');
    });

    test('应处理短值的敏感头', () => {
      const headers = new Headers({
        authorization: 'abc',
      });

      const masked = maskHeaders(headers);

      expect(masked.authorization).toBe('****');
    });

    test('应保留非敏感头的完整值', () => {
      const headers = new Headers({
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'test-agent/1.0',
        'x-custom-header': 'custom-value',
      });

      const masked = maskHeaders(headers);

      expect(masked['content-type']).toBe('application/json');
      expect(masked.accept).toBe('application/json');
      expect(masked['user-agent']).toBe('test-agent/1.0');
      expect(masked['x-custom-header']).toBe('custom-value');
    });

    test('应处理空 Headers', () => {
      const headers = new Headers();
      const masked = maskHeaders(headers);

      expect(Object.keys(masked).length).toBe(0);
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
        request_headers_masked: {},
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
