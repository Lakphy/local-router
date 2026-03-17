import { create } from 'zustand';
import { fetchUsageMetrics } from '@/lib/api';
import type { UsageMetricsResponse, UsageMetricsWindow } from '@/types/config';

interface UsageState {
  data: UsageMetricsResponse | null;
  loading: boolean;
  error: string | null;
  window: UsageMetricsWindow;
}

interface UsageActions {
  fetch: (window?: UsageMetricsWindow, refresh?: boolean) => Promise<void>;
  setWindow: (window: UsageMetricsWindow) => void;
  refresh: () => Promise<void>;
}

export type UsageStore = UsageState & UsageActions;

export const useUsageStore = create<UsageStore>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  window: '24h',

  fetch: async (window, refresh = false) => {
    const currentWindow = window ?? get().window;
    set({ loading: true, error: null, window: currentWindow });

    try {
      const data = await fetchUsageMetrics(currentWindow, refresh);
      set({ data, loading: false, error: null });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '获取用量统计失败',
      });
    }
  },

  setWindow: (window) => {
    set({ window });
  },

  refresh: async () => {
    await get().fetch(undefined, true);
  },
}));
