import Editor from '@monaco-editor/react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import { useConfigStore } from '@/stores/config-store';
import { useDialogStore } from '@/stores/dialog-store';
import type { AppConfig } from '@/types/config';

const MODEL_URI = 'inmemory://model/local-router-config.json';
const SCHEMA_URI = 'local-router://schema/config.schema.json';

export function ConfigRawDialog() {
  const config = useConfigStore((s) => s.config);
  const saving = useConfigStore((s) => s.saving);
  const applying = useConfigStore((s) => s.applying);
  const save = useConfigStore((s) => s.save);
  const saveAndApply = useConfigStore((s) => s.saveAndApply);
  const setDraft = useConfigStore((s) => s.setDraft);
  const reset = useConfigStore((s) => s.reset);

  const rawOpen = useDialogStore((s) => s.rawOpen);
  const setRawOpen = useDialogStore((s) => s.setRawOpen);
  const rawValue = useDialogStore((s) => s.rawValue);
  const setRawValue = useDialogStore((s) => s.setRawValue);
  const rawParseError = useDialogStore((s) => s.rawParseError);
  const setRawParseError = useDialogStore((s) => s.setRawParseError);
  const schema = useDialogStore((s) => s.schema);

  const loading = saving || applying;

  function parseRawValue(): AppConfig | null {
    try {
      const parsed = JSON.parse(rawValue) as AppConfig;
      setRawParseError(null);
      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'JSON 解析失败';
      setRawParseError(message);
      return null;
    }
  }

  async function handleSave() {
    const parsed = parseRawValue();
    if (!parsed) {
      toast.error('JSON 格式错误，无法保存');
      return;
    }
    try {
      await save(parsed);
      setDraft(parsed);
      setRawOpen(false);
      toast.success('配置已保存');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    }
  }

  async function handleSaveAndApply() {
    const parsed = parseRawValue();
    if (!parsed) {
      toast.error('JSON 格式错误，无法保存并应用');
      return;
    }
    try {
      await saveAndApply(parsed);
      setDraft(parsed);
      setRawOpen(false);
      toast.success('配置已保存并应用');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存并应用失败');
    }
  }

  function handleReset() {
    reset();
    const next = config ?? {};
    setRawValue(JSON.stringify(next, null, 2));
    setRawParseError(null);
    toast.info('已重置为上次保存的配置');
  }

  return (
    <Dialog open={rawOpen} onOpenChange={setRawOpen}>
      <DialogContent className="h-[92vh] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)]!">
        <DialogHeader>
          <DialogTitle>Raw 配置编辑</DialogTitle>
          <DialogDescription>
            使用 Monaco 编辑 JSON。支持 schema 提示与校验，保存前请确认语法正确。
          </DialogDescription>
        </DialogHeader>

        {rawParseError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{rawParseError}</span>
          </div>
        )}

        <div className="h-[calc(92vh-210px)] overflow-hidden rounded-lg border">
          <Editor
            height="100%"
            language="json"
            value={rawValue}
            onChange={(next) => setRawValue(next ?? '')}
            path={MODEL_URI}
            beforeMount={(monaco) => {
              monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                validate: false,
                allowComments: true,
                schemaValidation: 'error',
                schemas: schema
                  ? [
                      {
                        uri: SCHEMA_URI,
                        fileMatch: [MODEL_URI],
                        schema,
                      },
                    ]
                  : [],
              });
            }}
            options={{
              minimap: { enabled: false },
              wordWrap: 'on',
              fontSize: 13,
              tabSize: 2,
              formatOnPaste: true,
              formatOnType: true,
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleReset} disabled={loading}>
            重置
          </Button>
          <Button variant="outline" onClick={handleSave} disabled={loading || !!rawParseError}>
            保存
          </Button>
          <Button onClick={handleSaveAndApply} disabled={loading || !!rawParseError}>
            保存并应用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
