import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Download, ExternalLink, Loader2, Server } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { useCCSImportStore } from '@/stores/ccs-import-store';

export function ImportCCSPage() {
  const {
    providers,
    dbExists,
    loading,
    error,
    importing,
    importResult,
    fetchProviders,
    importSelected,
    clearResult,
  } = useCCSImportStore();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  useEffect(() => {
    if (importResult && importResult.imported.length > 0) {
      fetchProviders();
      setSelectedIds(new Set());
    }
  }, [importResult, fetchProviders]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectableProviders = providers.filter((p) => !p.alreadyImported);

  const toggleAll = () => {
    if (selectedIds.size === selectableProviders.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableProviders.map((p) => p.id)));
    }
  };

  const handleImport = async () => {
    if (selectedIds.size === 0) return;
    clearResult();
    await importSelected(Array.from(selectedIds));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        <span>加载中...</span>
      </div>
    );
  }

  if (error && !dbExists) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold">从 CC Switch 导入</h1>
          <p className="text-muted-foreground mt-1">将 CC Switch 中已配置的供应商迁移到 local-router</p>
        </div>
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      </div>
    );
  }

  if (!dbExists) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold">从 CC Switch 导入</h1>
          <p className="text-muted-foreground mt-1">将 CC Switch 中已配置的供应商迁移到 local-router</p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Server className="text-muted-foreground mb-4 h-12 w-12" />
            <p className="text-muted-foreground mb-2 text-center">
              未找到 CC Switch 数据库
            </p>
            <p className="text-muted-foreground text-center text-sm">
              请确认已安装并使用过{' '}
              <a
                href="https://github.com/farion1231/cc-switch"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary inline-flex items-center gap-1 underline"
              >
                CC Switch
                <ExternalLink className="h-3 w-3" />
              </a>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">从 CC Switch 导入</h1>
          <p className="text-muted-foreground mt-1">
            将 CC Switch 中已配置的供应商迁移到 local-router
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectableProviders.length > 0 && (
            <Button variant="outline" size="sm" onClick={toggleAll}>
              {selectedIds.size === selectableProviders.length ? '取消全选' : '全选'}
            </Button>
          )}
          <Button
            size="sm"
            disabled={selectedIds.size === 0 || importing}
            onClick={handleImport}
          >
            {importing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            导入选中 ({selectedIds.size})
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      {importResult && (
        <div className="rounded-md border p-4">
          {importResult.imported.length > 0 && (
            <p className="text-sm">
              <Check className="mr-1 inline h-4 w-4 text-green-500" />
              已导入: {importResult.imported.join(', ')}
            </p>
          )}
          {importResult.skipped.length > 0 && (
            <p className="text-muted-foreground mt-1 text-sm">
              跳过（已存在）: {importResult.skipped.join(', ')}
            </p>
          )}
          <p className="text-muted-foreground mt-2 text-xs">
            前往{' '}
            <Link to="/providers" className="underline">
              供应商配置
            </Link>{' '}
            页面查看导入结果
          </p>
        </div>
      )}

      {providers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground">CC Switch 中没有 Claude 供应商配置</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {providers.map((p) => {
            const disabled = p.alreadyImported;
            const checked = selectedIds.has(p.id);
            return (
              <Card
                key={p.id}
                className={`transition-colors ${disabled ? 'opacity-60' : 'cursor-pointer hover:border-primary/50'} ${checked ? 'border-primary' : ''}`}
                onClick={() => !disabled && toggleSelect(p.id)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      {!disabled && (
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleSelect(p.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      )}
                      <CardTitle className="text-base">{p.name}</CardTitle>
                    </div>
                    <div className="flex gap-1">
                      {p.isCurrent && <Badge variant="default">活跃</Badge>}
                      {p.alreadyImported && <Badge variant="secondary">已导入</Badge>}
                    </div>
                  </div>
                  <CardDescription className="mt-1 truncate text-xs">{p.base || '(未设置 Base URL)'}</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="space-y-1 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">协议:</span>
                      <Badge variant="outline">{p.type}</Badge>
                    </div>
                    {p.models.length > 0 && (
                      <div>
                        <span className="text-muted-foreground">模型: </span>
                        <span className="text-xs">{p.models.join(', ')}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
