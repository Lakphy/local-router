import { Plus, Trash2 } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

export function ModelEditor({ models, onChange }: ModelEditorProps) {
  const entries = Object.entries(models);
  const rowIdsRef = useRef(new Map<string, string>());
  const rowCounterRef = useRef(0);

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
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型ID</TableHead>
                <TableHead className="w-24 text-center">图像输入</TableHead>
                <TableHead className="w-24 text-center">推理输出</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(([key, caps]) => (
                <TableRow key={getRowId(key)}>
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
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
