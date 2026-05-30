import { RoutesEditor } from '@/components/routes-editor';

export function RoutesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">路由</h2>
        <p className="text-muted-foreground">管理协议入口与模型路由映射</p>
      </div>
      <RoutesEditor />
    </div>
  );
}
