import { type CliError, isCliError } from './errors';
import { DEFAULT_FLAGS, type GlobalFlags } from './global-flags';
import {
  type JsonErrorEnvelope,
  type JsonResultEnvelope,
  renderJsonError,
  renderJsonResult,
  SCHEMA_VERSION,
} from './render-json';
import { type MdSection, renderMd } from './render-md';

export interface ResultPayload<T = unknown> {
  command: string;
  data: T;
  meta?: Record<string, unknown>;
  warnings?: string[];
  /** Markdown rendering (used when format=markdown). */
  md?: MdSection;
  /** Plain text rendering for --output text. Falls back to compact JSON if missing. */
  text?: string;
}

export interface OutputContext {
  flags: GlobalFlags;
  startedAt: number;
}

export function createOutputContext(flags: GlobalFlags = DEFAULT_FLAGS): OutputContext {
  return { flags, startedAt: Date.now() };
}

function writeStdout(line: string): void {
  if (!line.endsWith('\n')) {
    process.stdout.write(`${line}\n`);
  } else {
    process.stdout.write(line);
  }
}

export function emitResult<T>(ctx: OutputContext, payload: ResultPayload<T>): void {
  const elapsedMs = Date.now() - ctx.startedAt;
  const meta = { elapsedMs, ...(payload.meta ?? {}) };
  const fmt = ctx.flags.output;

  if (fmt === 'json') {
    const env: JsonResultEnvelope<T> = {
      ok: true,
      command: payload.command,
      schema_version: SCHEMA_VERSION,
      data: payload.data,
      meta,
    };
    if (payload.warnings && payload.warnings.length > 0) env.warnings = payload.warnings;
    writeStdout(renderJsonResult(env));
    return;
  }
  if (fmt === 'ndjson') {
    writeStdout(
      JSON.stringify({
        type: 'result',
        ok: true,
        command: payload.command,
        schema_version: SCHEMA_VERSION,
        data: payload.data,
        meta,
      })
    );
    return;
  }
  if (fmt === 'text') {
    if (payload.text !== undefined) {
      const out = payload.text.endsWith('\n') ? payload.text : `${payload.text}\n`;
      process.stdout.write(out);
      return;
    }
    writeStdout(JSON.stringify(payload.data));
    return;
  }
  if (payload.md) {
    process.stdout.write(renderMd(payload.md));
    return;
  }
  process.stdout.write(
    `## ${payload.command}\n\n\`\`\`json\n${JSON.stringify(payload.data, null, 2)}\n\`\`\`\n`
  );
}

export function emitError(ctx: OutputContext | null, command: string, err: unknown): number {
  const fmt = ctx?.flags.output ?? 'markdown';
  let code = 'UNKNOWN_ERROR';
  let message = err instanceof Error ? err.message : String(err);
  let hint: string | undefined;
  let doc: string | undefined;
  let details: unknown;
  let exitCode = 1;
  if (isCliError(err)) {
    const cliErr: CliError = err;
    code = cliErr.code;
    hint = cliErr.hint;
    doc = cliErr.doc;
    details = cliErr.details;
    exitCode = cliErr.exitCode;
    message = cliErr.message;
  }

  if (fmt === 'json') {
    const env: JsonErrorEnvelope = {
      ok: false,
      command,
      schema_version: SCHEMA_VERSION,
      error: { code, message, hint, doc, details },
      exit_code: exitCode,
    };
    writeStdout(renderJsonError(env));
    return exitCode;
  }
  if (fmt === 'ndjson') {
    writeStdout(
      JSON.stringify({
        type: 'error',
        ok: false,
        command,
        schema_version: SCHEMA_VERSION,
        error: { code, message, hint, doc, details },
        exit_code: exitCode,
      })
    );
    return exitCode;
  }
  if (fmt === 'text') {
    process.stderr.write(`${message}\n`);
    if (hint) process.stderr.write(`提示: ${hint}\n`);
    return exitCode;
  }
  process.stdout.write(
    renderMd({
      heading: `${command} · ✗ 失败`,
      meta: [`错误码 \`${code}\` · exit ${exitCode}`],
      errorDetails: { code, message, hint, doc, details },
    })
  );
  return exitCode;
}

/** Diagnostic message: always to stderr, suppressed by --quiet. */
export function emitDiagnostic(
  ctx: OutputContext | null,
  message: string,
  level: 'info' | 'warn' = 'info'
): void {
  if (ctx?.flags.quiet) return;
  const prefix = level === 'warn' ? '[warn] ' : '';
  process.stderr.write(`${prefix}${message}\n`);
}

export interface StreamEmitter {
  event(eventType: string, payload: Record<string, unknown>): void;
  end(meta?: Record<string, unknown>): void;
  error(err: unknown): number;
}

export function startStream(ctx: OutputContext, command: string): StreamEmitter {
  const fmt = ctx.flags.output;
  return {
    event(eventType, payload) {
      if (fmt === 'ndjson' || fmt === 'json') {
        writeStdout(
          JSON.stringify({
            type: eventType,
            command,
            schema_version: SCHEMA_VERSION,
            ...payload,
          })
        );
      } else if (fmt === 'markdown') {
        const eventId = payload.id ?? payload.eventId ?? '';
        if (eventId) process.stdout.write(`<!-- event-id: ${String(eventId)} -->\n`);
        process.stdout.write(
          `### ${eventType}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n`
        );
      } else {
        writeStdout(JSON.stringify(payload));
      }
    },
    end(meta) {
      if (fmt === 'ndjson' || fmt === 'json') {
        writeStdout(
          JSON.stringify({
            type: 'end',
            command,
            schema_version: SCHEMA_VERSION,
            meta,
          })
        );
      }
    },
    error(err) {
      return emitError(ctx, command, err);
    },
  };
}

export interface CommandRunOptions {
  command: string;
  flags: GlobalFlags;
  fn: (ctx: OutputContext) => Promise<void> | void;
}

/**
 * Wrap a command body so any thrown error becomes a structured emission and
 * the function resolves to a process exit code. Never throws.
 */
export async function runCommand({ command, flags, fn }: CommandRunOptions): Promise<number> {
  const ctx = createOutputContext(flags);
  try {
    await fn(ctx);
    return 0;
  } catch (err) {
    return emitError(ctx, command, err);
  }
}
