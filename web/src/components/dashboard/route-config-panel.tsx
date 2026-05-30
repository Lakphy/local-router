import { CircleDot, Loader2, RotateCcw, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { DashboardPanel } from '@/components/dashboard/panel';
import { RoutesEditor } from '@/components/routes-editor';
import { Button } from '@/components/ui/button';
import { selectIsDirty, useConfigStore } from '@/stores/config-store';
import { useDialogStore } from '@/stores/dialog-store';

export function RouteConfigPanel() {
  const isDirty = useConfigStore(selectIsDirty);
  const saving = useConfigStore((s) => s.saving);
  const applying = useConfigStore((s) => s.applying);
  const reset = useConfigStore((s) => s.reset);
  const openDiff = useDialogStore((s) => s.openDiff);

  const busy = saving || applying;

  function handleReset() {
    reset();
    toast.info('已重置为上次保存的配置');
  }

  return (
    <DashboardPanel
      title="路由配置"
      description="直接在仪表盘编辑模型路由，保存并应用即可生效"
      action={
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1.5 text-xs sm:flex">
            {isDirty ? (
              <>
                <CircleDot className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-muted-foreground">有未保存的更改</span>
              </>
            ) : (
              <span className="text-muted-foreground">配置已同步</span>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={handleReset} disabled={!isDirty || busy}>
            <RotateCcw className="mr-1 h-4 w-4" />
            重置
          </Button>
          <Button size="sm" onClick={() => openDiff('saveAndApply')} disabled={!isDirty || busy}>
            {applying ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Zap className="mr-1 h-4 w-4" />
            )}
            应用更改
          </Button>
        </div>
      }
      contentClassName="px-3 py-3"
    >
      <RoutesEditor />
    </DashboardPanel>
  );
}
