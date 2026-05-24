import { create } from 'zustand';
import {
  type FetchLogEventsParams,
  fetchLogEvents,
  type LogEventSummary,
  type LogEventsResponse,
} from '@/lib/api';

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
}

interface LogsActions {
  setFilter: <K extends keyof LogFilters>(key: K, value: LogFilters[K]) => void;
  setSort: (sort: LogsState['sort']) => Promise<void>;
  applyFilters: () => Promise<void>;
  resetFilters: () => Promise<void>;
  fetchFirstPage: () => Promise<void>;
  fetchNextPage: () => Promise<void>;
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

  fetchFirstPage: async () => {
    firstPageController?.abort();
    const controller = new AbortController();
    firstPageController = controller;
    const requestSeq = ++firstPageRequestSeq;

    set({
      loading: true,
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
        loadingMore: false,
      });
    } catch (err) {
      if (isAbortError(err) || requestSeq !== firstPageRequestSeq) return;
      set({
        loading: false,
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
}));
