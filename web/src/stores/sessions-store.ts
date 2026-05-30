import { create } from 'zustand';
import {
  type FetchLogEventsParams,
  type FetchLogSessionsParams,
  fetchLogSessions,
  type LogEventSummary,
  type LogSessionsResponse,
  type LogUserSummary,
} from '@/lib/api';
import { LogRealtimeClient, type LogRealtimeStatus } from '@/lib/log-realtime-client';

export interface SessionsFilters {
  window: '1h' | '6h' | '24h' | '7d' | '1mo' | '1y';
  from: string;
  to: string;
  user: string;
  session: string;
  q: string;
}

interface SessionsRealtimeState {
  enabled: boolean;
  status: LogRealtimeStatus;
  subscriptionId: string | null;
  error: string | null;
  received: number;
  dropped: number;
}

interface SessionsState {
  filters: SessionsFilters;
  appliedQuery: FetchLogEventsParams | null;
  summary: LogSessionsResponse['summary'] | null;
  users: LogSessionsResponse['users'];
  meta: LogSessionsResponse['meta'] | null;
  from: string;
  to: string;
  realtime: SessionsRealtimeState;
  loading: boolean;
  error: string | null;
}

interface SessionsActions {
  setFilter: <K extends keyof SessionsFilters>(key: K, value: SessionsFilters[K]) => void;
  fetchData: () => Promise<void>;
  resetFilters: () => Promise<void>;
  startRealtime: () => Promise<void>;
  stopRealtime: (reason?: string) => void;
  receiveRealtimeEvents: (items: LogEventSummary[]) => void;
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

let fetchController: AbortController | null = null;
let fetchRequestSeq = 0;
let realtimeClient: LogRealtimeClient | null = null;

// Realtime fold bookkeeping (module-level, reset on each query / realtime start).
let realtimeSinceMs = Number.POSITIVE_INFINITY;
let seenEventIds = new Set<string>();
let knownUserKeys = new Set<string>();
let knownSessionKeys = new Set<string>();

const IDLE_REALTIME_STATE: SessionsRealtimeState = {
  enabled: false,
  status: 'idle',
  subscriptionId: null,
  error: null,
  received: 0,
  dropped: 0,
};

function createIdleRealtimeState(
  overrides: Partial<SessionsRealtimeState> = {}
): SessionsRealtimeState {
  return { ...IDLE_REALTIME_STATE, ...overrides };
}

function buildSessionsRequest(filters: SessionsFilters): FetchLogSessionsParams {
  return {
    window: filters.window,
    from: filters.from || undefined,
    to: filters.to || undefined,
    user: filters.user || undefined,
    session: filters.session || undefined,
    q: filters.q || undefined,
  };
}

function buildRealtimeQuery(filters: SessionsFilters): FetchLogEventsParams {
  return {
    window: filters.window,
    from: filters.from || undefined,
    to: filters.to || undefined,
    user: filters.user || undefined,
    session: filters.session || undefined,
    q: filters.q || undefined,
    sort: 'time_desc',
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function closeRealtimeClient(reason: string): void {
  const client = realtimeClient;
  realtimeClient = null;
  client?.close(reason);
}

function bumpCount(
  items: Array<{ key: string; count: number }>,
  key: string
): Array<{ key: string; count: number }> {
  if (!key) return items;
  const index = items.findIndex((item) => item.key === key);
  let next: Array<{ key: string; count: number }>;
  if (index >= 0) {
    next = items.slice();
    next[index] = { key, count: next[index].count + 1 };
  } else {
    next = [...items, { key, count: 1 }];
  }
  return next.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function sortByActivity<T extends { requestCount: number; lastSeenAt: string }>(
  a: T,
  b: T
): number {
  if (a.requestCount !== b.requestCount) return b.requestCount - a.requestCount;
  return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
}

interface FoldResult {
  summary: NonNullable<SessionsState['summary']>;
  users: LogUserSummary[];
  folded: number;
}

function foldSessionEvents(state: SessionsState, items: LogEventSummary[]): FoldResult | null {
  const summary = {
    totalRequests: state.summary?.totalRequests ?? 0,
    metadataRequests: state.summary?.metadataRequests ?? 0,
    uniqueUsers: state.summary?.uniqueUsers ?? 0,
    uniqueSessions: state.summary?.uniqueSessions ?? 0,
  };
  const userMap = new Map<string, LogUserSummary>(state.users.map((u) => [u.userKey, u]));
  const touchedUsers = new Set<string>();
  let folded = 0;

  for (const event of items) {
    const tsMs = Date.parse(event.ts);
    if (!Number.isFinite(tsMs) || tsMs <= realtimeSinceMs) continue;
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    folded += 1;

    summary.totalRequests += 1;
    if (event.hasMetadata) summary.metadataRequests += 1;

    const userKey = event.userKey;
    if (userKey && !knownUserKeys.has(userKey)) {
      knownUserKeys.add(userKey);
      summary.uniqueUsers += 1;
    }

    const sessionId = event.sessionId;
    if (!userKey || !sessionId) continue;

    const sessionKey = `${userKey} ${sessionId}`;
    if (!knownSessionKeys.has(sessionKey)) {
      knownSessionKeys.add(sessionKey);
      summary.uniqueSessions += 1;
    }

    const model = event.modelOut || event.modelIn;
    const existing = userMap.get(userKey);
    const user: LogUserSummary = existing
      ? {
          ...existing,
          models: existing.models.slice(),
          providers: existing.providers.slice(),
          routeTypes: existing.routeTypes.slice(),
          sessions: existing.sessions.slice(),
        }
      : {
          userKey,
          requestCount: 0,
          sessionCount: 0,
          firstSeenAt: event.ts,
          lastSeenAt: event.ts,
          models: [],
          providers: [],
          routeTypes: [],
          sessions: [],
        };

    user.requestCount += 1;
    if (tsMs < Date.parse(user.firstSeenAt)) user.firstSeenAt = event.ts;
    if (tsMs > Date.parse(user.lastSeenAt)) user.lastSeenAt = event.ts;
    user.models = bumpCount(user.models, model);
    user.providers = bumpCount(user.providers, event.provider);
    user.routeTypes = bumpCount(user.routeTypes, event.routeType);

    const sessionIndex = user.sessions.findIndex((s) => s.sessionId === sessionId);
    const session =
      sessionIndex >= 0
        ? { ...user.sessions[sessionIndex], models: user.sessions[sessionIndex].models.slice() }
        : {
            sessionId,
            requestCount: 0,
            firstSeenAt: event.ts,
            lastSeenAt: event.ts,
            models: [] as Array<{ key: string; count: number }>,
            latestRequestId: event.requestId,
          };

    session.requestCount += 1;
    if (tsMs < Date.parse(session.firstSeenAt)) session.firstSeenAt = event.ts;
    if (tsMs >= Date.parse(session.lastSeenAt)) {
      session.lastSeenAt = event.ts;
      session.latestRequestId = event.requestId;
    }
    session.models = bumpCount(session.models, model);

    if (sessionIndex >= 0) user.sessions[sessionIndex] = session;
    else user.sessions.push(session);

    user.sessionCount = user.sessions.length;
    userMap.set(userKey, user);
    touchedUsers.add(userKey);
  }

  if (folded === 0) return null;

  // Sort sessions once per touched user after folding the whole batch rather than on every
  // event. Only touched users hold freshly-cloned arrays; untouched ones are shared state.
  for (const userKey of touchedUsers) {
    userMap.get(userKey)?.sessions.sort(sortByActivity);
  }

  const users = Array.from(userMap.values()).sort(sortByActivity);
  return { summary, users, folded };
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  filters: { ...DEFAULT_FILTERS },
  appliedQuery: null,
  summary: null,
  users: [],
  meta: null,
  from: '',
  to: '',
  realtime: createIdleRealtimeState(),
  loading: false,
  error: null,

  setFilter: (key, value) => {
    closeRealtimeClient('filter-changed');
    set((state) => ({
      filters: { ...state.filters, [key]: value },
      appliedQuery: null,
      realtime: createIdleRealtimeState(),
    }));
  },

  fetchData: async () => {
    closeRealtimeClient('query-refresh');
    fetchController?.abort();
    const controller = new AbortController();
    fetchController = controller;
    const requestSeq = ++fetchRequestSeq;
    const filtersSnapshot = get().filters;

    set({
      loading: true,
      error: null,
      appliedQuery: null,
      realtime: createIdleRealtimeState(),
    });

    try {
      const data = await fetchLogSessions(buildSessionsRequest(filtersSnapshot));
      if (requestSeq !== fetchRequestSeq) return;
      set({
        appliedQuery: buildRealtimeQuery(filtersSnapshot),
        summary: data.summary,
        users: data.users,
        meta: data.meta,
        from: data.from,
        to: data.to,
        loading: false,
        error: null,
      });
    } catch (err) {
      if (isAbortError(err) || requestSeq !== fetchRequestSeq) return;
      set({
        loading: false,
        error: err instanceof Error ? err.message : '用户会话查询失败',
      });
    } finally {
      if (fetchController === controller) {
        fetchController = null;
      }
    }
  },

  resetFilters: async () => {
    closeRealtimeClient('reset-filters');
    set({
      filters: { ...DEFAULT_FILTERS },
      appliedQuery: null,
      realtime: createIdleRealtimeState(),
    });
    await get().fetchData();
  },

  startRealtime: async () => {
    const state = get();
    const query = state.appliedQuery;
    if (!query) {
      set({
        realtime: createIdleRealtimeState({ status: 'error', error: '请先查询后再开启实时推送' }),
      });
      return;
    }
    if (query.to) {
      set({
        realtime: createIdleRealtimeState({ status: 'error', error: '固定结束时间不支持实时推送' }),
      });
      return;
    }

    closeRealtimeClient('realtime-restart');

    // Seed fold bookkeeping from the current snapshot.
    realtimeSinceMs = state.to ? Date.parse(state.to) : Date.now();
    seenEventIds = new Set<string>();
    knownUserKeys = new Set<string>(state.users.map((u) => u.userKey));
    knownSessionKeys = new Set<string>(
      state.users.flatMap((u) => u.sessions.map((s) => `${u.userKey} ${s.sessionId}`))
    );

    set({ realtime: createIdleRealtimeState({ enabled: true, status: 'connecting' }) });

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
        get().receiveRealtimeEvents(items);
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
        set({ realtime: createIdleRealtimeState({ status: 'error', error: message }) });
      },
      onClose: (reason) => {
        if (realtimeClient !== client) return;
        realtimeClient = null;
        set({
          realtime: createIdleRealtimeState(
            reason === 'connection-closed' ? { status: 'error', error: '实时连接已断开' } : {}
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
          error: err instanceof Error ? err.message : '实时连接失败',
        }),
      });
    }
  },

  stopRealtime: (reason = 'manual-stop') => {
    closeRealtimeClient(reason);
    set({ realtime: createIdleRealtimeState() });
  },

  receiveRealtimeEvents: (items) => {
    if (items.length === 0) return;
    const result = foldSessionEvents(get(), items);
    if (!result) return;
    set((state) => ({
      summary: result.summary,
      users: result.users,
      realtime: {
        ...state.realtime,
        received: state.realtime.received + result.folded,
      },
    }));
  },
}));
