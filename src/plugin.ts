/**
 * 插件体系核心类型定义。
 *
 * 洋葱模型：请求阶段正序执行（外→内），响应阶段逆序执行（内→外）。
 */

/** 插件上下文（只读，传递给每个 handler） */
export interface PluginContext {
  requestId: string;
  provider: string;
  modelIn: string;
  modelOut: string;
  routeType: string;
  isStream: boolean;
}

/** 插件模块导出的工厂接口 */
export interface PluginDefinition {
  name: string;
  version?: string;
  create(params: Record<string, unknown>): Plugin | Promise<Plugin>;
}

/** 日志中记录的插件阶段信息 */
export interface PluginPhaseLog {
  name: string;
  package: string;
  params: Record<string, unknown>;
}

/** 插件实例接口（三个核心处理器 + 错误处理 + 销毁） */
export interface Plugin {
  onRequest?(args: {
    ctx: PluginContext;
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }): Promise<{ url?: string; headers?: Headers; body?: Record<string, unknown> } | void>;

  onResponse?(args: {
    ctx: PluginContext;
    status: number;
    headers: Record<string, string>;
    body: string;
  }): Promise<{ status?: number; headers?: Record<string, string>; body?: string } | void>;

  onSSEResponse?(args: {
    ctx: PluginContext;
    status: number;
    headers: Record<string, string>;
  }): Promise<{
    status?: number;
    headers?: Record<string, string>;
    transform?: TransformStream<Uint8Array, Uint8Array>;
  } | void>;

  onError?(args: {
    ctx: PluginContext;
    phase: 'request' | 'response';
    error: Error;
  }): Promise<void>;

  dispose?(): void | Promise<void>;
}
