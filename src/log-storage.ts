import { existsSync, promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import type { LogConfig } from './config';
import { resolveLogBaseDir } from './config';

export interface LogStorageInfo {
  totalBytes: number;
  eventsBytes: number;
  streamsBytes: number;
  fileCount: number;
  lastUpdatedAt: string;
  isCalculating: boolean;
}

interface CachedStorageInfo {
  info: LogStorageInfo;
  expiresAt: number;
}

let cachedStorage: CachedStorageInfo | null = null;
let calculationPromise: Promise<LogStorageInfo> | null = null;
let lastCalculationTime = 0;

const CACHE_TTL_MS = 60 * 60 * 1000; // 1小时缓存
const CALCULATION_INTERVAL_MS = 60 * 60 * 1000; // 每小时计算一次
const MIN_CALCULATION_INTERVAL_MS = 5 * 60 * 1000; // 最少5分钟间隔，避免频繁计算

async function calculateDirSize(dirPath: string): Promise<{ bytes: number; fileCount: number }> {
  if (!existsSync(dirPath)) {
    return { bytes: 0, fileCount: 0 };
  }

  let bytes = 0;
  let fileCount = 0;

  async function walk(currentPath: string): Promise<void> {
    try {
      const entries = await fsPromises.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          try {
            const stats = await fsPromises.stat(fullPath);
            bytes += stats.size;
            fileCount += 1;
          } catch {
            // 忽略无法读取的文件
          }
        }
      }
    } catch {
      // 忽略无法读取的目录
    }
  }

  await walk(dirPath);
  return { bytes, fileCount };
}

async function doCalculateStorage(logConfig?: LogConfig): Promise<LogStorageInfo> {
  const logEnabled = !!logConfig && logConfig.enabled !== false;

  if (!logEnabled) {
    return {
      totalBytes: 0,
      eventsBytes: 0,
      streamsBytes: 0,
      fileCount: 0,
      lastUpdatedAt: new Date().toISOString(),
      isCalculating: false,
    };
  }

  const baseDir = resolveLogBaseDir(logConfig);

  const [eventsResult, streamsResult] = await Promise.all([
    calculateDirSize(join(baseDir, 'events')),
    calculateDirSize(join(baseDir, 'streams')),
  ]);

  return {
    totalBytes: eventsResult.bytes + streamsResult.bytes,
    eventsBytes: eventsResult.bytes,
    streamsBytes: streamsResult.bytes,
    fileCount: eventsResult.fileCount + streamsResult.fileCount,
    lastUpdatedAt: new Date().toISOString(),
    isCalculating: false,
  };
}

export async function getLogStorageInfo(options: {
  logConfig?: LogConfig;
  forceRefresh?: boolean;
  nowMs?: number;
}): Promise<LogStorageInfo> {
  const { logConfig, forceRefresh = false, nowMs = Date.now() } = options;

  // 如果有缓存且未过期，直接返回缓存
  if (!forceRefresh && cachedStorage && cachedStorage.expiresAt > nowMs) {
    return cachedStorage.info;
  }

  // 如果正在计算中，返回当前的计算 Promise
  if (calculationPromise) {
    const result = await calculationPromise;
    return { ...result, isCalculating: true };
  }

  // 检查是否需要重新计算（距离上次计算时间超过间隔）
  const timeSinceLastCalculation = nowMs - lastCalculationTime;
  if (!forceRefresh && timeSinceLastCalculation < MIN_CALCULATION_INTERVAL_MS && cachedStorage) {
    return cachedStorage.info;
  }

  // 启动新的计算
  calculationPromise = doCalculateStorage(logConfig);

  try {
    const info = await calculationPromise;
    lastCalculationTime = nowMs;
    cachedStorage = {
      info,
      expiresAt: nowMs + CACHE_TTL_MS,
    };
    return info;
  } finally {
    calculationPromise = null;
  }
}

// 格式化字节为可读字符串
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / k ** i;

  if (i === 0) return `${bytes} B`;
  return `${value.toFixed(2)} ${units[i]}`;
}

// 后台定时任务：每小时检查一次是否需要更新
export function startLogStorageBackgroundTask(logConfig?: LogConfig): () => void {
  // 立即执行一次计算（如果日志已启用）
  if (logConfig?.enabled !== false && logConfig) {
    getLogStorageInfo({ logConfig }).catch(() => {
      // 忽略初始化错误
    });
  }

  // 每小时检查一次
  const timer = setInterval(() => {
    const nowMs = Date.now();

    // 检查缓存是否过期
    if (!cachedStorage || cachedStorage.expiresAt <= nowMs) {
      getLogStorageInfo({ logConfig, nowMs }).catch(() => {
        // 忽略后台计算错误
      });
    }
  }, CALCULATION_INTERVAL_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}
