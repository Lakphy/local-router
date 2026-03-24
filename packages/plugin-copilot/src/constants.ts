export const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const GITHUB_APP_SCOPES = 'read:user';
export const GITHUB_BASE_URL = 'https://github.com';
export const GITHUB_API_BASE_URL = 'https://api.github.com';

export const COPILOT_BASE_URL = 'https://api.githubcopilot.com';
export const COPILOT_TOKEN_URL = `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`;

const COPILOT_CHAT_VERSION = '0.38.2';
const VSCODE_VERSION = '1.110.1';

/** Copilot-specific headers injected into every upstream request. */
export const COPILOT_HEADERS: Record<string, string> = {
  'copilot-integration-id': 'vscode-chat',
  'editor-version': `vscode/${VSCODE_VERSION}`,
  'editor-plugin-version': `copilot-chat/${COPILOT_CHAT_VERSION}`,
  'user-agent': `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`,
  'openai-intent': 'conversation-agent',
  'x-github-api-version': '2025-10-01',
};

/** GitHub API request headers for token exchange. */
export const GITHUB_TOKEN_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json',
  'editor-version': `vscode/${VSCODE_VERSION}`,
  'editor-plugin-version': `copilot-chat/${COPILOT_CHAT_VERSION}`,
  'user-agent': `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`,
  'x-github-api-version': '2025-10-01',
};

/** Refresh the Copilot token this many seconds before it expires. */
export const TOKEN_REFRESH_BUFFER_SECONDS = 60;

/** Initial retry delay (ms) when token refresh fails. */
export const INITIAL_RETRY_DELAY_MS = 1_000;

/** Maximum retry delay (ms) when token refresh fails. */
export const MAX_RETRY_DELAY_MS = 30_000;

/** Default path for persisting the GitHub OAuth token. */
export const DEFAULT_GITHUB_TOKEN_DIR = '~/.local-router/copilot';
export const DEFAULT_GITHUB_TOKEN_FILENAME = 'github_token';
