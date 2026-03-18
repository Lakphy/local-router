import ReactDiffViewer from 'react-diff-viewer-continued';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { useConfigStore } from '@/stores/config-store';
import { useDialogStore, type DiffMode } from '@/stores/dialog-store';

function getDialogTitle(mode: DiffMode): string {
  if (mode === 'save') return '确认保存配置';
  if (mode === 'saveAndApply') return '确认保存并应用配置';
  return '配置 Diff';
}

function getDialogDescription(mode: DiffMode): string {
  if (mode === 'save') return '请先审核配置变更，再确认保存到配置文件。';
  if (mode === 'saveAndApply') return '请先审核配置变更，再确认保存并热应用。';
  return '查看当前草稿与已保存配置的差异。';
}

export function ConfigDiffDialog() {
  const { theme } = useTheme();
  const config = useConfigStore((s) => s.config);
  const draft = useConfigStore((s) => s.draft);
  const saving = useConfigStore((s) => s.saving);
  const applying = useConfigStore((s) => s.applying);
  const save = useConfigStore((s) => s.save);
  const saveAndApply = useConfigStore((s) => s.saveAndApply);

  const diffOpen = useDialogStore((s) => s.diffOpen);
  const diffMode = useDialogStore((s) => s.diffMode);
  const setDiffOpen = useDialogStore((s) => s.setDiffOpen);

  const loading = saving || applying;
  const oldValue = JSON.stringify(config ?? {}, null, 2);
  const newValue = JSON.stringify(draft ?? {}, null, 2);
  const hasDiff = oldValue !== newValue;
  const isConfirmMode = diffMode === 'save' || diffMode === 'saveAndApply';

  async function handleConfirm() {
    try {
      if (diffMode === 'save') {
        await save();
        toast.success('配置已保存');
      } else if (diffMode === 'saveAndApply') {
        await saveAndApply();
        toast.success('配置已保存并应用');
      }
      setDiffOpen(false);
    } catch (err) {
      const fallback = diffMode === 'saveAndApply' ? '保存并应用失败' : '保存失败';
      toast.error(err instanceof Error ? err.message : fallback);
    }
  }

  return (
    <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
      <DialogContent className="h-[92vh] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)]!">
        <DialogHeader>
          <DialogTitle>{getDialogTitle(diffMode)}</DialogTitle>
          <DialogDescription>{getDialogDescription(diffMode)}</DialogDescription>
        </DialogHeader>

        <div className="h-[calc(92vh-170px)] rounded-lg border bg-background">
          <ScrollArea className="h-full w-full">
            {hasDiff ? (
              <ReactDiffViewer
                oldValue={oldValue}
                newValue={newValue}
                splitView
                showDiffOnly={false}
                leftTitle="已保存配置"
                rightTitle="当前草稿"
                useDarkTheme={theme === 'dark'}
                styles={{
                  variables: {
                    light: {
                      codeFoldGutterBackground: 'transparent',
                    },
                  },
                  diffContainer: {
                    overflowX: 'auto',
                  },
                }}
              />
            ) : (
              <pre className="p-4 text-xs leading-5 whitespace-pre-wrap wrap-break-word font-mono">
                {newValue}
              </pre>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          {isConfirmMode ? (
            <>
              <Button variant="outline" onClick={() => setDiffOpen(false)} disabled={loading}>
                取消
              </Button>
              <Button onClick={handleConfirm} disabled={loading || !hasDiff}>
                {diffMode === 'save' ? '确认保存' : '确认保存并应用'}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setDiffOpen(false)}>
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
