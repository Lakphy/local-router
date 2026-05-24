import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { HeadersTableBlock } from '@/components/log-detail/headers-table-block';
import { JsonBlock } from '@/components/log-detail/json-block';
import { MetaItem } from '@/components/log-detail/meta-item';
import { PluginPipelineSection } from '@/components/log-detail/plugin-pipeline-section';
import { RouteFlowCard } from '@/components/log-detail/route-flow-card';
import { StreamContentBlock } from '@/components/log-detail/stream-content-block';
import {
  formatDateTime,
  getInterfaceType,
  restoreLocalRouterBody,
} from '@/components/log-detail/utils';
import { ChatHistorySplitViewer } from '@/components/logs/chat-history-split-viewer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchLogEventDetail, type LogEventDetail, type TokenUsageSummary } from '@/lib/api';
import { parseChatHistory } from '@/lib/log-chat-history/parse-chat-history';
import { cn } from '@/lib/utils';

const DETAIL_TAB_IDS = [
  'overview',
  'conversation',
  'request',
  'response',
  'plugins',
  'stream',
  'raw',
] as const;
type DetailTabId = (typeof DETAIL_TAB_IDS)[number];

interface ViewerTab {
  id: DetailTabId;
  label: string;
  meta?: string;
}

function normalizeDetailTab(value: string | null | undefined): DetailTabId {
  if (DETAIL_TAB_IDS.includes(value as DetailTabId)) return value as DetailTabId;
  return 'overview';
}

