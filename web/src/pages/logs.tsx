import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download, Radio, RefreshCw, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { LogsDataTable } from '@/components/logs/logs-data-table';
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
import { exportLogEvents } from '@/lib/api';
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

export function LogsPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/logs' });
  const filters = useLogsStore((s) => s.filters);
  const sort = useLogsStore((s) => s.sort);
  const items = useLogsStore((s) => s.items);
  const hasMore = useLogsStore((s) => s.hasMore);
  const stats = useLogsStore((s) => s.stats);
  const meta = useLogsStore((s) => s.meta);
  const loading = useLogsStore((s) => s.loading);
  const loadingMore = useLogsStore((s) => s.loadingMore);
  const error = useLogsStore((s) => s.error);
  const autoRefreshEnabled = useLogsStore((s) => s.autoRefreshEnabled);
  const refreshIntervalSec = useLogsStore((s) => s.refreshIntervalSec);
  const savedViews = useLogsStore((s) => s.savedViews);
  const tailEnabled = useLogsStore((s) => s.tailEnabled);
  const tailConnected = useLogsStore((s) => s.tailConnected);
  const tailError = useLogsStore((s) => s.tailError);

  const setFilter = useLogsStore((s) => s.setFilter);
  const setSort = useLogsStore((s) => s.setSort);
  const applyFilters = useLogsStore((s) => s.applyFilters);
  const resetFilters = useLogsStore((s) => s.resetFilters);
  const fetchNextPage = useLogsStore((s) => s.fetchNextPage);
  const setAutoRefreshEnabled = useLogsStore((s) => s.setAutoRefreshEnabled);
  const setRefreshIntervalSec = useLogsStore((s) => s.setRefreshIntervalSec);
  const saveCurrentView = useLogsStore((s) => s.saveCurrentView);
  const applySavedView = useLogsStore((s) => s.applySavedView);
  const deleteSavedView = useLogsStore((s) => s.deleteSavedView);
  const setTailEnabled = useLogsStore((s) => s.setTailEnabled);

  const [savedViewName, setSavedViewName] = useState('');

  useEffect(() => {
    if (search.user) {
      setFilter('user', search.user);
    }
    if (search.session) {
      setFilter('session', search.session);
    }

    void applyFilters();
  }, [applyFilters, search.user, search.session, setFilter]);

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

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">日志检索</h2>
        <p className="text-muted-foreground">多条件过滤、详情定位、导出与实时追踪</p>
      </div>

      <div className="rounded-lg border bg-background">
        <div className="border-b px-3 py-3">
          <h3 className="text-base font-semibold">检索条件</h3>
          <p className="text-sm text-muted-foreground">支持窗口、范围、关键词与多维过滤</p>
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

            <div className="space-y-1.5">
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
                  setFilter('levels', v === 'all' ? [] : (v.split(',') as Array<'info' | 'error'>))
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

            <div className="space-y-1.5">
              <Label htmlFor="session-id">会话 ID</Label>
              <Input
                id="session-id"
                className="h-8"
                value={filters.session}
                onChange={(e) => setFilter('session', e.target.value)}
                placeholder="sessionId"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatBox title="总条数" value={stats?.total ?? 0} />
        <StatBox title="错误率" value={`${stats?.errorRate ?? 0}%`} />
        <StatBox title="P95" value={`${stats?.p95LatencyMs ?? 0} ms`} />
        <StatBox title="平均延迟" value={`${stats?.avgLatencyMs ?? 0} ms`} />
        <StatBox title="扫描行数" value={meta?.scannedLines ?? 0} />
      </div>

      <div className="rounded-lg border bg-background">
        <div className="border-b px-3 py-3">
          <h3 className="text-base font-semibold">结果列表</h3>
          <p className="text-sm text-muted-foreground">
            {meta
              ? `文件 ${meta.scannedFiles} · 行 ${meta.scannedLines} · 解析异常 ${meta.parseErrors}${meta.truncated ? ' · 已截断' : ''}`
              : '等待查询'}
          </p>
        </div>
        <div className="space-y-3 px-3 py-3">
          {error ? (
            <Empty className="min-h-[160px] p-6 md:p-6">
              <EmptyHeader>
                <EmptyTitle>日志检索失败</EmptyTitle>
                <EmptyDescription>{error}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : loading ? (
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
                onSortChange={setSort}
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

      <div className="rounded-lg border bg-background">
        <div className="border-b px-3 py-3">
          <h3 className="text-base font-semibold">增强功能</h3>
          <p className="text-sm text-muted-foreground">预设视图、自动刷新、实时追踪（可选）</p>
        </div>
        <div className="space-y-4 px-3 py-3">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch checked={autoRefreshEnabled} onCheckedChange={setAutoRefreshEnabled} />
              <span className="text-sm">自动刷新</span>
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
            </div>

            <div className="flex items-center gap-2">
              <Label className="text-sm">间隔</Label>
              <Select
                value={String(refreshIntervalSec)}
                onValueChange={(v) => setRefreshIntervalSec(Number.parseInt(v, 10) || 5)}
              >
                <SelectTrigger className="h-8 w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">3 秒</SelectItem>
                  <SelectItem value="5">5 秒</SelectItem>
                  <SelectItem value="10">10 秒</SelectItem>
                  <SelectItem value="30">30 秒</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Switch checked={tailEnabled} onCheckedChange={setTailEnabled} />
              <span className="text-sm">实时追踪</span>
              <Radio className="h-4 w-4 text-muted-foreground" />
              {tailEnabled ? (
                <Badge variant={tailConnected ? 'outline' : 'secondary'}>
                  {tailConnected ? '已连接' : '连接中'}
                </Badge>
              ) : null}
            </div>
          </div>

          {tailError ? <div className="text-xs text-destructive">{tailError}</div> : null}

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                className="h-8 max-w-sm"
                value={savedViewName}
                onChange={(e) => setSavedViewName(e.target.value)}
                placeholder="输入视图名称"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!savedViewName.trim()) return;
                  saveCurrentView(savedViewName.trim());
                  setSavedViewName('');
                }}
              >
                <Save className="h-3.5 w-3.5" />
                保存当前筛选
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              {savedViews.length === 0 ? (
                <div className="text-xs text-muted-foreground">暂无预设视图</div>
              ) : (
                savedViews.map((view) => (
                  <div
                    key={view.id}
                    className="flex items-center gap-1 rounded-md border px-2 py-1"
                  >
                    <button
                      type="button"
                      className="text-xs hover:underline"
                      onClick={() => void applySavedView(view.id)}
                    >
                      {view.name}
                    </button>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => deleteSavedView(view.id)}
                    >
                      删除
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
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
