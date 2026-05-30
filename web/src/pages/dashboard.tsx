import { useEffect } from 'react';
import { toast } from 'sonner';
import { ClientConfigPanel } from '@/components/dashboard/client-config-panel';
import { MetricsPanel } from '@/components/dashboard/metrics-panel';
import { OverviewStrip } from '@/components/dashboard/overview-strip';
import { RouteConfigPanel } from '@/components/dashboard/route-config-panel';
import { useConfigStore } from '@/stores/config-store';
import { useDashboardStore } from '@/stores/dashboard-store';
import type { LogMetricsWindow } from '@/types/config';

const DEFAULT_PORT = 4099;

function resolvePort(configPort?: number): number {
  if (typeof configPort === 'number' && configPort > 0) return configPort;
  if (typeof window !== 'undefined' && window.location.port) {
    const fromLocation = Number(window.location.port);
    if (Number.isFinite(fromLocation) && fromLocation > 0) return fromLocation;
  }
  return DEFAULT_PORT;
}

export function DashboardPage() {
  const config = useConfigStore((s) => s.config);
  const metrics = useDashboardStore((s) => s.metrics);
  const metricsLoading = useDashboardStore((s) => s.metricsLoading);
  const metricsError = useDashboardStore((s) => s.metricsError);
  const metricsWindow = useDashboardStore((s) => s.metricsWindow);
  const logStorage = useDashboardStore((s) => s.logStorage);
  const logStorageLoading = useDashboardStore((s) => s.logStorageLoading);
  const fetchMetrics = useDashboardStore((s) => s.fetchMetrics);
  const fetchLogStorage = useDashboardStore((s) => s.fetchLogStorage);
  const setMetricsWindow = useDashboardStore((s) => s.setMetricsWindow);

  useEffect(() => {
    fetchMetrics();
    fetchLogStorage();
  }, [fetchMetrics, fetchLogStorage]);

  const port = resolvePort(config?.server?.port);
  const lanEnabled = config?.server?.lanAccess?.enabled === true;

  function handleWindowChange(window: LogMetricsWindow): void {
    setMetricsWindow(window);
    fetchMetrics(window, true);
  }

  async function copyText(content: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      toast.success(`已复制${label}`);
    } catch {
      toast.error(`复制${label}失败`);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">仪表盘</h2>
        <p className="text-muted-foreground">Local Router 运行指标与路由配置</p>
      </div>

      <OverviewStrip
        metrics={metrics}
        metricsLoading={metricsLoading}
        metricsWindow={metricsWindow}
        onWindowChange={handleWindowChange}
        logStorageLoading={logStorageLoading}
        logStorageTotalBytes={logStorage?.totalBytes}
        logStorageFileCount={logStorage?.fileCount}
      />

      <RouteConfigPanel />

      <MetricsPanel
        metricsLoading={metricsLoading}
        metricsError={metricsError}
        metrics={metrics}
        metricsWindow={metricsWindow}
      />

      <ClientConfigPanel port={port} lanEnabled={lanEnabled} onCopyText={copyText} />
    </div>
  );
}
