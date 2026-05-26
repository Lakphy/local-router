export const SCHEMA_VERSION = 2;

export interface JsonEnvelopeBase {
  ok: boolean;
  command: string;
  schema_version: number;
  correlation_id?: string;
  meta?: Record<string, unknown>;
  warnings?: string[];
}

export interface JsonResultEnvelope<T = unknown> extends JsonEnvelopeBase {
  ok: true;
  data: T;
  /** Suggested next commands the agent could run. */
  next?: Array<{ command: string; reason: string }>;
}

export interface JsonErrorEnvelope extends JsonEnvelopeBase {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    doc?: string;
    details?: unknown;
  };
  exit_code: number;
}

export type JsonEnvelope<T = unknown> = JsonResultEnvelope<T> | JsonErrorEnvelope;

export function renderJsonResult(env: JsonResultEnvelope): string {
  return JSON.stringify(env, null, 2);
}

export function renderJsonError(env: JsonErrorEnvelope): string {
  return JSON.stringify(env, null, 2);
}
