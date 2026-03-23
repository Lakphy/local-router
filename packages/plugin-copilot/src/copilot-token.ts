import {
  COPILOT_BASE_URL,
  COPILOT_HEADERS,
  COPILOT_TOKEN_URL,
  GITHUB_TOKEN_HEADERS,
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  TOKEN_REFRESH_BUFFER_SECONDS,
} from './constants';

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  refresh_in: number;
}

interface CopilotModel {
  id: string;
  name: string;
  vendor: string;
  version: string;
  preview: boolean;
  supported_endpoints?: string[];
  capabilities?: {
    family?: string;
    type?: string;
    limits?: { max_context_window_tokens?: number; max_output_tokens?: number };
  };
}

interface CopilotModelsResponse {
  data: CopilotModel[];
}

/**
 * Shared singleton cache: multiple providers using the same GitHub token
 * share one CopilotTokenManager to avoid duplicate refresh loops and model fetches.
 * Reference-counted so the manager is disposed only when all consumers release it.
 */
const sharedManagers = new Map<string, { manager: CopilotTokenManager; refCount: number }>();

export async function acquireTokenManager(githubToken: string): Promise<CopilotTokenManager> {
  const existing = sharedManagers.get(githubToken);
  if (existing) {
    existing.refCount++;
    return existing.manager;
  }

  const manager = new CopilotTokenManager(githubToken);
  await manager.initialize();
  sharedManagers.set(githubToken, { manager, refCount: 1 });
  return manager;
}

export function releaseTokenManager(githubToken: string): void {
  const existing = sharedManagers.get(githubToken);
  if (!existing) return;

  existing.refCount--;
  if (existing.refCount <= 0) {
    existing.manager.dispose();
    sharedManagers.delete(githubToken);
  }
}

export class CopilotTokenManager {
  private githubToken: string;
  private copilotToken = '';
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = INITIAL_RETRY_DELAY_MS;

  constructor(githubToken: string) {
    this.githubToken = githubToken;
  }

  async initialize(): Promise<void> {
    const { token, refresh_in } = await this.fetchCopilotToken();
    this.copilotToken = token;
    this.retryDelay = INITIAL_RETRY_DELAY_MS;
    this.scheduleRefresh(refresh_in);

    // Fetch and display available models
    try {
      await this.printAvailableModels();
    } catch (err) {
      console.warn('[plugin:copilot] Failed to fetch models:', err);
    }
  }

  getToken(): string {
    return this.copilotToken;
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async fetchCopilotToken(): Promise<CopilotTokenResponse> {
    const response = await fetch(COPILOT_TOKEN_URL, {
      headers: {
        ...GITHUB_TOKEN_HEADERS,
        authorization: `token ${this.githubToken}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get Copilot token: ${response.status} ${text}`);
    }

    return (await response.json()) as CopilotTokenResponse;
  }

  private scheduleRefresh(refreshIn: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    const delayMs = Math.max(0, (refreshIn - TOKEN_REFRESH_BUFFER_SECONDS) * 1000);

    this.refreshTimer = setTimeout(() => {
      this.refreshToken();
    }, delayMs);
  }

  private async fetchModels(): Promise<CopilotModel[]> {
    const response = await fetch(`${COPILOT_BASE_URL}/models`, {
      headers: {
        ...COPILOT_HEADERS,
        Authorization: `Bearer ${this.copilotToken}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch models: ${response.status} ${text}`);
    }

    const data = (await response.json()) as CopilotModelsResponse;
    return data.data ?? [];
  }

  private async printAvailableModels(): Promise<void> {
    const models = await this.fetchModels();
    if (models.length === 0) {
      console.log('[plugin:copilot] No models available');
      return;
    }

    // Group by supported endpoints
    const groups = new Map<string, string[]>();

    for (const m of models) {
      const endpoints = m.supported_endpoints ?? [];
      const label = m.preview ? `${m.id} (preview)` : m.id;
      for (const ep of endpoints) {
        const list = groups.get(ep);
        if (list) {
          list.push(label);
        } else {
          groups.set(ep, [label]);
        }
      }
      if (endpoints.length === 0) {
        const list = groups.get('(none)');
        if (list) {
          list.push(label);
        } else {
          groups.set('(none)', [label]);
        }
      }
    }

    const endpointLabels: Record<string, string> = {
      '/chat/completions': 'openai-completions',
      '/v1/messages': 'anthropic-messages',
      '/responses': 'openai-responses',
      '/embeddings': 'embeddings',
    };

    console.log('');
    console.log(`[plugin:copilot] Available models (${models.length} total):`);
    for (const [endpoint, modelList] of groups) {
      const routeType = endpointLabels[endpoint] ?? endpoint;
      console.log(`  ${endpoint} (${routeType}): ${modelList.join(', ')}`);
    }
    console.log('');
  }

  private async refreshToken(): Promise<void> {
    try {
      const { token, refresh_in } = await this.fetchCopilotToken();
      this.copilotToken = token;
      this.retryDelay = INITIAL_RETRY_DELAY_MS;
      console.log('[plugin:copilot] Copilot token refreshed');
      this.scheduleRefresh(refresh_in);
    } catch (err) {
      console.error('[plugin:copilot] Failed to refresh Copilot token:', err);
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS);
      console.warn(`[plugin:copilot] Retrying in ${this.retryDelay}ms`);
      this.refreshTimer = setTimeout(() => {
        this.refreshToken();
      }, this.retryDelay);
    }
  }
}
