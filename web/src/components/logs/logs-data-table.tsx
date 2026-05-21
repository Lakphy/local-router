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
import { createLogsColumns } from './logs-columns';

export function LogsDataTable(props: {
  data: LogEventSummary[];
  sort: 'time_desc' | 'time_asc';
  onSortChange: (next: 'time_desc' | 'time_asc') => void;
  onRowClick: (item: LogEventSummary) => void;
}) {
  const { data, sort, onSortChange, onRowClick } = props;
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const columns = useMemo(() => createLogsColumns(onSortChange, sort), [onSortChange, sort]);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: {
      columnVisibility,
    },
    onColumnVisibilityChange: setColumnVisibility,
  });

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
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
          {table.getRowModel().rows?.length ? (
            table
              .getRowModel()
              .rows.map((row) => <DataRow key={row.id} row={row} onClick={onRowClick} />)
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
    <TableRow className="cursor-pointer" onClick={() => onClick(row.original)}>
      {row.getVisibleCells().map((cell) => (
        <TableCell key={cell.id}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  );
}
