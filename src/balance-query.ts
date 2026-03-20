import type { BalanceConfig } from './config';

export interface BalanceResult {
  provider: string;
  remaining: number;
  unit: string;
  error?: string | null;
}

export async function queryProviderBalance(
  providerName: string,
  balanceConfig: BalanceConfig,
  proxy?: string
): Promise<BalanceResult> {
  const { request, extractor } = balanceConfig;
  const method = request.method ?? 'GET';

  try {
    const fetchOptions: RequestInit & { proxy?: string } = {
      method,
      headers: request.headers ?? {},
    };

    if (request.body && method !== 'GET') {
      fetchOptions.headers = {
        'Content-Type': 'application/json',
        ...fetchOptions.headers,
      };
      fetchOptions.body = JSON.stringify(request.body);
    }

    if (proxy?.trim()) {
      fetchOptions.proxy = proxy;
    }

    const res = await fetch(request.url, fetchOptions);

    if (!res.ok) {
      return {
        provider: providerName,
        remaining: 0,
        unit: '',
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const response = await res.json();

    // eslint-disable-next-line no-new-func
    const extractFn = new Function('response', `return ${extractor}`) as (response: unknown) => {
      remaining: number;
      unit: string;
    };

    const result = extractFn(response);

    if (typeof result?.remaining !== 'number' || typeof result?.unit !== 'string') {
      return {
        provider: providerName,
        remaining: 0,
        unit: '',
        error: 'extractor 返回值格式无效，需要 { remaining: number, unit: string }',
      };
    }

    return {
      provider: providerName,
      remaining: result.remaining,
      unit: result.unit,
      error: null,
    };
  } catch (err) {
    return {
      provider: providerName,
      remaining: 0,
      unit: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface BalanceResponse {
  balances: BalanceResult[];
}

export async function queryAllBalances(
  providers: Record<string, { balance?: BalanceConfig; proxy?: string }>
): Promise<BalanceResponse> {
  const entries = Object.entries(providers).filter(
    (entry): entry is [string, { balance: BalanceConfig; proxy?: string }] => !!entry[1].balance
  );

  if (entries.length === 0) {
    return { balances: [] };
  }

  const results = await Promise.all(
    entries.map(([name, cfg]) => queryProviderBalance(name, cfg.balance, cfg.proxy))
  );

  return { balances: results };
}
