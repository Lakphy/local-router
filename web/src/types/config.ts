export type ProviderType = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export interface RouteTarget {
  provider: string;
  model: string;
}

export interface ModelCapabilities {
  'image-input'?: boolean;
  reasoning?: boolean;
}

export interface PluginConfig {
  package: string;
  params?: Record<string, unknown>;
}

export interface ProviderConfig {
  type: ProviderType;
  base: string;
  apiKey: string;
  proxy?: string;
  models: Record<string, ModelCapabilities>;
  plugins?: PluginConfig[];
}

export interface LogConfig {
  enabled?: boolean;
  baseDir?: string;
  events?: {
    retainDays?: number;
  };
  streams?: {
    enabled?: boolean;
    retainDays?: number;
    maxBytesPerRequest?: number;
  };
  bodyPolicy?: 'off' | 'masked' | 'full';
}

export interface AppConfig {
  routes: Record<string, Record<string, RouteTarget>>;
  providers: Record<string, ProviderConfig>;
  log?: LogConfig;
}

export interface ConfigMeta {
  configPath: string;
  routeTypes: string[];
}

export type LogMetricsWindow = '1h' | '6h' | '24h';

export interface LogMetricsSeriesPoint {
  ts: string;
  requests: number;
  errors: number;
  avgLatencyMs: number;
}

export interface LogMetricsResponse {
  window: LogMetricsWindow;
  from: string;
  to: string;
  generatedAt: string;
  source: {
    logEnabled: boolean;
    baseDir: string | null;
    filesScanned: number;
    linesScanned: number;
    partial: boolean;
  };
  summary: {
    totalRequests: number;
    successRequests: number;
    errorRequests: number;
    successRate: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    totalRequestBytes: number;
    totalResponseBytes: number;
  };
  series: LogMetricsSeriesPoint[];
  topProviders: Array<{ key: string; requests: number; errorRate: number; avgLatencyMs: number }>;
  topRouteTypes: Array<{ key: string; requests: number; errorRate: number }>;
  statusClasses: {
    '2xx': number;
    '4xx': number;
    '5xx': number;
    network_error: number;
  };
  warnings: string[];
}
