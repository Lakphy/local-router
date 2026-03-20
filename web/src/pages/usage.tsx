import { Coins, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { BalancePanel } from '@/components/dashboard/balance-panel';
import { Button } from '@/components/ui/button';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useUsageStore } from '@/stores/usage-store';
import type { UsageMetricsWindow } from '@/types/config';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(2)}`;
}

function formatTokensOrNA(n: number, usageAvailable: boolean): string {
  if (!usageAvailable) return '-';
  return formatTokens(n);
}

const trendChartConfig = {
  inputTokens: { label: '输入', color: 'oklch(0.623 0.214 259.815)' },
  outputTokens: { label: '输出', color: 'oklch(0.627 0.194 149.214)' },
} satisfies ChartConfig;

export function UsagePage() {
  const data = useUsageStore((s) => s.data);
  const loading = useUsageStore((s) => s.loading);
  const error = useUsageStore((s) => s.error);
  const window = useUsageStore((s) => s.window);
  const fetchUsage = useUsageStore((s) => s.fetch);
  const setWindow = useUsageStore((s) => s.setWindow);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  function handleWindowChange(w: UsageMetricsWindow): void {
    setWindow(w);
    fetchUsage(w, true);
  }

  const series = data?.series.slice(-8) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">用量统计</h2>
          <p className="text-muted-foreground">Token 用量与费用统计</p>
        </div>
        <div className="flex items-center gap-1">
          {(['1h', '6h', '24h'] as const).map((w) => (
            <Button
              key={w}
              size="xs"
              variant={window === w ? 'secondary' : 'ghost'}
              onClick={() => handleWindowChange(w)}
              disabled={loading}
            >
              {w}
            </Button>
          ))}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => fetchUsage(undefined, true)}
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <BalancePanel />

      {loading && !data ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : error ? (
        <Empty className="min-h-[220px] p-6 md:p-6">
          <EmptyHeader>
            <EmptyTitle>用量统计加载失败</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !data || data.summary.totalRequests === 0 ? (
        <Empty className="min-h-[220px] p-6 md:p-6">
          <EmptyMedia variant="icon">
            <Coins className="h-5 w-5" />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>暂无用量数据</EmptyTitle>
            <EmptyDescription>
              当前窗口内没有包含 Token 用量的请求。请确保日志已启用且有请求记录。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">请求数</div>
              <div className="text-xl font-semibold">{data.summary.totalRequests}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">输入 Tokens</div>
              <div className="text-xl font-semibold">
                {formatTokens(data.summary.totalInputTokens)}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">输出 Tokens</div>
              <div className="text-xl font-semibold">
                {formatTokens(data.summary.totalOutputTokens)}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">缓存读取</div>
              <div className="text-xl font-semibold">
                {formatTokens(data.summary.totalCacheReadTokens)}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">总费用</div>
              <div className="text-xl font-semibold">{formatCost(data.summary.totalCost)}</div>
            </div>
          </div>

          {/* Token trend chart */}
          <section className="rounded-lg border bg-background">
            <div className="border-b px-3 py-2.5">
              <h3 className="text-base font-semibold">Token 用量趋势</h3>
            </div>
            <div className="px-3 py-2.5">
              <ChartContainer config={trendChartConfig} className="h-[200px] w-full">
                <AreaChart
                  data={series.map((p) => ({
                    time: new Date(p.ts).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                    inputTokens: p.inputTokens,
                    outputTokens: p.outputTokens,
                  }))}
                  margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
                >
                  <defs>
                    <linearGradient id="fillInput" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-inputTokens)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--color-inputTokens)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="fillOutput" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-outputTokens)" stopOpacity={0.3} />
                      <stop
                        offset="100%"
                        stopColor="var(--color-outputTokens)"
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    tickFormatter={formatTokens}
                    width={50}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value, name) => {
                          const label =
                            name === 'inputTokens'
                              ? '输入'
                              : name === 'outputTokens'
                                ? '输出'
                                : String(name);
                          return `${label}: ${formatTokens(Number(value))}`;
                        }}
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="inputTokens"
                    stroke="var(--color-inputTokens)"
                    fill="url(#fillInput)"
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="outputTokens"
                    stroke="var(--color-outputTokens)"
                    fill="url(#fillOutput)"
                    strokeWidth={2}
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                </AreaChart>
              </ChartContainer>
            </div>
          </section>

          {/* By Provider */}
          {data.byProvider.length > 0 && (
            <section className="rounded-lg border bg-background">
              <div className="border-b px-3 py-2.5">
                <h3 className="text-base font-semibold">按 Provider</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">Provider</th>
                      <th className="px-3 py-2 text-right font-medium">请求数</th>
                      <th className="px-3 py-2 text-right font-medium">输入</th>
                      <th className="px-3 py-2 text-right font-medium">输出</th>
                      <th className="px-3 py-2 text-right font-medium">缓存读取</th>
                      <th className="px-3 py-2 text-right font-medium">费用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byProvider.map((row) => (
                      <tr key={row.provider} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{row.provider}</td>
                        <td className="px-3 py-2 text-right">{row.requests}</td>
                        <td className="px-3 py-2 text-right">{formatTokens(row.inputTokens)}</td>
                        <td className="px-3 py-2 text-right">{formatTokens(row.outputTokens)}</td>
                        <td className="px-3 py-2 text-right">
                          {formatTokens(row.cacheReadTokens)}
                        </td>
                        <td className="px-3 py-2 text-right">{formatCost(row.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* By Model */}
          {data.byModel.length > 0 && (
            <section className="rounded-lg border bg-background">
              <div className="border-b px-3 py-2.5">
                <h3 className="text-base font-semibold">按 Model</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">Provider</th>
                      <th className="px-3 py-2 text-left font-medium">Model</th>
                      <th className="px-3 py-2 text-right font-medium">请求数</th>
                      <th className="px-3 py-2 text-right font-medium">输入</th>
                      <th className="px-3 py-2 text-right font-medium">输出</th>
                      <th className="px-3 py-2 text-right font-medium">缓存读取</th>
                      <th className="px-3 py-2 text-right font-medium">缓存创建</th>
                      <th className="px-3 py-2 text-right font-medium">费用</th>
                      <th className="px-3 py-2 text-right font-medium">单价</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.map((row) => (
                      <tr key={`${row.provider}:${row.model}`} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{row.provider}</td>
                        <td className="px-3 py-2 font-mono text-xs">{row.model}</td>
                        <td className="px-3 py-2 text-right">{row.requests}</td>
                        <td className="px-3 py-2 text-right">
                          {formatTokensOrNA(row.inputTokens, row.usageAvailable)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatTokensOrNA(row.outputTokens, row.usageAvailable)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatTokensOrNA(row.cacheReadTokens, row.usageAvailable)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatTokensOrNA(row.cacheCreationTokens, row.usageAvailable)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {!row.usageAvailable ? (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-help text-muted-foreground">—</span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  此 provider 未提供用量数据，无法估算费用
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            formatCost(row.cost)
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                          {row.pricing ? `$${row.pricing.input}/$${row.pricing.output}` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
