import { create } from 'zustand';
import { fetchProviderBalances, fetchUsageMetrics } from '@/lib/api';
import type {
  ProviderBalanceResult,
  UsageMetricsResponse,
  UsageMetricsWindow,
} from '@/types/config';

interface UsageState {
  data: UsageMetricsResponse | null;
  loading: boolean;
  error: string | null;
  window: UsageMetricsWindow;
  balances: ProviderBalanceResult[];
  balancesLoading: boolean;
  balancesError: string | null;
}

interface UsageActions {
  fetch: (window?: UsageMetricsWindow, refresh?: boolean) => Promise<void>;
  setWindow: (window: UsageMetricsWindow) => void;
  refresh: () => Promise<void>;
  fetchBalances: () => Promise<void>;
}

export type UsageStore = UsageState & UsageActions;

export const useUsageStore = create<UsageStore>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  window: '24h',
  balances: [],
  balancesLoading: false,
  balancesError: null,

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

  fetchBalances: async () => {
    set({ balancesLoading: true, balancesError: null });

    try {
      const result = await fetchProviderBalances();
      set({ balances: result.balances, balancesLoading: false, balancesError: null });
    } catch (err) {
      set({
        balancesLoading: false,
        balancesError: err instanceof Error ? err.message : '获取余额失败',
      });
    }
  },
}));
