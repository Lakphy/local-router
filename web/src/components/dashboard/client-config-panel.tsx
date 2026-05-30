import { Copy } from 'lucide-react';
import { DashboardPanel } from '@/components/dashboard/panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface ClientConfigPanelProps {
  port: number;
  lanEnabled: boolean;
  onCopyText: (content: string, label: string) => void;
}

interface ConfigCodeBlockProps {
  title: string;
  hint?: string;
  content: string;
  copyLabel: string;
  onCopyText: (content: string, label: string) => void;
}

function ConfigCodeBlock({ title, hint, content, copyLabel, onCopyText }: ConfigCodeBlockProps) {
  return (
    <div className="flex flex-col space-y-2 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">{title}</div>
          {hint ? <div className="truncate text-[11px] text-muted-foreground">{hint}</div> : null}
        </div>
        <Button size="xs" variant="outline" onClick={() => onCopyText(content, copyLabel)}>
          <Copy className="mr-1 h-3.5 w-3.5" />
          复制
        </Button>
      </div>
      <ScrollArea className="h-64 rounded-md bg-muted">
        <pre className="p-3 text-xs leading-5">
          <code>{content}</code>
        </pre>
      </ScrollArea>
    </div>
  );
}

export function ClientConfigPanel({ port, lanEnabled, onCopyText }: ClientConfigPanelProps) {
  const base = `http://localhost:${port}`;

  const endpoints: Array<{ label: string; url: string }> = [
    { label: 'Anthropic Messages', url: `${base}/anthropic-messages` },
    { label: 'OpenAI Responses', url: `${base}/openai-responses/v1` },
    { label: 'OpenAI Completions', url: `${base}/openai-completions/v1` },
  ];

  const claudeEnvText = `# Claude Code 环境变量
export ANTHROPIC_BASE_URL="${base}/anthropic-messages"
export ANTHROPIC_AUTH_TOKEN="local-router"  # 占位即可，转发时由 provider.apiKey 替换
# 模型名走路由映射；如需指定可设置:
# export ANTHROPIC_MODEL="<路由中配置的模型别名>"`;

  const codexConfigText = `# ~/.codex/config.toml
model = "<路由中配置的模型别名>"
model_provider = "local-router"

[model_providers.local-router]
name = "Local Router"
base_url = "${base}/openai-responses/v1"
wire_api = "responses"
env_key = "LOCAL_ROUTER_KEY"   # 任意非空值即可: export LOCAL_ROUTER_KEY=local-router`;

  const opencodeConfigText = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local-router-responses": {
      "npm": "@ai-sdk/openai",
      "name": "Local Router (Responses)",
      "options": {
        "baseURL": "${base}/openai-responses/v1",
        "apiKey": "local-router"
      },
      "models": {
        "<模型别名>": { "name": "<模型别名>" }
      }
    },
    "local-router-completions": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local Router (Completions)",
      "options": {
        "baseURL": "${base}/openai-completions/v1",
        "apiKey": "local-router"
      },
      "models": {
        "<模型别名>": { "name": "<模型别名>" }
      }
    }
  }
}`;

  const lanGuideText = `# 局域网访问指引
# 1. 在「通用设置」开启「局域网访问 (lanAccess)」，保存并应用
# 2. 查询本机局域网 IP:
#    macOS:   ipconfig getifaddr en0
#    Linux:   hostname -I
#    Windows: ipconfig  (查看 IPv4 地址)
# 3. 把上面配置里的 localhost 换成该 IP，端口保持 ${port}
#    例如: http://192.168.x.x:${port}/anthropic-messages
# 4. 确保系统防火墙放行 ${port} 端口；同一局域网内的设备即可访问`;

  return (
    <DashboardPanel
      title="客户端配置方式"
      description={`把 Claude Code / Codex / OpenCode 指向本地 local-router（当前端口 ${port}）`}
      contentClassName="space-y-3 px-3 py-2.5 text-sm"
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>服务入口</span>
          <Badge variant={lanEnabled ? 'default' : 'secondary'} className="text-[11px]">
            局域网 {lanEnabled ? '已开启' : '未开启'}
          </Badge>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {endpoints.map((endpoint) => (
            <div key={endpoint.url} className="flex items-center gap-2 rounded bg-muted p-2">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-muted-foreground">{endpoint.label}</div>
                <code className="block truncate text-xs">{endpoint.url}</code>
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={() => onCopyText(endpoint.url, '服务入口')}
              >
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
          title="Claude Code"
          hint="环境变量"
          content={claudeEnvText}
          copyLabel="Claude Code 配置"
          onCopyText={onCopyText}
        />
        <ConfigCodeBlock
          title="Codex"
          hint="~/.codex/config.toml"
          content={codexConfigText}
          copyLabel="Codex 配置"
          onCopyText={onCopyText}
        />
        <ConfigCodeBlock
          title="OpenCode"
          hint="opencode.json"
          content={opencodeConfigText}
          copyLabel="OpenCode 配置"
          onCopyText={onCopyText}
        />
      </div>

      <ConfigCodeBlock
        title="局域网使用"
        hint="供同一网络内的其他设备访问"
        content={lanGuideText}
        copyLabel="局域网指引"
        onCopyText={onCopyText}
      />
    </DashboardPanel>
  );
}
