import { AlertCircle, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useUsageStore } from '@/stores/usage-store';
import { DashboardPanel } from './panel';

export function BalancePanel() {
  const balances = useUsageStore((s) => s.balances);
  const loading = useUsageStore((s) => s.balancesLoading);
  const error = useUsageStore((s) => s.balancesError);
  const fetchBalances = useUsageStore((s) => s.fetchBalances);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  if (balances.length === 0 && !error && !loading) {
    return null;
  }

  return (
    <DashboardPanel
      title="Provider 余额"
      action={
        <Button size="xs" variant="ghost" onClick={() => fetchBalances()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      }
    >
      {loading && balances.length === 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : (
        <>
          {error && (
            <div className="text-sm text-destructive flex items-center gap-1 mb-2">
              <AlertCircle className="h-3.5 w-3.5" />
              {error}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {balances.map((b) => (
              <div key={b.provider} className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground font-mono truncate">{b.provider}</div>
                {b.error ? (
                  <div className="text-sm text-destructive mt-0.5 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    <span className="truncate">{b.error}</span>
                  </div>
                ) : (
                  <div className="text-xl font-semibold mt-0.5">
                    {b.remaining.toLocaleString()}{' '}
                    <span className="text-sm font-normal text-muted-foreground">{b.unit}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </DashboardPanel>
  );
}
