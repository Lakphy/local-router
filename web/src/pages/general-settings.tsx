import { Network, Power, Server, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { type AutostartStatus, fetchAutostartStatus, setAutostart } from '@/lib/api';
import { useConfigStore } from '@/stores/config-store';
import type { AppConfig, ServerConfig } from '@/types/config';

function ensureServer(cfg: AppConfig): ServerConfig {
  return cfg.server ?? {};
}

export function GeneralSettingsPage() {
  const draft = useConfigStore((s) => s.draft);
  const updateDraft = useConfigStore((s) => s.updateDraft);

  const [autostartInfo, setAutostartInfo] = useState<AutostartStatus | null>(null);
  const [autostartLoading, setAutostartLoading] = useState(false);

  const loadAutostart = useCallback(async () => {
    try {
      const info = await fetchAutostartStatus();
      setAutostartInfo(info);
    } catch {}
  }, []);

  useEffect(() => {
    loadAutostart();
  }, [loadAutostart]);

  if (!draft) return null;

  const lanEnabled = draft.server?.lanAccess?.enabled === true;

  function updateServer(fn: (server: ServerConfig) => ServerConfig) {
    updateDraft((cfg) => {
      cfg.server = fn(ensureServer(cfg));
      return cfg;
    });
  }

  async function handleAutostartToggle(enabled: boolean) {
    setAutostartLoading(true);
    try {
      await setAutostart(enabled);
      await loadAutostart();
      toast.success(enabled ? '已启用开机自启动' : '已禁用开机自启动');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setAutostartLoading(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 lg:overflow-hidden">
      <div className="shrink-0">
        <h2 className="text-2xl font-bold tracking-tight">通用设置</h2>
        <p className="text-muted-foreground">管理服务访问范围与全局运行策略</p>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4 overflow-y-auto">
          {/* 启动参数 */}
          <div className="rounded-lg border bg-background">
            <div className="flex items-start gap-4 border-b px-3 py-3">
              <div className="flex min-w-0 gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Server className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-base font-semibold">启动参数</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    配置服务监听地址和端口。修改后需重启生效。
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-4 px-3 py-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">监听地址</Label>
                <Input
                  placeholder="0.0.0.0"
                  value={draft.server?.host ?? ''}
                  onChange={(e) =>
                    updateServer((server) => ({
                      ...server,
                      host: e.target.value || undefined,
                    }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">监听端口</Label>
                <Input
                  type="number"
                  placeholder="4099"
                  min={1}
                  max={65535}
                  value={draft.server?.port ?? ''}
                  onChange={(e) =>
                    updateServer((server) => ({
                      ...server,
                      port: e.target.value ? Number(e.target.value) : undefined,
                    }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">空闲超时（秒）</Label>
                <Input
                  type="number"
                  placeholder="不限制"
                  min={0}
                  value={draft.server?.idleTimeout ?? ''}
                  onChange={(e) =>
                    updateServer((server) => ({
                      ...server,
                      idleTimeout: e.target.value ? Number(e.target.value) : undefined,
                    }))
                  }
                />
              </div>
            </div>
          </div>

          {/* 局域网服务 */}
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

          {/* 开机自启动 */}
          {autostartInfo && (
            <div className="rounded-lg border bg-background">
              <div className="flex items-start justify-between gap-4 border-b px-3 py-3">
                <div className="flex min-w-0 gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Power className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold">开机自启动</h3>
                      <Badge variant={autostartInfo.systemInstalled ? 'default' : 'secondary'}>
                        {autostartInfo.systemInstalled ? '已启用' : '已禁用'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      用户登录时自动以 daemon 模式启动，使用上方配置的启动参数。
                    </p>
                  </div>
                </div>
                <Switch
                  checked={autostartInfo.systemInstalled}
                  onCheckedChange={handleAutostartToggle}
                  disabled={autostartLoading || autostartInfo.platform === 'unsupported'}
                  aria-label="切换开机自启动"
                />
              </div>

              <div className="grid gap-3 px-3 py-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">平台</Label>
                  <p className="text-sm">{autostartInfo.platform}</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">服务路径</Label>
                  <p className="break-all font-mono text-sm">{autostartInfo.servicePath || '-'}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="rounded-lg border bg-background p-3">
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
              <ShieldCheck className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold">说明</h3>
              <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
                <li>
                  <strong>启动参数</strong>
                  修改后保存至配置文件，下次启动或重启时生效。开机自启动也读取此配置。
                </li>
                <li>
                  <strong>局域网服务</strong>保存并应用后立即生效，无需重启。
                </li>
                <li>
                  <strong>开机自启动</strong>切换即时生效（安装/卸载系统服务），无需额外保存。
                </li>
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
