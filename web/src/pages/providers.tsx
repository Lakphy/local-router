import { ChevronDown, ChevronUp, Copy, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useState, type DragEvent } from 'react';
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
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
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config-store';
import type { ProviderConfig } from '@/types/config';

const DEFAULT_PROVIDER: ProviderConfig = {
  type: 'openai-completions',
  base: '',
  apiKey: '',
  proxy: '',
  models: {},
};

type DropPosition = 'before' | 'after';

function reorderProviders(
  providers: Record<string, ProviderConfig>,
  sourceName: string,
  targetName: string,
  position: DropPosition
) {
  const names = Object.keys(providers);
  if (sourceName === targetName) return providers;

  const reorderedNames = names.filter((name) => name !== sourceName);
  let insertIndex = reorderedNames.indexOf(targetName);
  if (insertIndex === -1) return providers;
  if (position === 'after') insertIndex += 1;
  reorderedNames.splice(insertIndex, 0, sourceName);

  const nextProviders: Record<string, ProviderConfig> = {};
  for (const name of reorderedNames) {
    nextProviders[name] = providers[name];
  }
  return nextProviders;
}

function moveProviderToIndex(
  providers: Record<string, ProviderConfig>,
  sourceName: string,
  targetIndex: number
) {
  const names = Object.keys(providers);
  const sourceIndex = names.indexOf(sourceName);
  if (sourceIndex === -1) return providers;

  const boundedIndex = Math.max(0, Math.min(targetIndex, names.length - 1));
  if (boundedIndex === sourceIndex) return providers;

  const reorderedNames = [...names];
  reorderedNames.splice(sourceIndex, 1);
  reorderedNames.splice(boundedIndex, 0, sourceName);

  const nextProviders: Record<string, ProviderConfig> = {};
  for (const name of reorderedNames) {
    nextProviders[name] = providers[name];
  }
  return nextProviders;
}

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
  const [copySource, setCopySource] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [draggingName, setDraggingName] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    name: string;
    position: DropPosition;
  } | null>(null);

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
    setPendingDelete(null);
  }

  function openCopyDialog(name: string) {
    setCopySource(name);
    setCopyDialogOpen(true);
  }

  function handleCopy() {
    if (!copySource || !providers[copySource]) return;
    const name = copyName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
    if (!name || providers[name]) return;
    updateDraft((cfg) => {
      cfg.providers[name] = structuredClone(cfg.providers[copySource]);
      return cfg;
    });
    setSelected(name);
    setCopyName('');
    setCopySource(null);
    setCopyDialogOpen(false);
  }

  function moveProvider(name: string, targetIndex: number) {
    updateDraft((cfg) => {
      cfg.providers = moveProviderToIndex(cfg.providers, name, targetIndex);
      return cfg;
    });
  }

  function getDropPosition(event: DragEvent<HTMLButtonElement>): DropPosition {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
  }

  function handleDragStart(event: DragEvent<HTMLButtonElement>, name: string) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', name);
    setDraggingName(name);
    setDropIndicator(null);
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>, name: string) {
    if (!draggingName) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropIndicator({ name, position: getDropPosition(event) });
  }

  function clearDragState() {
    setDraggingName(null);
    setDropIndicator(null);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>, targetName: string) {
    if (!draggingName) return;
    event.preventDefault();
    const position = getDropPosition(event);
    updateDraft((cfg) => {
      cfg.providers = reorderProviders(cfg.providers, draggingName, targetName, position);
      return cfg;
    });
    clearDragState();
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
                  const showDropBefore =
                    dropIndicator?.name === name &&
                    dropIndicator.position === 'before' &&
                    draggingName !== name;
                  const showDropAfter =
                    dropIndicator?.name === name &&
                    dropIndicator.position === 'after' &&
                    draggingName !== name;
                  return (
                    <div key={name} className="relative">
                      <div
                        className={cn(
                          'pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-primary transition-opacity',
                          showDropBefore ? 'top-0 opacity-100' : 'top-0 opacity-0'
                        )}
                      />
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <button
                            type="button"
                            draggable
                            className={cn(
                              'w-full min-w-0 cursor-pointer overflow-hidden rounded-lg border p-3 text-left transition-colors hover:bg-accent',
                              selected === name ? 'border-primary bg-accent' : 'border-border',
                              draggingName === name && 'opacity-60'
                            )}
                            onClick={() => setSelected(name)}
                            onContextMenu={() => setSelected(name)}
                            onDragStart={(event) => handleDragStart(event, name)}
                            onDragOver={(event) => handleDragOver(event, name)}
                            onDrop={(event) => handleDrop(event, name)}
                            onDragEnd={clearDragState}
                          >
                            <div className="flex w-full min-w-0 items-center gap-2">
                              <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span className="block min-w-0 flex-1 truncate font-medium text-sm">
                                {name}
                              </span>
                            </div>
                            <div className="mt-1.5 flex w-full min-w-0 items-center gap-2">
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
                        </ContextMenuTrigger>
                        <ContextMenuContent className="w-48">
                          <ContextMenuItem onSelect={() => openCopyDialog(name)}>
                            <Copy className="h-4 w-4" />
                            复制
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => setPendingDelete(name)} variant="destructive">
                            <Trash2 className="h-4 w-4" />
                            删除
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onSelect={() => moveProvider(name, names.indexOf(name) - 1)}
                            disabled={names.indexOf(name) <= 0}
                          >
                            <ChevronUp className="h-4 w-4" />
                            上移
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() => moveProvider(name, names.indexOf(name) + 1)}
                            disabled={names.indexOf(name) >= names.length - 1}
                          >
                            <ChevronDown className="h-4 w-4" />
                            下移
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() => moveProvider(name, 0)}
                            disabled={names.indexOf(name) <= 0}
                          >
                            <ChevronUp className="h-4 w-4" />
                            上移至顶部
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() => moveProvider(name, names.length - 1)}
                            disabled={names.indexOf(name) >= names.length - 1}
                          >
                            <ChevronDown className="h-4 w-4" />
                            下移至底部
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                      <div
                        className={cn(
                          'pointer-events-none absolute inset-x-2 bottom-0 z-10 h-0.5 rounded-full bg-primary transition-opacity',
                          showDropAfter ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </div>
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
                      <Dialog
                        open={copyDialogOpen}
                        onOpenChange={(open) => {
                          setCopyDialogOpen(open);
                          if (!open) {
                            setCopyName('');
                            setCopySource(null);
                          }
                        }}
                      >
                        <DialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label="复制此 Provider"
                            onClick={() => selected && openCopyDialog(selected)}
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
                      <AlertDialog
                        open={pendingDelete !== null}
                        onOpenChange={(open) => {
                          if (!open) setPendingDelete(null);
                        }}
                      >
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            aria-label="删除此 Provider"
                            onClick={() => selected && setPendingDelete(selected)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>确认删除</AlertDialogTitle>
                            <AlertDialogDescription>
                              确定要删除 Provider「{pendingDelete}」吗？引用此 Provider
                              的路由规则将失效。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => pendingDelete && handleDelete(pendingDelete)}
                            >
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
