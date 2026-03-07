import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Copy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChatHistoryCard } from '@/components/logs/chat-history-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchLogEventDetail, type LogEventDetail } from '@/lib/api';
import { parseChatHistory } from '@/lib/log-chat-history/parse-chat-history';

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function captureReason(detail: LogEventDetail): string | null {
  if (detail.capture.bodyPolicy === 'off') {
    return 'Body 采集策略为 off，未记录请求/响应 body。';
  }
  if (detail.capture.bodyPolicy === 'masked') {
    return 'Body 采集策略为 masked，敏感字段已脱敏。';
  }
  if (detail.capture.bodyPolicy === 'full') {
    return 'Body 采集策略为 full。';
  }
  return null;
}

function getInterfaceType(routeType: string): string {
  if (routeType.startsWith('openai')) return 'openai';
  if (routeType.startsWith('anthropic')) return 'anthropic';
  return routeType;
}

export function LogDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams({ from: '/logs/$id' });

  const [detail, setDetail] = useState<LogEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadDetail() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchLogEventDetail(id);
        if (!cancelled) {
          setDetail(data);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '日志详情加载失败');
          setLoading(false);
        }
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const hintText = useMemo(() => {
    if (!detail) return [];
    const hints = [...detail.capture.truncatedHints];
    const reason = captureReason(detail);
    if (reason) hints.unshift(reason);
    return hints;
  }, [detail]);

  const interfaceType = useMemo(
    () => (detail ? getInterfaceType(detail.summary.routeType) : '-'),
    [detail]
  );

  const parsedChatHistory = useMemo(() => {
    if (!detail) return null;
    return parseChatHistory(detail);
  }, [detail]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <Empty className="min-h-[240px] p-6 md:p-6">
        <EmptyHeader>
          <EmptyTitle>日志详情加载失败</EmptyTitle>
          <EmptyDescription>{error ?? '日志事件不存在'}</EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          onClick={() => navigate({ to: '/logs', search: { user: undefined, session: undefined } })}
        >
          返回日志列表
        </Button>
      </Empty>
    );
  }

  return (
    <Tabs defaultValue="overview" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate({ to: '/logs', search: { user: undefined, session: undefined } })}
        >
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>

        <TabsList variant="line" className="h-auto shrink-0">
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="request-response">请求 / 响应</TabsTrigger>
          <TabsTrigger value="session-tracing">会话 / 追踪</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>

        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={async () => {
            await navigator.clipboard.writeText(prettyJson(detail.rawEvent));
            toast.success('已复制完整日志 JSON');
          }}
        >
          <Copy className="h-4 w-4" />
          复制 Raw JSON
        </Button>
      </div>

      <TabsContent value="overview" className="mt-0 space-y-4">
        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">概览</h3>
            <p className="text-sm text-muted-foreground">核心元信息与定位字段</p>
          </div>
          <div className="space-y-3 px-3 py-3">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{detail.summary.level}</Badge>
              <Badge variant="outline">{detail.summary.provider}</Badge>
              <Badge variant="outline">{detail.summary.routeType}</Badge>
              <Badge variant="outline">{detail.summary.statusClass}</Badge>
              <Badge variant={detail.summary.hasError ? 'secondary' : 'outline'}>
                {detail.summary.upstreamStatus}
              </Badge>
            </div>

            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <MetaItem label="时间" value={formatDateTime(detail.summary.ts)} />
              <MetaItem label="request_id" value={detail.summary.requestId} mono />
              <MetaItem label="model_in" value={detail.summary.modelIn} mono />
              <MetaItem label="model_out" value={detail.summary.modelOut} mono />
              <MetaItem label="route_rule_key" value={detail.summary.routeRuleKey} mono />
              <MetaItem label="latency" value={`${detail.summary.latencyMs} ms`} />
              <MetaItem label="target_url" value={detail.upstream.targetUrl} mono />
              <MetaItem label="proxy_url" value={detail.upstream.proxyUrl ?? '-'} mono />
              <MetaItem
                label="定位"
                value={`${detail.location.file}:${detail.location.line}`}
                mono
              />
            </div>

            {hintText.length > 0 ? (
              <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {hintText.map((hint) => (
                  <div key={hint}>• {hint}</div>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">路由链路</h3>
            <p className="text-sm text-muted-foreground">入站请求到出站转发的完整可视化链路</p>
          </div>
          <div className="px-3 py-3">
            <RouteFlowCard
              interfaceType={interfaceType}
              routeType={detail.summary.routeType}
              modelIn={detail.summary.modelIn}
              provider={detail.summary.provider}
              modelOut={detail.summary.modelOut}
              routeRuleKey={detail.summary.routeRuleKey}
            />
          </div>
        </section>
      </TabsContent>

      <TabsContent value="request-response" className="mt-0 space-y-4">
        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">Request</h3>
          </div>
          <div className="space-y-3 px-3 py-3">
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <MetaItem label="method" value={detail.request.method} />
              <MetaItem label="path" value={detail.request.path} mono />
              <MetaItem label="content-type" value={detail.request.contentType ?? '-'} mono />
            </div>
            <JsonBlock title="headers(masked)" value={detail.request.requestHeadersMasked} />
            <JsonBlock
              title="body"
              value={detail.request.requestBody}
              emptyText="无请求 body 或未采集。"
            />
          </div>
        </section>

        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">Response</h3>
          </div>
          <div className="space-y-3 px-3 py-3">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <MetaItem label="upstream_status" value={String(detail.response.upstreamStatus)} />
              <MetaItem label="content-type" value={detail.response.contentType ?? '-'} mono />
            </div>
            <JsonBlock title="headers" value={detail.response.responseHeaders} />
            <JsonBlock
              title="body"
              value={detail.response.responseBody}
              emptyText="无响应 body 或未采集。"
            />
          </div>
        </section>
      </TabsContent>

      <TabsContent value="session-tracing" className="mt-0 space-y-4">
        {parsedChatHistory ? <ChatHistoryCard parsed={parsedChatHistory} /> : null}

        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">Upstream / Tracing</h3>
          </div>
          <div className="grid gap-2 px-3 py-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <MetaItem
              label="provider_request_id"
              value={detail.upstream.providerRequestId ?? '-'}
              mono
            />
            <MetaItem label="error_type" value={detail.upstream.errorType ?? '-'} mono />
            <MetaItem label="error_message" value={detail.upstream.errorMessage ?? '-'} />
            <MetaItem label="is_stream" value={detail.upstream.isStream ? 'true' : 'false'} />
            <MetaItem
              label="stream_file"
              value={detail.upstream.streamFile ?? '无 stream 数据'}
              mono
            />
          </div>
          <div className="px-3 pb-3">
            <StreamContentBlock
              title="stream content"
              content={detail.upstream.streamContent}
              emptyText={
                detail.upstream.isStream ? '未捕获 stream 内容。' : '非流式请求，无 stream 内容。'
              }
            />
          </div>
        </section>
      </TabsContent>

      <TabsContent value="raw" className="mt-0">
        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">Raw</h3>
            <p className="text-sm text-muted-foreground">完整事件 JSON（已脱敏）</p>
          </div>
          <div className="px-3 py-3">
            <pre className="max-h-[520px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
              {prettyJson(detail.rawEvent)}
            </pre>
          </div>
        </section>
      </TabsContent>
    </Tabs>
  );
}

function MetaItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 break-all ${mono ? 'font-mono text-xs' : 'text-sm'}`}>{value}</div>
    </div>
  );
}

function FlowPill({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/90 px-2 py-1">
      <div className="text-[11px] leading-4 text-muted-foreground">{label}</div>
      <div className={`mt-0.5 break-all text-xs ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

function RouteFlowCard({
  interfaceType,
  routeType,
  modelIn,
  provider,
  modelOut,
  routeRuleKey,
}: {
  interfaceType: string;
  routeType: string;
  modelIn: string;
  provider: string;
  modelOut: string;
  routeRuleKey: string;
}) {
  return (
    <div className="rounded-xl border bg-linear-to-br from-muted/20 to-muted/40 p-3">
      <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr] lg:items-center">
        <div className="space-y-2 rounded-lg border bg-background/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">入站请求</div>
            <Badge variant="outline">IN</Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <FlowPill label="接口类型" value={interfaceType} />
            <FlowPill label="routeType" value={routeType} mono />
          </div>
          <FlowPill label="原始模型（model_in）" value={modelIn} mono />
        </div>

        <div className="flex flex-col items-center justify-center gap-1 py-1">
          <div className="hidden h-0.5 w-16 bg-border lg:block" />
          <div className="rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground">
            路由匹配并改写
          </div>
          <div className="text-xl leading-none text-muted-foreground">→</div>
          <div className="hidden h-0.5 w-16 bg-border lg:block" />
        </div>

        <div className="space-y-2 rounded-lg border bg-background/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">出站转发</div>
            <Badge variant="outline">OUT</Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <FlowPill label="目标 provider" value={provider} />
            <FlowPill label="命中规则" value={routeRuleKey} mono />
          </div>
          <FlowPill label="路由模型（model_out）" value={modelOut} mono />
        </div>
      </div>
    </div>
  );
}

type StreamLine =
  | { type: 'json'; lineNo: number; value: unknown }
  | { type: 'raw'; lineNo: number; value: string };

function parseStreamLines(content: string): StreamLine[] {
  const rawLines = content.split('\n');
  const lines: StreamLine[] = [];

  rawLines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    const lineNo = index + 1;

    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trim();
      if (!payload) return;
      try {
        lines.push({ type: 'json', lineNo, value: JSON.parse(payload) });
      } catch {
        lines.push({ type: 'raw', lineNo, value: trimmed });
      }
      return;
    }

    try {
      lines.push({ type: 'json', lineNo, value: JSON.parse(trimmed) });
    } catch {
      lines.push({ type: 'raw', lineNo, value: trimmed });
    }
  });

  return lines;
}

