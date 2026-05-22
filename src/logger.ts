import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LogConfig } from './config';
import {
  disposeLogIndex,
  encodeOffsetLogEventId,
  enqueueLogEventForIndex,
  initLogIndex,
} from './log-index';
import { publishLogEvent } from './log-tail';
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
  /** 流式日志实际落盘字节数；省略时表示未落盘或全部以 stream_bytes 字段表达。 */
  stream_file_bytes?: number;
  /** 流式日志因 maxBytesPerRequest 上限被截断时为 true。 */
  stream_file_truncated?: boolean;
  // 插件相关日志字段
  plugins_request?: PluginPhaseLog[];
  request_body_after_plugins?: unknown;
  request_url_after_plugins?: string;
  plugins_response?: PluginPhaseLog[];
  response_body_before_plugins?: string;
  response_body_after_plugins?: string;
}

/**
 * 流式日志旁路落盘句柄。
 *
 * 由 Logger.openStreamCapture 创建，调用方在每个 chunk 上调用 write()，
 * 流结束（或异常关闭）时调用 finalize() 一次。两者都是幂等的。
 */
export interface StreamCaptureHandle {
  /** 实际落盘文件路径；当流日志被禁用时为 null。 */
  filePath: string | null;
  /** 同步追加一段字节到流日志文件；超过 maxBytesPerRequest 后自动写入 [TRUNCATED] 标记并停止落盘。 */
  write(chunk: Uint8Array): void;
  /** 关闭文件、返回累计落盘字节数与截断状态。允许多次调用（幂等）。 */
  finalize(): { bytesWritten: number; truncated: boolean; filePath: string | null };
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
      const offset = existsSync(filePath) ? statSync(filePath).size : 0;
      const line = `${JSON.stringify(event)}\n`;
      appendFileSync(filePath, line);
      const id = encodeOffsetLogEventId(dateStr, offset);
      enqueueLogEventForIndex({
        baseDir: this.baseDir,
        filePath,
        date: dateStr,
        offset,
        byteLength: Buffer.byteLength(line),
        event,
      });
      publishLogEvent({ id, date: dateStr, filePath, offset, event });
    } catch (err) {
      console.error('[logger] 事件日志写入失败:', err);
    }
  }

  /**
   * 打开一个流式日志旁路落盘句柄。
   *
   * 返回的 handle 在每次 chunk 到达时被同步追加到正式日志路径，避免临时文件 +
   * 全量回读的内存放大。当 logger 或 streams 被禁用时返回一个 noop handle。
   */
  openStreamCapture(requestId: string, dateStr: string): StreamCaptureHandle {
    if (!this._enabled || !this._streamsEnabled) {
      return makeNoopStreamCaptureHandle();
    }

    const maxStreamBytes = this.maxStreamBytes;
    const truncationMarker = Buffer.from('\n[TRUNCATED]');

    let filePath: string | null;
    let fd: number | null;
    try {
      const dir = this.ensureStreamDateDir(dateStr);
      filePath = join(dir, `${requestId}.sse.raw`);
      fd = openSync(filePath, 'a');
    } catch (err) {
      console.error('[logger] 流式日志打开失败:', err);
      return makeNoopStreamCaptureHandle();
    }

    let bytes = 0;
    let truncated = false;
    let finalized = false;

    return {
      filePath,
      write(chunk: Uint8Array): void {
        if (finalized || truncated || fd == null) return;
        try {
          if (bytes + chunk.byteLength > maxStreamBytes) {
            const remaining = Math.max(0, maxStreamBytes - bytes);
            if (remaining > 0) {
              writeSync(fd, chunk.subarray(0, remaining));
              bytes += remaining;
            }
            writeSync(fd, truncationMarker);
            truncated = true;
            return;
          }
          writeSync(fd, chunk);
          bytes += chunk.byteLength;
        } catch (err) {
          console.error('[logger] 流式日志写入失败:', err);
          // 单 chunk 写入失败不应中断整个流；将状态置为已截断，避免后续 chunk 继续重试。
          truncated = true;
        }
      },
      finalize() {
        if (finalized) return { bytesWritten: bytes, truncated, filePath };
        finalized = true;
        if (fd != null) {
          try {
            closeSync(fd);
          } catch {
            // 重复关闭或已被外部关闭时静默忽略。
          }
          fd = null;
        }
        return { bytesWritten: bytes, truncated, filePath };
      },
    };
  }
}

function makeNoopStreamCaptureHandle(): StreamCaptureHandle {
  return {
    filePath: null,
    write(): void {
      // no-op
    },
    finalize(): { bytesWritten: number; truncated: boolean; filePath: string | null } {
      return { bytesWritten: 0, truncated: false, filePath: null };
    },
  };
}

let instance: Logger | null = null;

export function initLogger(baseDir: string, config: LogConfig): void {
  instance = new Logger(baseDir, config);
  initLogIndex(baseDir, config);
  if (instance.enabled) {
    console.log(`[logger] 日志系统已初始化: ${baseDir}`);
  }
}

export function getLogger(): Logger | null {
  return instance;
}

export function resetLogger(): void {
  instance = null;
  disposeLogIndex();
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
