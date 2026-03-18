import { Badge } from '@/components/ui/badge';
import { FlowPill } from '@/components/log-detail/flow-pill';

interface RouteFlowCardProps {
  interfaceType: string;
  routeType: string;
  modelIn: string;
  provider: string;
  modelOut: string;
  routeRuleKey: string;
}

export function RouteFlowCard({
  interfaceType,
  routeType,
  modelIn,
  provider,
  modelOut,
  routeRuleKey,
}: RouteFlowCardProps) {
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
