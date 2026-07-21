import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_FLAGS, extractGlobalFlags } from '../../src/cli/global-flags';

describe('CLI output flags', () => {
  let previousFormat: string | undefined;

  beforeEach(() => {
    previousFormat = process.env.LOCAL_ROUTER_FORMAT;
    delete process.env.LOCAL_ROUTER_FORMAT;
  });

  afterEach(() => {
    if (previousFormat === undefined) delete process.env.LOCAL_ROUTER_FORMAT;
    else process.env.LOCAL_ROUTER_FORMAT = previousFormat;
  });

  test('human is the default output format', () => {
    expect(DEFAULT_FLAGS.output).toBe('human');
    expect(extractGlobalFlags(['version']).flags.output).toBe('human');
  });

  test('supports human, machine, compatibility, and document formats', () => {
    for (const output of ['human', 'json', 'ndjson', 'text', 'markdown'] as const) {
      expect(extractGlobalFlags(['version', '--output', output]).flags.output).toBe(output);
    }
    expect(extractGlobalFlags(['version', '--json']).flags.output).toBe('json');
  });

  test('accepts terminal/table and md aliases', () => {
    expect(extractGlobalFlags(['version', '-o', 'terminal']).flags.output).toBe('human');
    expect(extractGlobalFlags(['version', '-o', 'table']).flags.output).toBe('human');
    expect(extractGlobalFlags(['version', '-o', 'md']).flags.output).toBe('markdown');
  });

  test('LOCAL_ROUTER_FORMAT can select human or an explicit alternate format', () => {
    process.env.LOCAL_ROUTER_FORMAT = 'human';
    expect(extractGlobalFlags(['version']).flags.output).toBe('human');
    process.env.LOCAL_ROUTER_FORMAT = 'markdown';
    expect(extractGlobalFlags(['version']).flags.output).toBe('markdown');
  });
});
