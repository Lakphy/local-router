import { Activity, FileText, HardDrive, Route, Server } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

interface OverviewStripProps {
  isHealthLoading: boolean;
  healthy: boolean | null;
  isMetaLoading: boolean;
  providerCount: number;
  providersReferenced: number;
  totalRules: number;
  routeTypeCount: number;
  avgRulesPerType: number;
  logConfigured: boolean;
  logEnabled: boolean;
  bodyPolicy: string;
  streamsEnabled: boolean;
  logStorageLoading?: boolean;
  logStorageTotalBytes?: number;
  logStorageFileCount?: number;
}

interface StatTileProps {
  title: string;
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}

function StatTile({ title, icon: Icon, children }: StatTileProps) {
  return (
    <section className="rounded-lg border bg-background px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{title}</div>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      {children}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / k ** i;

  if (i === 0) return `${bytes} B`;
  return `${value.toFixed(2)} ${units[i]}`;
}

export function OverviewStrip(props: OverviewStripProps) {
  const {
    isHealthLoading,
    healthy,
    isMetaLoading,
    providerCount,
    providersReferenced,
    totalRules,
    routeTypeCount,
    avgRulesPerType,
    logConfigured,
    logEnabled,
    bodyPolicy,
    streamsEnabled,
    logStorageLoading,
    logStorageTotalBytes,
    logStorageFileCount,
  } = props;

  return (
    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-5">
      <StatTile title="服务状态" icon={Activity}>
        <div className="space-y-2">
          {isHealthLoading ? (
            <Skeleton className="h-6 w-20" />
          ) : healthy ? (
            <Badge variant="default" className="bg-emerald-600 hover:bg-emerald-600">
              运行中
            </Badge>
          ) : (
            <Badge variant="destructive">离线</Badge>
          )}
          <p className="text-xs text-muted-foreground">
            {isMetaLoading ? '等待元信息' : '配置元信息已就绪'}
          </p>
        </div>
      </StatTile>

      <StatTile title="Providers" icon={Server}>
        <div className="space-y-1.5">
          <div className="text-2xl font-bold">{providerCount}</div>
          <p className="text-xs text-muted-foreground">
            已被路由引用 {providersReferenced} / {providerCount || 0}
          </p>
        </div>
      </StatTile>

      <StatTile title="Routing" icon={Route}>
        <div className="space-y-1.5">
          <div className="text-2xl font-bold">{totalRules}</div>
          <p className="text-xs text-muted-foreground">
            {routeTypeCount} 个协议入口 · 平均 {avgRulesPerType.toFixed(1)} 条/入口
          </p>
        </div>
      </StatTile>

      <StatTile title="日志" icon={FileText}>
        <div className="space-y-2">
          {logConfigured ? (
            logEnabled ? (
              <Badge variant="default" className="bg-emerald-600 hover:bg-emerald-600">
                已启用
              </Badge>
            ) : (
              <Badge variant="secondary">已暂停</Badge>
            )
          ) : (
            <Badge variant="secondary">未配置</Badge>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="text-xs">
              body: {bodyPolicy}
            </Badge>
            <Badge variant="outline" className="text-xs">
              stream: {streamsEnabled ? 'on' : 'off'}
            </Badge>
          </div>
        </div>
      </StatTile>

      <StatTile title="日志存储" icon={HardDrive}>
        <div className="space-y-1.5">
          {logStorageLoading || logStorageTotalBytes === undefined ? (
            <Skeleton className="h-6 w-24" />
          ) : (
            <div className="text-2xl font-bold">{formatBytes(logStorageTotalBytes)}</div>
          )}
          <p className="text-xs text-muted-foreground">
            {logStorageLoading || logStorageFileCount === undefined
              ? '计算中...'
              : `${logStorageFileCount} 个文件 · 每小时自动更新`}
          </p>
        </div>
      </StatTile>
    </div>
  );
}
