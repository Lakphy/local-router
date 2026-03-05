import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { LogConfig } from './config';
import { resolveLogBaseDir } from './config';
import { resolveLogSessionIdentity } from './log-session-identity';
import type { LogEvent } from './logger';

const MAX_LINES_SCANNED = 250_000;
const MAX_Q_LENGTH = 200;

interface CountItem {
  key: string;
  count: number;
}

export interface LogSessionSummary {
  sessionId: string;
  requestCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  models: CountItem[];
  latestRequestId: string;
}

export interface LogUserSummary {
  userKey: string;
  requestCount: number;
  sessionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  models: CountItem[];
  providers: CountItem[];
  routeTypes: CountItem[];
  sessions: LogSessionSummary[];
}

export interface LogSessionsSummary {
  totalRequests: number;
  metadataRequests: number;
  uniqueUsers: number;
  uniqueSessions: number;
}

export interface LogSessionsMeta {
  scannedFiles: number;
  scannedLines: number;
  parseErrors: number;
  truncated: boolean;
}

export interface LogSessionsResult {
  from: string;
  to: string;
  summary: LogSessionsSummary;
  users: LogUserSummary[];
  meta: LogSessionsMeta;
}

export interface LogSessionsContext {
  logConfig?: LogConfig;
}

export interface QueryLogSessionsInput {
  fromMs: number;
  toMs: number;
  users?: string[];
  sessions?: string[];
  q?: string;
}

interface NormalizedQueryInput {
  fromMs: number;
  toMs: number;
  users: string[];
  sessions: string[];
  q: string;
}

interface SessionAggregate {
  sessionId: string;
  requestCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
  latestRequestId: string;
  models: Map<string, number>;
}

interface UserAggregate {
  userKey: string;
  requestCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
  models: Map<string, number>;
  providers: Map<string, number>;
  routeTypes: Map<string, number>;
  sessions: Map<string, SessionAggregate>;
}

