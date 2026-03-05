import { CircleDot, RotateCcw, Save, Zap, Loader2, GitCompare, FileCode2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConfigStore, selectIsDirty } from '@/stores/config-store';
import { useDialogStore } from '@/stores/dialog-store';

export function ActionBar() {
  const isDirty = useConfigStore(selectIsDirty);
  const saving = useConfigStore((s) => s.saving);
  const applying = useConfigStore((s) => s.applying);
  const config = useConfigStore((s) => s.config);
  const draft = useConfigStore((s) => s.draft);
  const reset = useConfigStore((s) => s.reset);

  const openDiff = useDialogStore((s) => s.openDiff);
  const openRaw = useDialogStore((s) => s.openRaw);

  const busy = saving || applying;

  function handleViewDiff() {
    openDiff('view');
  }

  function handleViewRaw() {
    openRaw(JSON.stringify(draft ?? config ?? {}, null, 2));
  }

  function handleReset() {
    reset();
    toast.info('已重置为上次保存的配置');
  }

  function handleSave() {
    openDiff('save');
  }

  function handleSaveAndApply() {
    openDiff('saveAndApply');
  }

  return (
    <div className="ml-auto flex items-center gap-3">
      <div className="hidden md:flex items-center gap-2 text-sm">
        {isDirty ? (
          <>
            <CircleDot className="h-4 w-4 text-amber-500" />
            <span className="text-muted-foreground">有未保存的更改</span>
          </>
        ) : (
          <span className="text-muted-foreground">配置已同步</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleViewDiff}
          disabled={busy}
        >
          <GitCompare className="h-4 w-4 mr-1" />
          查看 Diff
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleViewRaw}
          disabled={busy}
        >
          <FileCode2 className="h-4 w-4 mr-1" />
          查看 Raw
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleReset}
          disabled={!isDirty || busy}
        >
          <RotateCcw className="h-4 w-4 mr-1" />
          重置
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSave}
          disabled={!isDirty || busy}
        >
          {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
          保存
        </Button>
        <Button
          size="sm"
          onClick={handleSaveAndApply}
          disabled={!isDirty || busy}
        >
          {applying ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
          保存并应用
        </Button>
      </div>
    </div>
  );
}
