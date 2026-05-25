import { useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronDown, Download, Radio, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { LogsDataTable } from '@/components/logs/logs-data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
import { exportLogEvents } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useLogsStore } from '@/stores/logs-store';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

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

function formatCompact(value: number | null | undefined): string {
  return Intl.NumberFormat(undefined, {
    notation: Math.abs(value ?? 0) >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value ?? 0);
}

function formatPercent(value: number | null | undefined): string {
  return `${(value ?? 0).toFixed(2).replace(/\.?0+$/, '')}%`;
}

export function LogsPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/logs' });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filters = useLogsStore((s) => s.filters);
  const sort = useLogsStore((s) => s.sort);
  const appliedQuery = useLogsStore((s) => s.appliedQuery);
  const items = useLogsStore((s) => s.items);
  const hasMore = useLogsStore((s) => s.hasMore);
  const stats = useLogsStore((s) => s.stats);
  const meta = useLogsStore((s) => s.meta);
  const loading = useLogsStore((s) => s.loading);
  const loadingMore = useLogsStore((s) => s.loadingMore);
  const error = useLogsStore((s) => s.error);
  const realtime = useLogsStore((s) => s.realtime);

  const setFilter = useLogsStore((s) => s.setFilter);
  const setSort = useLogsStore((s) => s.setSort);
  const applyFilters = useLogsStore((s) => s.applyFilters);
  const resetFilters = useLogsStore((s) => s.resetFilters);
  const fetchNextPage = useLogsStore((s) => s.fetchNextPage);
  const startRealtime = useLogsStore((s) => s.startRealtime);
  const stopRealtime = useLogsStore((s) => s.stopRealtime);

  useEffect(() => {
    if (search.user) {
      setFilter('user', search.user);
    }
    if (search.session) {
      setFilter('session', search.session);
    }

    void applyFilters();
  }, [applyFilters, search.user, search.session, setFilter]);

  useEffect(() => {
    return () => stopRealtime('page-unmount');
  }, [stopRealtime]);

  const providerOptions = useMemo(
    () =>
      Array.from(new Set(items.map((item) => item.provider))).sort((a, b) => a.localeCompare(b)),
    [items]
  );
  const routeTypeOptions = useMemo(
    () =>
      Array.from(new Set(items.map((item) => item.routeType))).sort((a, b) => a.localeCompare(b)),
    [items]
  );
  const modelOptions = useMemo(
    () =>
      Array.from(new Set(items.map((item) => item.modelIn).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [items]
  );
  const modelOutOptions = useMemo(
    () =>
      Array.from(new Set(items.map((item) => item.modelOut).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [items]
  );
  const activeAdvancedFilterLabels = useMemo(() => {
    const labels: string[] = [];
    if (filters.from) labels.push('起始时间');
    if (filters.to) labels.push('结束时间');
    if (filters.q) labels.push('关键词');
    if (filters.levels.length > 0) labels.push('级别');
    if (filters.provider) labels.push('Provider');
    if (filters.routeType) labels.push('路由类型');
    if (filters.modelIn) labels.push('原始模型');
    if (filters.modelOut) labels.push('路由模型');
    if (filters.hasError !== 'all') labels.push('是否错误');
    if (filters.user) labels.push('用户标识');
    if (filters.statusClass.length > 0) labels.push('状态');
    return labels;
  }, [filters]);
  const queryStatus = useMemo(() => {
    if (!meta) return null;
    const parts = [
      typeof meta.queryMs === 'number' ? `查询 ${meta.queryMs} ms` : null,
      meta.indexUsed ? 'SQLite 索引' : 'JSONL 回退',
      meta.fallbackReason,
    ];
    return parts.filter(Boolean).join(' · ');
  }, [meta]);
  const realtimeDisabledReason = useMemo(() => {
    if (loading) return '查询中';
    if (!appliedQuery) return '查询后可开启';
    if (sort !== 'time_desc') return '按时间倒序时可开启';
    if (appliedQuery.to) return '固定结束时间不支持';
    return null;
  }, [appliedQuery, loading, sort]);

  async function handleExport(format: 'csv' | 'json') {
    try {
      const blob = await exportLogEvents(
        {
          window: filters.window,
          from: filters.from || undefined,
          to: filters.to || undefined,
          levels: filters.levels,
          provider: filters.provider || undefined,
          routeType: filters.routeType || undefined,
          modelIn: filters.modelIn || undefined,
          modelOut: filters.modelOut || undefined,
          user: filters.user || undefined,
          session: filters.session || undefined,
          statusClass: filters.statusClass,
          hasError: filters.hasError === 'all' ? undefined : filters.hasError === 'true',
          q: filters.q || undefined,
          sort,
        },
        format
      );
      downloadBlob(blob, `logs-export.${format}`);
      toast.success(`已导出 ${format.toUpperCase()} 文件`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导出失败');
    }
  }

  function handleRealtimeToggle(checked: boolean) {
    if (checked) {
      void startRealtime();
      return;
    }
    stopRealtime('manual-stop');
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">日志检索</h2>
        <p className="text-muted-foreground">多条件过滤、详情定位与导出</p>
      </div>

      <Collapsible
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        className="rounded-lg border bg-background"
      >
        <div className="space-y-3 px-3 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="w-full space-y-1.5 sm:w-48">
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

              <div className="w-full space-y-1.5 sm:w-64">
                <Label htmlFor="session-id">会话 ID</Label>
                <Input
                  id="session-id"
                  className="h-8"
                  value={filters.session}
                  onChange={(e) => setFilter('session', e.target.value)}
                  placeholder="sessionId"
                />
              </div>

              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full justify-between sm:w-auto"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    高级筛选
                    {activeAdvancedFilterLabels.length > 0 ? (
                      <Badge variant="secondary" className="ml-1">
                        {activeAdvancedFilterLabels.length}
                      </Badge>
                    ) : null}
                  </span>
                  <ChevronDown
                    className={cn('h-3.5 w-3.5 transition-transform', filtersOpen && 'rotate-180')}
                  />
                </Button>
              </CollapsibleTrigger>
            </div>

            <div className="flex flex-wrap items-center gap-2">
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
                  id="logs-realtime"
                  checked={realtime.enabled}
                  disabled={!!realtimeDisabledReason}
                  onCheckedChange={handleRealtimeToggle}
                />
                <Label htmlFor="logs-realtime" className="text-sm">
                  实时
                </Label>
                {realtime.status === 'active' ? (
                  <Badge variant="outline" className="hidden sm:inline-flex">
                    +{realtime.received}
                  </Badge>
                ) : null}
              </div>
              <Button size="sm" onClick={() => void applyFilters()} disabled={loading}>
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
              <Button size="sm" variant="outline" onClick={() => void handleExport('csv')}>
                <Download className="h-3.5 w-3.5" />
                导出 CSV
              </Button>
              <Button size="sm" variant="outline" onClick={() => void handleExport('json')}>
                <Download className="h-3.5 w-3.5" />
                导出 JSON
              </Button>
            </div>
          </div>

          {activeAdvancedFilterLabels.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>已启用</span>
              {activeAdvancedFilterLabels.slice(0, 6).map((label) => (
                <Badge key={label} variant="outline">
                  {label}
                </Badge>
              ))}
              {activeAdvancedFilterLabels.length > 6 ? (
                <Badge variant="outline">+{activeAdvancedFilterLabels.length - 6}</Badge>
              ) : null}
            </div>
          ) : null}

          <CollapsibleContent className="space-y-3 border-t pt-3">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="from">起始时间</Label>
                <Input
                  id="from"
                  type="datetime-local"
                  className="h-8"
                  value={toDateTimeLocalValue(filters.from)}
                  onChange={(e) => setFilter('from', fromDateTimeLocalValue(e.target.value))}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="to">结束时间</Label>
                <Input
                  id="to"
                  type="datetime-local"
                  className="h-8"
                  value={toDateTimeLocalValue(filters.to)}
                  onChange={(e) => setFilter('to', fromDateTimeLocalValue(e.target.value))}
                />
              </div>

              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="keyword">关键词</Label>
                <Input
                  id="keyword"
                  className="h-8"
                  value={filters.q}
                  onChange={(e) => setFilter('q', e.target.value)}
                  placeholder="request id / path / message"
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
              <div className="space-y-1.5">
                <Label>级别</Label>
                <Select
                  value={filters.levels.length === 0 ? 'all' : filters.levels.join(',')}
                  onValueChange={(v) =>
                    setFilter(
                      'levels',
                      v === 'all' ? [] : (v.split(',') as Array<'info' | 'error'>)
                    )
                  }
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部</SelectItem>
                    <SelectItem value="info">info</SelectItem>
                    <SelectItem value="error">error</SelectItem>
                    <SelectItem value="info,error">info + error</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Provider</Label>
                <Select
                  value={filters.provider || 'all'}
                  onValueChange={(v) => setFilter('provider', v === 'all' ? '' : v)}
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部</SelectItem>
                    {providerOptions.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>路由类型</Label>
                <Select
                  value={filters.routeType || 'all'}
                  onValueChange={(v) => setFilter('routeType', v === 'all' ? '' : v)}
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部</SelectItem>
                    {routeTypeOptions.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>原始模型</Label>
                <Select
                  value={filters.modelIn || 'all'}
                  onValueChange={(v) => setFilter('modelIn', v === 'all' ? '' : v)}
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部</SelectItem>
                    {modelOptions.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>路由模型</Label>
                <Select
                  value={filters.modelOut || 'all'}
                  onValueChange={(v) => setFilter('modelOut', v === 'all' ? '' : v)}
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部</SelectItem>
                    {modelOutOptions.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>是否错误</Label>
                <Select
                  value={filters.hasError}
                  onValueChange={(v) => setFilter('hasError', v as 'all' | 'true' | 'false')}
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部</SelectItem>
                    <SelectItem value="true">仅错误</SelectItem>
                    <SelectItem value="false">仅成功</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="user-key">用户标识</Label>
                <Input
                  id="user-key"
                  className="h-8"
                  value={filters.user}
                  onChange={(e) => setFilter('user', e.target.value)}
                  placeholder="userKey 或原始 user_id"
                />
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <StatBox title="总条数" value={stats?.total ?? 0} />
        <StatBox title="Total Token" value={formatCompact(stats?.totalTokens)} />
        <StatBox title="Input Token" value={formatCompact(stats?.inputTokens)} />
        <StatBox title="Output Token" value={formatCompact(stats?.outputTokens)} />
        <StatBox title="缓存命中率" value={formatPercent(stats?.cacheHitRate)} />
        <StatBox title="缓存命中 Token" value={formatCompact(stats?.cacheHitInputTokens)} />
        <StatBox title="错误率" value={formatPercent(stats?.errorRate)} />
        <StatBox title="P95" value={`${stats?.p95LatencyMs ?? 0} ms`} />
      </div>

      <div className="space-y-3">
        {queryStatus ? (
          <div className="flex min-h-5 flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
            {realtime.status === 'connecting' ? <span>实时连接中</span> : null}
            {realtime.error ? <span className="text-destructive">{realtime.error}</span> : null}
            {!realtime.enabled && realtimeDisabledReason ? (
              <span>{realtimeDisabledReason}</span>
            ) : null}
            <span>{queryStatus}</span>
          </div>
        ) : null}

        {error ? (
          <Empty className="min-h-[160px] p-6 md:p-6">
            <EmptyHeader>
              <EmptyTitle>日志检索失败</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : loading && items.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : items.length === 0 ? (
          <Empty className="min-h-[200px] p-6 md:p-6">
            <EmptyHeader>
              <EmptyTitle>没有匹配日志</EmptyTitle>
              <EmptyDescription>请调整筛选条件后重试</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <LogsDataTable
              data={items}
              sort={sort}
              onSortChange={(next) => void setSort(next)}
              onRowClick={(item) => void navigate({ to: '/logs/$id', params: { id: item.id } })}
            />

            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">已加载 {items.length} 条</div>
              <Button
                size="sm"
                variant="outline"
                disabled={!hasMore || loadingMore}
                onClick={() => void fetchNextPage()}
              >
                {loadingMore ? '加载中...' : hasMore ? '加载更多' : '已到底部'}
              </Button>
            </div>
          </>
        )}
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
