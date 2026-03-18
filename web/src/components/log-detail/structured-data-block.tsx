import JsonView from '@uiw/react-json-view';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { JSON_VIEW_STYLE, parseJsonCandidate, prettyJson } from '@/components/log-detail/utils';

interface StructuredDataBlockProps {
  value: unknown;
  contentType?: string | null;
  emptyText?: string;
  className?: string;
  noScroll?: boolean;
}

export function StructuredDataBlock({
  value,
  contentType,
  emptyText,
  className,
  noScroll = false,
}: StructuredDataBlockProps) {
  const parsed = useMemo(() => parseJsonCandidate(value, contentType), [contentType, value]);

  if (parsed.kind === 'empty') {
    return (
      <div className={cn('rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground', className)}>
        {emptyText ?? '-'}
      </div>
    );
  }

  if (parsed.kind === 'json-tree') {
    return (
      <div
        className={cn(
          noScroll
            ? 'rounded-md border bg-muted/20 p-3 text-xs'
            : 'max-h-[320px] overflow-auto rounded-md border bg-muted/20 p-3 text-xs',
          className
        )}
      >
        <JsonView
          value={parsed.value as object}
          displayDataTypes={false}
          displayObjectSize={false}
          enableClipboard={true}
          shortenTextAfterLength={0}
          shouldExpandNodeInitially={(_, { level }) => level < 2}
          style={JSON_VIEW_STYLE}
        />
      </div>
    );
  }

  const text =
    parsed.kind === 'json-primitive' ? prettyJson(parsed.value) : (parsed.text ?? prettyJson(value));

  return (
    <pre
      className={cn(
        noScroll
          ? 'rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-all'
          : 'max-h-[320px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-all',
        className
      )}
    >
      {text}
    </pre>
  );
}
