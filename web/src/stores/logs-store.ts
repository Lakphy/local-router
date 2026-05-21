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
  refreshing: boolean;
}

interface LogsActions {
  setFilter: <K extends keyof LogFilters>(key: K, value: LogFilters[K]) => void;
  setSort: (sort: LogsState['sort']) => Promise<void>;
  applyFilters: () => Promise<void>;
  resetFilters: () => Promise<void>;
  fetchFirstPage: (options?: { silent?: boolean }) => Promise<void>;
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
let firstPageController: AbortController | null = null;
let firstPageRequestSeq = 0;

const MAX_ITEMS_IN_MEMORY = 1_000;

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
  incoming: LogEventSummary[],
  sort: LogsState['sort']
): LogEventSummary[] {
  const map = new Map<string, LogEventSummary>();
  for (const item of current) map.set(item.id, item);
  for (const item of incoming) map.set(item.id, item);
  return Array.from(map.values())
    .sort((a, b) => {
      const diff = Date.parse(a.ts) - Date.parse(b.ts);
      return sort === 'time_asc' ? diff : -diff;
    })
    .slice(0, MAX_ITEMS_IN_MEMORY);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
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
  refreshing: false,

  setFilter: (key, value) => {
    set((state) => ({
      filters: {
        ...state.filters,
        [key]: value,
      },
    }));
  },

  setSort: async (sort) => {
    if (get().sort === sort) return;
    set({ sort });
    await get().fetchFirstPage();
  },

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

  fetchFirstPage: async (options = {}) => {
    firstPageController?.abort();
    const controller = new AbortController();
    firstPageController = controller;
    const requestSeq = ++firstPageRequestSeq;
    const silent = options.silent === true && get().items.length > 0;

    set({
      loading: !silent,
      refreshing: silent,
      error: null,
    });

    try {
      const data = await fetchLogEvents(buildRequestParams(get()), { signal: controller.signal });
      if (requestSeq !== firstPageRequestSeq) return;
      set({
        items: data.items,
        nextCursor: data.nextCursor,
        hasMore: data.hasMore,
        stats: data.stats,
        meta: data.meta,
        loading: false,
        refreshing: false,
        loadingMore: false,
      });

      if (get().tailEnabled) {
        get().startTail();
      }
    } catch (err) {
      if (isAbortError(err) || requestSeq !== firstPageRequestSeq) return;
      set({
        loading: false,
        refreshing: false,
        loadingMore: false,
        error: err instanceof Error ? err.message : '日志查询失败',
      });
    } finally {
      if (firstPageController === controller) {
        firstPageController = null;
      }
    }
  },

  fetchNextPage: async () => {
    const state = get();
    if (!state.nextCursor || state.loadingMore) return;

    set({ loadingMore: true, error: null });

    try {
      const data = await fetchLogEvents(buildRequestParams(state, state.nextCursor));
      const latest = get();
      set({
        items: mergeUniqueById(latest.items, data.items, latest.sort),
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
      void get().fetchFirstPage({ silent: true });
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
            items: mergeUniqueById(current.items, data.items, current.sort),
            stats: data.meta.statsMode === 'none' ? current.stats : data.stats,
            meta: data.meta,
            tailError: data.meta.fallbackReason ?? null,
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
