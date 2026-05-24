import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  Copy,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type {
  NormalizedChatMessage,
  NormalizedContentBlock,
  ParsedChatHistory,
} from '@/lib/log-chat-history/types';
import { cn } from '@/lib/utils';

const ROW_HEIGHT = 68;
const VIEWPORT_HEIGHT = 560;
const OVERSCAN_ROWS = 8;

type MessageSortOrder = 'asc' | 'desc';
type MessageDetailMode = 'visual' | 'json';

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function calculateMessageVirtualRange(input: { dataLength: number; scrollTop: number }): {
  start: number;
  end: number;
} {
  const dataLength = Math.max(0, input.dataLength);
  const visibleRows = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT);
  const windowSize = visibleRows + OVERSCAN_ROWS * 2;
  const maxStart = Math.max(0, dataLength - windowSize);
  const rawStart = Math.max(0, Math.floor(input.scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const start = Math.min(rawStart, maxStart);
  const end = Math.min(dataLength, start + windowSize);
  return { start, end };
}

function roleClassName(role: NormalizedChatMessage['role']): string {
  if (role === 'assistant') return 'border-sky-400/40 bg-sky-500/5';
  if (role === 'user') return 'border-emerald-400/40 bg-emerald-500/5';
  if (role === 'system') return 'border-violet-400/40 bg-violet-500/5';
  return 'border-amber-400/40 bg-amber-500/5';
}

function rolePillClassName(role: NormalizedChatMessage['role']): string {
  if (role === 'assistant') return 'border-sky-400/40 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  if (role === 'user') {
    return 'border-emerald-400/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (role === 'system') {
    return 'border-violet-400/40 bg-violet-500/10 text-violet-700 dark:text-violet-300';
  }
  return 'border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
}

function roleAccentClassName(role: NormalizedChatMessage['role']): string {
  if (role === 'assistant') return 'bg-sky-500/70';
  if (role === 'user') return 'bg-emerald-500/70';
  if (role === 'system') return 'bg-violet-500/70';
  return 'bg-amber-500/70';
}

function blockLabel(block: NormalizedContentBlock): string {
  if (block.type === 'text') return 'text';
  if (block.type === 'thinking') return 'thinking';
  if (block.type === 'tool_use') return block.name ? `tool_use:${block.name}` : 'tool_use';
  if (block.type === 'tool_result') return 'tool_result';
  if (block.type === 'image') return 'image';
  return block.label ?? 'unknown';
}

function blockPreview(block: NormalizedContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'thinking') return block.thinking;
  if (block.type === 'tool_use') {
    return block.input !== undefined
      ? prettyJson(block.input)
      : (block.rawInput ?? block.name ?? '');
  }
  if (block.type === 'tool_result') return prettyJson(block.content);
  if (block.type === 'image') return block.url ?? block.mimeType ?? block.data ?? 'image';
  return prettyJson(block.raw);
}

function messagePreview(message: NormalizedChatMessage): string {
  const preview = message.blocks
    .map((block) => blockPreview(block).trim())
    .filter(Boolean)
    .join(' ');
  return preview || '(empty message)';
}

function truncateText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function blockKey(block: NormalizedContentBlock): string {
  return `${block.type}-${blockLabel(block)}-${truncateText(prettyJson(block), 160)}`;
}

function roleLabel(role: NormalizedChatMessage['role']): string {
  if (role === 'assistant') return '助手';
  if (role === 'user') return '用户';
  if (role === 'system') return '系统';
  return '工具';
}

function sourceLabel(source: NormalizedChatMessage['source']): string {
  if (source === 'request') return '入站';
  if (source === 'response') return '出站';
  return '流式';
}

function ChatStatBadge({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="rounded-full border bg-muted/20 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
      {label}: {value}
    </span>
  );
}

function blockTypeLabel(type: NormalizedContentBlock['type']): string {
  if (type === 'text') return '文本';
  if (type === 'thinking') return '思考';
  if (type === 'tool_use') return '工具调用';
  if (type === 'tool_result') return '工具结果';
  if (type === 'image') return '图片';
  return '其他';
}

