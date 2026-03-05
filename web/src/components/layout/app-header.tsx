import type { ReactNode } from 'react';
import { SidebarTrigger } from '@/components/ui/sidebar';

interface AppHeaderProps {
  title: string;
  actions?: ReactNode;
}

export function AppHeader({ title, actions }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 bg-[#EFEFEF] px-4">
      <SidebarTrigger className="-ml-1" />
      <h1 className="text-sm font-medium">{title}</h1>
      {actions}
    </header>
  );
}
