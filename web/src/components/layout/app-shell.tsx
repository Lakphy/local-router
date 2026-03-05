import type { ReactNode } from 'react';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppHeader } from './app-header';
import { AppSidebar } from './app-sidebar';

interface AppShellProps {
  title: string;
  headerActions?: ReactNode;
  children: ReactNode;
  overlays?: ReactNode;
}

export function AppShell({ title, headerActions, children, overlays }: AppShellProps) {
  return (
    <SidebarProvider className="flex h-svh flex-col overflow-hidden">
      <AppHeader title={title} actions={headerActions} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AppSidebar />
        <SidebarInset className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-auto p-6">{children}</div>
        </SidebarInset>
      </div>
      {overlays}
    </SidebarProvider>
  );
}
