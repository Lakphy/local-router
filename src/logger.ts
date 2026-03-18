import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogConfig } from './config';
import type { PluginPhaseLog } from './plugin';

export interface LogEvent {
  request_id: string;
  ts_start: string;
  ts_end: string;
  latency_ms: number;
  method: string;
  path: string;
  route_type: string;
  route_rule_key: string;
  provider: string;
  model_in: string;
  model_out: string;
  target_url: string;
  proxy_url?: string | null;
  is_stream: boolean;
  upstream_status: number;
  content_type_req: string | null;
  content_type_res: string | null;
  user_agent: string | null;
  request_headers: Record<string, string>;
  response_headers: Record<string, string>;
  request_bytes: number;
  response_bytes: number | null;
  stream_bytes: number | null;
  provider_request_id: string | null;
  error_type: string | null;
  error_message: string | null;
  request_body?: unknown;
  response_body?: string;
  stream_file?: string;
  // 插件相关日志字段
  plugins_request?: PluginPhaseLog[];
  request_body_after_plugins?: unknown;
  request_url_after_plugins?: string;
  plugins_response?: PluginPhaseLog[];
  response_body_before_plugins?: string;
  response_body_after_plugins?: string;
}

export interface LogMeta {
  requestId: string;
  tsStart: number;
  routeType: string;
  routeRuleKey: string;
  provider: string;
  modelIn: string;
  modelOut: string;
  isStream: boolean;
  method: string;
  path: string;
  contentTypeReq: string | null;
  userAgent: string | null;
  requestBytes: number;
  requestHeaders: Record<string, string>;
}

class Logger {
  private eventsDir: string;
  private streamsDir: string;
  private _enabled: boolean;
  private _bodyPolicy: 'off' | 'masked' | 'full';
  private _streamsEnabled: boolean;
  private maxStreamBytes: number;

  constructor(
    private baseDir: string,
    config: LogConfig
  ) {
    this._enabled = config.enabled !== false;
    this._bodyPolicy = config.bodyPolicy ?? 'off';
    this._streamsEnabled = config.streams?.enabled !== false;
    this.maxStreamBytes = config.streams?.maxBytesPerRequest ?? 10 * 1024 * 1024;
    this.eventsDir = join(baseDir, 'events');
    this.streamsDir = join(baseDir, 'streams');
    if (this._enabled) this.ensureDirs();
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get bodyPolicy(): 'off' | 'masked' | 'full' {
    return this._bodyPolicy;
  }

  private ensureDirs(): void {
    for (const dir of [this.baseDir, this.eventsDir, this.streamsDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  private ensureStreamDateDir(dateStr: string): string {
    const dir = join(this.streamsDir, dateStr);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeEvent(event: LogEvent): void {
    if (!this._enabled) return;
    try {
      // 目录可能在测试或外部清理后被删除，这里做一次自愈。
      this.ensureDirs();
      const dateStr = event.ts_start.slice(0, 10);
      const filePath = join(this.eventsDir, `${dateStr}.jsonl`);
      appendFileSync(filePath, `${JSON.stringify(event)}\n`);
    } catch (err) {
      console.error('[logger] 事件日志写入失败:', err);
    }
  }

  writeStreamFile(requestId: string, dateStr: string, content: string): string | null {
    if (!this._enabled || !this._streamsEnabled) return null;
    try {
      const dir = this.ensureStreamDateDir(dateStr);
      const filePath = join(dir, `${requestId}.sse.raw`);
      const toWrite =
        content.length > this.maxStreamBytes
          ? `${content.slice(0, this.maxStreamBytes)}\n[TRUNCATED]`
          : content;
      writeFileSync(filePath, toWrite);
      return filePath;
    } catch (err) {
      console.error('[logger] 流式日志写入失败:', err);
      return null;
    }
  }
}

let instance: Logger | null = null;

export function initLogger(baseDir: string, config: LogConfig): void {
  instance = new Logger(baseDir, config);
  if (instance.enabled) {
    console.log(`[logger] 日志系统已初始化: ${baseDir}`);
  }
}

export function getLogger(): Logger | null {
  return instance;
}

export function resetLogger(): void {
  instance = null;
}

export function collectHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export function extractProviderRequestId(headers: Headers): string | null {
  for (const name of ['x-request-id', 'request-id', 'x-trace-id', 'cf-ray']) {
    const val = headers.get(name);
    if (val) return val;
  }
  return null;
}

export function normalizeUrl(rawUrl: string): string {
  return rawUrl;
}
