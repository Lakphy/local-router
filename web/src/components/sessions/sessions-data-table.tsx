import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { LogSessionSummary, LogUserSummary } from '@/lib/api';
import { calculateVirtualRange } from '@/lib/virtual-list';

const ROW_HEIGHT = 44;
const COLUMN_COUNT = 10;

type FlatRow =
  | { type: 'user'; key: string; user: LogUserSummary; expanded: boolean }
  | { type: 'session'; key: string; user: LogUserSummary; session: LogSessionSummary };

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatModelSummary(models: Array<{ key: string; count: number }>): string {
  if (models.length === 0) return '-';
  return models
    .slice(0, 3)
    .map((item) => `${item.key}(${item.count})`)
    .join(', ');
}

function compactText(value: string, keep = 6): string {
  if (value.length <= keep * 2 + 3) return value;
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

export function SessionsDataTable(props: {
  users: LogUserSummary[];
  onViewLogs: (userKey: string, sessionId?: string) => void;
}) {
  const { users, onViewLogs } = props;
  const [collapsedUsers, setCollapsedUsers] = useState<Record<string, boolean>>({});
  const [scrollTop, setScrollTop] = useState(0);

  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const user of users) {
      const expanded = !collapsedUsers[user.userKey];
      rows.push({ type: 'user', key: user.userKey, user, expanded });
      if (expanded) {
        for (const session of user.sessions) {
          rows.push({
            type: 'session',
            key: `${user.userKey}-${session.sessionId}`,
            user,
            session,
          });
        }
      }
    }
    return rows;
  }, [users, collapsedUsers]);

  const virtualRange = useMemo(
    () => calculateVirtualRange({ dataLength: flatRows.length, scrollTop }),
    [flatRows.length, scrollTop]
  );

  const visibleRows = useMemo(
    () => flatRows.slice(virtualRange.start, virtualRange.end),
    [flatRows, virtualRange.end, virtualRange.start]
  );

  const topSpacerHeight = virtualRange.start * ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, (flatRows.length - virtualRange.end) * ROW_HEIGHT);

  function toggleUser(userKey: string): void {
    setCollapsedUsers((current) => ({ ...current, [userKey]: !current[userKey] }));
  }

  return (
    <div
      className="max-h-[560px] overflow-auto rounded-md border"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead className="w-[46px]" />
            <TableHead>用户</TableHead>
            <TableHead>请求数</TableHead>
            <TableHead>会话数</TableHead>
            <TableHead>首次活跃</TableHead>
            <TableHead>最近活跃</TableHead>
            <TableHead>模型摘要</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>RouteType</TableHead>
            <TableHead className="sticky right-0 z-20 bg-background text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {topSpacerHeight > 0 ? (
            <TableRow aria-hidden="true">
              <TableCell
                colSpan={COLUMN_COUNT}
                className="p-0"
                style={{ height: topSpacerHeight }}
              />
            </TableRow>
          ) : null}

          {visibleRows.map((row) =>
            row.type === 'user' ? (
              <TableRow key={row.key} style={{ height: ROW_HEIGHT }}>
                <TableCell>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => toggleUser(row.user.userKey)}
                  >
                    {row.expanded ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TableCell>
                <TableCell className="font-mono text-xs" title={row.user.userKey}>
                  {compactText(row.user.userKey, 10)}
                </TableCell>
                <TableCell>{row.user.requestCount}</TableCell>
                <TableCell>{row.user.sessionCount}</TableCell>
                <TableCell className="text-xs">{formatDateTime(row.user.firstSeenAt)}</TableCell>
                <TableCell className="text-xs">{formatDateTime(row.user.lastSeenAt)}</TableCell>
                <TableCell
                  className="max-w-[260px] truncate text-xs"
                  title={formatModelSummary(row.user.models)}
                >
                  {formatModelSummary(row.user.models)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {row.user.providers.length}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {row.user.routeTypes.length}
                  </Badge>
                </TableCell>
                <TableCell className="sticky right-0 z-10 bg-background text-right">
                  <Button size="sm" variant="outline" onClick={() => onViewLogs(row.user.userKey)}>
                    查看日志
                  </Button>
                </TableCell>
              </TableRow>
            ) : (
              <TableRow key={row.key} className="bg-muted/20" style={{ height: ROW_HEIGHT }}>
                <TableCell />
                <TableCell className="text-muted-foreground text-xs">↳ 会话</TableCell>
                <TableCell>{row.session.requestCount}</TableCell>
                <TableCell
                  className="max-w-[160px] truncate text-xs text-muted-foreground"
                  title={row.session.sessionId}
                >
                  {row.session.sessionId}
                </TableCell>
                <TableCell className="text-xs">{formatDateTime(row.session.firstSeenAt)}</TableCell>
                <TableCell className="text-xs">{formatDateTime(row.session.lastSeenAt)}</TableCell>
                <TableCell
                  className="max-w-[260px] truncate text-xs"
                  title={formatModelSummary(row.session.models)}
                >
                  {formatModelSummary(row.session.models)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground" colSpan={2}>
                  最近 requestId: {compactText(row.session.latestRequestId, 8)}
                </TableCell>
                <TableCell className="sticky right-0 z-10 bg-background text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onViewLogs(row.user.userKey, row.session.sessionId)}
                  >
                    查看日志
                  </Button>
                </TableCell>
              </TableRow>
            )
          )}

          {bottomSpacerHeight > 0 ? (
            <TableRow aria-hidden="true">
              <TableCell
                colSpan={COLUMN_COUNT}
                className="p-0"
                style={{ height: bottomSpacerHeight }}
              />
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
