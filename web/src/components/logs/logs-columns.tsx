import type { ColumnDef } from '@tanstack/react-table';
import { ArrowUpDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { LogEventSummary, TokenUsageSummary } from '@/lib/api';

function LevelBadge({ level }: { level: LogEventSummary['level'] }) {
  if (level === 'error') {
    return <Badge variant="destructive">error</Badge>;
  }
  return <Badge variant="outline">info</Badge>;
}

function StatusBadge({ statusClass }: { statusClass: LogEventSummary['statusClass'] }) {
  if (statusClass === '2xx') return <Badge variant="outline">2xx</Badge>;
  if (statusClass === '4xx') return <Badge variant="secondary">4xx</Badge>;
  if (statusClass === '5xx') return <Badge variant="destructive">5xx</Badge>;
  return <Badge variant="secondary">network</Badge>;
}

function formatMetric(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return Intl.NumberFormat(undefined, {
    notation: Math.abs(value) >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${value.toFixed(2).replace(/\.?0+$/, '')}%`;
}

function usageTooltip(usage: TokenUsageSummary): string {
  const rows: Array<[string, string]> = [
    ['input', formatMetric(usage.inputTokens)],
    ['output', formatMetric(usage.outputTokens)],
    ['total', formatMetric(usage.totalTokens)],
    ['cache hit rate', formatPercent(usage.cacheHitRate)],
    ['cache hit input', formatMetric(usage.cacheHitInputTokens)],
    ['cached input', formatMetric(usage.cachedInputTokens)],
    ['cache read', formatMetric(usage.cacheReadInputTokens)],
    ['cache creation', formatMetric(usage.cacheCreationInputTokens)],
    ['cache creation 5m', formatMetric(usage.cacheCreationInputTokens5m)],
    ['cache creation 1h', formatMetric(usage.cacheCreationInputTokens1h)],
    ['cache write', formatMetric(usage.cacheWriteInputTokens)],
    ['cache miss', formatMetric(usage.cacheMissInputTokens)],
    ['reasoning', formatMetric(usage.reasoningTokens)],
    ['audio input', formatMetric(usage.audioInputTokens)],
    ['audio output', formatMetric(usage.audioOutputTokens)],
    ['text input', formatMetric(usage.textInputTokens)],
    ['text output', formatMetric(usage.textOutputTokens)],
    ['accepted prediction', formatMetric(usage.acceptedPredictionTokens)],
    ['rejected prediction', formatMetric(usage.rejectedPredictionTokens)],
    ['tool prompt', formatMetric(usage.toolUsePromptTokens)],
    ['billable input', formatMetric(usage.billableInputTokens)],
    ['billable output', formatMetric(usage.billableOutputTokens)],
    ['credit usage', formatMetric(usage.creditUsage)],
    ['cost', formatMetric(usage.cost)],
    ['style', usage.providerStyle],
    ['source', usage.source],
    ['path', usage.rawUsagePath ?? '-'],
    ['formula', usage.cacheHitRateFormula ?? '-'],
  ];
  return rows.map(([label, value]) => `${label}: ${value}`).join('\n');
}

function TokenUsageCell({ usage }: { usage: TokenUsageSummary | null }) {
  if (!usage) return <div className="text-xs text-muted-foreground">-</div>;
  return (
    <div className="min-w-[190px] text-xs leading-tight" title={usageTooltip(usage)}>
      <div className="font-medium tabular-nums">
        in {formatMetric(usage.inputTokens)} · out {formatMetric(usage.outputTokens)} · total{' '}
        {formatMetric(usage.totalTokens)}
      </div>
      <div className="mt-0.5 text-muted-foreground tabular-nums">
        cache {formatPercent(usage.cacheHitRate)} · hit {formatMetric(usage.cacheHitInputTokens)} ·
        reason {formatMetric(usage.reasoningTokens)}
      </div>
    </div>
  );
}

export function createLogsColumns(
  onSortChange: (next: 'time_desc' | 'time_asc') => void,
  sort: 'time_desc' | 'time_asc'
): ColumnDef<LogEventSummary>[] {
  return [
    {
      accessorKey: 'ts',
      header: () => (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-1"
          onClick={() => onSortChange(sort === 'time_desc' ? 'time_asc' : 'time_desc')}
        >
          时间
          <ArrowUpDown className="h-3.5 w-3.5" />
        </Button>
      ),
      cell: ({ row }) => {
        const value = row.original.ts;
        return <div className="text-xs tabular-nums">{new Date(value).toLocaleString()}</div>;
      },
    },
    {
      accessorKey: 'level',
      header: '级别',
      cell: ({ row }) => <LevelBadge level={row.original.level} />,
    },
    {
      accessorKey: 'provider',
      header: 'Provider',
      cell: ({ row }) => (
        <div className="max-w-[140px] truncate text-xs" title={row.original.provider}>
          {row.original.provider}
        </div>
      ),
    },
    {
      accessorKey: 'routeType',
      header: '路由',
      cell: ({ row }) => (
        <div className="max-w-[160px] truncate text-xs" title={row.original.routeType}>
          {row.original.routeType}
        </div>
      ),
    },
    {
      accessorKey: 'modelIn',
      header: '模型链路',
      cell: ({ row }) => (
        <div
          className="max-w-[260px] truncate font-mono text-xs"
          title={`${row.original.modelIn} -> ${row.original.modelOut}`}
        >
          {row.original.modelIn}
          {' -> '}
          {row.original.modelOut}
        </div>
      ),
    },
    {
      accessorKey: 'message',
      header: '消息',
      cell: ({ row }) => (
        <div className="max-w-[400px] truncate text-xs" title={row.original.message}>
          {row.original.message}
        </div>
      ),
    },
    {
      accessorKey: 'latencyMs',
      header: '延迟',
      cell: ({ row }) => <div className="text-xs tabular-nums">{row.original.latencyMs} ms</div>,
    },
    {
      accessorKey: 'tokenUsage',
      header: 'Usage',
      cell: ({ row }) => <TokenUsageCell usage={row.original.tokenUsage} />,
    },
    {
      accessorKey: 'statusClass',
      header: '状态',
      cell: ({ row }) => <StatusBadge statusClass={row.original.statusClass} />,
    },
    {
      accessorKey: 'userKey',
      header: '用户',
      cell: ({ row }) => (
        <div
          className="max-w-[180px] truncate font-mono text-xs"
          title={row.original.userKey ?? '-'}
        >
          {row.original.userKey ?? '-'}
        </div>
      ),
    },
    {
      accessorKey: 'sessionId',
      header: '会话',
      cell: ({ row }) => (
        <div
          className="max-w-[220px] truncate font-mono text-xs"
          title={row.original.sessionId ?? '-'}
        >
          {row.original.sessionId ?? '-'}
        </div>
      ),
    },
    {
      accessorKey: 'requestId',
      header: 'Request ID',
      cell: ({ row }) => (
        <div className="max-w-[220px] truncate font-mono text-xs" title={row.original.requestId}>
          {row.original.requestId}
        </div>
      ),
    },
  ];
}
