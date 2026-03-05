import { Copy, Plus, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ProviderForm } from '@/components/provider-form';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useConfigStore } from '@/stores/config-store';
import type { ProviderConfig } from '@/types/config';

const DEFAULT_PROVIDER: ProviderConfig = {
  type: 'openai-completions',
  base: '',
  apiKey: '',
  models: {},
};

export function ProvidersPage() {
  const draft = useConfigStore((s) => s.draft);
  const updateDraft = useConfigStore((s) => s.updateDraft);

  const providers = draft?.providers ?? {};
  const names = Object.keys(providers);
  const [selected, setSelected] = useState<string | null>(names[0] ?? null);
  const [newName, setNewName] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [copyName, setCopyName] = useState('');

  if (!draft) return null;

  function handleAdd() {
    const name = newName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
    if (!name || providers[name]) return;
    updateDraft((cfg) => {
      cfg.providers[name] = { ...DEFAULT_PROVIDER };
      return cfg;
    });
    setSelected(name);
    setNewName('');
    setDialogOpen(false);
  }

  function handleChange(name: string, config: ProviderConfig) {
    updateDraft((cfg) => {
      cfg.providers[name] = config;
      return cfg;
    });
  }

  function handleDelete(name: string) {
    updateDraft((cfg) => {
      delete cfg.providers[name];
      return cfg;
    });
    setSelected(names.find((n) => n !== name) ?? null);
  }

  function handleCopy() {
    if (!selected || !providers[selected]) return;
    const name = copyName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
    if (!name || providers[name]) return;
    updateDraft((cfg) => {
      cfg.providers[name] = structuredClone(cfg.providers[selected]);
      return cfg;
    });
    setSelected(name);
    setCopyName('');
    setCopyDialogOpen(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 lg:overflow-hidden">
      <div className="shrink-0">
        <h2 className="text-2xl font-bold tracking-tight">Providers</h2>
        <p className="text-muted-foreground">管理上游 API 服务商配置</p>
      </div>

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="280px" minSize="180px" maxSize="50%" className="min-w-0">
          <div className="flex h-full min-w-0 min-h-0 flex-col gap-3 overflow-hidden">
            <ScrollArea className="min-h-0 min-w-0 flex-1 **:data-[slot=scroll-area-viewport]:min-w-0 **:data-[slot=scroll-area-viewport]:overflow-x-hidden [&_[data-slot=scroll-area-viewport]>div]:block! [&_[data-slot=scroll-area-viewport]>div]:min-w-0 [&_[data-slot=scroll-area-viewport]>div]:w-full">
              <div className="w-full min-w-0 space-y-2 pr-2">
                {names.map((name) => {
                  const p = providers[name];
                  const modelCount = Object.keys(p.models).length;
                  return (
                    <button
                      key={name}
                      type="button"
                      className={`w-full min-w-0 overflow-hidden text-left rounded-lg border p-3 transition-colors hover:bg-accent cursor-pointer ${
                        selected === name ? 'border-primary bg-accent' : 'border-border'
                      }`}
                      onClick={() => setSelected(name)}
                    >
                      <div className="flex w-full min-w-0 items-center gap-2">
                        <Server className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="block min-w-0 flex-1 truncate font-medium text-sm">{name}</span>
                      </div>
                      <div className="mt-1.5 ml-6 flex w-full min-w-0 items-center gap-2">
                        <Badge
                          variant="outline"
                          className="min-w-0 max-w-full overflow-hidden text-xs"
                        >
                          <span className="block min-w-0 truncate">{p.type}</span>
                        </Badge>
                        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                          {modelCount} 个模型
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>

            <div className="shrink-0 pr-2">
              <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" className="w-full">
                    <Plus className="h-4 w-4 mr-1" />
                    添加 Provider
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>添加 Provider</DialogTitle>
                    <DialogDescription>
                      输入新 Provider 的名称（kebab-case 格式）
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2">
                    <Label htmlFor="new-provider-name">名称</Label>
                    <Input
                      id="new-provider-name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="my-provider"
                      className="font-mono"
                      onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                    />
                  </div>
                  <DialogFooter>
                    <Button onClick={handleAdd} disabled={!newName.trim()}>
                      创建
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle
          withHandle
          className="bg-transparent transition-colors duration-200 hover:bg-border focus-visible:bg-border active:bg-border [&>div]:opacity-0 [&>div]:transition-opacity [&>div]:duration-200 hover:[&>div]:opacity-100 focus-visible:[&>div]:opacity-100 active:[&>div]:opacity-100"
        />

        <ResizablePanel minSize="400px">
          <div className="flex h-full flex-col min-h-0 pl-2 pb-3 lg:pb-0">
            <div className="rounded-lg border bg-background flex flex-col min-h-0 h-full">
              <div className="border-b px-3 py-3 shrink-0">
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <h3 className="text-base font-semibold truncate">
                    {selected ? `${selected}` : '选择一个 Provider'}
                  </h3>
                  {selected && providers[selected] && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Dialog open={copyDialogOpen} onOpenChange={setCopyDialogOpen}>
                        <DialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label="复制此 Provider"
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>复制 Provider</DialogTitle>
                            <DialogDescription>
                              输入新 Provider 的名称（kebab-case 格式）
                            </DialogDescription>
                          </DialogHeader>
                          <div className="space-y-2">
                            <Label htmlFor="copy-provider-name">名称</Label>
                            <Input
                              id="copy-provider-name"
                              value={copyName}
                              onChange={(e) => setCopyName(e.target.value)}
                              placeholder="my-provider-copy"
                              className="font-mono"
                              onKeyDown={(e) => e.key === 'Enter' && handleCopy()}
                            />
                          </div>
                          <DialogFooter>
                            <Button onClick={handleCopy} disabled={!copyName.trim()}>
                              复制
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            aria-label="删除此 Provider"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>确认删除</AlertDialogTitle>
                            <AlertDialogDescription>
                              确定要删除 Provider「{selected}」吗？引用此 Provider
                              的路由规则将失效。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDelete(selected)}>
                              删除
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="px-3 py-3">
                  {selected && providers[selected] ? (
                    <ProviderForm
                      key={selected}
                      name={selected}
                      config={providers[selected]}
                      isNew={false}
                      onChange={(config) => handleChange(selected, config)}
                    />
                  ) : (
                    <p className="text-muted-foreground text-sm py-8 text-center">
                      {names.length === 0
                        ? '暂无 Provider，点击左侧「添加 Provider」按钮创建'
                        : '请从左侧列表中选择一个 Provider'}
                    </p>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
