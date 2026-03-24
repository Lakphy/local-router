import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_GITHUB_TOKEN_DIR,
  DEFAULT_GITHUB_TOKEN_FILENAME,
  GITHUB_API_BASE_URL,
  GITHUB_APP_SCOPES,
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
} from './constants';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
}

interface GitHubUserResponse {
  login: string;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function defaultTokenPath(): string {
  return join(expandHome(DEFAULT_GITHUB_TOKEN_DIR), DEFAULT_GITHUB_TOKEN_FILENAME);
}

export async function readGithubToken(filePath?: string): Promise<string | null> {
  const p = filePath ? expandHome(filePath) : defaultTokenPath();
  try {
    const content = await readFile(p, 'utf-8');
    const token = content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return token ?? null;
  } catch {
    return null;
  }
}

export async function writeGithubToken(token: string, filePath?: string): Promise<void> {
  const p = filePath ? expandHome(filePath) : defaultTokenPath();
  const dir = dirname(p);
  await mkdir(dir, { recursive: true });
  await writeFile(p, token, 'utf-8');
  try {
    await chmod(p, 0o600);
  } catch {
    // chmod may fail on some platforms, non-critical
  }
}

async function getDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_APP_SCOPES }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get device code: ${response.status} ${text}`);
  }

  return (await response.json()) as DeviceCodeResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollAccessToken(deviceCode: DeviceCodeResponse): Promise<string> {
  const sleepDuration = (deviceCode.interval + 1) * 1000;
  const deadline = Date.now() + deviceCode.expires_in * 1000;

  while (Date.now() < deadline) {
    const response = await fetch(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    if (!response.ok) {
      console.error('[plugin:copilot] Failed to poll access token:', await response.text());
      await sleep(sleepDuration);
      continue;
    }

    const json = (await response.json()) as AccessTokenResponse;
    if (json.access_token) {
      return json.access_token;
    }

    await sleep(sleepDuration);
  }

  throw new Error('[plugin:copilot] Device code expired, please try again');
}

export async function getGitHubUser(token: string): Promise<string> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: {
      authorization: `token ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get GitHub user: ${response.status}`);
  }

  const user = (await response.json()) as GitHubUserResponse;
  return user.login;
}

/**
 * Resolve a GitHub token from params, file, or interactive OAuth device flow.
 *
 * Priority:
 * 1. `githubToken` param (direct value)
 * 2. `githubTokenFile` param (read from specified file)
 * 3. Default token file (~/.local-router/copilot/github_token)
 * 4. Interactive OAuth device flow (prompts user in terminal)
 */
export async function resolveGithubToken(params: {
  githubToken?: string;
  githubTokenFile?: string;
}): Promise<string> {
  // 1. Direct token
  if (params.githubToken) {
    console.log('[plugin:copilot] Using GitHub token from params');
    return params.githubToken;
  }

  // 2. From specified file
  if (params.githubTokenFile) {
    const token = await readGithubToken(params.githubTokenFile);
    if (token) {
      console.log(`[plugin:copilot] Using GitHub token from ${params.githubTokenFile}`);
      return token;
    }
    throw new Error(
      `[plugin:copilot] GitHub token file "${params.githubTokenFile}" is empty or not found`
    );
  }

  // 3. From default file
  const existingToken = await readGithubToken();
  if (existingToken) {
    console.log('[plugin:copilot] Using GitHub token from default path');
    return existingToken;
  }

  // 4. Interactive OAuth device flow
  console.log('[plugin:copilot] No GitHub token found, starting OAuth device flow...');
  const deviceCode = await getDeviceCode();

  console.log('');
  console.log('='.repeat(60));
  console.log(`  Please visit: ${deviceCode.verification_uri}`);
  console.log(`  Enter code:   ${deviceCode.user_code}`);
  console.log('='.repeat(60));
  console.log('');
  console.log('[plugin:copilot] Waiting for authorization...');

  const token = await pollAccessToken(deviceCode);
  await writeGithubToken(token);

  const login = await getGitHubUser(token);
  console.log(`[plugin:copilot] Logged in as ${login}`);

  return token;
}
