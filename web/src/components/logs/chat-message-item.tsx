import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type {
  NormalizedChatMessage,
  NormalizedContentBlock,
} from "@/lib/log-chat-history/types";

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function roleClassName(role: NormalizedChatMessage["role"]): string {
  if (role === "assistant") return "border-sky-300/50 bg-sky-500/5";
  if (role === "user") return "border-emerald-300/50 bg-emerald-500/5";
  if (role === "system") return "border-violet-300/50 bg-violet-500/5";
  return "border-amber-300/50 bg-amber-500/5";
}

function BlockContainer({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border bg-muted/20">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-between rounded-b-none rounded-t-md px-2"
          >
            <span className="text-xs text-muted-foreground">{title}</span>
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-2 pb-2">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function CopyablePre({
  text,
  copyLabel,
  className,
}: {
  text: string;
  copyLabel: string;
  className?: string;
}) {
  return (
    <div className="relative">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="absolute top-2 right-2 z-10"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast.success(`已复制 ${copyLabel}`);
          } catch {
            toast.error(`复制 ${copyLabel} 失败`);
          }
        }}
      >
        <Copy className="h-3.5 w-3.5" />
        <span className="sr-only">复制 {copyLabel}</span>
      </Button>
      <pre
        className={cn(
          "overflow-auto rounded-md border bg-background p-2 pr-10 text-xs",
          className,
        )}
      >
        {text}
      </pre>
    </div>
  );
}

function renderBlock(
  block: NormalizedContentBlock,
  index: number,
): React.ReactNode {
  if (block.type === "text") {
    return (
      <CopyablePre
        key={index}
        text={block.text || "(empty text)"}
        copyLabel="text block"
        className="whitespace-pre-wrap"
      />
    );
  }

  if (block.type === "thinking") {
    return (
      <BlockContainer key={index} title="thinking" defaultOpen={false}>
        <CopyablePre
          text={block.thinking || "(empty thinking)"}
          copyLabel="thinking block"
          className="whitespace-pre-wrap"
        />
        {block.signature ? (
          <CopyablePre
            text={`signature: ${block.signature}`}
            copyLabel="thinking signature"
            className="mt-2 whitespace-pre-wrap"
          />
        ) : null}
      </BlockContainer>
    );
  }

  if (block.type === "image") {
    return (
      <BlockContainer key={index} title="image" defaultOpen={false}>
        <div className="space-y-1 text-xs">
          <div>url: {block.url ?? "-"}</div>
          <div>mime: {block.mimeType ?? "-"}</div>
          <div>detail: {block.detail ?? "-"}</div>
        </div>
        {block.data ? (
          <CopyablePre
            text={`${block.data.slice(0, 1200)}${
              block.data.length > 1200 ? "\n... (truncated)" : ""
            }`}
            copyLabel="image data"
            className="mt-2 max-h-40"
          />
        ) : null}
      </BlockContainer>
    );
  }

  if (block.type === "tool_use") {
    return (
      <BlockContainer
        key={index}
        title={`tool_use${block.partial ? " (partial)" : ""}`}
        defaultOpen={false}
      >
        <div className="space-y-1 text-xs">
          <div>id: {block.id ?? "-"}</div>
          <div>name: {block.name ?? "-"}</div>
        </div>
        <CopyablePre
          text={
            block.input !== undefined
              ? prettyJson(block.input)
              : (block.rawInput ?? "(no input)")
          }
          copyLabel="tool_use input"
          className="mt-2 max-h-52"
        />
      </BlockContainer>
    );
  }

  if (block.type === "tool_result") {
    return (
      <BlockContainer
        key={index}
        title={`tool_result${block.isError ? " (error)" : ""}`}
        defaultOpen={false}
      >
        <div className="space-y-1 text-xs">
          <div>tool_use_id: {block.toolUseId ?? "-"}</div>
        </div>
        <CopyablePre
          text={prettyJson(block.content)}
          copyLabel="tool_result content"
          className="mt-2 max-h-52"
        />
      </BlockContainer>
    );
  }

  return (
    <BlockContainer
      key={index}
      title={block.label ?? "unknown"}
      defaultOpen={false}
    >
      <CopyablePre
        text={prettyJson(block.raw)}
        copyLabel="unknown block"
        className="max-h-52"
      />
    </BlockContainer>
  );
}

export function ChatMessageItem({
  message,
  index,
}: {
  message: NormalizedChatMessage;
  index: number;
}) {
  const messageJson = {
    role: message.role,
    source: message.source,
    meta: message.meta ?? null,
    blocks: message.blocks,
  };
  const messageCopyText = prettyJson(messageJson);

  const blocksContent = (
    <div className="space-y-2">
      {message.blocks.length > 0
        ? message.blocks.map((block, blockIndex) =>
            renderBlock(block, blockIndex),
          )
        : null}
    </div>
  );

  return (
    <div
      className={cn(
        "space-y-2 rounded-md border p-2",
        roleClassName(message.role),
      )}
    >
      <Tabs defaultValue="content" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">#{index + 1}</Badge>
          <Badge variant="outline">{message.role}</Badge>
          <Badge variant="outline">{message.source}</Badge>
          {message.meta?.stopReason ? (
            <Badge variant="secondary">stop: {message.meta.stopReason}</Badge>
          ) : null}
          {message.meta?.partial ? (
            <Badge variant="secondary">partial</Badge>
          ) : null}
          <TabsList className="ml-auto">
            <TabsTrigger value="content" className="text-xs">
              内容
            </TabsTrigger>
            <TabsTrigger value="json" className="text-xs">
              JSON
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="content" className="mt-0">
          {message.role === "system" ? (
            <BlockContainer title="system content" defaultOpen={false}>
              {blocksContent}
            </BlockContainer>
          ) : (
            blocksContent
          )}
        </TabsContent>
        <TabsContent value="json" className="mt-0">
          <div className="relative">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="absolute top-2 right-2 z-10"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(messageCopyText);
                  toast.success(`已复制 JSON #${index + 1}`);
                } catch {
                  toast.error(`复制 JSON #${index + 1} 失败`);
                }
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              <span className="sr-only">复制 JSON</span>
            </Button>
            <pre className="max-h-72 overflow-auto rounded-md border bg-background p-2 pr-10 text-xs whitespace-pre-wrap">
              {messageCopyText}
            </pre>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
