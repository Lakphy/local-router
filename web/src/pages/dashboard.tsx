import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { BalancePanel } from '@/components/dashboard/balance-panel';
import { ClientConfigPanel } from '@/components/dashboard/client-config-panel';
import {
  ConfigMetaPanel,
  RouteDistributionPanel,
} from '@/components/dashboard/distribution-and-meta-panels';
import { MetricsPanel } from '@/components/dashboard/metrics-panel';
import { OverviewStrip } from '@/components/dashboard/overview-strip';
import { ProviderUsageTablePanel, RouteTypeTablePanel } from '@/components/dashboard/usage-tables';
import { useConfigStore } from '@/stores/config-store';
import { useDashboardStore } from '@/stores/dashboard-store';
import type { LogMetricsWindow } from '@/types/config';

const ENDPOINT_LINES = [
  'http://localhost:4099/anthropic-messages',
  'http://localhost:4099/openai-responses',
  'http://localhost:4099/openai-completions',
];

const CLAUDE_ENV_TEXT = `ANTHROPIC_AUTH_TOKEN="DEFAULT_API_KEY"
ANTHROPIC_BASE_URL="http://localhost:4099/anthropic-messages"
ANTHROPIC_DEFAULT_HAIKU_MODEL=""
ANTHROPIC_DEFAULT_OPUS_MODEL=""
ANTHROPIC_DEFAULT_SONNET_MODEL=""
ANTHROPIC_MODEL=""`;

const CODEX_ENV_TEXT = `OPENAI_API_KEY="DEFAULT_API_KEY"
OPENAI_BASE_URL="http://localhost:4099/openai-responses"
# 模型建议用: codex --model <model>
# 或在 ~/.codex/config.toml 里配置 model 字段`;

