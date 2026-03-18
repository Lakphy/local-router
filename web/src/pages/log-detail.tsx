import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, ChevronDown, Copy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { JsonBlock } from '@/components/log-detail/json-block';
import { MetaItem } from '@/components/log-detail/meta-item';
import { PluginPipelineSection } from '@/components/log-detail/plugin-pipeline-section';
import { RequestResponseFlowSections } from '@/components/log-detail/request-response-flow-sections';
import { RouteFlowCard } from '@/components/log-detail/route-flow-card';
import { StreamContentBlock } from '@/components/log-detail/stream-content-block';
import {
  buildCurlCommand,
  captureReason,
  formatDateTime,
  getInterfaceType,
  prettyJson,
} from '@/components/log-detail/utils';
import { ChatHistoryCard } from '@/components/logs/chat-history-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchLogEventDetail, type LogEventDetail } from '@/lib/api';
import { parseChatHistory } from '@/lib/log-chat-history/parse-chat-history';

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

  const hasPlugins = Boolean(
    detail.plugins && (detail.plugins.request?.length || detail.plugins.response?.length)
  );

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
          {hasPlugins ? <TabsTrigger value="plugins">插件</TabsTrigger> : null}
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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <Copy className="h-4 w-4" />
              Copy as cURL
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={async () => {
                await navigator.clipboard.writeText(buildCurlCommand(detail, 'local-router'));
                toast.success('已复制 local-router cURL');
              }}
            >
              复制发给 local-router 的请求
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={async () => {
                await navigator.clipboard.writeText(buildCurlCommand(detail, 'provider'));
                toast.success('已复制 provider cURL（API Key 为占位符）');
              }}
            >
              复制发给 provider 的请求
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
        <RequestResponseFlowSections detail={detail} />
      </TabsContent>

      {hasPlugins ? (
        <TabsContent value="plugins" className="mt-0 space-y-4">
          <PluginPipelineSection detail={detail} />
        </TabsContent>
      ) : null}

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
            <p className="text-sm text-muted-foreground">完整事件 JSON</p>
          </div>
          <div className="px-3 py-3">
            <JsonBlock title="event" value={detail.rawEvent} />
          </div>
        </section>
      </TabsContent>
    </Tabs>
  );
}
