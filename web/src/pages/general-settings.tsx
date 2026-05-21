import { Network, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useConfigStore } from '@/stores/config-store';
import type { AppConfig, ServerConfig } from '@/types/config';

function ensureServer(cfg: AppConfig): ServerConfig {
  return cfg.server ?? {};
}

export function GeneralSettingsPage() {
  const draft = useConfigStore((s) => s.draft);
  const updateDraft = useConfigStore((s) => s.updateDraft);

  if (!draft) return null;

  const lanEnabled = draft.server?.lanAccess?.enabled === true;

  function updateServer(fn: (server: ServerConfig) => ServerConfig) {
    updateDraft((cfg) => {
      cfg.server = fn(ensureServer(cfg));
      return cfg;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 lg:overflow-hidden">
      <div className="shrink-0">
        <h2 className="text-2xl font-bold tracking-tight">通用设置</h2>
        <p className="text-muted-foreground">管理服务访问范围与全局运行策略</p>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <div className="rounded-lg border bg-background">
            <div className="flex items-start justify-between gap-4 border-b px-3 py-3">
              <div className="flex min-w-0 gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Network className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold">局域网服务</h3>
                    <Badge variant={lanEnabled ? 'default' : 'secondary'}>
                      {lanEnabled ? '已开启' : '已关闭'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    关闭时只处理本机来源请求；开启后允许局域网内其他设备调用网关接口。
                  </p>
                </div>
              </div>
              <Switch
                checked={lanEnabled}
                onCheckedChange={(enabled) =>
                  updateServer((server) => ({
                    ...server,
                    lanAccess: {
                      ...server.lanAccess,
                      enabled,
                    },
                  }))
                }
                aria-label="切换局域网服务"
              />
            </div>

            <div className="grid gap-3 px-3 py-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">关闭状态</Label>
                <p className="text-sm">仅接受 127.0.0.1 和 ::1 等本机回环来源。</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">开启状态</Label>
                <p className="text-sm">接受本机来源与私有网段、链路本地地址来源。</p>
              </div>
            </div>
          </div>
        </div>

        <aside className="rounded-lg border bg-background p-3">
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
              <ShieldCheck className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold">访问控制</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                服务默认监听所有网卡，运行时按来源 IP 判断是否处理请求。配置保存并应用后立即生效。
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
