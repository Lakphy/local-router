import { describe, expect, test } from 'bun:test';
import {
  calculateLogsVirtualRange,
  getCacheHitRateRowClass,
} from '../../web/src/components/logs/logs-data-table';

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

  test('应按缓存命中率返回日志行底色 class', () => {
    expect(getCacheHitRateRowClass(null)).toBe('');
    expect(getCacheHitRateRowClass(undefined)).toBe('');
    expect(getCacheHitRateRowClass(19.99)).toContain('bg-red-50');
    expect(getCacheHitRateRowClass(20)).toContain('bg-yellow-50');
    expect(getCacheHitRateRowClass(89.99)).toContain('bg-yellow-50');
    expect(getCacheHitRateRowClass(90)).toBe('');
  });
});
