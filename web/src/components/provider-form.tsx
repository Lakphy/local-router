import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
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
import type { ProviderConfig, ProviderType } from '@/types/config';
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

interface ProviderFormProps {
  name: string;
  config: ProviderConfig;
  isNew: boolean;
  onChange: (config: ProviderConfig) => void;
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
    </div>
  );
}
