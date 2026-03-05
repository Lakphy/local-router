import { BarChart3, Network } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { DashboardPanel } from '@/components/dashboard/panel';
import type { ConfigMeta } from '@/types/config';

interface RouteTypeDistributionItem {
  type: string;
  count: number;
  ratio: number;
}

interface RouteDistributionPanelProps {
  hasConfig: boolean;
  routeTypeDistribution: RouteTypeDistributionItem[];
}

interface ConfigMetaPanelProps {
  isMetaLoading: boolean;
  meta: ConfigMeta | null;
  metaRouteTypes: string[];
  configuredInMetaCount: number;
}

export function RouteDistributionPanel({
  hasConfig,
  routeTypeDistribution,
}: RouteDistributionPanelProps) {
  return (
    <DashboardPanel
      title="路由类型分布"
      description="按协议入口统计规则数量与占比"
      action={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
    >
      {!hasConfig ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-[85%]" />
          <Skeleton className="h-4 w-[70%]" />
        </div>
      ) : routeTypeDistribution.length === 0 ? (
        <Empty className="min-h-[180px] p-6 md:p-6">
          <EmptyHeader>
            <EmptyTitle>暂无路由规则</EmptyTitle>
            <EmptyDescription>请先配置 routes 后查看分布信息。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-2.5">
          {routeTypeDistribution.map((item) => (
            <div key={item.type} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate font-medium" title={item.type}>
                  {item.type}
                </span>
                <span className="text-muted-foreground">
                  {item.count} 条 · {(item.ratio * 100).toFixed(1)}%
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted">
                <div
                  className="h-2 rounded-full bg-foreground/80"
                  style={{ width: `${Math.max(item.ratio * 100, 2)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardPanel>
  );
}

export function ConfigMetaPanel(props: ConfigMetaPanelProps) {
  const { isMetaLoading, meta, metaRouteTypes, configuredInMetaCount } = props;

  return (
    <DashboardPanel
      title="配置摘要"
      description="当前加载配置与协议支持信息"
      action={<Network className="h-4 w-4 text-muted-foreground" />}
      contentClassName="space-y-2.5 px-3 py-2.5 text-sm"
    >
      {isMetaLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-[80%]" />
          <Skeleton className="h-6 w-[70%]" />
        </div>
      ) : meta ? (
        <>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">配置路径</div>
            <code className="block truncate rounded bg-muted px-2 py-1 text-xs" title={meta.configPath}>
              {meta.configPath}
            </code>
          </div>

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">支持协议</div>
            <div className="flex flex-wrap gap-1.5">
              {metaRouteTypes.length > 0 ? (
                metaRouteTypes.map((type) => (
                  <Badge key={type} variant="outline" className="text-xs">
                    {type}
                  </Badge>
                ))
              ) : (
                <Badge variant="secondary" className="text-xs">
                  未知协议
                </Badge>
              )}
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            已配置协议覆盖：{configuredInMetaCount} / {metaRouteTypes.length || 0}
          </div>
        </>
      ) : (
        <Empty className="min-h-[180px] p-6 md:p-6">
          <EmptyHeader>
            <EmptyTitle>暂无元信息</EmptyTitle>
            <EmptyDescription>服务尚未返回配置元数据。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </DashboardPanel>
  );
}
