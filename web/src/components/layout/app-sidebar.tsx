import { Link, useRouterState } from "@tanstack/react-router";
import {
  Coins,
  FileCog,
  FileSearch,
  LayoutDashboard,
  MessageSquare,
  Route,
  Server,
  Users,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

type NavItem = {
  to:
    | "/dashboard"
    | "/chat"
    | "/providers"
    | "/routes"
    | "/logs"
    | "/sessions"
    | "/usage"
    | "/logs-settings";
  label: string;
  icon: typeof LayoutDashboard;
};

const OBSERVE_ITEMS: NavItem[] = [
  { to: "/dashboard", label: "仪表盘", icon: LayoutDashboard },
  { to: "/chat", label: "聊天面板", icon: MessageSquare },
  { to: "/usage", label: "用量统计", icon: Coins },
  { to: "/logs", label: "日志检索", icon: FileSearch },
  { to: "/sessions", label: "用户会话", icon: Users },
];

const CONFIG_ITEMS: NavItem[] = [
  { to: "/providers", label: "供应商配置", icon: Server },
  { to: "/routes", label: "路由配置", icon: Route },
  { to: "/logs-settings", label: "日志配置", icon: FileCog },
];

function NavGroup({
  title,
  items,
  pathname,
}: {
  title: string;
  items: NavItem[];
  pathname: string;
}) {
  const { open } = useSidebar();
  return (
    <SidebarGroup>
      <p
        className="px-2 text-xs text-muted-foreground/60 font-medium tracking-wide select-none overflow-hidden transition-[max-height,opacity,padding] duration-200"
        style={{
          maxHeight: open ? "2rem" : 0,
          opacity: open ? 1 : 0,
          paddingTop: open ? "0.75rem" : 0,
          paddingBottom: open ? "0.25rem" : 0,
        }}
      >
        {title}
      </p>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const isActive =
              pathname === item.to ||
              (item.to === "/logs" && pathname.startsWith("/logs/")) ||
              (item.to === "/sessions" && pathname.startsWith("/sessions"));
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
  );
}

export function AppSidebar() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return (
    <Sidebar>
      <SidebarContent>
        <NavGroup title="观测" items={OBSERVE_ITEMS} pathname={pathname} />
        <NavGroup title="配置" items={CONFIG_ITEMS} pathname={pathname} />
      </SidebarContent>
    </Sidebar>
  );
}
