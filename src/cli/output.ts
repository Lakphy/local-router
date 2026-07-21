import { randomUUID } from 'node:crypto';
import { type CliError, isCliError } from './errors';
import { DEFAULT_FLAGS, type GlobalFlags } from './global-flags';
import {
  renderHuman,
  renderHumanError,
  renderHumanStreamEvent,
  renderHumanValue,
  stripInlineMarkdown,
} from './render-human';
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
  /** Rich presentation shared by the human and explicit Markdown renderers. */
  md?: MdSection;
  /** Plain text rendering for --output text. Falls back to compact JSON if missing. */
  text?: string;
  /** Suggested follow-up commands the agent could run. */
  next?: Array<{ command: string; reason: string }>;
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

function genCorrelationId(): string {
  return randomUUID();
}

/**
 * correlation_id source of truth:
 * - If `LOCAL_ROUTER_CORRELATION_ID` env is set, pass through verbatim (lets
 *   external tooling thread a fixed trace id across multiple CLI invocations).
 * - Otherwise generate one only when explicitly requested via --verbose
 *   (machine consumers wanting trace IDs) or --explain (AI frontmatter).
 */
function resolveCorrelationId(ctx: OutputContext): string | undefined {
  const env = process.env.LOCAL_ROUTER_CORRELATION_ID;
  if (env) return env;
  if (ctx.flags.verbose || ctx.flags.explain) return genCorrelationId();
  return undefined;
}

export function emitResult<T>(ctx: OutputContext, payload: ResultPayload<T>): void {
  const elapsedMs = Date.now() - ctx.startedAt;
  const meta = { elapsedMs, ...(payload.meta ?? {}) };
  const fmt = ctx.flags.output;
  const correlationId = resolveCorrelationId(ctx);

  if (fmt === 'json') {
    const env: JsonResultEnvelope<T> = {
      ok: true,
      command: payload.command,
      schema_version: SCHEMA_VERSION,
      data: payload.data,
      meta,
    };
    if (correlationId) env.correlation_id = correlationId;
    if (payload.warnings && payload.warnings.length > 0) env.warnings = payload.warnings;
    if (payload.next && payload.next.length > 0) env.next = payload.next;
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
        ...(correlationId ? { correlation_id: correlationId } : {}),
        data: payload.data,
        meta,
        ...(payload.next && payload.next.length > 0 ? { next: payload.next } : {}),
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
  if (fmt === 'human') {
    writeStdout(payload.md ? renderHuman(payload.md) : renderHumanValue(payload.data));
    if (payload.warnings && payload.warnings.length > 0 && !ctx.flags.quiet) {
      for (const warning of payload.warnings) {
        process.stderr.write(`警告: ${stripInlineMarkdown(warning)}\n`);
      }
    }
    if (ctx.flags.explain && payload.next && payload.next.length > 0) {
      process.stdout.write(
        `\n下一步:\n${payload.next.map((item) => `  ${item.command}  ${item.reason}`).join('\n')}\n`
      );
    }
    return;
  }
  if (fmt === 'markdown' && payload.md) {
    const md = renderMd(payload.md);
    if (ctx.flags.explain) {
      // AI frontmatter: machine-readable hint at top of markdown
      const frontmatter = [
        '<!-- json:',
        JSON.stringify(
          {
            ok: true,
            command: payload.command,
            schema_version: SCHEMA_VERSION,
            correlation_id: correlationId,
            data: payload.data,
            meta,
            next: payload.next ?? [],
          },
          null,
          2
        ),
        '-->',
        '',
      ].join('\n');
      process.stdout.write(frontmatter + md);
    } else {
      process.stdout.write(md);
    }
    if (payload.next && payload.next.length > 0 && ctx.flags.explain) {
      process.stdout.write(
        `\n**下一步建议**\n\n${payload.next.map((n) => `- \`${n.command}\` — ${n.reason}`).join('\n')}\n`
      );
    }
    return;
  }
  process.stdout.write(
    renderMd({
      heading: payload.command,
      data: `\`\`\`json\n${JSON.stringify(payload.data, null, 2)}\n\`\`\``,
    })
  );
}

export function emitError(ctx: OutputContext | null, command: string, err: unknown): number {
  const fmt = ctx?.flags.output ?? 'human';
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
  if (fmt === 'human') {
    process.stderr.write(
      renderHumanError({
        command,
        code,
        message,
        hint,
        doc,
        details: ctx?.flags.verbose ? details : undefined,
        detailsOmitted: details !== undefined && !ctx?.flags.verbose,
        exitCode,
      })
    );
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
  const rendered = ctx?.flags.output === 'human' ? stripInlineMarkdown(message) : message;
  process.stderr.write(`${prefix}${rendered}\n`);
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
      } else if (fmt === 'human') {
        process.stdout.write(renderHumanStreamEvent(eventType, payload));
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

export interface CommandRunWithSchemaOptions<TValues> {
  command: string;
  flags: GlobalFlags;
  /** Pre-parsed and validated flag values (from parseCommandArgs). */
  values: TValues;
  /** Positional args after flag stripping. */
  positionals: string[];
  fn: (args: {
    values: TValues;
    positionals: string[];
    ctx: OutputContext;
  }) => Promise<void> | void;
}

/**
 * Like runCommand, but signature mirrors the spec-first engine: handler
 * receives pre-parsed values/positionals instead of raw args. Use this from
 * the registry dispatch path so each handler stays declarative.
 */
export async function runCommandWithSchema<TValues>(
  opts: CommandRunWithSchemaOptions<TValues>
): Promise<number> {
  const ctx = createOutputContext(opts.flags);
  try {
    await opts.fn({ values: opts.values, positionals: opts.positionals, ctx });
    return 0;
  } catch (err) {
    return emitError(ctx, opts.command, err);
  }
}
