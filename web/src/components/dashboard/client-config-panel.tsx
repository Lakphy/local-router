import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DashboardPanel } from '@/components/dashboard/panel';

interface ClientConfigPanelProps {
  endpointLines: string[];
  claudeEnvText: string;
  codexEnvText: string;
  opencodeConfigText: string;
  onCopyText: (content: string, label: string) => void;
}

interface ConfigCodeBlockProps {
  title: string;
  content: string;
  copyLabel: string;
  onCopyText: (content: string, label: string) => void;
}

function ConfigCodeBlock({ title, content, copyLabel, onCopyText }: ConfigCodeBlockProps) {
  return (
    <div className="space-y-2 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{title}</div>
        <Button size="xs" variant="outline" onClick={() => onCopyText(content, copyLabel)}>
          <Copy className="mr-1 h-3.5 w-3.5" />
          复制
        </Button>
      </div>
      <ScrollArea className="h-72 rounded-md bg-muted">
        <pre className="p-3 text-xs leading-5">
          <code>{content}</code>
        </pre>
      </ScrollArea>
    </div>
  );
}

export function ClientConfigPanel(props: ClientConfigPanelProps) {
  const { endpointLines, claudeEnvText, codexEnvText, opencodeConfigText, onCopyText } = props;

  return (
    <DashboardPanel
      title="客户端配置方式"
      description="可直接把 Claude Code / Codex 指向本地 local-router"
      contentClassName="space-y-3 px-3 py-2.5 text-sm"
    >
      <div className="space-y-2">
        <div className="text-xs text-muted-foreground">服务入口</div>
        <div className="grid gap-2 md:grid-cols-3">
          {endpointLines.map((endpoint) => (
            <div key={endpoint} className="flex items-center gap-2 rounded bg-muted p-2">
              <code className="block flex-1 truncate text-xs">{endpoint}</code>
              <Button size="xs" variant="outline" onClick={() => onCopyText(endpoint, '服务入口')}>
                <Copy className="mr-1 h-3.5 w-3.5" />
                复制
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="h-px w-full bg-border" />

      <div className="grid gap-3 lg:grid-cols-3">
        <ConfigCodeBlock
          title="Claude Code 环境变量（示例）"
          content={claudeEnvText}
          copyLabel="Claude Code 环境变量"
          onCopyText={onCopyText}
        />
        <ConfigCodeBlock
          title="Codex 环境变量（官方支持）"
          content={codexEnvText}
          copyLabel="Codex 环境变量"
          onCopyText={onCopyText}
        />
        <ConfigCodeBlock
          title="OpenCode 配置（opencode.json）"
          content={opencodeConfigText}
          copyLabel="OpenCode 配置"
          onCopyText={onCopyText}
        />
      </div>
    </DashboardPanel>
  );
}
