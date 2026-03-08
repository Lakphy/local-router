import { Link, useRouterState } from '@tanstack/react-router';
import { FileCog, FileSearch, LayoutDashboard, MessageSquare, Route, Server, Users } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

const NAV_ITEMS: {
  to: '/dashboard' | '/chat' | '/providers' | '/routes' | '/logs' | '/sessions' | '/logs-settings';
  label: string;
  icon: typeof LayoutDashboard;
}[] = [
  { to: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
  { to: '/chat', label: '聊天面板', icon: MessageSquare },
  { to: '/logs', label: '日志检索', icon: FileSearch },
  { to: '/sessions', label: '用户会话', icon: Users },
  { to: '/providers', label: '供应商配置', icon: Server },
  { to: '/routes', label: '路由配置', icon: Route },
  { to: '/logs-settings', label: '日志配置', icon: FileCog },
];

export function AppSidebar() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const isActive =
                  pathname === item.to ||
                  (item.to === '/logs' && pathname.startsWith('/logs/')) ||
                  (item.to === '/sessions' && pathname.startsWith('/sessions'));
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                      <Link to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
