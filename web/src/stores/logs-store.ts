import { create } from 'zustand';
import {
  type FetchLogEventsParams,
  fetchLogEvents,
  type LogEventSummary,
  type LogEventsResponse,
  openLogTail,
} from '@/lib/api';

export interface SavedLogView {
  id: string;
  name: string;
  filters: LogFilters;
  sort: 'time_desc' | 'time_asc';
}

export interface LogFilters {
  window: '1h' | '6h' | '24h';
  from: string;
  to: string;
  levels: Array<'info' | 'error'>;
  provider: string;
  routeType: string;
  modelIn: string;
  modelOut: string;
  user: string;
  session: string;
  statusClass: Array<'2xx' | '4xx' | '5xx' | 'network_error'>;
  hasError: 'all' | 'true' | 'false';
  q: string;
}

interface LogsState {
  filters: LogFilters;
  sort: 'time_desc' | 'time_asc';
  items: LogEventSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  stats: LogEventsResponse['stats'] | null;
  meta: LogEventsResponse['meta'] | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  autoRefreshEnabled: boolean;
  refreshIntervalSec: number;
  savedViews: SavedLogView[];
  tailEnabled: boolean;
  tailConnected: boolean;
  tailError: string | null;
}

interface LogsActions {
  setFilter: <K extends keyof LogFilters>(key: K, value: LogFilters[K]) => void;
  setSort: (sort: LogsState['sort']) => void;
  applyFilters: () => Promise<void>;
  resetFilters: () => Promise<void>;
  fetchFirstPage: () => Promise<void>;
  fetchNextPage: () => Promise<void>;
  setAutoRefreshEnabled: (enabled: boolean) => void;
  setRefreshIntervalSec: (seconds: number) => void;
  startAutoRefresh: () => void;
  stopAutoRefresh: () => void;
  setTailEnabled: (enabled: boolean) => void;
  startTail: () => void;
  stopTail: () => void;
  saveCurrentView: (name: string) => void;
  applySavedView: (id: string) => Promise<void>;
  deleteSavedView: (id: string) => void;
}

type LogsStore = LogsState & LogsActions;

const DEFAULT_FILTERS: LogFilters = {
  window: '24h',
  from: '',
  to: '',
  levels: [],
  provider: '',
  routeType: '',
  modelIn: '',
  modelOut: '',
  user: '',
  session: '',
  statusClass: [],
  hasError: 'all',
  q: '',
};

let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let tailCleanup: (() => void) | null = null;

function buildRequestParams(state: LogsState, cursor?: string | null): FetchLogEventsParams {
  return {
    window: state.filters.window,
    from: state.filters.from || undefined,
    to: state.filters.to || undefined,
    levels: state.filters.levels,
    provider: state.filters.provider || undefined,
    routeType: state.filters.routeType || undefined,
    modelIn: state.filters.modelIn || undefined,
    modelOut: state.filters.modelOut || undefined,
    user: state.filters.user || undefined,
    session: state.filters.session || undefined,
    statusClass: state.filters.statusClass,
    hasError: state.filters.hasError === 'all' ? undefined : state.filters.hasError === 'true',
    q: state.filters.q || undefined,
    sort: state.sort,
    limit: 50,
    cursor: cursor ?? undefined,
  };
}

