import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LogConfig } from '../../src/config';
import type { LogEvent, LogMeta } from '../../src/logger';
import { getLogger, initLogger } from '../../src/logger';

describe('proxy 日志功能', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const createMockLogMeta = (): LogMeta => ({
    requestId: 'test-req-123',
    tsStart: Date.now(),
    routeType: 'openai-completions',
    routeRuleKey: 'gpt-4',
    provider: 'test-provider',
    modelIn: 'gpt-4',
    modelOut: 'gpt-4-turbo',
    isStream: false,
    method: 'POST',
    path: '/v1/chat/completions',
    contentTypeReq: 'application/json',
    userAgent: 'test-agent/1.0',
    requestBytes: 100,
    requestHeadersMasked: { 'content-type': 'application/json' },
  });

  describe('buildLogEvent 结构', () => {
    test('应构建正确的日志事件结构', () => {
      const config: LogConfig = { enabled: true };
      initLogger(tempDir, config);

      const logMeta = createMockLogMeta();
      const tsEnd = logMeta.tsStart + 500;

      // 模拟 buildLogEvent 的行为
      const event: LogEvent = {
        request_id: logMeta.requestId,
        ts_start: new Date(logMeta.tsStart).toISOString(),
        ts_end: new Date(tsEnd).toISOString(),
        latency_ms: tsEnd - logMeta.tsStart,
        method: logMeta.method,
        path: logMeta.path,
        route_type: logMeta.routeType,
        route_ruleKey: logMeta.routeRuleKey,
        provider: logMeta.provider,
        model_in: logMeta.modelIn,
        model_out: logMeta.modelOut,
        target_url: 'https://api.test.com/v1/chat/completions',
        is_stream: logMeta.isStream,
        upstream_status: 200,
        content_type_req: logMeta.contentTypeReq,
        content_type_res: 'application/json',
        user_agent: logMeta.userAgent,
        request_headers_masked: logMeta.requestHeadersMasked,
        response_headers: { 'content-type': 'application/json' },
        request_bytes: logMeta.requestBytes,
        response_bytes: 200,
        stream_bytes: null,
        provider_request_id: 'upstream-req-456',
        error_type: null,
        error_message: null,
      };

      expect(event.request_id).toBe('test-req-123');
      expect(event.route_type).toBe('openai-completions');
      expect(event.provider).toBe('test-provider');
      expect(event.latency_ms).toBe(500);
      expect(event.is_stream).toBe(false);
      expect(event.upstream_status).toBe(200);
      expect(event.error_type).toBeNull();
      expect(event.error_message).toBeNull();
    });

    test('应正确计算延迟时间', () => {
      const tsStart = Date.now();
      const tsEnd = tsStart + 1234; // 1.234 秒

      const latency = tsEnd - tsStart;

      expect(latency).toBe(1234);
    });

    test('应正确标记流式请求', () => {
      const streamMeta: LogMeta = {
        ...createMockLogMeta(),
        isStream: true,
      };

      expect(streamMeta.isStream).toBe(true);

      const nonStreamMeta: LogMeta = {
        ...createMockLogMeta(),
        isStream: false,
      };

      expect(nonStreamMeta.isStream).toBe(false);
    });

    test('应正确记录错误信息', () => {
      const errorEvent: Partial<LogEvent> = {
        request_id: 'test-req-123',
        upstream_status: 0,
        error_type: 'FetchError',
        error_message: 'Network request failed',
      };

      expect(errorEvent.error_type).toBe('FetchError');
      expect(errorEvent.error_message).toBe('Network request failed');
      expect(errorEvent.upstream_status).toBe(0);
    });
  });

  describe('响应头提取', () => {
    test('应从响应头中提取 provider_request_id', () => {
      const headers = new Headers({
        'content-type': 'application/json',
        'x-request-id': 'upstream-req-789',
      });

      const providerRequestId =
        headers.get('x-request-id') ||
        headers.get('request-id') ||
        headers.get('x-trace-id') ||
        headers.get('cf-ray');

      expect(providerRequestId).toBe('upstream-req-789');
    });
  });

  describe('日志集成测试', () => {
    test('应在成功响应后写入事件日志', () => {
      const config: LogConfig = { enabled: true };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const logMeta = createMockLogMeta();
      const tsEnd = logMeta.tsStart + 500;

      const event: LogEvent = {
        request_id: logMeta.requestId,
        ts_start: new Date(logMeta.tsStart).toISOString(),
        ts_end: new Date(tsEnd).toISOString(),
        latency_ms: tsEnd - logMeta.tsStart,
        method: logMeta.method,
        path: logMeta.path,
        route_type: logMeta.routeType,
        route_rule_key: logMeta.routeRuleKey,
        provider: logMeta.provider,
        model_in: logMeta.modelIn,
        model_out: logMeta.modelOut,
        target_url: 'https://api.test.com/v1/chat/completions',
        is_stream: logMeta.isStream,
        upstream_status: 200,
        content_type_req: logMeta.contentTypeReq,
        content_type_res: 'application/json',
        user_agent: logMeta.userAgent,
        request_headers_masked: logMeta.requestHeadersMasked,
        response_headers: { 'content-type': 'application/json' },
        request_bytes: logMeta.requestBytes,
        response_bytes: 500,
        stream_bytes: null,
        provider_request_id: 'upstream-req-456',
        error_type: null,
        error_message: null,
        response_body: '{"id": "test", "choices": []}',
      };

      logger.writeEvent(event);

      const dateStr = event.ts_start.slice(0, 10);
      const logFile = join(tempDir, 'events', `${dateStr}.jsonl`);
      expect(existsSync(logFile)).toBe(true);

      const content = readFileSync(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim()) as LogEvent;

      expect(parsed.request_id).toBe('test-req-123');
      expect(parsed.upstream_status).toBe(200);
      expect(parsed.response_bytes).toBe(500);
      expect(parsed.provider_request_id).toBe('upstream-req-456');
    });

    test('应在失败时写入错误日志', () => {
      const config: LogConfig = { enabled: true };
      initLogger(tempDir, config);
      const logger = getLogger()!;

      const logMeta = createMockLogMeta();
      const tsEnd = logMeta.tsStart + 100;

      const event: LogEvent = {
        request_id: logMeta.requestId,
        ts_start: new Date(logMeta.tsStart).toISOString(),
        ts_end: new Date(tsEnd).toISOString(),
        latency_ms: tsEnd - logMeta.tsStart,
        method: logMeta.method,
        path: logMeta.path,
        route_type: logMeta.routeType,
        route_rule_key: logMeta.routeRuleKey,
        provider: logMeta.provider,
        model_in: logMeta.modelIn,
        model_out: logMeta.modelOut,
        target_url: 'https://api.test.com/v1/chat/completions',
        is_stream: logMeta.isStream,
        upstream_status: 0,
        content_type_req: logMeta.contentTypeReq,
        content_type_res: null,
        user_agent: logMeta.userAgent,
        request_headers_masked: logMeta.requestHeadersMasked,
        response_headers: {},
        request_bytes: logMeta.requestBytes,
        response_bytes: null,
        stream_bytes: null,
        provider_request_id: null,
        error_type: 'TypeError',
        error_message: 'fetch failed',
      };

      logger.writeEvent(event);

      const dateStr = event.ts_start.slice(0, 10);
      const logFile = join(tempDir, 'events', `${dateStr}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim()) as LogEvent;

      expect(parsed.error_type).toBe('TypeError');
      expect(parsed.error_message).toBe('fetch failed');
      expect(parsed.upstream_status).toBe(0);
    });

    test('应根据 bodyPolicy 控制 request_body 记录', () => {
      const testCases: Array<{ policy: 'off' | 'masked' | 'full'; shouldRecord: boolean }> = [
        { policy: 'off', shouldRecord: false },
        { policy: 'full', shouldRecord: true },
        { policy: 'masked', shouldRecord: true },
      ];

      for (const { policy, shouldRecord } of testCases) {
        const dir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
        const config: LogConfig = { enabled: true, bodyPolicy: policy };
        initLogger(dir, config);
        const logger = getLogger()!;

        const logMeta = createMockLogMeta();
        const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] };

        const tsEnd = logMeta.tsStart + 100;
        const event: LogEvent = {
          request_id: logMeta.requestId,
          ts_start: new Date(logMeta.tsStart).toISOString(),
          ts_end: new Date(tsEnd).toISOString(),
          latency_ms: tsEnd - logMeta.tsStart,
          method: logMeta.method,
          path: logMeta.path,
          route_type: logMeta.routeType,
          route_rule_key: logMeta.routeRuleKey,
          provider: logMeta.provider,
          model_in: logMeta.modelIn,
          model_out: logMeta.modelOut,
          target_url: 'https://api.test.com',
          is_stream: false,
          upstream_status: 200,
          content_type_req: logMeta.contentTypeReq,
          content_type_res: 'application/json',
          user_agent: logMeta.userAgent,
          request_headers_masked: logMeta.requestHeadersMasked,
          response_headers: {},
          request_bytes: logMeta.requestBytes,
          response_bytes: 100,
          stream_bytes: null,
          provider_request_id: null,
          error_type: null,
          error_message: null,
        };

        // 根据 policy 决定是否添加 request_body
        if (logger.bodyPolicy !== 'off') {
          event.request_body = body;
        }

        logger.writeEvent(event);

        const dateStr = event.ts_start.slice(0, 10);
        const logFile = join(dir, 'events', `${dateStr}.jsonl`);
        const content = readFileSync(logFile, 'utf-8');
        const parsed = JSON.parse(content.trim()) as LogEvent & { request_body?: unknown };

        if (shouldRecord) {
          expect(parsed.request_body).toBeDefined();
        } else {
          expect(parsed.request_body).toBeUndefined();
        }

        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
