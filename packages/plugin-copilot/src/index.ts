import type { Plugin, PluginDefinition } from '@lakphy/local-router/plugin';
import { COPILOT_HEADERS } from './constants';
import { acquireTokenManager, releaseTokenManager } from './copilot-token';
import { resolveGithubToken } from './github-auth';

interface CopilotPluginParams {
  /** GitHub OAuth token (e.g. gho_xxx). */
  githubToken?: string;
  /** Path to a file containing the GitHub token. Default: ~/.local-router/copilot/github_token */
  githubTokenFile?: string;
}

const definition: PluginDefinition = {
  name: 'copilot',
  version: '0.1.0',

  async create(params: Record<string, unknown>): Promise<Plugin> {
    const { githubToken, githubTokenFile } = params as CopilotPluginParams;

    const resolvedToken = await resolveGithubToken({ githubToken, githubTokenFile });
    const tokenManager = await acquireTokenManager(resolvedToken);

    console.log('[plugin:copilot] Copilot token acquired successfully');

    let requestCount = 0;

    return {
      async onRequest({ url, headers }) {
        requestCount++;

        // Copilot uses Bearer auth uniformly — remove x-api-key if present (Anthropic route sets it)
        headers.delete('x-api-key');
        headers.set('Authorization', `Bearer ${tokenManager.getToken()}`);

        // Inject Copilot-specific headers
        for (const [key, value] of Object.entries(COPILOT_HEADERS)) {
          headers.set(key, value);
        }

        // Copilot chat completions has no /v1 prefix; /v1/messages is correct as-is
        const u = new URL(url);
        if (u.pathname === '/v1/chat/completions') {
          u.pathname = '/chat/completions';
        }

        return { url: u.toString(), headers };
      },

      async onError({ ctx, phase, error }) {
        console.error(
          `[plugin:copilot] onError phase=${phase} provider=${ctx.provider}: ${error.message}`
        );
      },

      dispose() {
        releaseTokenManager(resolvedToken);
        console.log(`[plugin:copilot] disposed after handling ${requestCount} requests`);
      },
    };
  },
};

export default definition;