const OPENCODE_CONFIG_TEXT = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local-router-responses": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local Router Responses",
      "options": {
        "baseURL": "http://localhost:4099/openai-responses",
        "apiKey": "{env:OPENAI_API_KEY}"
      },
      "models": {
        "your-model": {
          "name": "Your Model"
        }
      }
    },
    "local-router-completions": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local Router Completions",
      "options": {
        "baseURL": "http://localhost:4099/openai-completions",
        "apiKey": "{env:OPENAI_API_KEY}"
      },
      "models": {
        "your-model": {
          "name": "Your Model"
        }
      }
    },
    "anthropic": {
      "options": {
        "baseURL": "http://localhost:4099/anthropic-messages",
        "apiKey": "{env:ANTHROPIC_AUTH_TOKEN}"
      }
    }
  }
}`;

export function DashboardPage() {
  const config = useConfigStore((s) => s.config);
  const healthy = useDashboardStore((s) => s.healthy);
  const meta = useDashboardStore((s) => s.meta);
  const metrics = useDashboardStore((s) => s.metrics);
  const metricsLoading = useDashboardStore((s) => s.metricsLoading);
  const metricsError = useDashboardStore((s) => s.metricsError);
  const metricsWindow = useDashboardStore((s) => s.metricsWindow);
  const logStorage = useDashboardStore((s) => s.logStorage);
  const logStorageLoading = useDashboardStore((s) => s.logStorageLoading);
  const fetchHealth = useDashboardStore((s) => s.fetchHealth);
  const fetchMeta = useDashboardStore((s) => s.fetchMeta);
  const fetchMetrics = useDashboardStore((s) => s.fetchMetrics);
  const fetchLogStorage = useDashboardStore((s) => s.fetchLogStorage);
  const setMetricsWindow = useDashboardStore((s) => s.setMetricsWindow);

  useEffect(() => {
    fetchHealth();
    fetchMeta();
    fetchMetrics();
    fetchLogStorage();
  }, [fetchHealth, fetchMeta, fetchMetrics, fetchLogStorage]);

  const {
    providerCount,
    routeTypeCount,
    totalRules,
    avgRulesPerType,
    providersReferenced,
    providerUsageRows,
    routeTypeDistribution,
    logConfigured,
    logEnabled,
    bodyPolicy,
    streamsEnabled,
  } = useMemo(() => {
    const providers = config?.providers ?? {};
    const routes = config?.routes ?? {};

    const providerCountValue = Object.keys(providers).length;
    const routeEntries = Object.entries(routes);
    const routeTypeCountValue = routeEntries.length;

    const providerUsageMap = new Map<string, number>(
      Object.keys(providers).map((providerKey) => [providerKey, 0])
    );

    const distribution = routeEntries
      .map(([type, mapping]) => {
        const count = Object.keys(mapping ?? {}).length;
        Object.values(mapping ?? {}).forEach((target) => {
          if (!target?.provider) return;
          providerUsageMap.set(target.provider, (providerUsageMap.get(target.provider) ?? 0) + 1);
        });
        return { type, count };
      })
      .sort((a, b) => b.count - a.count);

    const totalRulesValue = distribution.reduce((sum, item) => sum + item.count, 0);
    const avgRulesPerTypeValue = routeTypeCountValue ? totalRulesValue / routeTypeCountValue : 0;

    const providerUsageRowsValue = Array.from(providerUsageMap.entries())
      .map(([provider, count]) => ({ provider, count, used: count > 0 }))
      .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));

    const providersReferencedValue = providerUsageRowsValue.filter((item) => item.used).length;

    const distributionWithRatio = distribution.map((item) => ({
      ...item,
      ratio: totalRulesValue ? item.count / totalRulesValue : 0,
    }));

    return {
      providerCount: providerCountValue,
      routeTypeCount: routeTypeCountValue,
      totalRules: totalRulesValue,
      avgRulesPerType: avgRulesPerTypeValue,
      providersReferenced: providersReferencedValue,
      providerUsageRows: providerUsageRowsValue,
      routeTypeDistribution: distributionWithRatio,
      logConfigured: !!config?.log,
      logEnabled: !!config?.log && config.log.enabled !== false,
      bodyPolicy: config?.log?.bodyPolicy ?? 'off',
      streamsEnabled: config?.log ? config.log.streams?.enabled !== false : false,
    };
  }, [config]);

  const configuredRouteTypeKeys = Object.keys(config?.routes ?? {});
  const metaRouteTypes = meta?.routeTypes ?? [];
  const metaRouteTypeSet = new Set(metaRouteTypes);
  const configuredInMetaCount = configuredRouteTypeKeys.filter((type) =>
    metaRouteTypeSet.has(type)
  ).length;

  const isMetaLoading = meta === null;
  const isHealthLoading = healthy === null;

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
        <p className="text-muted-foreground">Local Router 服务状态与配置概览</p>
      </div>

      <OverviewStrip
        isHealthLoading={isHealthLoading}
        healthy={healthy}
        isMetaLoading={isMetaLoading}
        providerCount={providerCount}
        providersReferenced={providersReferenced}
        totalRules={totalRules}
        routeTypeCount={routeTypeCount}
        avgRulesPerType={avgRulesPerType}
        logConfigured={logConfigured}
        logEnabled={logEnabled}
        bodyPolicy={bodyPolicy}
        streamsEnabled={streamsEnabled}
        logStorageLoading={logStorageLoading}
        logStorageTotalBytes={logStorage?.totalBytes}
        logStorageFileCount={logStorage?.fileCount}
      />

      <BalancePanel />

      <ClientConfigPanel
        endpointLines={ENDPOINT_LINES}
        claudeEnvText={CLAUDE_ENV_TEXT}
        codexEnvText={CODEX_ENV_TEXT}
        opencodeConfigText={OPENCODE_CONFIG_TEXT}
        onCopyText={copyText}
      />

      <MetricsPanel
        metricsLoading={metricsLoading}
        metricsError={metricsError}
        metrics={metrics}
        metricsWindow={metricsWindow}
        onWindowChange={handleWindowChange}
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RouteDistributionPanel
            hasConfig={!!config}
            routeTypeDistribution={routeTypeDistribution}
          />
        </div>
        <ConfigMetaPanel
          isMetaLoading={isMetaLoading}
          meta={meta}
          metaRouteTypes={metaRouteTypes}
          configuredInMetaCount={configuredInMetaCount}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ProviderUsageTablePanel hasConfig={!!config} providerUsageRows={providerUsageRows} />
        <RouteTypeTablePanel
          hasConfig={!!config}
          routeTypeDistribution={routeTypeDistribution}
          totalRules={totalRules}
        />
      </div>
    </div>
  );
}
