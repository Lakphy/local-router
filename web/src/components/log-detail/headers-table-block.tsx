import { Copy } from 'lucide-react';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

interface HeadersTableBlockProps {
  title: string;
  headers: Record<string, string> | null | undefined;
  emptyText?: string;
}

export function HeadersTableBlock({ title, headers, emptyText }: HeadersTableBlockProps) {
  const entries = useMemo(() => {
    if (!headers) return [];
    return Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  }, [headers]);

  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{title}</div>
      {entries.length === 0 ? (
        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          {emptyText ?? '-'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border bg-muted/10">
          <Table className="text-xs">
            <TableBody>
              {entries.map(([key, value]) => (
                <TableRow key={key} className="hover:bg-transparent">
                  <TableCell className="w-[240px] max-w-[240px] align-top font-mono text-[11px] text-muted-foreground whitespace-normal break-all">
                    {key}
                  </TableCell>
                  <TableCell className="align-top font-mono whitespace-normal break-all">
                    {value}
                  </TableCell>
                  <TableCell className="w-10 align-top text-right">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      onClick={async () => {
                        await navigator.clipboard.writeText(`${key}: ${value}`);
                        toast.success(`已复制 ${key}`);
                      }}
                      aria-label={`复制 ${key}`}
                      title={`复制 ${key}`}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
