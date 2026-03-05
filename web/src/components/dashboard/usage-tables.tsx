import { Route, Server } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DashboardPanel } from '@/components/dashboard/panel';

interface ProviderUsageRow {
  provider: string;
  count: number;
  used: boolean;
}

interface RouteTypeDistributionItem {
  type: string;
  count: number;
  ratio: number;
}

interface ProviderUsageTablePanelProps {
  hasConfig: boolean;
  providerUsageRows: ProviderUsageRow[];
}

interface RouteTypeTablePanelProps {
  hasConfig: boolean;
  routeTypeDistribution: RouteTypeDistributionItem[];
  totalRules: number;
}

export function ProviderUsageTablePanel({ hasConfig, providerUsageRows }: ProviderUsageTablePanelProps) {
  return (
    <DashboardPanel title="Provider 使用概览" description="按路由规则统计 provider 被引用次数">
      {!hasConfig ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : providerUsageRows.length === 0 ? (
        <Empty className="min-h-[200px] p-6 md:p-6">
          <EmptyMedia variant="icon">
            <Server className="h-5 w-5" />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>未配置 Provider</EmptyTitle>
            <EmptyDescription>请先在 Providers 页面完成上游配置。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead className="text-right">引用次数</TableHead>
              <TableHead className="text-right">状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providerUsageRows.slice(0, 8).map((row) => (
              <TableRow key={row.provider}>
                <TableCell className="max-w-[220px] truncate font-medium" title={row.provider}>
                  {row.provider}
                </TableCell>
                <TableCell className="text-right">{row.count}</TableCell>
                <TableCell className="text-right">
                  {row.used ? (
                    <Badge variant="outline" className="text-xs">
                      已使用
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs">
                      未使用
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </DashboardPanel>
  );
}

export function RouteTypeTablePanel({
  hasConfig,
  routeTypeDistribution,
  totalRules,
}: RouteTypeTablePanelProps) {
  return (
    <DashboardPanel title="协议类型速览" description="按协议入口查看规则数量与占比">
      {!hasConfig ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : routeTypeDistribution.length === 0 ? (
        <Empty className="min-h-[200px] p-6 md:p-6">
          <EmptyMedia variant="icon">
            <Route className="h-5 w-5" />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>暂无协议规则</EmptyTitle>
            <EmptyDescription>当前还没有可统计的协议入口。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>协议类型</TableHead>
              <TableHead className="text-right">规则数</TableHead>
              <TableHead className="text-right">占比</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {routeTypeDistribution.slice(0, 8).map((item) => (
              <TableRow key={item.type}>
                <TableCell className="max-w-[260px] truncate font-medium" title={item.type}>
                  {item.type}
                </TableCell>
                <TableCell className="text-right">{item.count}</TableCell>
                <TableCell className="text-right">{(item.ratio * 100).toFixed(1)}%</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>总计</TableCell>
              <TableCell className="text-right">{totalRules}</TableCell>
              <TableCell className="text-right">100%</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </DashboardPanel>
  );
}
