import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { ParsedChatHistory } from '@/lib/log-chat-history/types';
import { ChatMessageItem } from './chat-message-item';

export function ChatHistoryCard({ parsed }: { parsed: ParsedChatHistory }) {
  const hasWarnings = parsed.warnings.length > 0;

  return (
    <section className="rounded-lg border bg-background">
      <div className="border-b px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Chat History</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">messages: {parsed.messages.length}</Badge>
            <Badge variant="outline">input: {parsed.stats.inputCount}</Badge>
            <Badge variant="outline">output: {parsed.stats.outputCount}</Badge>
            {parsed.stats.streamEventCount > 0 ? (
              <Badge variant="outline">stream events: {parsed.stats.streamEventCount}</Badge>
            ) : null}
            {parsed.stats.streamPartial ? <Badge variant="secondary">stream partial</Badge> : null}
            <Badge variant={hasWarnings ? 'secondary' : 'outline'}>
              {hasWarnings ? `warnings: ${parsed.warnings.length}` : 'parse ok'}
            </Badge>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          由 request + response/stream 自动还原的消息历史
        </p>
      </div>

      <div className="space-y-3 px-3 py-3">
        {hasWarnings ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>解析提示</AlertTitle>
            <AlertDescription>
              {parsed.warnings.map((warning) => (
                <div key={warning}>• {warning}</div>
              ))}
            </AlertDescription>
          </Alert>
        ) : null}

        {parsed.messages.length === 0 ? (
          <pre className="max-h-[320px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
            无可还原的消息历史。
          </pre>
        ) : (
          <div className="space-y-2">
            {parsed.messages.map((message, index) => (
              <ChatMessageItem
                key={`${message.role}-${message.source}-${JSON.stringify(message.blocks)}-${JSON.stringify(message.meta ?? {})}`}
                message={message}
                index={index}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