function getDetailTabFromHash(): DetailTabId {
  if (typeof window === 'undefined') return 'overview';
  return normalizeDetailTab(window.location.hash.replace(/^#/, ''));
}

export function LogDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams({ from: '/logs/$id' });

  const [detail, setDetail] = useState<LogEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTabId>(() => getDetailTabFromHash());
  const [mountedTabs, setMountedTabs] = useState<Set<DetailTabId>>(
    () => new Set([getDetailTabFromHash()])
  );

  useEffect(() => {
    let cancelled = false;

    async function loadDetail() {
      setLoading(true);
      setError(null);
      const tabFromHash = getDetailTabFromHash();
      setActiveTab(tabFromHash);
      setMountedTabs(new Set([tabFromHash]));
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

  useEffect(() => {
    function handleHashChange() {
      const nextTab = getDetailTabFromHash();
      setActiveTab(nextTab);
      setMountedTabs((current) => {
        if (current.has(nextTab)) return current;
        const next = new Set(current);
        next.add(nextTab);
        return next;
      });
    }

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const mountTab = useCallback((tabId: DetailTabId) => {
    setMountedTabs((current) => {
      if (current.has(tabId)) return current;
      const next = new Set(current);
      next.add(tabId);
      return next;
    });
  }, []);

  const handleTabChange = useCallback(
    (value: string) => {
      const nextTab = normalizeDetailTab(value);
      setActiveTab(nextTab);
      mountTab(nextTab);
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}#${nextTab}`
      );
    },
    [mountTab]
  );

  const interfaceType = useMemo(
    () => (detail ? getInterfaceType(detail.summary.routeType) : '-'),
    [detail]
  );

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
  const pluginCount =
    (detail.plugins?.request?.length ?? 0) + (detail.plugins?.response?.length ?? 0);
  const hasRequestBodyAfterPlugins = detail.plugins?.requestBodyAfterPlugins !== undefined;
  const hasResponseBodyBeforePlugins = detail.plugins?.responseBodyBeforePlugins !== undefined;
  const tabs: ViewerTab[] = [
    { id: 'overview', label: '概览', meta: detail.summary.statusClass },
    { id: 'conversation', label: '对话', meta: 'derived' },
    {
      id: 'request',
      label: '请求',
      meta: hasRequestBodyAfterPlugins ? 'plugin-after' : 'captured',
    },
    {
      id: 'response',
      label: '响应',
      meta: hasResponseBodyBeforePlugins ? 'plugin-before' : 'captured',
    },
    { id: 'plugins', label: '插件', meta: pluginCount > 0 ? `${pluginCount} 个` : '无' },
    {
      id: 'stream',
      label: 'Stream',
      meta: detail.upstream.isStream
        ? detail.capture.streamCaptured
          ? '已采集'
          : '未采集'
        : '非流式',
    },
    { id: 'raw', label: 'Raw', meta: detail.capture.bodyPolicy },
  ];

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="min-w-[720px] space-y-3">
      <DetailHeader
        detail={detail}
        interfaceType={interfaceType}
        tabs={tabs}
        onBack={() => navigate({ to: '/logs', search: { user: undefined, session: undefined } })}
      />

      <main className="min-w-0 space-y-3">
        <TabsContent value="overview" className="mt-0">
          <OverviewSection detail={detail} interfaceType={interfaceType} />
        </TabsContent>

        <LazyTabsContent
          value="conversation"
          mounted={mountedTabs.has('conversation')}
          onMount={mountTab}
          placeholder="对话会在进入本 Tab 时解析，避免打开详情时一次性处理大消息。"
        >
          <ConversationViewer detail={detail} />
        </LazyTabsContent>

        <TabsContent value="request" className="mt-0">
          <SectionGroup
            title="请求"
            description="用户请求与实际发送给 Provider 的请求并排查看"
            badges={['reconstructed', hasRequestBodyAfterPlugins ? 'plugin-after' : 'captured']}
          >
            <RequestCompareSection detail={detail} />
          </SectionGroup>
        </TabsContent>

        <TabsContent value="response" className="mt-0">
          <SectionGroup
            title="响应"
            description="Provider 原始响应与最终返回给用户的响应并排查看"
            badges={[hasResponseBodyBeforePlugins ? 'plugin-before' : 'captured', 'captured']}
          >
            <ResponseCompareSection detail={detail} />
          </SectionGroup>
        </TabsContent>

        <TabsContent value="plugins" className="mt-0">
          <SectionGroup
            title="插件"
            description="请求阶段和响应阶段的插件顺序与已记录快照"
            badges={[hasPlugins ? `${pluginCount} plugins` : 'unavailable']}
          >
            {hasPlugins ? (
              <PluginPipelineSection detail={detail} />
            ) : (
              <EmptyPanel title="无插件记录" description="本条日志没有记录请求或响应插件链路。" />
            )}
          </SectionGroup>
        </TabsContent>

        <LazyTabsContent
          value="stream"
          mounted={mountedTabs.has('stream')}
          onMount={mountTab}
          placeholder="Stream 内容会在进入本 Tab 时解析。"
        >
          <DetailSection
            title="Stream"
            description="SSE 或流式响应内容"
            badges={[
              detail.upstream.isStream
                ? detail.capture.streamCaptured
                  ? 'raw'
                  : 'unavailable'
                : 'unavailable',
            ]}
          >
            <StreamViewer detail={detail} />
          </DetailSection>
        </LazyTabsContent>

        <LazyTabsContent
          value="raw"
          mounted={mountedTabs.has('raw')}
          onMount={mountTab}
          placeholder="Raw JSON 会在进入本 Tab 时格式化，避免首屏阻塞。"
        >
          <DetailSection
            title="Raw"
            description="完整事件 JSON，作为事实源兜底查看"
            badges={['raw']}
          >
            <JsonBlock title="event" value={detail.rawEvent} />
          </DetailSection>
        </LazyTabsContent>
      </main>
    </Tabs>
  );
}

function DetailHeader({
  detail,
  interfaceType,
  tabs,
  onBack,
}: {
  detail: LogEventDetail;
  interfaceType: string;
  tabs: ViewerTab[];
  onBack: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-md border bg-background">
      <div className="space-y-2 px-3 py-2">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            <Button variant="outline" size="xs" onClick={onBack} className="mt-0.5">
              <ArrowLeft className="h-4 w-4" />
              返回
            </Button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={detail.summary.hasError ? 'secondary' : 'outline'}>
                  {detail.summary.statusClass}
                </Badge>
                {detail.upstream.isStream ? <Badge variant="outline">stream</Badge> : null}
              </div>
              <h1 className="mt-1 flex min-w-0 items-center gap-2 text-sm font-semibold">
                <span className="shrink-0 rounded-md border bg-muted/30 px-1.5 py-0.5 font-mono text-xs">
                  {detail.request.method}
                </span>
                <span className="truncate" title={detail.request.path}>
                  {detail.request.path}
                </span>
              </h1>
            </div>
          </div>

          <div className="hidden min-w-0 text-right text-xs text-muted-foreground md:block">
            <div className="font-mono">{detail.summary.requestId}</div>
            <div className="mt-1">{formatDateTime(detail.summary.ts)}</div>
          </div>
        </div>

        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_220px]">
          <HeaderRouteSummary detail={detail} interfaceType={interfaceType} />
          <div className="grid grid-cols-2 gap-2 text-xs">
            <HeaderMetric label="HTTP" value={String(detail.summary.upstreamStatus)} />
            <HeaderMetric label="Latency" value={`${detail.summary.latencyMs} ms`} />
          </div>
        </div>
      </div>
      <div className="overflow-x-auto border-t px-3 py-1.5">
        <TabsList variant="line" className="h-auto min-w-max justify-start">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} className="gap-1.5 px-2.5 py-1.5 text-xs">
              <span>{tab.label}</span>
              {tab.meta ? (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                  {tab.meta}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </section>
  );
}

function HeaderRouteSummary({
  detail,
  interfaceType,
}: {
  detail: LogEventDetail;
  interfaceType: string;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/15 px-2.5 py-1.5">
      <div className="text-[11px] text-muted-foreground">Route</div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
        <HeaderPill value={detail.summary.modelIn} mono />
        <span className="text-muted-foreground">→</span>
        <HeaderPill value={detail.summary.provider} />
        <span className="text-muted-foreground">/</span>
        <HeaderPill value={detail.summary.modelOut} mono />
        <HeaderPill value={detail.summary.routeType} subtle />
        <HeaderPill value={interfaceType} subtle />
        {detail.summary.routeRuleKey ? (
          <HeaderPill value={detail.summary.routeRuleKey} mono subtle />
        ) : null}
      </div>
    </div>
  );
}

function HeaderPill({ value, mono, subtle }: { value: string; mono?: boolean; subtle?: boolean }) {
  return (
    <span
      className={cn(
        'max-w-full truncate rounded-full border px-2 py-0.5 text-xs',
        mono && 'font-mono',
        subtle ? 'bg-background text-muted-foreground' : 'bg-background text-foreground'
      )}
      title={value}
    >
      {value}
    </span>
  );
}

function HeaderMetric({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/15 px-2.5 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn('mt-0.5 truncate text-sm font-medium', mono ? 'font-mono' : 'tabular-nums')}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function OverviewSection({
  detail,
  interfaceType,
}: {
  detail: LogEventDetail;
  interfaceType: string;
}) {
  return (
    <DetailSection
      title="概览"
      description="核心元信息、模型路由、用量和采集范围"
      badges={[
        'captured',
        detail.usage.tokenUsage ? detail.usage.tokenUsage.source : 'unavailable',
      ]}
    >
      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-1.5">
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
          <MetaItem label="定位" value={`${detail.location.file}:${detail.location.line}`} mono />
        </div>

        <div className="rounded-md border bg-muted/10 p-2">
          <RouteFlowCard
            interfaceType={interfaceType}
            routeType={detail.summary.routeType}
            modelIn={detail.summary.modelIn}
            provider={detail.summary.provider}
            modelOut={detail.summary.modelOut}
            routeRuleKey={detail.summary.routeRuleKey}
          />
        </div>

        <UsageSizeSection detail={detail} />
        <CaptureMatrix detail={detail} />
        <OverviewContext detail={detail} />
      </div>
    </DetailSection>
  );
}

function DetailSection({
  title,
  description,
  badges,
  children,
}: {
  title: string;
  description?: string;
  badges?: string[];
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border bg-background">
      <SectionHeading title={title} description={description} badges={badges} />
      <div className="px-3 py-2.5">{children}</div>
    </section>
  );
}

function SectionGroup({
  title,
  description,
  badges,
  children,
}: {
  title: string;
  description?: string;
  badges?: string[];
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <SectionHeading title={title} description={description} badges={badges} bare />
      {children}
    </section>
  );
}

function SectionHeading({
  title,
  description,
  badges,
  bare,
}: {
  title: string;
  description?: string;
  badges?: string[];
  bare?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-2 px-3 py-2',
        bare ? 'rounded-md border bg-background' : 'border-b'
      )}
    >
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {badges && badges.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {badges.map((badge) => (
            <SourceBadge key={badge} value={badge} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SourceBadge({ value }: { value: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-[11px]',
        value === 'unavailable' && 'border-muted-foreground/30 text-muted-foreground',
        value === 'partial' && 'border-amber-500/40 text-amber-600 dark:text-amber-400',
        value.startsWith('plugin') && 'border-blue-500/40 text-blue-600 dark:text-blue-400'
      )}
    >
      {value}
    </Badge>
  );
}

function LazyTabsContent({
  value,
  mounted,
  onMount,
  placeholder,
  children,
}: {
  value: DetailTabId;
  mounted: boolean;
  onMount: (tabId: DetailTabId) => void;
  placeholder: string;
  children: ReactNode;
}) {
  return (
    <TabsContent value={value} className="mt-0">
      {mounted ? (
        children
      ) : (
        <div className="rounded-md border border-dashed bg-background px-3 py-4">
          <div className="text-sm text-muted-foreground">{placeholder}</div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => onMount(value)}
          >
            查看本 Tab 内容
          </Button>
        </div>
      )}
    </TabsContent>
  );
}

function ConversationViewer({ detail }: { detail: LogEventDetail }) {
  const parsed = useMemo(() => parseChatHistory(detail), [detail]);
  return <ChatHistorySplitViewer parsed={parsed} />;
}

function RequestCompareSection({ detail }: { detail: LogEventDetail }) {
  const userRequestBody = restoreLocalRouterBody(detail);
  const hasRequestBodyAfterPlugins = detail.plugins?.requestBodyAfterPlugins !== undefined;
  const providerRequestBody = hasRequestBodyAfterPlugins
    ? detail.plugins?.requestBodyAfterPlugins
    : detail.request.requestBody;
  const providerRequestUrl = detail.plugins?.requestUrlAfterPlugins ?? detail.upstream.targetUrl;

  return (
    <div className="grid gap-2.5 xl:grid-cols-2">
      <ComparePanel
        title="用户请求"
        description="进入 local-router 的请求视图"
        source="reconstructed"
      >
        <div className="space-y-2.5">
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <MetaItem label="method" value={detail.request.method} />
            <MetaItem label="path" value={detail.request.path} mono />
            <MetaItem label="content-type" value={detail.request.contentType ?? '-'} mono />
          </div>
          <HeadersTableBlock title="headers" headers={detail.request.requestHeaders} />
          <JsonBlock
            title="request_body"
            value={userRequestBody}
            contentType={detail.request.contentType}
            emptyText="无请求 body 或未采集。"
          />
        </div>
      </ComparePanel>

      <ComparePanel
        title="Provider 请求"
        description={`最终发送给 ${detail.summary.provider} 的请求视图`}
        source={hasRequestBodyAfterPlugins ? 'plugin-after' : 'captured'}
      >
        <div className="space-y-2.5">
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <MetaItem label="target_url" value={providerRequestUrl} mono />
            <MetaItem label="provider" value={detail.summary.provider} />
          </div>
          <JsonBlock
            title="request_body_after_plugins"
            value={providerRequestBody}
            contentType={detail.request.contentType}
            emptyText="无请求 body 或未采集。"
          />
          <SnapshotNote
            text={
              hasRequestBodyAfterPlugins
                ? '已记录插件处理后的请求 body 快照。'
                : '未记录插件处理后的请求 body 快照；此处展示已采集的请求 body。'
            }
          />
        </div>
      </ComparePanel>
    </div>
  );
}

function ResponseCompareSection({ detail }: { detail: LogEventDetail }) {
  const hasResponseBodyBeforePlugins = detail.plugins?.responseBodyBeforePlugins !== undefined;
  const hasResponseBodyAfterPlugins = detail.plugins?.responseBodyAfterPlugins !== undefined;
  const providerResponseBody = hasResponseBodyBeforePlugins
    ? detail.plugins?.responseBodyBeforePlugins
    : detail.response.responseBody;
  const finalResponseBody = hasResponseBodyAfterPlugins
    ? detail.plugins?.responseBodyAfterPlugins
    : detail.response.responseBody;

  return (
    <div className="grid gap-2.5 xl:grid-cols-2">
      <ComparePanel
        title="Provider 响应"
        description={`${detail.summary.provider} 返回给 local-router 的响应视图`}
        source={hasResponseBodyBeforePlugins ? 'plugin-before' : 'captured'}
      >
        <div className="space-y-2.5">
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <MetaItem label="upstream_status" value={String(detail.response.upstreamStatus)} />
            <MetaItem label="content-type" value={detail.response.contentType ?? '-'} mono />
          </div>
          <HeadersTableBlock title="headers" headers={detail.response.responseHeaders} />
          <JsonBlock
            title="response_body_before_plugins"
            value={providerResponseBody}
            contentType={detail.response.contentType}
            emptyText={
              detail.upstream.isStream
                ? '流式响应内容在 Stream 区域查看。'
                : '无响应 body 或未采集。'
            }
          />
        </div>
      </ComparePanel>

      <ComparePanel
        title="最终响应"
        description="local-router 返回给用户的响应视图"
        source={hasResponseBodyAfterPlugins ? 'plugin-after' : 'captured'}
      >
        <div className="space-y-2.5">
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <MetaItem label="status" value={String(detail.response.upstreamStatus)} />
            <MetaItem label="content-type" value={detail.response.contentType ?? '-'} mono />
          </div>
          <JsonBlock
            title="response_body"
            value={finalResponseBody}
            contentType={detail.response.contentType}
            emptyText={
              detail.upstream.isStream
                ? '流式响应内容在 Stream 区域查看。'
                : '无响应 body 或未采集。'
            }
          />
          <SnapshotNote
            text={
              hasResponseBodyAfterPlugins
                ? '已记录插件处理后的最终响应 body 快照。'
                : '未记录插件处理后的响应 body 快照；此处展示已采集的响应 body。'
            }
          />
        </div>
      </ComparePanel>
    </div>
  );
}

function ComparePanel({
  title,
  description,
  source,
  children,
}: {
  title: string;
  description: string;
  source: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-md border bg-background">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold">{title}</h4>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <SourceBadge value={source} />
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  );
}

function SnapshotNote({ text }: { text: string }) {
  return (
    <div className="rounded-md border bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground">
      {text}
    </div>
  );
}

function StreamViewer({ detail }: { detail: LogEventDetail }) {
  return (
    <div className="space-y-2.5">
      <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <MetaItem label="is_stream" value={detail.upstream.isStream ? 'true' : 'false'} />
        <MetaItem label="stream_file" value={detail.upstream.streamFile ?? '无 stream 数据'} mono />
        <MetaItem label="stream bytes" value={formatBytes(detail.usage.streamBytes)} />
        <MetaItem label="stream file bytes" value={formatBytes(detail.usage.streamFileBytes)} />
        <MetaItem
          label="stream file truncated"
          value={detail.usage.streamFileTruncated ? 'true' : 'false'}
        />
      </div>
      <StreamContentBlock
        title="stream content"
        content={detail.upstream.streamContent}
        emptyText={
          detail.upstream.isStream ? '未捕获 stream 内容。' : '非流式请求，无 stream 内容。'
        }
      />
    </div>
  );
}

function OverviewContext({ detail }: { detail: LogEventDetail }) {
  const hasRequestBodyAfterPlugins = detail.plugins?.requestBodyAfterPlugins !== undefined;
  const hasResponseBodyBeforePlugins = detail.plugins?.responseBodyBeforePlugins !== undefined;

  return (
    <div className="space-y-2 border-t pt-2.5">
      <div className="text-xs font-semibold">日志上下文</div>
      <div className="grid gap-2 lg:grid-cols-3">
        <ContextPanel title="Capture">
          <ContextRow label="bodyPolicy" value={detail.capture.bodyPolicy} mono />
          <ContextRow
            label="request body"
            value={detail.capture.requestBodyAvailable ? '已采集' : '未采集'}
          />
          <ContextRow
            label="response body"
            value={detail.capture.responseBodyAvailable ? '已采集' : '未采集'}
          />
          <ContextRow label="stream" value={detail.capture.streamCaptured ? '已采集' : '未采集'} />
          {detail.capture.truncatedHints.length > 0 ? (
            <div className="sm:col-span-2">
              <div className="text-[11px] text-muted-foreground">truncated</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {detail.capture.truncatedHints.map((hint) => (
                  <span key={hint} className="rounded-md border bg-muted/20 px-2 py-1 text-xs">
                    {hint}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </ContextPanel>

        <ContextPanel title="Trace">
          <ContextRow label="request_id" value={detail.summary.requestId} mono />
          <ContextRow
            label="provider_request_id"
            value={detail.upstream.providerRequestId ?? '-'}
            mono
          />
          <ContextRow label="date" value={detail.location.date} mono />
          <ContextRow label="line" value={String(detail.location.line)} mono />
          <ContextRow label="file" value={detail.location.file} mono />
        </ContextPanel>

        <ContextPanel title="Sources">
          <ContextRow label="Overview" value="captured" />
          <ContextRow label="Conversation" value="derived" />
          <ContextRow
            label="Request"
            value={hasRequestBodyAfterPlugins ? 'plugin-after' : 'captured'}
          />
          <ContextRow
            label="Response"
            value={hasResponseBodyBeforePlugins ? 'plugin-before' : 'captured'}
          />
          <ContextRow label="Raw" value="raw" />
        </ContextPanel>
      </div>
    </div>
  );
}

function ContextPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border bg-muted/10">
      <div className="border-b px-2.5 py-1.5 text-xs font-semibold">{title}</div>
      <div className="grid gap-2 px-2.5 py-2.5 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function ContextRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('truncate text-xs', mono && 'font-mono')} title={value}>
        {value}
      </div>
    </div>
  );
}

function CaptureMatrix({ detail }: { detail: LogEventDetail }) {
  const hasPluginRecords = Boolean(
    detail.plugins && (detail.plugins.request?.length || detail.plugins.response?.length)
  );
  const items = [
    {
      label: 'Request body',
      value: detail.capture.requestBodyAvailable ? '已采集' : '未采集',
    },
    {
      label: 'Response body',
      value: detail.capture.responseBodyAvailable ? '已采集' : '未采集',
    },
    {
      label: 'Stream',
      value: detail.capture.streamCaptured ? '已采集' : '未采集',
    },
    {
      label: 'Plugin snapshots',
      value: hasPluginRecords ? '已记录' : '未记录',
    },
  ];

  return (
    <div className="space-y-2 border-t pt-2.5">
      <div className="text-xs font-semibold">采集范围</div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="rounded-md border bg-muted/10 px-2.5 py-1.5">
            <div className="text-xs text-muted-foreground">{item.label}</div>
            <div className="mt-0.5 text-xs font-medium">{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-md border border-dashed bg-background px-3 py-4">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{description}</div>
    </div>
  );
}

function formatToken(value: number | null | undefined): string {
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

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function usageRows(usage: TokenUsageSummary | null): Array<[string, string]> {
  if (!usage) return [];
  const rows: Array<[string, string]> = [
    ['cached input', formatToken(usage.cachedInputTokens)],
    ['cache read', formatToken(usage.cacheReadInputTokens)],
    ['cache creation', formatToken(usage.cacheCreationInputTokens)],
    ['cache creation 5m', formatToken(usage.cacheCreationInputTokens5m)],
    ['cache creation 1h', formatToken(usage.cacheCreationInputTokens1h)],
    ['cache write', formatToken(usage.cacheWriteInputTokens)],
    ['cache miss', formatToken(usage.cacheMissInputTokens)],
    ['reasoning', formatToken(usage.reasoningTokens)],
    ['audio input', formatToken(usage.audioInputTokens)],
    ['audio output', formatToken(usage.audioOutputTokens)],
    ['text input', formatToken(usage.textInputTokens)],
    ['text output', formatToken(usage.textOutputTokens)],
    ['accepted prediction', formatToken(usage.acceptedPredictionTokens)],
    ['rejected prediction', formatToken(usage.rejectedPredictionTokens)],
    ['tool prompt', formatToken(usage.toolUsePromptTokens)],
    ['billable input', formatToken(usage.billableInputTokens)],
    ['billable output', formatToken(usage.billableOutputTokens)],
    ['credit usage', formatToken(usage.creditUsage)],
    ['cost', formatToken(usage.cost)],
    ['provider style', usage.providerStyle],
    ['source', usage.source],
    ['raw path', usage.rawUsagePath ?? '-'],
    ['cache formula', usage.cacheHitRateFormula ?? '-'],
  ];
  return rows.filter(([, value]) => value !== '-');
}

function UsageSizeSection({ detail }: { detail: LogEventDetail }) {
  const usage = detail.usage.tokenUsage ?? detail.summary.tokenUsage;
  const rows = usageRows(usage);
  return (
    <div className="space-y-2.5 border-t pt-2.5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold">Usage / Size</div>
          <div className="text-xs text-muted-foreground">Token 用量与请求/响应体积</div>
        </div>
        {usage ? <Badge variant="outline">{usage.providerStyle}</Badge> : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Input" value={formatToken(usage?.inputTokens)} />
        <MetricTile label="Output" value={formatToken(usage?.outputTokens)} />
        <MetricTile label="Total" value={formatToken(usage?.totalTokens)} />
        <MetricTile label="缓存命中率" value={formatPercent(usage?.cacheHitRate)} />
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <MetaItem label="request bytes" value={formatBytes(detail.usage.requestBytes)} />
        <MetaItem label="response bytes" value={formatBytes(detail.usage.responseBytes)} />
        <MetaItem label="stream bytes" value={formatBytes(detail.usage.streamBytes)} />
        <MetaItem
          label="stream file"
          value={`${formatBytes(detail.usage.streamFileBytes)}${
            detail.usage.streamFileTruncated ? ' · truncated' : ''
          }`}
        />
      </div>

      {rows.length > 0 ? (
        <div className="grid gap-x-4 gap-y-1 border-t pt-2.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(([label, value]) => (
            <div key={label} className="flex min-w-0 justify-between gap-3">
              <span className="shrink-0 text-muted-foreground">{label}</span>
              <span className="min-w-0 truncate text-right font-mono" title={value}>
                {value}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="border-t pt-2.5 text-xs text-muted-foreground">
          本条日志未包含 provider usage 字段。
        </div>
      )}
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-2.5 py-1.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}
