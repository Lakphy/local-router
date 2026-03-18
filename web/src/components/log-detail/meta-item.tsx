import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

interface MetaItemProps {
  label: string;
  value: string;
  mono?: boolean;
}

export function MetaItem({ label, value, mono = false }: MetaItemProps) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
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
      <div className={`mt-1 break-all ${mono ? 'font-mono text-xs' : 'text-sm'}`}>{value}</div>
    </div>
  );
}
