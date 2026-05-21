import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogConfig } from '../../src/config';
import { getLogStorageInfo } from '../../src/log-storage';

describe('log-storage', () => {
  let tempDir: string;
  let logConfig: LogConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'log-storage-test-'));
    logConfig = {
      enabled: true,
      baseDir: tempDir,
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('应统计 events、streams 与 SQLite 索引文件大小', async () => {
    mkdirSync(join(tempDir, 'events'), { recursive: true });
    mkdirSync(join(tempDir, 'streams', '2026-03-16'), { recursive: true });

    writeFileSync(join(tempDir, 'events', '2026-03-16.jsonl'), 'event\n');
    writeFileSync(join(tempDir, 'streams', '2026-03-16', 'req-1.sse.raw'), 'stream\n');
    writeFileSync(join(tempDir, 'logs-index.sqlite'), 'index-main');
    writeFileSync(join(tempDir, 'logs-index.sqlite-wal'), 'index-wal');
    writeFileSync(join(tempDir, 'logs-index.sqlite-shm'), 'index-shm');

    const info = await getLogStorageInfo({ logConfig, forceRefresh: true });

    expect(info.eventsBytes).toBe(Buffer.byteLength('event\n'));
    expect(info.streamsBytes).toBe(Buffer.byteLength('stream\n'));
    expect(info.indexBytes).toBe(
      Buffer.byteLength('index-main') +
        Buffer.byteLength('index-wal') +
        Buffer.byteLength('index-shm')
    );
    expect(info.totalBytes).toBe(info.eventsBytes + info.streamsBytes + info.indexBytes);
    expect(info.fileCount).toBe(5);
  });
});
