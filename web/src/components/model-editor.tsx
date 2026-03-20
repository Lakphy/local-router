import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Fragment, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ModelCapabilities } from '@/types/config';

interface ModelEditorProps {
  models: Record<string, ModelCapabilities>;
  onChange: (models: Record<string, ModelCapabilities>) => void;
}

function parsePriceInput(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function ModelEditor({ models, onChange }: ModelEditorProps) {
  const entries = Object.entries(models);
  const rowIdsRef = useRef(new Map<string, string>());
  const rowCounterRef = useRef(0);
  const [expandedPricing, setExpandedPricing] = useState<Set<string>>(new Set());

  const currentKeys = new Set(entries.map(([key]) => key));
  for (const key of rowIdsRef.current.keys()) {
    if (!currentKeys.has(key)) {
      rowIdsRef.current.delete(key);
    }
  }

  function getRowId(modelKey: string): string {
    const existing = rowIdsRef.current.get(modelKey);
    if (existing) return existing;
    rowCounterRef.current += 1;
    const created = `model-row-${rowCounterRef.current}`;
    rowIdsRef.current.set(modelKey, created);
    return created;
  }

  function addModel() {
    const name = `model-${Date.now()}`;
    onChange({ ...models, [name]: {} });
  }

  function removeModel(key: string) {
    const next = { ...models };
    delete next[key];
    onChange(next);
  }

  function renameModel(oldKey: string, newKey: string) {
    if (newKey === oldKey) return;
    const rowId = rowIdsRef.current.get(oldKey);
    if (rowId) {
      rowIdsRef.current.delete(oldKey);
      rowIdsRef.current.set(newKey, rowId);
    }
    // Transfer pricing expand state
    if (expandedPricing.has(oldKey)) {
      setExpandedPricing((prev) => {
        const next = new Set(prev);
        next.delete(oldKey);
        next.add(newKey);
        return next;
      });
    }
    const ordered: Record<string, ModelCapabilities> = {};
    for (const [k, v] of Object.entries(models)) {
      ordered[k === oldKey ? newKey : k] = v;
    }
    onChange(ordered);
  }

  function updateCapability(key: string, field: keyof ModelCapabilities, value: boolean) {
    onChange({
      ...models,
      [key]: { ...models[key], [field]: value },
    });
  }

  function updatePricing(
    key: string,
    field: 'input' | 'output' | 'cacheRead' | 'cacheCreation',
    value: string
  ) {
    const parsed = parsePriceInput(value);
    const currentPricing = models[key]?.pricing ?? {};
    const newPricing = { ...currentPricing, [field]: parsed };

    // Clean up undefined values
    const cleaned: Record<string, number> = {};
    for (const [k, v] of Object.entries(newPricing)) {
      if (v !== undefined) cleaned[k] = v;
    }

    onChange({
      ...models,
      [key]: {
        ...models[key],
        pricing: Object.keys(cleaned).length > 0 ? cleaned : undefined,
      },
    });
  }

  function togglePricing(key: string) {
    setExpandedPricing((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function hasPricing(caps: ModelCapabilities): boolean {
    const p = caps.pricing;
    if (!p) return false;
    return (
      p.input !== undefined ||
      p.output !== undefined ||
      p.cacheRead !== undefined ||
      p.cacheCreation !== undefined
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">模型列表</Label>
        <Button type="button" variant="outline" size="sm" onClick={addModel}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          添加模型
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">暂无模型，点击上方按钮添加</p>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型ID</TableHead>
                <TableHead className="w-24 text-center">图像输入</TableHead>
                <TableHead className="w-24 text-center">推理输出</TableHead>
                <TableHead className="w-20 text-center">定价</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(([key, caps]) => {
                const isPricingExpanded = expandedPricing.has(key);
                const pricing = caps.pricing;
                return (
                  <Fragment key={getRowId(key)}>
                    <TableRow>
                      <TableCell>
                        <Input
                          value={key}
                          onChange={(e) => renameModel(key, e.target.value)}
                          className="h-8 text-sm"
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={caps['image-input'] ?? false}
                          onCheckedChange={(v) => updateCapability(key, 'image-input', v)}
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={caps.reasoning ?? false}
                          onCheckedChange={(v) => updateCapability(key, 'reasoning', v)}
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => togglePricing(key)}
                        >
                          {isPricingExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                          {hasPricing(caps) ? (
                            <span className="ml-0.5 text-muted-foreground">
                              ${pricing?.input ?? '-'}/${pricing?.output ?? '-'}
                            </span>
                          ) : null}
                        </Button>
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => removeModel(key)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                    {isPricingExpanded && (
                      <TableRow className="bg-muted/30">
                        <TableCell colSpan={5} className="py-2 px-3">
                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-2 gap-y-1.5 min-w-0">
                            {(
                              [
                                ['input', '输入'],
                                ['output', '输出'],
                                ['cacheRead', '缓存读取'],
                                ['cacheCreation', '缓存创建'],
                              ] as const
                            ).map(([field, label]) => (
                              <InputGroup key={field} className="h-7">
                                <InputGroupAddon className="py-0 text-xs whitespace-nowrap">
                                  <InputGroupText className="text-xs">{label}</InputGroupText>
                                </InputGroupAddon>
                                <InputGroupInput
                                  type="number"
                                  min="0"
                                  step="any"
                                  className="h-7 text-xs px-2"
                                  placeholder="0"
                                  value={pricing?.[field] ?? ''}
                                  onChange={(e) => updatePricing(key, field, e.target.value)}
                                />
                                <InputGroupAddon
                                  align="inline-end"
                                  className="py-0 text-xs whitespace-nowrap"
                                >
                                  <InputGroupText className="text-[10px]">$/1M</InputGroupText>
                                </InputGroupAddon>
                              </InputGroup>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
