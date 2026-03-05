import { create } from 'zustand';
import { fetchLogSessions, type LogSessionsResponse } from '@/lib/api';

export interface SessionsFilters {
  window: '1h' | '6h' | '24h';
  from: string;
  to: string;
  user: string;
  session: string;
  q: string;
}

interface SessionsState {
  filters: SessionsFilters;
  summary: LogSessionsResponse['summary'] | null;
  users: LogSessionsResponse['users'];
  meta: LogSessionsResponse['meta'] | null;
  from: string;
  to: string;
  loading: boolean;
  error: string | null;
}

interface SessionsActions {
  setFilter: <K extends keyof SessionsFilters>(key: K, value: SessionsFilters[K]) => void;
  fetchData: () => Promise<void>;
  resetFilters: () => Promise<void>;
}

type SessionsStore = SessionsState & SessionsActions;

const DEFAULT_FILTERS: SessionsFilters = {
  window: '24h',
  from: '',
  to: '',
  user: '',
  session: '',
  q: '',
};

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  filters: { ...DEFAULT_FILTERS },
  summary: null,
  users: [],
  meta: null,
  from: '',
  to: '',
  loading: false,
  error: null,

  setFilter: (key, value) => {
    set((state) => ({
      filters: {
        ...state.filters,
        [key]: value,
      },
    }));
  },

  fetchData: async () => {
    set({ loading: true, error: null });

    try {
      const state = get();
      const data = await fetchLogSessions({
        window: state.filters.window,
        from: state.filters.from || undefined,
        to: state.filters.to || undefined,
        user: state.filters.user || undefined,
        session: state.filters.session || undefined,
        q: state.filters.q || undefined,
      });

      set({
        summary: data.summary,
        users: data.users,
        meta: data.meta,
        from: data.from,
        to: data.to,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '用户会话查询失败',
      });
    }
  },

  resetFilters: async () => {
    set({ filters: { ...DEFAULT_FILTERS } });
    await get().fetchData();
  },
}));