function StreamContentBlock({
  title,
  content,
  emptyText,
}: {
  title: string;
  content: string | null;
  emptyText?: string;
}) {
  const lines = useMemo(() => (content ? parseStreamLines(content) : []), [content]);

  const header = (
    <div className="flex items-center justify-between gap-2">
      <div className="text-xs text-muted-foreground">{title}</div>
      <Button
        size="sm"
        variant="outline"
        disabled={!content}
        onClick={async () => {
          if (!content) return;
          await navigator.clipboard.writeText(content);
          toast.success('已复制 stream content');
        }}
      >
        <Copy className="h-3.5 w-3.5" />
        复制
      </Button>
    </div>
  );

  if (!content || lines.length === 0) {
    return (
      <div className="space-y-1">
        {header}
        <pre className="max-h-[320px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
          {emptyText ?? '-'}
        </pre>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {header}
      <div className="max-h-[420px] space-y-2 overflow-auto rounded-md border bg-muted/30 p-3">
        {lines.map((line) => (
          <div
            key={`${line.lineNo}-${line.type}`}
            className="space-y-1 rounded-md border bg-background/80 p-2"
          >
            <div className="text-[11px] text-muted-foreground">line {line.lineNo}</div>
            <pre className="overflow-auto rounded bg-muted/40 p-2 text-xs">
              {line.type === 'json' ? prettyJson(line.value) : line.value}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function JsonBlock({
  title,
  value,
  emptyText,
}: {
  title: string;
  value: unknown;
  emptyText?: string;
}) {
  const isEmpty = value == null;
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{title}</div>
      <pre className="max-h-[320px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
        {isEmpty ? (emptyText ?? '-') : prettyJson(value)}
      </pre>
    </div>
  );
}
