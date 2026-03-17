import type { LogEventDetail } from '@/lib/api';
import { Badge } from '@/components/ui/badge';

interface PluginPipelineSectionProps {
  detail: LogEventDetail;
}

export function PluginPipelineSection({ detail }: PluginPipelineSectionProps) {
  const plugins = detail.plugins;

  if (!plugins || (!plugins.request?.length && !plugins.response?.length)) {
    return null;
  }

  return (
    <>
      <section className="rounded-lg border bg-background">
        <div className="border-b px-3 py-3">
          <h3 className="text-base font-semibold">插件管线</h3>
          <p className="text-sm text-muted-foreground">请求/响应经过的插件处理链路（洋葱模型）</p>
        </div>
        <div className="space-y-3 px-3 py-3">
          {plugins.request && plugins.request.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">请求阶段（正序）</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-xs">
                  用户请求
                </Badge>
                {plugins.request.map((plugin, index) => (
                  <div key={`req-${plugin.name}-${index}`} className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="secondary" className="text-xs">
                      {plugin.name}
                    </Badge>
                  </div>
                ))}
                <span className="text-muted-foreground">→</span>
                <Badge variant="outline" className="text-xs">
                  Provider 请求
                </Badge>
              </div>
            </div>
          ) : null}

          {plugins.response && plugins.response.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">响应阶段（逆序）</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-xs">
                  Provider 响应
                </Badge>
                {[...plugins.response].reverse().map((plugin, index) => (
                  <div key={`res-${plugin.name}-${index}`} className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="secondary" className="text-xs">
                      {plugin.name}
                    </Badge>
                  </div>
                ))}
                <span className="text-muted-foreground">→</span>
                <Badge variant="outline" className="text-xs">
                  用户响应
                </Badge>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border bg-background">
        <div className="border-b px-3 py-3">
          <h3 className="text-base font-semibold">插件详情</h3>
          <p className="text-sm text-muted-foreground">各插件的包名与参数配置</p>
        </div>
        <div className="space-y-3 px-3 py-3">
          {(plugins.request ?? plugins.response ?? []).map((plugin, index) => (
            <div key={`detail-${plugin.name}-${index}`} className="rounded-md border bg-muted/20 p-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">
                  {plugin.name}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">{plugin.package}</span>
              </div>
              {Object.keys(plugin.params).length > 0 ? (
                <div className="mt-2">
                  <div className="text-xs text-muted-foreground">params</div>
                  <pre className="mt-1 rounded-md border bg-muted/30 p-2 text-xs">
                    {JSON.stringify(plugin.params, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {plugins.requestUrlAfterPlugins ? (
        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">插件修改记录</h3>
            <p className="text-sm text-muted-foreground">插件对请求/响应的修改</p>
          </div>
          <div className="space-y-3 px-3 py-3">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">插件处理后 URL</div>
              <div className="rounded-md border bg-muted/30 p-2 font-mono text-xs break-all">
                {plugins.requestUrlAfterPlugins}
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
