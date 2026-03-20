import { Eye, EyeOff, Plus, Trash2, GripVertical, ChevronUp, ChevronDown } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import type { BalanceConfig, PluginConfig, ProviderConfig, ProviderType } from '@/types/config';
import { ModelEditor } from './model-editor';

const PROVIDER_TYPES: { value: ProviderType; label: string }[] = [
  { value: 'openai-completions', label: 'OpenAI Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
];

const PROVIDER_TARGET_PATH: Record<ProviderType, string> = {
  'openai-completions': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  'anthropic-messages': '/v1/messages',
};

const BALANCE_METHODS = ['GET', 'POST', 'PUT', 'PATCH'] as const;

interface ProviderFormProps {
  name: string;
  config: ProviderConfig;
  isNew: boolean;
  onChange: (config: ProviderConfig) => void;
}

function BalanceEditor({
  balance,
  onChange,
}: {
  balance?: BalanceConfig;
  onChange: (balance: BalanceConfig | undefined) => void;
}) {
  const [expanded, setExpanded] = useState(!!balance);
  const [headersText, setHeadersText] = useState(() =>
    balance?.request.headers ? JSON.stringify(balance.request.headers, null, 2) : ''
  );
  const [bodyText, setBodyText] = useState(() =>
    balance?.request.body ? JSON.stringify(balance.request.body, null, 2) : ''
  );
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);

  function enableBalance() {
    setExpanded(true);
    if (!balance) {
      onChange({
        request: { url: '' },
        extractor: '',
      });
    }
  }

  function disableBalance() {
    setExpanded(false);
    onChange(undefined);
    setHeadersText('');
    setBodyText('');
    setHeadersError(null);
    setBodyError(null);
  }

  function updateRequest(partial: Partial<BalanceConfig['request']>) {
    if (!balance) return;
    onChange({
      ...balance,
      request: { ...balance.request, ...partial },
    });
  }

  function handleHeadersChange(text: string) {
    setHeadersText(text);
    if (text.trim() === '') {
      setHeadersError(null);
      updateRequest({ headers: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setHeadersError('必须是 JSON 对象');
        return;
      }
      setHeadersError(null);
      updateRequest({ headers: parsed });
    } catch {
      setHeadersError('JSON 格式错误');
    }
  }

  function handleBodyChange(text: string) {
    setBodyText(text);
    if (text.trim() === '') {
      setBodyError(null);
      updateRequest({ body: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setBodyError(null);
      updateRequest({ body: parsed });
    } catch {
      setBodyError('JSON 格式错误');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">余额查询（可选）</Label>
        {balance ? (
          <Button type="button" variant="outline" size="sm" onClick={disableBalance}>
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            移除
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={enableBalance}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            配置
          </Button>
        )}
      </div>

      {!balance && !expanded && (
        <p className="text-xs text-muted-foreground">
          配置自定义 HTTP 请求来查询此 provider 的账户余额，结果将在用量统计页面展示。
        </p>
      )}

      {balance && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-1.5">
            <Label className="text-xs">请求 URL</Label>
            <Input
              value={balance.request.url}
              onChange={(e) => updateRequest({ url: e.target.value })}
              placeholder="https://api.example.com/v1/dashboard/billing/usage"
              className="text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">HTTP 方法</Label>
            <Select
              value={balance.request.method ?? 'GET'}
              onValueChange={(v) => updateRequest({ method: v })}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BALANCE_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">请求头（JSON 对象，可选）</Label>
            <Textarea
              value={headersText}
              onChange={(e) => handleHeadersChange(e.target.value)}
              placeholder={'{\n  "Authorization": "Bearer sk-xxx"\n}'}
              className="font-mono text-xs min-h-[60px]"
              rows={3}
            />
            {headersError && <p className="text-xs text-destructive">{headersError}</p>}
          </div>

          {(balance.request.method ?? 'GET') !== 'GET' && (
            <div className="space-y-1.5">
              <Label className="text-xs">请求体（JSON，可选）</Label>
              <Textarea
                value={bodyText}
                onChange={(e) => handleBodyChange(e.target.value)}
                placeholder='{ "key": "value" }'
                className="font-mono text-xs min-h-[60px]"
                rows={3}
              />
              {bodyError && <p className="text-xs text-destructive">{bodyError}</p>}
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Extractor（JS 表达式）</Label>
            <Textarea
              value={balance.extractor}
              onChange={(e) => onChange({ ...balance, extractor: e.target.value })}
              placeholder='({ remaining: response.data.balance, unit: "USD" })'
              className="font-mono text-xs min-h-[60px]"
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              JS 表达式，接收 <code className="bg-muted px-1 rounded">response</code> 变量（响应
              JSON），需返回{' '}
              <code className="bg-muted px-1 rounded">{'{ remaining: number, unit: string }'}</code>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProviderForm({ name, config, isNew, onChange }: ProviderFormProps) {
  const [showApiKey, setShowApiKey] = useState(false);
  const normalizedBase = config.base.replace(/\/+$/, '');
  const previewUrl = `${normalizedBase}${PROVIDER_TARGET_PATH[config.type]}`;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="provider-name">Provider 名称</Label>
        <Input
          id="provider-name"
          value={name}
          disabled={!isNew}
          readOnly={!isNew}
          className="font-mono"
        />
        {!isNew && <p className="text-xs text-muted-foreground">名称在创建后不可修改</p>}
      </div>

      <div className="space-y-1.5">
        <Label>协议类型</Label>
        <Select
          value={config.type}
          onValueChange={(v) => onChange({ ...config, type: v as ProviderType })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="provider-base">Base URL</Label>
        <Input
          id="provider-base"
          value={config.base}
          onChange={(e) => onChange({ ...config, base: e.target.value })}
          placeholder="https://api.example.com"
        />
        {config.base && (
          <p className="text-xs text-muted-foreground break-all">
            预览 URL: <span className="font-mono">{previewUrl}</span>
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="provider-proxy">Proxy URL（可选）</Label>
        <Input
          id="provider-proxy"
          value={config.proxy ?? ''}
          onChange={(e) => onChange({ ...config, proxy: e.target.value })}
          placeholder="http://127.0.0.1:7890"
        />
        <p className="text-xs text-muted-foreground">
          留空表示直连上游；仅此 provider 生效，不读取环境变量代理。
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="provider-apikey">API Key</Label>
        <div className="relative">
          <Input
            id="provider-apikey"
            type={showApiKey ? 'text' : 'password'}
            value={config.apiKey}
            onChange={(e) => onChange({ ...config, apiKey: e.target.value })}
            className="pr-10 font-mono"
            placeholder="sk-..."
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
            onClick={() => setShowApiKey(!showApiKey)}
          >
            {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <Separator />

      <ModelEditor models={config.models} onChange={(models) => onChange({ ...config, models })} />

      <Separator />

      <BalanceEditor
        balance={config.balance}
        onChange={(balance) => {
          const next = { ...config };
          if (balance) {
            next.balance = balance;
          } else {
            delete next.balance;
          }
          onChange(next);
        }}
      />

      <PluginListEditor
        plugins={config.plugins ?? []}
        onChange={(plugins) => onChange({ ...config, plugins: plugins.length > 0 ? plugins : undefined })}
      />
    </div>
  );
}

interface PluginEntry {
  id: string;
  config: PluginConfig;
}

let nextPluginId = 0;
function generatePluginId(): string {
  return `plugin-${Date.now()}-${++nextPluginId}`;
}

function PluginListEditor({
  plugins,
  onChange,
}: {
  plugins: PluginConfig[];
  onChange: (plugins: PluginConfig[]) => void;
}) {
  const [entries, setEntries] = useState<PluginEntry[]>(() =>
    plugins.map((config) => ({ id: generatePluginId(), config }))
  );

  // 当外部 plugins 数组变化（如父组件 reset/save 后写回），全量同步
  const prevPluginsRef = useRef(plugins);
  useEffect(() => {
    if (prevPluginsRef.current !== plugins) {
      prevPluginsRef.current = plugins;
      // 全量比较：长度不同或任意项内容不同时重建 entries
      const needsSync =
        plugins.length !== entries.length ||
        plugins.some(
          (p, i) =>
            p.package !== entries[i]?.config.package ||
            JSON.stringify(p.params) !== JSON.stringify(entries[i]?.config.params)
        );
      if (needsSync) {
        setEntries(plugins.map((config) => ({ id: generatePluginId(), config })));
      }
    }
  }, [plugins, entries.length]);

  function commitEntries(next: PluginEntry[]) {
    setEntries(next);
    onChange(next.map((e) => e.config));
  }

  function handleAdd() {
    commitEntries([...entries, { id: generatePluginId(), config: { package: '' } }]);
  }

  function handleRemove(index: number) {
    commitEntries(entries.filter((_, i) => i !== index));
  }

  function handleUpdate(index: number, updated: PluginConfig) {
    const next = [...entries];
    next[index] = { ...next[index], config: updated };
    commitEntries(next);
  }

  function handleMoveUp(index: number) {
    if (index <= 0) return;
    const next = [...entries];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    commitEntries(next);
  }

  function handleMoveDown(index: number) {
    if (index >= entries.length - 1) return;
    const next = [...entries];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    commitEntries(next);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label>插件列表</Label>
          <p className="text-xs text-muted-foreground">
            数组顺序决定洋葱模型层级：请求正序、响应逆序执行
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          添加插件
        </Button>
      </div>

      {entries.length === 0 && (
        <p className="text-xs text-muted-foreground py-2">暂无插件配置</p>
      )}

      {entries.map((entry, index) => (
        <PluginItemEditor
          key={entry.id}
          plugin={entry.config}
          index={index}
          total={entries.length}
          onUpdate={(updated) => handleUpdate(index, updated)}
          onRemove={() => handleRemove(index)}
          onMoveUp={() => handleMoveUp(index)}
          onMoveDown={() => handleMoveDown(index)}
        />
      ))}
    </div>
  );
}

function PluginItemEditor({
  plugin,
  index,
  total,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  plugin: PluginConfig;
  index: number;
  total: number;
  onUpdate: (updated: PluginConfig) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [paramsText, setParamsText] = useState(
    plugin.params ? JSON.stringify(plugin.params, null, 2) : ''
  );
  const [paramsError, setParamsError] = useState<string | null>(null);

  // 当 plugin.params 从外部变化时同步本地编辑态
  const prevParamsRef = useRef(plugin.params);
  useEffect(() => {
    if (prevParamsRef.current !== plugin.params) {
      prevParamsRef.current = plugin.params;
      setParamsText(plugin.params ? JSON.stringify(plugin.params, null, 2) : '');
      setParamsError(null);
    }
  }, [plugin.params]);

  function handleParamsChange(text: string) {
    setParamsText(text);
    if (!text.trim()) {
      setParamsError(null);
      onUpdate({ ...plugin, params: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setParamsError('params 必须是 JSON 对象');
        return;
      }
      setParamsError(null);
      onUpdate({ ...plugin, params: parsed });
    } catch {
      setParamsError('JSON 格式不正确');
    }
  }

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground shrink-0">#{index + 1}</span>
        <Input
          value={plugin.package}
          onChange={(e) => onUpdate({ ...plugin, package: e.target.value })}
          placeholder="npm-package-name 或 ./local/path.ts"
          className="font-mono text-xs h-8"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onMoveUp}
          disabled={index <= 0}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onMoveDown}
          disabled={index >= total - 1}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">params (JSON)</Label>
        <Textarea
          value={paramsText}
          onChange={(e) => handleParamsChange(e.target.value)}
          placeholder='{ "key": "value" }'
          className="font-mono text-xs min-h-[60px]"
          rows={3}
        />
        {paramsError && (
          <p className="text-xs text-destructive">{paramsError}</p>
        )}
      </div>
    </div>
  );
}
