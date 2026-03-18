import * as React from "react";
import { PanelLeftIcon, PanelLeftClose } from "lucide-react";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const SIDEBAR_WIDTH = "192px";
const SIDEBAR_WIDTH_COLLAPSED = "48px";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

type SidebarContextProps = {
  open: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }
  return context;
}

function SidebarProvider({
  defaultOpen = true,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  const toggleSidebar = React.useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  return (
    <SidebarContext.Provider value={{ open, toggleSidebar }}>
      <TooltipProvider delayDuration={0}>
        <div
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH,
              "--sidebar-width-collapsed": SIDEBAR_WIDTH_COLLAPSED,
              ...style,
            } as React.CSSProperties
          }
          className={cn("flex min-h-svh w-full bg-sidebar", className)}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { open } = useSidebar();

  return (
    <div
      className="shrink-0 transition-[width] duration-200 ease-in-out"
      style={{
        width: open ? "var(--sidebar-width)" : "var(--sidebar-width-collapsed)",
      }}
    >
      <div
        className={cn(
          "fixed top-14 bottom-0 left-0 z-10 flex flex-col overflow-hidden bg-sidebar transition-[width] duration-200 ease-in-out",
          className,
        )}
        style={{
          width: open
            ? "var(--sidebar-width)"
            : "var(--sidebar-width-collapsed)",
        }}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { open, toggleSidebar } = useSidebar();

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-7", className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      {open ? <PanelLeftClose /> : <PanelLeftIcon />}
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      className={cn(
        "relative flex w-full flex-1 flex-col rounded-tl-2xl overflow-hidden bg-background",
        className,
      )}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden overscroll-y-contain",
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      {...props}
    />
  );
}

function SidebarGroupContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("w-full text-sm", className)} {...props} />;
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      className={cn("flex w-full min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li className={cn("group/menu-item relative", className)} {...props} />
  );
}

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  tooltip,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipContent>;
}) {
  const Comp = asChild ? Slot.Root : "button";
  const { open } = useSidebar();

  const button = (
    <Comp
      data-active={isActive}
      className={cn(
        "flex items-center overflow-hidden rounded-md p-2 text-left text-sm outline-hidden transition-all duration-200",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        "focus-visible:ring-2 ring-sidebar-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        "data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground",
        "[&>svg]:size-4 [&>svg]:shrink-0",
        open
          ? "w-full h-8 gap-2 [&>span:last-child]:truncate"
          : "size-8 justify-center [&>span]:hidden",
        className,
      )}
      {...props}
    >
      {children}
    </Comp>
  );

  if (!tooltip || open) {
    return button;
  }

  const tooltipProps =
    typeof tooltip === "string" ? { children: tooltip } : tooltip;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" {...tooltipProps} />
    </Tooltip>
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
};
