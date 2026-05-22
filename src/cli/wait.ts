import { setTimeout as sleep } from 'node:timers/promises';
import { CliError } from './errors';

export interface WaitForOptions {
  check: () => Promise<boolean> | boolean;
  timeoutMs: number;
  intervalMs?: number;
  message?: string;
}

export async function waitFor({
  check,
  timeoutMs,
  intervalMs = 250,
  message,
}: WaitForOptions): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (true) {
    try {
      if (await check()) return;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        'TIMEOUT',
        message ?? `等待超时 (${timeoutMs}ms)`,
        lastErr instanceof Error ? { cause: lastErr } : {}
      );
    }
    await sleep(intervalMs);
  }
}
