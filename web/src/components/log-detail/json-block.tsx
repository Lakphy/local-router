import { Copy } from 'lucide-react';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { StructuredDataBlock } from '@/components/log-detail/structured-data-block';

interface JsonBlockProps {
  title: string;
  value: unknown;
  contentType?: string | null;
  emptyText?: string;
}

export function JsonBlock({ title, value, contentType, emptyText }: JsonBlockProps) {
  const copyText = useMemo(() => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  }, [value]);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{title}</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={!copyText}
          onClick={async () => {
            if (!copyText) return;
            await navigator.clipboard.writeText(copyText);
            toast.success(`已复制 ${title}`);
          }}
          aria-label={`复制 ${title}`}
          title={`复制 ${title}`}
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
      <StructuredDataBlock value={value} contentType={contentType} emptyText={emptyText} />
    </div>
  );
}
