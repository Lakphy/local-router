import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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

function formatModelSummary(models: Array<{ key: string; count: number }>): string {
  if (models.length === 0) return '-';
  return models
    .slice(0, 3)
    .map((item) => `${item.key}(${item.count})`)
    .join(', ');
}

function compactText(value: string, keep = 6): string {
  if (value.length <= keep * 2 + 3) return value;
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
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
  const setFilter = useSessionsStore((s) => s.setFilter);
  const fetchData = useSessionsStore((s) => s.fetchData);
  const resetFilters = useSessionsStore((s) => s.resetFilters);

  const [expandedUsers, setExpandedUsers] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

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
                onValueChange={(v) => setFilter('window', v as '1h' | '6h' | '24h')}
              >
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1h">最近 1 小时</SelectItem>
                  <SelectItem value="6h">最近 6 小时</SelectItem>
                  <SelectItem value="24h">最近 24 小时</SelectItem>
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
            {from && to ? (
              <div className="text-xs text-muted-foreground">
                生效范围：{formatDateTime(from)} - {formatDateTime(to)}
              </div>
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
              ? `文件 ${meta.scannedFiles} · 行 ${meta.scannedLines} · 解析异常 ${meta.parseErrors}${meta.truncated ? ' · 已截断' : ''}`
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
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[46px]" />
                    <TableHead>用户</TableHead>
                    <TableHead>请求数</TableHead>
                    <TableHead>会话数</TableHead>
                    <TableHead>首次活跃</TableHead>
                    <TableHead>最近活跃</TableHead>
                    <TableHead>模型摘要</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>RouteType</TableHead>
                    <TableHead className="sticky right-0 z-10 bg-background text-right">
                      操作
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => {
                    const expanded = expandedUsers[user.userKey] ?? true;
                    return (
                      <Fragment key={user.userKey}>
                        <TableRow key={user.userKey}>
                          <TableCell>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              onClick={() =>
                                setExpandedUsers((current) => ({
                                  ...current,
                                  [user.userKey]: !expanded,
                                }))
                              }
                            >
                              {expanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </TableCell>
                          <TableCell className="font-mono text-xs" title={user.userKey}>
                            {compactText(user.userKey, 10)}
                          </TableCell>
                          <TableCell>{user.requestCount}</TableCell>
                          <TableCell>{user.sessionCount}</TableCell>
                          <TableCell className="text-xs">
                            {formatDateTime(user.firstSeenAt)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {formatDateTime(user.lastSeenAt)}
                          </TableCell>
                          <TableCell
                            className="max-w-[260px] truncate text-xs"
                            title={formatModelSummary(user.models)}
                          >
                            {formatModelSummary(user.models)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {user.providers.length}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {user.routeTypes.length}
                            </Badge>
                          </TableCell>
                          <TableCell className="sticky right-0 z-10 bg-background text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void navigate({
                                  to: '/logs',
                                  search: {
                                    user: user.userKey,
                                    session: undefined,
                                  },
                                })
                              }
                            >
                              查看日志
                            </Button>
                          </TableCell>
                        </TableRow>

                        {expanded
                          ? user.sessions.map((session) => (
                              <TableRow
                                key={`${user.userKey}-${session.sessionId}`}
                                className="bg-muted/20"
                              >
                                <TableCell />
                                <TableCell className="text-muted-foreground text-xs">
                                  ↳ 会话
                                </TableCell>
                                <TableCell>{session.requestCount}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {session.sessionId}
                                </TableCell>
                                <TableCell className="text-xs">
                                  {formatDateTime(session.firstSeenAt)}
                                </TableCell>
                                <TableCell className="text-xs">
                                  {formatDateTime(session.lastSeenAt)}
                                </TableCell>
                                <TableCell
                                  className="max-w-[260px] truncate text-xs"
                                  title={formatModelSummary(session.models)}
                                >
                                  {formatModelSummary(session.models)}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground" colSpan={2}>
                                  最近 requestId: {compactText(session.latestRequestId, 8)}
                                </TableCell>
                                <TableCell className="sticky right-0 z-10 bg-background text-right">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void navigate({
                                        to: '/logs',
                                        search: {
                                          user: user.userKey,
                                          session: session.sessionId,
                                        },
                                      })
                                    }
                                  >
                                    查看日志
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))
                          : null}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
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
