import type { ReactNode } from 'react';

interface DashboardPanelProps {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function DashboardPanel({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
}: DashboardPanelProps) {
  return (
    <section className={`rounded-lg border bg-background ${className ?? ''}`}>
      <div className="flex items-start justify-between gap-3 border-b px-3 py-2.5">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">{title}</h3>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={contentClassName ?? 'px-3 py-2.5'}>{children}</div>
    </section>
  );
}