function mergeUniqueById(
  current: LogEventSummary[],
  incoming: LogEventSummary[]
): LogEventSummary[] {
  const map = new Map<string, LogEventSummary>();
  for (const item of current) map.set(item.id, item);
  for (const item of incoming) map.set(item.id, item);
  return Array.from(map.values()).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

export const useLogsStore = create<LogsStore>((set, get) => ({
  filters: { ...DEFAULT_FILTERS },
  sort: 'time_desc',
  items: [],
  nextCursor: null,
  hasMore: false,
  stats: null,
  meta: null,
  loading: false,
  loadingMore: false,
  error: null,
  autoRefreshEnabled: false,
  refreshIntervalSec: 5,
  savedViews: [],
  tailEnabled: false,
  tailConnected: false,
  tailError: null,

  setFilter: (key, value) => {
    set((state) => ({
      filters: {
        ...state.filters,
        [key]: value,
      },
    }));
  },

  setSort: (sort) => set({ sort }),

  applyFilters: async () => {
    await get().fetchFirstPage();
  },

  resetFilters: async () => {
    set({
      filters: { ...DEFAULT_FILTERS },
      sort: 'time_desc',
    });
    await get().fetchFirstPage();
  },

  fetchFirstPage: async () => {
    set({ loading: true, error: null });
    try {
      const data = await fetchLogEvents(buildRequestParams(get()));
      set({
        items: data.items,
        nextCursor: data.nextCursor,
        hasMore: data.hasMore,
        stats: data.stats,
        meta: data.meta,
        loading: false,
        loadingMore: false,
      });
    } catch (err) {
      set({
        loading: false,
        loadingMore: false,
        error: err instanceof Error ? err.message : '日志查询失败',
      });
    }
  },

  fetchNextPage: async () => {
    const state = get();
    if (!state.nextCursor || state.loadingMore) return;

    set({ loadingMore: true, error: null });

    try {
      const data = await fetchLogEvents(buildRequestParams(state, state.nextCursor));
      set({
        items: [...state.items, ...data.items],
        nextCursor: data.nextCursor,
        hasMore: data.hasMore,
        stats: data.stats,
        meta: data.meta,
        loadingMore: false,
      });
    } catch (err) {
      set({
        loadingMore: false,
        error: err instanceof Error ? err.message : '加载更多日志失败',
      });
    }
  },

  setAutoRefreshEnabled: (enabled) => {
    set({ autoRefreshEnabled: enabled });
    if (enabled) get().startAutoRefresh();
    else get().stopAutoRefresh();
  },

  setRefreshIntervalSec: (seconds) => {
    const value = Math.max(2, Math.min(60, seconds));
    set({ refreshIntervalSec: value });
    if (get().autoRefreshEnabled) {
      get().startAutoRefresh();
    }
  },

  startAutoRefresh: () => {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }

    const interval = Math.max(2, get().refreshIntervalSec) * 1000;
    autoRefreshTimer = setInterval(() => {
      void get().fetchFirstPage();
    }, interval);
  },

  stopAutoRefresh: () => {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  },

  setTailEnabled: (enabled) => {
    set({ tailEnabled: enabled });
    if (enabled) get().startTail();
    else get().stopTail();
  },

  startTail: () => {
    if (tailCleanup) {
      tailCleanup();
      tailCleanup = null;
    }

    const state = get();
    tailCleanup = openLogTail(
      {
        window: state.filters.window,
        levels: state.filters.levels,
        provider: state.filters.provider || undefined,
        routeType: state.filters.routeType || undefined,
        modelIn: state.filters.modelIn || undefined,
        modelOut: state.filters.modelOut || undefined,
        user: state.filters.user || undefined,
        session: state.filters.session || undefined,
        statusClass: state.filters.statusClass,
        hasError: state.filters.hasError === 'all' ? undefined : state.filters.hasError === 'true',
        q: state.filters.q || undefined,
        sort: state.sort,
      },
      {
        onReady: () => {
          set({ tailConnected: true, tailError: null });
        },
        onEvents: (data) => {
          set((current) => ({
            tailConnected: true,
            tailError: null,
            items: mergeUniqueById(current.items, data.items),
            stats: data.stats,
            meta: data.meta,
          }));
        },
        onError: (message) => {
          set({ tailConnected: false, tailError: message });
        },
      }
    );
  },

  stopTail: () => {
    if (tailCleanup) {
      tailCleanup();
      tailCleanup = null;
    }
    set({ tailConnected: false, tailError: null });
  },

  saveCurrentView: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    const state = get();
    const view: SavedLogView = {
      id: crypto.randomUUID(),
      name: trimmed,
      filters: { ...state.filters },
      sort: state.sort,
    };

    set((current) => ({
      savedViews: [view, ...current.savedViews].slice(0, 20),
    }));
  },

  applySavedView: async (id) => {
    const view = get().savedViews.find((item) => item.id === id);
    if (!view) return;

    set({ filters: { ...view.filters }, sort: view.sort });
    await get().fetchFirstPage();
  },

  deleteSavedView: (id) => {
    set((state) => ({
      savedViews: state.savedViews.filter((view) => view.id !== id),
    }));
  },
}));
