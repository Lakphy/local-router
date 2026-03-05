import type { LogConfig } from '@/types/config';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigStore } from '@/stores/config-store';
import type { AppConfig } from '@/types/config';

function ensureLog(cfg: AppConfig): LogConfig {
  return cfg.log ?? {};
}

export function LogsSettingsPage() {
  const draft = useConfigStore((s) => s.draft);
  const updateDraft = useConfigStore((s) => s.updateDraft);

  if (!draft) return null;

  const log = draft.log;
  const enabled = log?.enabled !== false && log !== undefined;

  function updateLog(fn: (log: LogConfig) => LogConfig) {
    updateDraft((cfg) => {
      cfg.log = fn(ensureLog(cfg));
      return cfg;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 lg:overflow-hidden">
      <div className="shrink-0">
        <h2 className="text-2xl font-bold tracking-tight">日志配置</h2>
        <p className="text-muted-foreground">控制请求/响应日志的记录方式与存储策略</p>
      </div>

      <div className="min-h-0 flex-1 space-y-4">
        <div className="rounded-lg border bg-background">
          <div className="flex items-center justify-between gap-3 px-3 py-3">
            <div>
              <h3 className="text-base font-semibold">启用日志</h3>
              <p className="text-sm text-muted-foreground">开启后将记录所有代理请求的元数据</p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={(v) => {
                if (v) {
                  updateLog((l) => ({ ...l, enabled: true }));
                } else if (log) {
                  updateLog((l) => ({ ...l, enabled: false }));
                }
              }}
            />
          </div>
        </div>

        {log ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border bg-background">
              <div className="border-b px-3 py-3">
                <h3 className="text-base font-semibold">通用设置</h3>
                <p className="text-sm text-muted-foreground">日志目录、Body 记录策略等通用配置</p>
              </div>
              <div className="space-y-3 px-3 py-3">
                <div className="space-y-1.5">
                  <Label>Body 记录策略</Label>
                  <Select
                    value={log.bodyPolicy ?? 'off'}
                    onValueChange={(v) =>
                      updateLog((l) => ({
                        ...l,
                        bodyPolicy: v as LogConfig['bodyPolicy'],
                      }))
                    }
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">off — 不记录 body（推荐）</SelectItem>
                      <SelectItem value="masked">masked — 脱敏记录</SelectItem>
                      <SelectItem value="full">full — 完整记录（仅调试）</SelectItem>
                    </SelectContent>
                  </Select>
                  {log.bodyPolicy === 'full' && (
                    <p className="text-xs text-muted-foreground">
                      当前为完整记录模式，可能包含敏感信息，建议仅在排障时临时开启。
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="log-basedir">日志目录</Label>
                  <Input
                    id="log-basedir"
                    value={log.baseDir ?? ''}
                    onChange={(e) =>
                      updateLog((l) => ({
                        ...l,
                        baseDir: e.target.value || undefined,
                      }))
                    }
                    placeholder="默认: ~/.local-router/logs/"
                    className="h-8"
                  />
                  <p className="text-xs text-muted-foreground">留空则使用默认路径</p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-lg border bg-background">
                <div className="border-b px-3 py-3">
                  <h3 className="text-base font-semibold">事件日志</h3>
                  <p className="text-sm text-muted-foreground">按天分片的 JSONL 格式结构化日志</p>
                </div>
                <div className="px-3 py-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="events-retain">保留天数</Label>
                    <Input
                      id="events-retain"
                      type="number"
                      min={1}
                      value={log.events?.retainDays ?? 14}
                      onChange={(e) =>
                        updateLog((l) => ({
                          ...l,
                          events: {
                            ...l.events,
                            retainDays: Number.parseInt(e.target.value) || 14,
                          },
                        }))
                      }
                      className="h-8"
                    />
                  </div>
                </div>
              </div>

              <div className="rounded-lg border bg-background">
                <div className="border-b px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold">流式日志</h3>
                      <p className="text-sm text-muted-foreground">SSE 原始响应文本</p>
                    </div>
                    <Switch
                      checked={log.streams?.enabled !== false}
                      onCheckedChange={(v) =>
                        updateLog((l) => ({
                          ...l,
                          streams: { ...l.streams, enabled: v },
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="space-y-3 px-3 py-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="streams-retain">保留天数</Label>
                    <Input
                      id="streams-retain"
                      type="number"
                      min={1}
                      value={log.streams?.retainDays ?? 7}
                      onChange={(e) =>
                        updateLog((l) => ({
                          ...l,
                          streams: {
                            ...l.streams,
                            retainDays: Number.parseInt(e.target.value) || 7,
                          },
                        }))
                      }
                      className="h-8"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="streams-maxbytes">单请求最大字节数</Label>
                    <Input
                      id="streams-maxbytes"
                      type="number"
                      min={1}
                      value={log.streams?.maxBytesPerRequest ?? 10485760}
                      onChange={(e) =>
                        updateLog((l) => ({
                          ...l,
                          streams: {
                            ...l.streams,
                            maxBytesPerRequest: Number.parseInt(e.target.value) || 10485760,
                          },
                        }))
                      }
                      className="h-8"
                    />
                    <p className="text-xs text-muted-foreground">默认 10MB (10485760)，超出部分将被截断</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border bg-background py-12 text-center text-sm text-muted-foreground">
            当前未启用日志配置，请先打开上方开关
          </div>
        )}
      </div>
    </div>
  );
}
