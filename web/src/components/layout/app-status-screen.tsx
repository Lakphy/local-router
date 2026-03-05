import { Loader2 } from 'lucide-react';

interface AppStatusScreenProps {
  title: string;
  description?: string;
  loading?: boolean;
}

export function AppStatusScreen({ title, description, loading = false }: AppStatusScreenProps) {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center space-y-2">
        {loading && (
          <div className="flex justify-center pb-1">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}
        <p className={loading ? 'text-sm text-muted-foreground' : 'text-destructive font-medium'}>
          {title}
        </p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}
