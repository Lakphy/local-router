export type CliErrorCode =
  | 'USAGE_ERROR'
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_EXISTS'
  | 'PROVIDER_REFERENCED_BY_ROUTE'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_EXISTS'
  | 'ROUTE_NOT_FOUND'
  | 'ROUTE_FALLBACK_PROTECTED'
  | 'SERVICE_NOT_RUNNING'
  | 'SERVICE_ALREADY_RUNNING'
  | 'PORT_IN_USE'
  | 'HEALTH_FAILED'
  | 'APPLY_FAILED'
  | 'UPSTREAM_UNREACHABLE'
  | 'TIMEOUT'
  | 'INTERACTIVE_REQUIRED'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_UNREACHABLE'
  | 'UNKNOWN_ERROR';

const EXIT_CODES: Record<CliErrorCode, number> = {
  USAGE_ERROR: 2,
  SERVICE_NOT_RUNNING: 3,
  SERVICE_ALREADY_RUNNING: 4,
  PROVIDER_REFERENCED_BY_ROUTE: 4,
  PORT_IN_USE: 4,
  ROUTE_FALLBACK_PROTECTED: 4,
  PROVIDER_EXISTS: 4,
  MODEL_EXISTS: 4,
  CONFIG_INVALID: 5,
  CONFIG_NOT_FOUND: 6,
  PROVIDER_NOT_FOUND: 6,
  MODEL_NOT_FOUND: 6,
  ROUTE_NOT_FOUND: 6,
  TIMEOUT: 7,
  HEALTH_FAILED: 8,
  APPLY_FAILED: 8,
  UPSTREAM_UNREACHABLE: 9,
  INTERACTIVE_REQUIRED: 10,
  TARGET_NOT_FOUND: 3,
  TARGET_UNREACHABLE: 9,
  UNKNOWN_ERROR: 1,
};

export interface CliErrorOptions {
  hint?: string;
  doc?: string;
  details?: unknown;
  exitCode?: number;
  cause?: unknown;
}

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly hint?: string;
  readonly doc?: string;
  readonly details?: unknown;
  readonly exitCode: number;

  constructor(code: CliErrorCode, message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = options.hint;
    this.doc = options.doc;
    this.details = options.details;
    this.exitCode = options.exitCode ?? EXIT_CODES[code] ?? 1;
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, configurable: true });
    }
  }
}

export function exitCodeFor(code: CliErrorCode): number {
  return EXIT_CODES[code] ?? 1;
}

export function isCliError(err: unknown): err is CliError {
  return err instanceof CliError;
}

export function listErrorCodes(): Array<{ code: CliErrorCode; exitCode: number }> {
  return (Object.keys(EXIT_CODES) as CliErrorCode[]).map((code) => ({
    code,
    exitCode: EXIT_CODES[code],
  }));
}
