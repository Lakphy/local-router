import {
  flexRender,
  getCoreRowModel,
  type Row,
  useReactTable,
  type VisibilityState,
} from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { LogEventSummary } from '@/lib/api';
import { calculateVirtualRange } from '@/lib/virtual-list';
import { createLogsColumns } from './logs-columns';

const ROW_HEIGHT = 44;

export { calculateVirtualRange as calculateLogsVirtualRange };

export function LogsDataTable(props: {
  data: LogEventSummary[];
  sort: 'time_desc' | 'time_asc';
  onSortChange: (next: 'time_desc' | 'time_asc') => void;
  onRowClick: (item: LogEventSummary) => void;
}) {
  const { data, sort, onSortChange, onRowClick } = props;
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [scrollTop, setScrollTop] = useState(0);

  const virtualRange = useMemo(
    () => calculateVirtualRange({ dataLength: data.length, scrollTop }),
    [data.length, scrollTop]
  );

  const visibleData = useMemo(
    () => data.slice(virtualRange.start, virtualRange.end),
    [data, virtualRange.end, virtualRange.start]
  );

  const topSpacerHeight = virtualRange.start * ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, (data.length - virtualRange.end) * ROW_HEIGHT);

  const columns = useMemo(() => createLogsColumns(onSortChange, sort), [onSortChange, sort]);

  const table = useReactTable({
    data: visibleData,
    columns,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    state: {
      columnVisibility,
    },
    onColumnVisibilityChange: setColumnVisibility,
  });

  return (
    <div
      className="max-h-[560px] overflow-auto rounded-md border"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {data.length ? (
            <>
              {topSpacerHeight > 0 ? (
                <TableRow aria-hidden="true">
                  <TableCell
                    colSpan={columns.length}
                    className="p-0"
                    style={{ height: topSpacerHeight }}
                  />
                </TableRow>
              ) : null}
              {table.getRowModel().rows.map((row) => (
                <DataRow key={row.original.id} row={row} onClick={onRowClick} />
              ))}
              {bottomSpacerHeight > 0 ? (
                <TableRow aria-hidden="true">
                  <TableCell
                    colSpan={columns.length}
                    className="p-0"
                    style={{ height: bottomSpacerHeight }}
                  />
                </TableRow>
              ) : null}
            </>
          ) : (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="h-24 text-center text-sm text-muted-foreground"
              >
                暂无日志数据
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function DataRow({
  row,
  onClick,
}: {
  row: Row<LogEventSummary>;
  onClick: (item: LogEventSummary) => void;
}) {
  return (
    <TableRow
      className="cursor-pointer"
      style={{ height: ROW_HEIGHT }}
      onClick={() => onClick(row.original)}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell key={cell.id}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  );
}
