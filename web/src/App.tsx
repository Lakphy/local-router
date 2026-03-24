import { Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { ActionBar } from '@/components/action-bar';
import { ConfigDiffDialog } from '@/components/config-diff-dialog';
import { ConfigRawDialog } from '@/components/config-raw-dialog';
import { AppShell } from '@/components/layout/app-shell';
import { AppStatusScreen } from '@/components/layout/app-status-screen';
import { selectIsDirty, useConfigStore } from '@/stores/config-store';
import { useDialogStore } from '@/stores/dialog-store';

const PAGE_META: Record<string, { title: string; configPage: boolean }> = {
  '/dashboard': { title: '仪表盘', configPage: false },
  '/chat': { title: '聊天面板', configPage: false },
  '/providers': { title: 'Providers', configPage: true },
  '/routes': { title: '路由', configPage: true },
  '/logs-settings': { title: '日志配置', configPage: true },
  '/logs': { title: '日志检索', configPage: false },
  '/sessions': { title: '用户会话', configPage: false },
};

function resolvePageMeta(pathname: string): { title: string; configPage: boolean } {
  if (pathname.startsWith('/logs/')) {
    return { title: '日志详情', configPage: false };
  }
  return PAGE_META[pathname] ?? PAGE_META['/dashboard'];
}

function App() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const currentMeta = resolvePageMeta(pathname);

  useEffect(() => {
    document.title = `${currentMeta.title} | Local Router`;
  }, [currentMeta.title]);

  const loading = useConfigStore((s) => s.loading);
  const error = useConfigStore((s) => s.error);
  const draft = useConfigStore((s) => s.draft);
  const isDirty = useConfigStore(selectIsDirty);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const loadSchema = useDialogStore((s) => s.loadSchema);

  useEffect(() => {
    loadConfig();
    loadSchema();
  }, [loadConfig, loadSchema]);

  useEffect(() => {
    if (!isDirty) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDirty]);

  if (loading) {
    return <AppStatusScreen loading title="正在加载配置..." />;
  }

  if (error) {
    return <AppStatusScreen title="加载配置失败" description={error} />;
  }

  return (
    <AppShell
      title={currentMeta.title}
      headerActions={currentMeta.configPage && draft ? <ActionBar /> : undefined}
      overlays={
        <>
          <ConfigDiffDialog />
          <ConfigRawDialog />
          <Toaster richColors position="bottom-right" />
        </>
      }
    >
      <Outlet />
    </AppShell>
  );
}

export default App;
