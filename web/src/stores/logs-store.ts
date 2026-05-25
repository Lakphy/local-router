import { create } from 'zustand';
import {
  type FetchLogEventsParams,
  fetchLogEvents,
  type LogEventSummary,
  type LogEventsResponse,
} from '@/lib/api';
import { LogRealtimeClient, type LogRealtimeStatus } from '@/lib/log-realtime-client';

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
  appliedQuery: FetchLogEventsParams | null;
  items: LogEventSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  stats: LogEventsResponse['stats'] | null;
  meta: LogEventsResponse['meta'] | null;
  realtime: {
    enabled: boolean;
    status: LogRealtimeStatus;
    subscriptionId: string | null;
    error: string | null;
    received: number;
    dropped: number;
  };
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
  startRealtime: () => Promise<void>;
  stopRealtime: (reason?: string) => void;
  receiveRealtimeLogEvents: (items: LogEventSummary[]) => void;
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
let realtimeClient: LogRealtimeClient | null = null;

const MAX_ITEMS_IN_MEMORY = 1_000;

const IDLE_REALTIME_STATE: LogsState['realtime'] = {
  enabled: false,
  status: 'idle',
  subscriptionId: null,
  error: null,
  received: 0,
  dropped: 0,
};

function createIdleRealtimeState(
  overrides: Partial<LogsState['realtime']> = {}
): LogsState['realtime'] {
  return {
    ...IDLE_REALTIME_STATE,
    ...overrides,
  };
}

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

function closeRealtimeClient(reason: string): void {
  const client = realtimeClient;
  realtimeClient = null;
  client?.close(reason);
}

export const useLogsStore = create<LogsStore>((set, get) => ({
  filters: { ...DEFAULT_FILTERS },
  sort: 'time_desc',
  appliedQuery: null,
  items: [],
  nextCursor: null,
  hasMore: false,
  stats: null,
  meta: null,
  realtime: createIdleRealtimeState(),
  loading: false,
  loadingMore: false,
  error: null,

  setFilter: (key, value) => {
    closeRealtimeClient('filter-changed');
    set((state) => ({
      filters: {
        ...state.filters,
        [key]: value,
      },
      appliedQuery: null,
      realtime: createIdleRealtimeState(),
    }));
  },

  setSort: async (sort) => {
    if (get().sort === sort) return;
    closeRealtimeClient('sort-changed');
    set({ sort, appliedQuery: null, realtime: createIdleRealtimeState() });
    await get().fetchFirstPage();
  },

  applyFilters: async () => {
    await get().fetchFirstPage();
  },

  resetFilters: async () => {
    closeRealtimeClient('reset-filters');
    set({
      filters: { ...DEFAULT_FILTERS },
      sort: 'time_desc',
      appliedQuery: null,
      realtime: createIdleRealtimeState(),
    });
    await get().fetchFirstPage();
  },

  fetchFirstPage: async () => {
    closeRealtimeClient('query-refresh');
    firstPageController?.abort();
    const controller = new AbortController();
    firstPageController = controller;
    const requestSeq = ++firstPageRequestSeq;
    const querySnapshot = buildRequestParams(get());

    set({
      loading: true,
      error: null,
      appliedQuery: null,
      realtime: createIdleRealtimeState(),
    });

    try {
      const data = await fetchLogEvents(querySnapshot, { signal: controller.signal });
      if (requestSeq !== firstPageRequestSeq) return;
      set({
        appliedQuery: querySnapshot,
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

  startRealtime: async () => {
    const state = get();
    const query = state.appliedQuery;
    if (!query) {
      set({
        realtime: createIdleRealtimeState({
          status: 'error',
          error: '请先查询后再开启实时推送',
        }),
      });
      return;
    }
    if (state.sort !== 'time_desc') {
      set({
        realtime: createIdleRealtimeState({
          status: 'error',
          error: '实时推送仅支持按时间倒序展示',
        }),
      });
      return;
    }
    if (query.to) {
      set({
        realtime: createIdleRealtimeState({
          status: 'error',
          error: '固定结束时间不支持实时推送',
        }),
      });
      return;
    }

    closeRealtimeClient('realtime-restart');
    set({
      realtime: createIdleRealtimeState({
        enabled: true,
        status: 'connecting',
      }),
    });

    const client = new LogRealtimeClient(query, {
      onStatus: (status) => {
        if (realtimeClient !== client) return;
        set((latest) => ({
          realtime: {
            ...latest.realtime,
            status,
            error: status === 'error' ? latest.realtime.error : null,
          },
        }));
      },
      onSubscribed: (message) => {
        if (realtimeClient !== client) return;
        set((latest) => ({
          realtime: {
            ...latest.realtime,
            enabled: true,
            status: 'active',
            subscriptionId: message.subscriptionId,
            error: null,
          },
        }));
      },
      onEvents: (items) => {
        if (realtimeClient !== client) return;
        get().receiveRealtimeLogEvents(items);
      },
      onOverflow: (message) => {
        if (realtimeClient !== client) return;
        set((latest) => ({
          realtime: {
            ...latest.realtime,
            dropped: latest.realtime.dropped + message.dropped,
            error: message.message,
          },
        }));
      },
      onError: (message) => {
        if (realtimeClient !== client) return;
        closeRealtimeClient('realtime-error');
        set({
          realtime: createIdleRealtimeState({
            status: 'error',
            error: message,
          }),
        });
      },
      onClose: (reason) => {
        if (realtimeClient !== client) return;
        realtimeClient = null;
        set({
          realtime: createIdleRealtimeState(
            reason === 'connection-closed' ? { status: 'error', error: '实时日志连接已断开' } : {}
          ),
        });
      },
    });

    realtimeClient = client;
    try {
      client.connect();
    } catch (err) {
      if (realtimeClient === client) {
        realtimeClient = null;
      }
      set({
        realtime: createIdleRealtimeState({
          status: 'error',
          error: err instanceof Error ? err.message : '实时日志连接失败',
        }),
      });
    }
  },

  stopRealtime: (reason = 'manual-stop') => {
    closeRealtimeClient(reason);
    set({ realtime: createIdleRealtimeState() });
  },

  receiveRealtimeLogEvents: (items) => {
    if (items.length === 0) return;
    set((state) => ({
      items: mergeUniqueById(state.items, items, state.sort),
      realtime: {
        ...state.realtime,
        received: state.realtime.received + items.length,
      },
    }));
  },
}));
