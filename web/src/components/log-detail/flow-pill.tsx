import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

interface FlowPillProps {
  label: string;
  value: string;
  mono?: boolean;
}

export function FlowPill({ label, value, mono = false }: FlowPillProps) {
  return (
    <div className="rounded-md border bg-background/90 px-2 py-1">
      <div className="flex items-center justify-between gap-1 text-[11px] leading-4 text-muted-foreground">
        <span>{label}</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast.success(`已复制 ${label}`);
          }}
          aria-label={`复制 ${label}`}
          title={`复制 ${label}`}
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
      <div className={`mt-0.5 break-all text-xs ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}
