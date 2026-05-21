import { describe, expect, test } from 'bun:test';
import { calculateLogsVirtualRange } from '../../web/src/components/logs/logs-data-table';

describe('logs data table virtual range', () => {
  test('应在正常滚动时包含可见行和 overscan', () => {
    const range = calculateLogsVirtualRange({
      dataLength: 1_000,
      scrollTop: 44 * 100,
      viewportHeight: 440,
      rowHeight: 44,
      overscanRows: 5,
    });

    expect(range).toEqual({ start: 95, end: 115 });
  });

  test('数据量缩小后应将旧滚动位置 clamp 到有效范围', () => {
    const range = calculateLogsVirtualRange({
      dataLength: 10,
      scrollTop: 44 * 900,
      viewportHeight: 440,
      rowHeight: 44,
      overscanRows: 5,
    });

    expect(range).toEqual({ start: 0, end: 10 });
  });
});
