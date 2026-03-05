import { BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { DashboardPanel } from '@/components/dashboard/panel';
import type { LogMetricsResponse, LogMetricsWindow } from '@/types/config';

interface MetricsPanelProps {
  metricsLoading: boolean;
  metricsError: string | null;
  metrics: LogMetricsResponse | null;
  metricsWindow: LogMetricsWindow;
  onWindowChange: (window: LogMetricsWindow) => void;
}

export function MetricsPanel(props: MetricsPanelProps) {
  const { metricsLoading, metricsError, metrics, metricsWindow, onWindowChange } = props;
  const metricsSeries = metrics?.series.slice(-8) ?? [];
  const topProviders = metrics?.topProviders ?? [];
  const topRouteTypes = metrics?.topRouteTypes ?? [];
  const metricsWarnings = metrics?.warnings ?? [];

  return (
    <DashboardPanel
      title="运行指标（日志聚合）"
      description="基于事件日志窗口聚合的请求量、成功率与延迟分布"
      action={
        <div className="flex items-center gap-1">
          {(['1h', '6h', '24h'] as const).map((window) => (
            <Button
              key={window}
              size="xs"
              variant={metricsWindow === window ? 'secondary' : 'ghost'}
              onClick={() => onWindowChange(window)}
              disabled={metricsLoading}
            >
              {window}
            </Button>
          ))}
        </div>
      }
      contentClassName="space-y-3 px-3 py-2.5"
    >
      {metricsLoading ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : metricsError ? (
        <Empty className="min-h-[220px] p-6 md:p-6">
          <EmptyHeader>
            <EmptyTitle>运行指标加载失败</EmptyTitle>
            <EmptyDescription>{metricsError}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !metrics || metrics.summary.totalRequests === 0 ? (
        <Empty className="min-h-[220px] p-6 md:p-6">
          <EmptyMedia variant="icon">
            <BarChart3 className="h-5 w-5" />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>暂无运行日志数据</EmptyTitle>
            <EmptyDescription>
              {metrics?.source.logEnabled === false
                ? '日志未启用，请先在日志配置中开启。'
                : '当前窗口内没有可统计的请求事件。'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">总请求</div>
              <div className="text-xl font-semibold">{metrics.summary.totalRequests}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">成功率</div>
              <div className="text-xl font-semibold">{metrics.summary.successRate}%</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">错误请求</div>
              <div className="text-xl font-semibold">{metrics.summary.errorRequests}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">P95 延迟</div>
              <div className="text-xl font-semibold">{metrics.summary.p95LatencyMs} ms</div>
            </div>
          </div>

          {metricsWarnings.length > 0 ? (
            <div className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
              {metricsWarnings.join('；')}
            </div>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="space-y-2 lg:col-span-2">
              <div className="text-sm font-medium">请求趋势（最近 {metricsSeries.length} 个时间桶）</div>
              <div className="space-y-1.5">
                {metricsSeries.map((point) => {
                  const ratio = metrics.summary.totalRequests
                    ? point.requests / metrics.summary.totalRequests
                    : 0;
                  return (
                    <div key={point.ts} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {new Date(point.ts).toLocaleTimeString()}
                        </span>
                        <span>
                          {point.requests} req · {point.errors} err · {point.avgLatencyMs} ms
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted">
                        <div
                          className="h-1.5 rounded-full bg-foreground/80"
                          style={{
                            width: `${Math.max(ratio * 100, point.requests > 0 ? 2 : 0)}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <div className="mb-1 text-sm font-medium">Top Providers</div>
                <div className="space-y-1.5 text-xs">
                  {topProviders.length > 0 ? (
                    topProviders.map((item) => (
                      <div key={item.key} className="flex items-center justify-between gap-2">
                        <span className="truncate" title={item.key}>
                          {item.key}
                        </span>
                        <span className="text-muted-foreground">
                          {item.requests} · {item.errorRate}%
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="text-muted-foreground">暂无数据</div>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-1 text-sm font-medium">Top 协议入口</div>
                <div className="space-y-1.5 text-xs">
                  {topRouteTypes.length > 0 ? (
                    topRouteTypes.map((item) => (
                      <div key={item.key} className="flex items-center justify-between gap-2">
                        <span className="truncate" title={item.key}>
                          {item.key}
                        </span>
                        <span className="text-muted-foreground">
                          {item.requests} · {item.errorRate}%
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="text-muted-foreground">暂无数据</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </DashboardPanel>
  );
}