function toDayStart(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function listDateStrings(fromMs: number, toMs: number): string[] {
  const result: string[] = [];
  for (let day = toDayStart(fromMs); day <= toDayStart(toMs); day += 24 * 60 * 60 * 1000) {
    result.push(new Date(day).toISOString().slice(0, 10));
  }
  return result;
}

function normalizeInput(input: QueryLogSessionsInput): NormalizedQueryInput {
  const qRaw = (input.q ?? '').trim();
  return {
    fromMs: input.fromMs,
    toMs: input.toMs,
    users: (input.users ?? []).map((item) => item.trim()).filter(Boolean),
    sessions: (input.sessions ?? []).map((item) => item.trim()).filter(Boolean),
    q: qRaw.length > MAX_Q_LENGTH ? qRaw.slice(0, MAX_Q_LENGTH) : qRaw,
  };
}

function incrementCount(map: Map<string, number>, key: string): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toSortedCountItems(map: Map<string, number>): CountItem[] {
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function shouldIncludeByKeyword(event: LogEvent, keyword: string): boolean {
  if (!keyword) return true;
  const identity = resolveLogSessionIdentity(event.request_body);
  const haystack = [
    identity.userIdRaw ?? '',
    identity.userKey ?? '',
    identity.sessionId ?? '',
    event.provider,
    event.route_type,
    event.model_in,
    event.model_out,
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(keyword.toLowerCase());
}

function eventModel(event: LogEvent): string {
  return event.model_out || event.model_in;
}

function createEmptyResult(fromMs: number, toMs: number): LogSessionsResult {
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    summary: {
      totalRequests: 0,
      metadataRequests: 0,
      uniqueUsers: 0,
      uniqueSessions: 0,
    },
    users: [],
    meta: {
      scannedFiles: 0,
      scannedLines: 0,
      parseErrors: 0,
      truncated: false,
    },
  };
}

function ensureUserAggregate(
  usersMap: Map<string, UserAggregate>,
  userKey: string,
  tsMs: number
): UserAggregate {
  const existing = usersMap.get(userKey);
  if (existing) {
    if (tsMs < existing.firstSeenMs) existing.firstSeenMs = tsMs;
    if (tsMs > existing.lastSeenMs) existing.lastSeenMs = tsMs;
    return existing;
  }

  const created: UserAggregate = {
    userKey,
    requestCount: 0,
    firstSeenMs: tsMs,
    lastSeenMs: tsMs,
    models: new Map<string, number>(),
    providers: new Map<string, number>(),
    routeTypes: new Map<string, number>(),
    sessions: new Map<string, SessionAggregate>(),
  };
  usersMap.set(userKey, created);
  return created;
}

function ensureSessionAggregate(
  userAgg: UserAggregate,
  sessionId: string,
  tsMs: number,
  requestId: string
): SessionAggregate {
  const existing = userAgg.sessions.get(sessionId);
  if (existing) {
    if (tsMs < existing.firstSeenMs) existing.firstSeenMs = tsMs;
    if (tsMs >= existing.lastSeenMs) {
      existing.lastSeenMs = tsMs;
      existing.latestRequestId = requestId;
    }
    return existing;
  }

  const created: SessionAggregate = {
    sessionId,
    requestCount: 0,
    firstSeenMs: tsMs,
    lastSeenMs: tsMs,
    latestRequestId: requestId,
    models: new Map<string, number>(),
  };
  userAgg.sessions.set(sessionId, created);
  return created;
}

export async function queryLogSessions(
  context: LogSessionsContext,
  input: QueryLogSessionsInput
): Promise<LogSessionsResult> {
  const normalized = normalizeInput(input);

  const logEnabled = !!context.logConfig && context.logConfig.enabled !== false;
  if (!logEnabled) {
    return createEmptyResult(normalized.fromMs, normalized.toMs);
  }

  const baseDir = resolveLogBaseDir(context.logConfig);
  const eventsDir = join(baseDir, 'events');
  if (!existsSync(eventsDir)) {
    return createEmptyResult(normalized.fromMs, normalized.toMs);
  }

  const usersMap = new Map<string, UserAggregate>();
  const uniqueUsers = new Set<string>();
  const uniqueSessions = new Set<string>();

  let totalRequests = 0;
  let metadataRequests = 0;

  let scannedFiles = 0;
  let scannedLines = 0;
  let parseErrors = 0;
  let truncated = false;

  const dateStrings = listDateStrings(normalized.fromMs, normalized.toMs);

  for (const date of dateStrings) {
    if (scannedLines >= MAX_LINES_SCANNED) {
      truncated = true;
      break;
    }

    const filePath = join(eventsDir, `${date}.jsonl`);
    if (!existsSync(filePath)) continue;

    scannedFiles += 1;
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    for await (const line of rl) {
      if (scannedLines >= MAX_LINES_SCANNED) {
        truncated = true;
        rl.close();
        stream.destroy();
        break;
      }

      scannedLines += 1;
      if (!line.trim()) continue;

      let event: LogEvent;
      try {
        event = JSON.parse(line) as LogEvent;
      } catch {
        parseErrors += 1;
        continue;
      }

      if (!event.ts_start) continue;
      const tsMs = Date.parse(event.ts_start);
      if (!Number.isFinite(tsMs) || tsMs < normalized.fromMs || tsMs > normalized.toMs) continue;

      const identity = resolveLogSessionIdentity(event.request_body);

      if (normalized.users.length > 0) {
        const matchedByRaw = identity.userIdRaw
          ? normalized.users.includes(identity.userIdRaw)
          : false;
        const matchedByUserKey = identity.userKey
          ? normalized.users.includes(identity.userKey)
          : false;
        if (!matchedByRaw && !matchedByUserKey) continue;
      }

      if (normalized.sessions.length > 0) {
        if (!identity.sessionId || !normalized.sessions.includes(identity.sessionId)) continue;
      }

      if (!shouldIncludeByKeyword(event, normalized.q)) continue;

      totalRequests += 1;
      if (identity.hasMetadata) metadataRequests += 1;

      if (identity.userKey) {
        uniqueUsers.add(identity.userKey);
      }

      if (!identity.userKey || !identity.sessionId) continue;

      const userAgg = ensureUserAggregate(usersMap, identity.userKey, tsMs);
      userAgg.requestCount += 1;
      incrementCount(userAgg.models, eventModel(event));
      incrementCount(userAgg.providers, event.provider);
      incrementCount(userAgg.routeTypes, event.route_type);

      const sessionAgg = ensureSessionAggregate(
        userAgg,
        identity.sessionId,
        tsMs,
        event.request_id
      );
      sessionAgg.requestCount += 1;
      incrementCount(sessionAgg.models, eventModel(event));

      uniqueSessions.add(identity.sessionId);
    }
  }

  const users: LogUserSummary[] = Array.from(usersMap.values())
    .map((user) => {
      const sessions: LogSessionSummary[] = Array.from(user.sessions.values())
        .map((session) => ({
          sessionId: session.sessionId,
          requestCount: session.requestCount,
          firstSeenAt: new Date(session.firstSeenMs).toISOString(),
          lastSeenAt: new Date(session.lastSeenMs).toISOString(),
          models: toSortedCountItems(session.models),
          latestRequestId: session.latestRequestId,
        }))
        .sort((a, b) => {
          if (a.requestCount !== b.requestCount) return b.requestCount - a.requestCount;
          return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
        });

      return {
        userKey: user.userKey,
        requestCount: user.requestCount,
        sessionCount: sessions.length,
        firstSeenAt: new Date(user.firstSeenMs).toISOString(),
        lastSeenAt: new Date(user.lastSeenMs).toISOString(),
        models: toSortedCountItems(user.models),
        providers: toSortedCountItems(user.providers),
        routeTypes: toSortedCountItems(user.routeTypes),
        sessions,
      };
    })
    .sort((a, b) => {
      if (a.requestCount !== b.requestCount) return b.requestCount - a.requestCount;
      return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
    });

  return {
    from: new Date(normalized.fromMs).toISOString(),
    to: new Date(normalized.toMs).toISOString(),
    summary: {
      totalRequests,
      metadataRequests,
      uniqueUsers: uniqueUsers.size,
      uniqueSessions: uniqueSessions.size,
    },
    users,
    meta: {
      scannedFiles,
      scannedLines,
      parseErrors,
      truncated,
    },
  };
}
