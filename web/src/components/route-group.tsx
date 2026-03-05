import { ArrowRight, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AppConfig, ProviderType, RouteTarget } from '@/types/config';

const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  'openai-completions': 'OpenAI Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};

interface RouteGroupProps {
  routeType: string;
  modelMap: Record<string, RouteTarget>;
  providers: AppConfig['providers'];
  onChange: (modelMap: Record<string, RouteTarget>) => void;
}

export function RouteGroup({ modelMap, providers, onChange }: RouteGroupProps) {
  const entries = Object.entries(modelMap);

  const specificRules = entries.filter(([key]) => key !== '*');
  const wildcardRule = entries.find(([key]) => key === '*');

  function removeRule(key: string) {
    if (key === '*') return;
    const next = { ...modelMap };
    delete next[key];
    onChange(next);
  }

  function updateRuleKey(oldKey: string, newKey: string) {
    if (newKey === oldKey) return;
    const ordered: Record<string, RouteTarget> = {};
    for (const [k, v] of Object.entries(modelMap)) {
      ordered[k === oldKey ? newKey : k] = v;
    }
    onChange(ordered);
  }

  function updateRuleTarget(key: string, field: keyof RouteTarget, value: string) {
    onChange({
      ...modelMap,
      [key]: { ...modelMap[key], [field]: value },
    });
  }

  function getModelsForProvider(providerName: string): string[] {
    const p = providers[providerName];
    return p ? Object.keys(p.models) : [];
  }

  return (
    <div className="relative space-y-3">
      <div className="absolute left-0 top-0 bottom-6 w-px bg-border" />

      {/* 列标题 */}
      <div className="ml-5 flex items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground translate-x-[-0.5px] translate-y-[-1px]">
        <span className="w-[200px] min-w-[120px]">请求模型</span>
        <span className="w-5 shrink-0" />
        <span className="min-w-0 flex-1">路由目标</span>
        <span className="w-8 shrink-0" />
      </div>

      {/* 具名规则 */}
      {specificRules.length > 0 && (
        <div className="space-y-1.5 translate-x-[-0.5px] translate-y-[-1px]">
          {specificRules.map(([key, target]) => (
            <div key={key} className="relative pl-5">
              <CurvedBranchConnector />
              <RuleFlowCard
                ruleKey={key}
                target={target}
                isWildcard={false}
                providers={providers}
                getModelsForProvider={getModelsForProvider}
                onKeyCommit={(newKey) => updateRuleKey(key, newKey)}
                onTargetChange={(field, value) => updateRuleTarget(key, field, value)}
                onRemove={() => removeRule(key)}
              />
            </div>
          ))}
        </div>
      )}

      {/* 兜底分割线 */}
      {wildcardRule && specificRules.length > 0 && (
        <div className="relative ml-5 translate-x-[-0.5px] translate-y-[-1px]">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-dashed" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-background px-2 text-[11px] text-muted-foreground">
              兜底规则 — 未匹配的请求将路由至此
            </span>
          </div>
        </div>
      )}

      {/* 兜底规则 */}
      {wildcardRule && (
        <div className="relative pl-5 translate-x-[-0.5px] translate-y-[-1px]">
          <CurvedBranchConnector />
          <RuleFlowCard
            ruleKey={wildcardRule[0]}
            target={wildcardRule[1]}
            isWildcard
            providers={providers}
            getModelsForProvider={getModelsForProvider}
            onKeyCommit={() => {}}
            onTargetChange={(field, value) => updateRuleTarget('*', field, value)}
            onRemove={() => {}}
          />
        </div>
      )}
    </div>
  );
}

function CurvedBranchConnector() {
  return (
    <svg
      className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 text-border"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1 0A10 10 0 0 0 11 10H20"
        className="stroke-current"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface RuleFlowCardProps {
  ruleKey: string;
  target: RouteTarget;
  isWildcard: boolean;
  providers: AppConfig['providers'];
  getModelsForProvider: (name: string) => string[];
  onKeyCommit: (newKey: string) => void;
  onTargetChange: (field: keyof RouteTarget, value: string) => void;
  onRemove: () => void;
}

function RuleFlowCard({
  ruleKey,
  target,
  isWildcard,
  providers,
  getModelsForProvider,
  onKeyCommit,
  onTargetChange,
  onRemove,
}: RuleFlowCardProps) {
  const [draftRuleKey, setDraftRuleKey] = useState(ruleKey);

  useEffect(() => {
    setDraftRuleKey(ruleKey);
  }, [ruleKey]);

  function commitRuleKey() {
    if (draftRuleKey !== ruleKey) {
      onKeyCommit(draftRuleKey);
    }
  }

  const availableModels = getModelsForProvider(target.provider);
  const groupedProviders = (Object.entries(providers) as [string, AppConfig['providers'][string]][]).reduce(
    (acc, [name, provider]) => {
      acc[provider.type].push(name);
      return acc;
    },
    {
      'openai-completions': [],
      'openai-responses': [],
      'anthropic-messages': [],
    } as Record<ProviderType, string[]>
  );
  const rowClassName = isWildcard
    ? 'grid grid-cols-[minmax(120px,200px)_20px_1fr_32px] items-center gap-x-1.5 rounded-lg border border-dashed bg-muted/30 p-2 transition-colors'
    : 'grid grid-cols-[minmax(120px,200px)_20px_1fr_32px] items-center gap-x-1.5 rounded-lg border border-solid bg-background p-2 transition-colors';

  return (
    <div className={rowClassName}>
      {/* 请求模型（左侧） */}
      {isWildcard ? (
        <div className="flex w-full items-center gap-1.5 px-1">
          <Badge variant="secondary" className="text-xs font-mono">
            *
          </Badge>
          <span className="text-[11px] text-muted-foreground">所有</span>
        </div>
      ) : (
        <Input
          value={draftRuleKey}
          onChange={(e) => setDraftRuleKey(e.target.value)}
          onBlur={commitRuleKey}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
          }}
          className="h-7 text-sm font-mono"
        />
      )}

      {/* 箭头 */}
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground mx-auto" />

      {/* 路由目标（右侧） */}
      <div className="flex items-center gap-1.5 min-w-0">
        <Select value={target.provider} onValueChange={(v) => onTargetChange('provider', v)}>
          <SelectTrigger className="h-7 text-sm w-[320px] shrink-0">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PROVIDER_TYPE_LABELS) as ProviderType[]).map((type) => {
              const names = groupedProviders[type];
              if (names.length === 0) return null;
              return (
                <SelectGroup key={type}>
                  <SelectLabel>{PROVIDER_TYPE_LABELS[type]}</SelectLabel>
                  {names.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              );
            })}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground text-xs shrink-0">/</span>
        {availableModels.length > 0 ? (
          <Select value={target.model} onValueChange={(v) => onTargetChange('model', v)}>
            <SelectTrigger className="h-7 text-sm flex-1 min-w-0">
              <SelectValue placeholder="模型" />
            </SelectTrigger>
            <SelectContent>
              {availableModels.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={target.model}
            onChange={(e) => onTargetChange('model', e.target.value)}
            className="h-7 text-sm font-mono flex-1 min-w-0"
            placeholder="模型名称"
          />
        )}
      </div>

      {/* 删除 */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-destructive hover:text-destructive"
        disabled={isWildcard}
        onClick={onRemove}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}
