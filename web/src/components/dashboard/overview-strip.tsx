import { Activity, Coins, Database, Gauge, HardDrive, Layers } from 'lucide-react';
import type { ComponentType } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { LogMetricsResponse, LogMetricsWindow } from '@/types/config';

interface OverviewStripProps {
  metrics: LogMetricsResponse | null;
  metricsLoading: boolean;
  metricsWindow: LogMetricsWindow;
  onWindowChange: (window: LogMetricsWindow) => void;
  logStorageLoading?: boolean;
  logStorageTotalBytes?: number;
  logStorageFileCount?: number;
}

interface StatTileProps {
  title: string;
  icon: ComponentType<{ className?: string }>;
  value: string;
  subtitle: string;
  loading?: boolean;
  valueClassName?: string;
}

function StatTile({ title, icon: Icon, value, subtitle, loading, valueClassName }: StatTileProps) {
  return (
    <section className="rounded-lg border bg-background px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{title}</div>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      {loading ? (
        <Skeleton className="h-7 w-24" />
      ) : (
        <div className={`text-2xl font-bold tabular-nums ${valueClassName ?? ''}`}>{value}</div>
      )}
      <p className="mt-1 truncate text-xs text-muted-foreground" title={subtitle}>
        {subtitle}
      </p>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i === 0) return `${bytes} B`;
  return `${(bytes / k ** i).toFixed(2)} ${units[i]}`;
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

const WINDOWS: LogMetricsWindow[] = ['1h', '6h', '24h'];

export function OverviewStrip(props: OverviewStripProps) {
  const {
    metrics,
    metricsLoading,
    metricsWindow,
    onWindowChange,
    logStorageLoading,
    logStorageTotalBytes,
    logStorageFileCount,
  } = props;

  const summary = metrics?.summary;
  const tokens = metrics?.tokens;
  const status = metrics?.statusClasses;

  const totalRequests = summary?.totalRequests ?? 0;
  const errorBreakdown = status
    ? `4xx ${status['4xx']} · 5xx ${status['5xx']} · 网络 ${status.network_error}`
    : '暂无数据';

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">运行指标 · 时间范围</span>
        <div className="flex items-center gap-1">
          {WINDOWS.map((window) => (
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
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatTile
          title="请求总量"
          icon={Activity}
          loading={metricsLoading}
          value={formatCount(totalRequests)}
          subtitle={
            summary ? `成功 ${summary.successRequests} · 错误 ${summary.errorRequests}` : '暂无数据'
          }
        />
        <StatTile
          title="成功率"
          icon={Layers}
          loading={metricsLoading}
          value={summary ? `${summary.successRate}%` : '—'}
          subtitle={errorBreakdown}
        />
        <StatTile
          title="P95 延迟"
          icon={Gauge}
          loading={metricsLoading}
          value={summary ? `${summary.p95LatencyMs} ms` : '—'}
          subtitle={summary ? `平均 ${summary.avgLatencyMs} ms` : '暂无数据'}
        />
        <StatTile
          title="Token 用量"
          icon={Coins}
          loading={metricsLoading}
          value={tokens ? formatCount(tokens.totalTokens) : '—'}
          subtitle={
            tokens
              ? `入 ${formatCount(tokens.inputTokens)} · 出 ${formatCount(tokens.outputTokens)}`
              : '暂无数据'
          }
        />
        <StatTile
          title="缓存命中率"
          icon={Database}
          loading={metricsLoading}
          value={tokens ? `${tokens.cacheHitRate}%` : '—'}
          subtitle={tokens ? `推理 ${formatCount(tokens.reasoningTokens)} tokens` : '暂无数据'}
        />
        <StatTile
          title="日志存储"
          icon={HardDrive}
          loading={logStorageLoading || logStorageTotalBytes === undefined}
          value={logStorageTotalBytes !== undefined ? formatBytes(logStorageTotalBytes) : '—'}
          subtitle={
            logStorageFileCount === undefined
              ? '计算中...'
              : `${logStorageFileCount} 个文件 · 不随时间范围变化`
          }
        />
      </div>
    </div>
  );
}
