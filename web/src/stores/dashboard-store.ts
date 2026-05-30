import { create } from 'zustand';
import { fetchLogMetrics, fetchLogStorage, type LogStorageInfo } from '@/lib/api';
import type { LogMetricsResponse, LogMetricsWindow } from '@/types/config';

interface DashboardState {
  metrics: LogMetricsResponse | null;
  metricsLoading: boolean;
  metricsError: string | null;
  metricsWindow: LogMetricsWindow;
  logStorage: LogStorageInfo | null;
  logStorageLoading: boolean;
  logStorageError: string | null;
}

interface DashboardActions {
  fetchMetrics: (window?: LogMetricsWindow, refresh?: boolean) => Promise<void>;
  fetchLogStorage: (refresh?: boolean) => Promise<void>;
  setMetricsWindow: (window: LogMetricsWindow) => void;
}

export type DashboardStore = DashboardState & DashboardActions;

export const useDashboardStore = create<DashboardStore>((set, get) => ({
  metrics: null,
  metricsLoading: false,
  metricsError: null,
  metricsWindow: '24h',
  logStorage: null,
  logStorageLoading: false,
  logStorageError: null,

  fetchMetrics: async (window, refresh = false) => {
    const currentWindow = window ?? get().metricsWindow;
    set({ metricsLoading: true, metricsError: null, metricsWindow: currentWindow });

    try {
      const metrics = await fetchLogMetrics(currentWindow, refresh);
      set({ metrics, metricsLoading: false, metricsError: null });
    } catch (err) {
      set({
        metricsLoading: false,
        metricsError: err instanceof Error ? err.message : '获取日志统计失败',
      });
    }
  },

  fetchLogStorage: async (refresh = false) => {
    set({ logStorageLoading: true, logStorageError: null });

    try {
      const logStorage = await fetchLogStorage(refresh);
      set({ logStorage, logStorageLoading: false, logStorageError: null });
    } catch (err) {
      set({
        logStorageLoading: false,
        logStorageError: err instanceof Error ? err.message : '获取日志存储统计失败',
      });
    }
  },

  setMetricsWindow: (window) => {
    set({ metricsWindow: window });
  },
}));
