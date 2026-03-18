import { useState } from 'react';
import type { LogEventDetail } from '@/lib/api';
import { FlowStepHeader } from '@/components/log-detail/flow-step-header';
import { HeadersTableBlock } from '@/components/log-detail/headers-table-block';
import { JsonBlock } from '@/components/log-detail/json-block';
import { MetaItem } from '@/components/log-detail/meta-item';
import { restoreLocalRouterBody } from '@/components/log-detail/utils';
import { cn } from '@/lib/utils';

interface FlowStep {
  key: string;
  step: number;
  title: string;
  shortTitle: string;
  description: string;
  tag: 'request' | 'response';
  connector?: string;
}

interface RequestResponseFlowSectionsProps {
  detail: LogEventDetail;
}

export function RequestResponseFlowSections({ detail }: RequestResponseFlowSectionsProps) {
  const plugins = detail.plugins;
  const hasPlugins = Boolean(plugins && (plugins.request?.length || plugins.response?.length));
  const [activeStep, setActiveStep] = useState(1);

  const userRequestBody = restoreLocalRouterBody(detail);
  const providerRequestBody = plugins?.requestBodyAfterPlugins ?? detail.request.requestBody;
  const providerRequestUrl = plugins?.requestUrlAfterPlugins ?? detail.upstream.targetUrl;
  const providerResponseBody = plugins?.responseBodyBeforePlugins ?? detail.response.responseBody;
  const finalResponseBody = detail.response.responseBody;

  const steps: FlowStep[] = [
    {
      key: 'user-request',
      step: 1,
      title: '用户请求',
      shortTitle: '用户请求',
      description: '用户发送给 local-router 的原始请求（插件处理前）',
      tag: 'request',
      connector: hasPlugins ? `插件: ${plugins?.request?.map((p) => p.name).join(' → ') ?? '-'}` : undefined,
    },
    {
      key: 'provider-request',
      step: 2,
      title: '发送给 Provider 的请求',
      shortTitle: 'Provider 请求',
      description: `local-router 插件处理后最终发给 ${detail.summary.provider} 的请求`,
      tag: 'request',
      connector: `${detail.summary.provider} 处理`,
    },
    {
      key: 'provider-response',
      step: 3,
      title: 'Provider 响应',
      shortTitle: 'Provider 响应',
      description: `${detail.summary.provider} 返回给 local-router 的原始响应（插件处理前）`,
      tag: 'response',
      connector: hasPlugins
        ? `插件: ${plugins?.response ? [...plugins.response].reverse().map((p) => p.name).join(' → ') : '-'}`
        : undefined,
    },
    {
      key: 'final-response',
      step: 4,
      title: '最终响应',
      shortTitle: '最终响应',
      description: 'local-router 插件处理后最终返回给用户的响应',
      tag: 'response',
    },
  ];

  return (
    <div className="space-y-3 md:space-y-0">
      <div className="flex gap-1 md:hidden">
        {steps.map((step) => (
          <button
            key={step.key}
            type="button"
            onClick={() => setActiveStep(step.step)}
            className={cn(
              'flex-1 rounded-md border px-2 py-1.5 text-center text-xs transition-colors',
              activeStep === step.step
                ? 'border-primary bg-primary/10 font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted/50'
            )}
          >
            <div className="font-medium">{step.step}</div>
            <div className="mt-0.5 truncate text-[10px]">{step.shortTitle}</div>
          </button>
        ))}
      </div>

      <div className="flex gap-5">
        <div className="hidden w-44 shrink-0 md:block">
          <div className="sticky top-4 rounded-lg border bg-background px-2 py-3">
            <div className="relative flex flex-col">
              {steps.map((step, index) => (
                <div key={step.key} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => setActiveStep(step.step)}
                    className={cn(
                      'group relative flex items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-all',
                      activeStep === step.step
                        ? 'bg-primary/8 shadow-sm ring-1 ring-primary/20'
                        : 'hover:bg-muted/60'
                    )}
                  >
                    <div
                      className={cn(
                        'relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-all',
                        activeStep === step.step
                          ? 'bg-primary text-primary-foreground shadow-md shadow-primary/25'
                          : 'border-2 bg-background text-muted-foreground group-hover:border-primary/40 group-hover:text-foreground'
                      )}
                    >
                      {step.step}
                    </div>
                    <div className="min-w-0 pt-0.5">
                      <div
                        className={cn(
                          'text-sm font-medium leading-tight transition-colors',
                          activeStep === step.step
                            ? 'text-foreground'
                            : 'text-muted-foreground group-hover:text-foreground'
                        )}
                      >
                        {step.shortTitle}
                      </div>
                      <div
                        className={cn(
                          'mt-1 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none',
                          step.tag === 'request'
                            ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                            : 'bg-green-500/10 text-green-600 dark:text-green-400'
                        )}
                      >
                        {step.tag === 'request' ? 'REQUEST' : 'RESPONSE'}
                      </div>
                    </div>
                  </button>

                  {index < steps.length - 1 ? (
                    <div className="flex items-stretch gap-3 px-2.5">
                      <div className="flex w-7 justify-center">
                        <div
                          className={cn(
                            'w-px',
                            activeStep === step.step || activeStep === steps[index + 1].step
                              ? 'bg-primary/40'
                              : 'bg-border'
                          )}
                          style={{ minHeight: '40px' }}
                        />
                      </div>
                      <div className="flex items-center py-2">
                        {step.connector ? (
                          <div className="rounded-md border bg-muted/40 px-2 py-1 text-[10px] leading-snug text-muted-foreground">
                            {step.connector}
                          </div>
                        ) : (
                          <div className="h-px" />
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          {activeStep === 1 ? (
            <section className="rounded-lg border bg-background">
              <FlowStepHeader
                step={1}
                title="用户请求"
                description="用户发送给 local-router 的原始请求（插件处理前）"
              />
              <div className="space-y-3 px-3 py-3">
                <div className="grid gap-2 text-sm sm:grid-cols-3">
                  <MetaItem label="method" value={detail.request.method} />
                  <MetaItem label="path" value={detail.request.path} mono />
                  <MetaItem label="content-type" value={detail.request.contentType ?? '-'} mono />
                </div>
                <HeadersTableBlock title="headers" headers={detail.request.requestHeaders} />
                <JsonBlock
                  title="body"
                  value={userRequestBody}
                  contentType={detail.request.contentType}
                  emptyText="无请求 body 或未采集。"
                />
              </div>
            </section>
          ) : null}

          {activeStep === 2 ? (
            <section className="rounded-lg border bg-background">
              <FlowStepHeader
                step={2}
                title="发送给 Provider 的请求"
                description={`local-router 插件处理后最终发给 ${detail.summary.provider} 的请求`}
              />
              <div className="space-y-3 px-3 py-3">
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <MetaItem label="target_url" value={providerRequestUrl} mono />
                  <MetaItem label="provider" value={detail.summary.provider} />
                </div>
                <JsonBlock
                  title="body"
                  value={providerRequestBody}
                  contentType={detail.request.contentType}
                  emptyText="无请求 body 或未采集。"
                />
                {hasPlugins && plugins?.requestBodyAfterPlugins !== undefined ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                    插件已修改请求 body，此处展示的是修改后的内容。
                  </div>
                ) : !hasPlugins ? (
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    无插件处理，请求内容与用户请求一致（model 已由路由改写）。
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeStep === 3 ? (
            <section className="rounded-lg border bg-background">
              <FlowStepHeader
                step={3}
                title="Provider 响应"
                description={`${detail.summary.provider} 返回给 local-router 的原始响应（插件处理前）`}
              />
              <div className="space-y-3 px-3 py-3">
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <MetaItem label="upstream_status" value={String(detail.response.upstreamStatus)} />
                  <MetaItem label="content-type" value={detail.response.contentType ?? '-'} mono />
                </div>
                <HeadersTableBlock title="headers" headers={detail.response.responseHeaders} />
                <JsonBlock
                  title="body"
                  value={providerResponseBody}
                  contentType={detail.response.contentType}
                  emptyText={
                    detail.upstream.isStream
                      ? '流式响应，请在「会话 / 追踪」标签页查看 stream 内容。'
                      : '无响应 body 或未采集。'
                  }
                />
              </div>
            </section>
          ) : null}

          {activeStep === 4 ? (
            <section className="rounded-lg border bg-background">
              <FlowStepHeader
                step={4}
                title="最终响应"
                description="local-router 插件处理后最终返回给用户的响应"
              />
              <div className="space-y-3 px-3 py-3">
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <MetaItem label="status" value={String(detail.response.upstreamStatus)} />
                  <MetaItem label="content-type" value={detail.response.contentType ?? '-'} mono />
                </div>
                <JsonBlock
                  title="body"
                  value={finalResponseBody}
                  contentType={detail.response.contentType}
                  emptyText={
                    detail.upstream.isStream
                      ? '流式响应，请在「会话 / 追踪」标签页查看 stream 内容。'
                      : '无响应 body 或未采集。'
                  }
                />
                {hasPlugins && plugins?.responseBodyAfterPlugins !== undefined ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                    插件已修改响应 body，此处展示的是修改后的最终内容。
                  </div>
                ) : !hasPlugins ? (
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    无插件处理，响应内容与 Provider 响应一致。
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
