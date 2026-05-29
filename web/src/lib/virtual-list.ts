const DEFAULT_ROW_HEIGHT = 44;
const DEFAULT_VIEWPORT_HEIGHT = 560;
const DEFAULT_OVERSCAN_ROWS = 8;

export function calculateVirtualRange(input: {
  dataLength: number;
  scrollTop: number;
  viewportHeight?: number;
  rowHeight?: number;
  overscanRows?: number;
}): { start: number; end: number } {
  const dataLength = Math.max(0, input.dataLength);
  const rowHeight = input.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const viewportHeight = input.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
  const overscanRows = input.overscanRows ?? DEFAULT_OVERSCAN_ROWS;
  const visibleRows = Math.ceil(viewportHeight / rowHeight);
  const windowSize = visibleRows + overscanRows * 2;
  const maxStart = Math.max(0, dataLength - windowSize);
  const rawStart = Math.max(0, Math.floor(input.scrollTop / rowHeight) - overscanRows);
  const start = Math.min(rawStart, maxStart);
  const end = Math.min(dataLength, start + windowSize);
  return { start, end };
}
