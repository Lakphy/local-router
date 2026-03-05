import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { RouteGroup } from '@/components/route-group';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigStore } from '@/stores/config-store';
import type { AppConfig } from '@/types/config';

const KNOWN_ROUTE_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages'];

export function RoutesPage() {
  const draft = useConfigStore((s) => s.draft);
  const updateDraft = useConfigStore((s) => s.updateDraft);

  const routeTypes = Object.keys(draft?.routes ?? {});
  const [addType, setAddType] = useState('');
  const availableTypes = KNOWN_ROUTE_TYPES.filter((t) => !routeTypes.includes(t));

  if (!draft) return null;
  const currentDraft = draft;

  function addRouteType() {
    if (!addType) return;
    const defaultProvider = Object.keys(currentDraft.providers)[0] ?? '';
    const defaultModel = defaultProvider
      ? (Object.keys(currentDraft.providers[defaultProvider]?.models ?? {})[0] ?? '')
      : '';
    updateDraft((cfg) => {
      cfg.routes[addType] = {
        '*': { provider: defaultProvider, model: defaultModel },
      };
      return cfg;
    });
    setAddType('');
  }

  function removeRouteType(routeType: string) {
    updateDraft((cfg) => {
      delete cfg.routes[routeType];
      return cfg;
    });
  }

  function updateModelMap(routeType: string, modelMap: AppConfig['routes'][string]) {
    updateDraft((cfg) => {
      cfg.routes[routeType] = modelMap;
      return cfg;
    });
  }

  function addRule(routeType: string) {
    const defaultProvider = Object.keys(currentDraft.providers)[0] ?? '';
    const defaultModel = defaultProvider
      ? (Object.keys(currentDraft.providers[defaultProvider]?.models ?? {})[0] ?? '')
      : '';

    updateDraft((cfg) => {
      const rules = cfg.routes[routeType] ?? {};
      cfg.routes[routeType] = {
        ...rules,
        [`alias-${Date.now()}`]: { provider: defaultProvider, model: defaultModel },
      };
      return cfg;
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">路由</h2>
        <p className="text-muted-foreground">管理协议入口与模型路由映射</p>
      </div>

      {routeTypes.length === 0 ? (
        <div className="rounded-lg border bg-background py-12 text-center text-muted-foreground">
          暂无路由配置，请先添加一个协议入口
        </div>
      ) : (
        <div className="space-y-6">
          {routeTypes.map((routeType) => {
            const rules = draft.routes[routeType];
            const ruleCount = Object.keys(rules).length;
            return (
              <div key={routeType} className="relative">
                <div className="rounded-lg border bg-card text-card-foreground px-3 py-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">{routeType}</h3>
                      <Badge variant="secondary" className="text-xs">
                        {ruleCount} 个规则
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        onClick={() => addRule(routeType)}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        添加规则
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>确认删除</AlertDialogTitle>
                            <AlertDialogDescription>
                              确定要删除协议入口「{routeType}」及其所有路由规则吗？
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction onClick={() => removeRouteType(routeType)}>
                              删除
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                </div>

                <div className="relative mt-3 ml-3">
                  <div className="absolute left-0 -top-3 h-3 w-px bg-border" />
                  <RouteGroup
                    routeType={routeType}
                    modelMap={draft.routes[routeType]}
                    providers={draft.providers}
                    onChange={(m) => updateModelMap(routeType, m)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {availableTypes.length > 0 && (
        <div className="flex items-center gap-2">
          <Select value={addType} onValueChange={setAddType}>
            <SelectTrigger className="w-[240px]">
              <SelectValue placeholder="选择协议类型..." />
            </SelectTrigger>
            <SelectContent>
              {availableTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={addRouteType} disabled={!addType}>
            <Plus className="h-4 w-4 mr-1" />
            添加协议入口
          </Button>
        </div>
      )}
    </div>
  );
}
