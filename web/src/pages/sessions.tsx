import { useNavigate } from '@tanstack/react-router';
import { Radio, Search } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { SessionsDataTable } from '@/components/sessions/sessions-data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions-store';

function toDateTimeLocalValue(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function fromDateTimeLocalValue(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function SessionsPage() {
  const navigate = useNavigate();
  const filters = useSessionsStore((s) => s.filters);
  const summary = useSessionsStore((s) => s.summary);
  const users = useSessionsStore((s) => s.users);
  const meta = useSessionsStore((s) => s.meta);
  const from = useSessionsStore((s) => s.from);
  const to = useSessionsStore((s) => s.to);
  const loading = useSessionsStore((s) => s.loading);
  const error = useSessionsStore((s) => s.error);
  const appliedQuery = useSessionsStore((s) => s.appliedQuery);
  const realtime = useSessionsStore((s) => s.realtime);
  const setFilter = useSessionsStore((s) => s.setFilter);
  const fetchData = useSessionsStore((s) => s.fetchData);
  const resetFilters = useSessionsStore((s) => s.resetFilters);
  const startRealtime = useSessionsStore((s) => s.startRealtime);
  const stopRealtime = useSessionsStore((s) => s.stopRealtime);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    return () => stopRealtime('page-unmount');
  }, [stopRealtime]);

  const hasData = users.length > 0;

  const stats = useMemo(
    () => ({
      users: summary?.uniqueUsers ?? 0,
      sessions: summary?.uniqueSessions ?? 0,
      requests: summary?.totalRequests ?? 0,
      metadataRequests: summary?.metadataRequests ?? 0,
    }),
    [summary]
  );

  const queryStatus = useMemo(() => {
    if (!meta) return null;
    const parts = [
      typeof meta.queryMs === 'number' ? `查询 ${meta.queryMs} ms` : null,
      meta.indexUsed === false ? 'JSONL 回退' : meta.indexUsed ? 'SQLite 索引' : null,
      meta.fallbackReason,
    ];
    return parts.filter(Boolean).join(' · ');
  }, [meta]);

  const realtimeDisabledReason = useMemo(() => {
    if (loading) return '查询中';
    if (!appliedQuery) return '查询后可开启';
    if (appliedQuery.to) return '固定结束时间不支持';
    return null;
  }, [appliedQuery, loading]);

  function handleRealtimeToggle(checked: boolean) {
    if (checked) {
      void startRealtime();
      return;
    }
    stopRealtime('manual-stop');
  }

  function handleViewLogs(userKey: string, sessionId?: string) {
    void navigate({
      to: '/logs',
      search: { user: userKey, session: sessionId },
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">用户会话</h2>
        <p className="text-muted-foreground">
          解析日志 metadata 中的 user ↔ session 映射，查看活跃度并跳转日志检索
        </p>
      </div>

      <div className="rounded-lg border bg-background">
        <div className="border-b px-3 py-3">
          <h3 className="text-base font-semibold">检索条件</h3>
          <p className="text-sm text-muted-foreground">
            支持时间窗、范围、用户/会话精确筛选与关键词检索
          </p>
        </div>

        <div className="space-y-3 px-3 py-3">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5">
              <Label>时间窗口</Label>
              <Select
                value={filters.window}
                onValueChange={(v) =>
                  setFilter('window', v as '1h' | '6h' | '24h' | '7d' | '1mo' | '1y')
                }
              >
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1h">最近 1 小时</SelectItem>
                  <SelectItem value="6h">最近 6 小时</SelectItem>
                  <SelectItem value="24h">最近 24 小时</SelectItem>
                  <SelectItem value="7d">最近 7 天</SelectItem>
                  <SelectItem value="1mo">最近 1 个月</SelectItem>
                  <SelectItem value="1y">最近 1 年</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sessions-from">起始时间</Label>
              <Input
                id="sessions-from"
                type="datetime-local"
                className="h-8"
                value={toDateTimeLocalValue(filters.from)}
                onChange={(e) => setFilter('from', fromDateTimeLocalValue(e.target.value))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sessions-to">结束时间</Label>
              <Input
                id="sessions-to"
                type="datetime-local"
                className="h-8"
                value={toDateTimeLocalValue(filters.to)}
                onChange={(e) => setFilter('to', fromDateTimeLocalValue(e.target.value))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sessions-q">关键词</Label>
              <Input
                id="sessions-q"
                className="h-8"
                value={filters.q}
                onChange={(e) => setFilter('q', e.target.value)}
                placeholder="user/session/model/provider"
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="sessions-user">用户标识</Label>
              <Input
                id="sessions-user"
                className="h-8"
                value={filters.user}
                onChange={(e) => setFilter('user', e.target.value)}
                placeholder="userKey 或 raw user_id"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sessions-session">会话 ID</Label>
              <Input
                id="sessions-session"
                className="h-8"
                value={filters.session}
                onChange={(e) => setFilter('session', e.target.value)}
                placeholder="sessionId"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void fetchData()} disabled={loading}>
              <Search className="h-3.5 w-3.5" />
              查询
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void resetFilters()}
              disabled={loading}
            >
              重置
            </Button>
            <div className="flex h-8 items-center gap-2 rounded-md border px-2">
              <Radio
                className={cn(
                  'h-3.5 w-3.5',
                  realtime.status === 'active'
                    ? 'text-emerald-600'
                    : realtime.status === 'error'
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                )}
              />
              <Switch
                id="sessions-realtime"
                checked={realtime.enabled}
                disabled={!!realtimeDisabledReason}
                onCheckedChange={handleRealtimeToggle}
              />
              <Label htmlFor="sessions-realtime" className="text-sm">
                实时
              </Label>
              {realtime.status === 'active' ? (
                <Badge variant="outline" className="hidden sm:inline-flex">
                  +{realtime.received}
                </Badge>
              ) : null}
            </div>
            {from && to ? (
              <div className="text-xs text-muted-foreground">
                生效范围：{formatDateTime(from)} - {formatDateTime(to)}
              </div>
            ) : null}
            {realtime.status === 'connecting' ? (
              <span className="text-xs text-muted-foreground">实时连接中</span>
            ) : null}
            {realtime.error ? (
              <span className="text-xs text-destructive">{realtime.error}</span>
            ) : null}
            {!realtime.enabled && realtimeDisabledReason ? (
              <span className="text-xs text-muted-foreground">{realtimeDisabledReason}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatBox title="用户数" value={stats.users} />
        <StatBox title="会话数" value={stats.sessions} />
        <StatBox title="请求数" value={stats.requests} />
        <StatBox title="含 metadata 请求" value={stats.metadataRequests} />
      </div>

      <div className="rounded-lg border bg-background">
        <div className="border-b px-3 py-3">
          <h3 className="text-base font-semibold">用户与会话</h3>
          <p className="text-sm text-muted-foreground">
            {meta
              ? [
                  queryStatus,
                  `文件 ${meta.scannedFiles} · 行 ${meta.scannedLines} · 解析异常 ${meta.parseErrors}${meta.truncated ? ' · 已截断' : ''}`,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : '等待查询'}
          </p>
        </div>

        <div className="px-3 py-3">
          {error ? (
            <Empty className="min-h-[160px] p-6 md:p-6">
              <EmptyHeader>
                <EmptyTitle>用户会话查询失败</EmptyTitle>
                <EmptyDescription>{error}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : loading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !hasData ? (
            <Empty className="min-h-[220px] p-6 md:p-6">
              <EmptyHeader>
                <EmptyTitle>暂无可用用户会话</EmptyTitle>
                <EmptyDescription>
                  请确认 bodyPolicy 不为 off，并调整筛选条件后重试
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <SessionsDataTable users={users} onViewLogs={handleViewLogs} />
          )}
        </div>
      </div>
    </div>
  );
}

function StatBox({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-3">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}
