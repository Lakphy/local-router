import { Copy } from 'lucide-react';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { StructuredDataBlock } from '@/components/log-detail/structured-data-block';
import { parseStreamLines } from '@/components/log-detail/utils';

interface StreamContentBlockProps {
  title: string;
  content: string | null;
  emptyText?: string;
}

export function StreamContentBlock({ title, content, emptyText }: StreamContentBlockProps) {
  const lines = useMemo(() => (content ? parseStreamLines(content) : []), [content]);

  const header = (
    <div className="flex items-center justify-between gap-2">
      <div className="text-xs text-muted-foreground">{title}</div>
      <Button
        size="sm"
        variant="outline"
        disabled={!content}
        onClick={async () => {
          if (!content) return;
          await navigator.clipboard.writeText(content);
          toast.success('已复制 stream content');
        }}
      >
        <Copy className="h-3.5 w-3.5" />
        复制
      </Button>
    </div>
  );

  if (!content || lines.length === 0) {
    return (
      <div className="space-y-1">
        {header}
        <pre className="rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-all">
          {emptyText ?? '-'}
        </pre>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {header}
      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        {lines.map((line) => (
          <div key={`${line.lineNo}-${line.type}`} className="space-y-1 rounded-md border bg-background/80 p-2">
            <div className="text-[11px] text-muted-foreground">line {line.lineNo}</div>
            <StructuredDataBlock
              value={line.type === 'json' ? line.value : line.value}
              className="bg-muted/40"
              noScroll
            />
          </div>
        ))}
      </div>
    </div>
  );
}