function blockSummary(message: NormalizedChatMessage): string {
  if (message.blocks.length === 0) return '无内容';
  const counts = new Map<NormalizedContentBlock['type'], number>();
  for (const block of message.blocks) {
    counts.set(block.type, (counts.get(block.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => `${blockTypeLabel(type)}${count > 1 ? `×${count}` : ''}`)
    .slice(0, 3)
    .join(' · ');
}

function copyText(label: string, text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`已复制 ${label}`))
    .catch(() => toast.error(`复制 ${label} 失败`));
}

export function ChatHistorySplitViewer({ parsed }: { parsed: ParsedChatHistory }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [sortOrder, setSortOrder] = useState<MessageSortOrder>('asc');
  const messageCount = parsed.messages.length;

  const scrollListTo = useCallback((top: number, behavior: ScrollBehavior = 'smooth') => {
    const nextTop = Math.max(0, top);
    viewportRef.current?.scrollTo({ top: nextTop, behavior });
    setScrollTop(nextTop);
  }, []);

  const scrollToTop = useCallback(() => {
    scrollListTo(0);
  }, [scrollListTo]);

  const scrollToBottom = useCallback(() => {
    scrollListTo(Math.max(0, messageCount * ROW_HEIGHT - VIEWPORT_HEIGHT));
  }, [messageCount, scrollListTo]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, messageCount - 1)));
    scrollListTo(0, 'auto');
  }, [messageCount, scrollListTo]);

  const displayMessages = useMemo(() => {
    const items = parsed.messages.map((message, index) => ({ message, index }));
    return sortOrder === 'desc' ? items.reverse() : items;
  }, [parsed.messages, sortOrder]);

  const selectedMessage = parsed.messages[selectedIndex] ?? null;
  const virtualRange = useMemo(
    () => calculateMessageVirtualRange({ dataLength: displayMessages.length, scrollTop }),
    [displayMessages.length, scrollTop]
  );
  const visibleMessages = useMemo(
    () => displayMessages.slice(virtualRange.start, virtualRange.end),
    [displayMessages, virtualRange.end, virtualRange.start]
  );

  return (
    <section className="overflow-hidden rounded-md border bg-background">
      {parsed.warnings.length > 0 ? (
        <div className="border-b bg-muted/10 px-2.5 py-1.5">
          <div className="flex flex-wrap gap-1.5">
            {parsed.warnings.map((warning) => (
              <span
                key={warning}
                className="rounded-full border bg-muted/20 px-2 py-0.5 text-xs text-muted-foreground"
              >
                {warning}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {parsed.messages.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          无可还原的消息历史。
        </div>
      ) : (
        <div className="grid min-h-0 gap-0 lg:grid-cols-[360px_minmax(0,1fr)]">
          <div className="border-b lg:border-r lg:border-b-0">
            <div className="flex min-h-10 items-center justify-between gap-2 border-b px-2.5 py-1.5 text-xs">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="font-medium text-foreground">Messages</span>
                <span className="text-muted-foreground">
                  #{selectedIndex + 1}/{parsed.messages.length}
                </span>
                <ChatStatBadge label="in" value={parsed.stats.inputCount} />
                <ChatStatBadge label="out" value={parsed.stats.outputCount} />
                {parsed.stats.streamEventCount > 0 ? (
                  <ChatStatBadge label="stream" value={parsed.stats.streamEventCount} />
                ) : null}
                {parsed.stats.streamPartial ? <Badge variant="secondary">partial</Badge> : null}
                {parsed.warnings.length > 0 ? (
                  <Badge variant="secondary">warnings: {parsed.warnings.length}</Badge>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'));
                    scrollListTo(0);
                  }}
                  title="切换时间排序"
                >
                  <ArrowUpDown className="h-3.5 w-3.5" />
                  {sortOrder === 'asc' ? '正序' : '倒序'}
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  onClick={scrollToTop}
                  title="到顶部"
                  aria-label="到顶部"
                >
                  <ArrowUpToLine className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  onClick={scrollToBottom}
                  title="到底部"
                  aria-label="到底部"
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div
              ref={viewportRef}
              className="h-[560px] overflow-auto"
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            >
              <div className="relative" style={{ height: parsed.messages.length * ROW_HEIGHT }}>
                {visibleMessages.map((item, localIndex) => {
                  const position = virtualRange.start + localIndex;
                  return (
                    <MessageListRow
                      key={`${item.index}-${item.message.role}-${item.message.source}`}
                      message={item.message}
                      index={item.index}
                      position={position}
                      selected={item.index === selectedIndex}
                      onSelect={() => setSelectedIndex(item.index)}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          <div className="min-w-0">
            <MessageDetail message={selectedMessage} index={selectedIndex} />
          </div>
        </div>
      )}
    </section>
  );
}

function MessageListRow({
  message,
  index,
  position,
  selected,
  onSelect,
}: {
  message: NormalizedChatMessage;
  index: number;
  position: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'absolute left-0 flex w-full items-stretch gap-1.5 border-b px-2.5 py-1.5 text-left transition-colors',
        selected ? 'bg-primary/8 ring-1 ring-primary/20' : 'hover:bg-muted/50'
      )}
      style={{ top: position * ROW_HEIGHT, height: ROW_HEIGHT }}
    >
      <span className={cn('my-1 w-1 shrink-0 rounded-full', roleAccentClassName(message.role))} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="w-8 shrink-0 font-mono text-[11px] text-muted-foreground">
              #{index + 1}
            </span>
            <span
              className={cn(
                'rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
                rolePillClassName(message.role)
              )}
            >
              {roleLabel(message.role)}
            </span>
            <span className="rounded-full border bg-background px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
              {sourceLabel(message.source)}
            </span>
          </span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {blockSummary(message)}
          </span>
        </span>
        <span
          className="mt-1 block overflow-hidden text-xs leading-snug text-foreground/90"
          style={{
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2,
          }}
        >
          {truncateText(messagePreview(message), 130)}
        </span>
      </span>
    </button>
  );
}

function MessageDetail({
  message,
  index,
}: {
  message: NormalizedChatMessage | null;
  index: number;
}) {
  const [mode, setMode] = useState<MessageDetailMode>('visual');

  if (!message) {
    return (
      <div className="flex h-[560px] items-center justify-center text-sm text-muted-foreground">
        选择左侧消息查看内容。
      </div>
    );
  }

  const jsonText = prettyJson({
    role: message.role,
    source: message.source,
    meta: message.meta ?? null,
    blocks: message.blocks,
  });

  return (
    <Tabs value={mode} onValueChange={(value) => setMode(value as MessageDetailMode)}>
      <div className="h-[560px] overflow-auto">
        <div className={cn('border-b px-2.5 py-2', roleClassName(message.role))}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge variant="outline">#{index + 1}</Badge>
              <Badge variant="outline">{roleLabel(message.role)}</Badge>
              <Badge variant="outline">{message.source}</Badge>
              <Badge variant="outline">blocks: {message.blocks.length}</Badge>
              {message.meta?.stopReason ? (
                <Badge variant="secondary">stop: {message.meta.stopReason}</Badge>
              ) : null}
              {message.meta?.partial ? <Badge variant="secondary">partial</Badge> : null}
            </div>
            <div className="flex items-center gap-1.5">
              <TabsList className="h-7">
                <TabsTrigger value="visual" className="h-6 px-2 text-xs">
                  可视化
                </TabsTrigger>
                <TabsTrigger value="json" className="h-6 px-2 text-xs">
                  JSON
                </TabsTrigger>
              </TabsList>
              <Button
                type="button"
                size="icon-xs"
                variant="outline"
                onClick={() => copyText('message JSON', jsonText)}
                title="复制 JSON"
                aria-label="复制 JSON"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>

        <TabsContent value="json" className="mt-0 pt-2">
          <CopyablePre text={jsonText} copyLabel="message JSON" />
        </TabsContent>
        <TabsContent value="visual" className="mt-0 space-y-2 px-2.5 py-2.5">
          {message.blocks.length > 0 ? (
            message.blocks.map((block, blockIndex) => (
              <MessageBlockDisclosure key={blockKey(block)} block={block} index={blockIndex} />
            ))
          ) : (
            <div className="rounded-md border border-dashed bg-muted/20 px-3 py-6 text-center text-sm text-muted-foreground">
              当前消息没有内容块。
            </div>
          )}
        </TabsContent>
      </div>
    </Tabs>
  );
}

function MessageBlockDisclosure({
  block,
  index,
}: {
  block: NormalizedContentBlock;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  const label = blockLabel(block);
  const content = blockPreview(block);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border bg-muted/15">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left"
          >
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  block {index + 1}
                </Badge>
                <span className="text-sm font-medium">{label}</span>
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {truncateText(content, 140)}
              </span>
            </span>
            {open ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <BlockContent block={block} label={label} />
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function BlockContent({ block, label }: { block: NormalizedContentBlock; label: string }) {
  if (block.type === 'text') {
    return <CopyablePre text={block.text || '(empty text)'} copyLabel={label} />;
  }

  if (block.type === 'thinking') {
    return (
      <div className="space-y-2 px-2.5 pb-2.5">
        <CopyablePre text={block.thinking || '(empty thinking)'} copyLabel={label} />
        {block.signature ? (
          <CopyablePre text={block.signature} copyLabel="thinking signature" />
        ) : null}
      </div>
    );
  }

  if (block.type === 'tool_use') {
    return (
      <div className="space-y-2 px-2.5 pb-2.5">
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div>id: {block.id ?? '-'}</div>
          <div>name: {block.name ?? '-'}</div>
        </div>
        <CopyablePre
          text={
            block.input !== undefined ? prettyJson(block.input) : (block.rawInput ?? '(no input)')
          }
          copyLabel="tool input"
        />
      </div>
    );
  }

  if (block.type === 'tool_result') {
    return (
      <div className="space-y-2 px-2.5 pb-2.5">
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div>tool_use_id: {block.toolUseId ?? '-'}</div>
          <div>is_error: {block.isError ? 'true' : 'false'}</div>
        </div>
        <CopyablePre text={prettyJson(block.content)} copyLabel="tool result" />
      </div>
    );
  }

  if (block.type === 'image') {
    return (
      <div className="space-y-2 px-2.5 pb-2.5 text-xs">
        <div>url: {block.url ?? '-'}</div>
        <div>mime: {block.mimeType ?? '-'}</div>
        <div>detail: {block.detail ?? '-'}</div>
        {block.data ? <CopyablePre text={block.data} copyLabel="image data" /> : null}
      </div>
    );
  }

  return <CopyablePre text={prettyJson(block.raw)} copyLabel={label} />;
}

function CopyablePre({ text, copyLabel }: { text: string; copyLabel: string }) {
  return (
    <div className="relative px-2.5 pb-2.5">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="absolute top-2 right-5 z-10"
        onClick={() => copyText(copyLabel, text)}
      >
        <Copy className="h-3.5 w-3.5" />
        <span className="sr-only">复制 {copyLabel}</span>
      </Button>
      <pre className="max-h-[440px] overflow-auto rounded-md border bg-background p-2 pr-10 text-xs whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}
