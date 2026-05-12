"use client";

import type { ReactNode } from "react";

export type CostColumn<T> = {
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
};

type Props<T> = {
  title: string;
  hint?: ReactNode;
  rows: T[] | undefined;
  error?: unknown;
  rowKey: (row: T) => string;
  columns: CostColumn<T>[];
  emptyMessage?: string;
};

export default function CostBreakdownTable<T>({
  title,
  hint,
  rows,
  error,
  rowKey,
  columns,
  emptyMessage = "Sem dados no intervalo.",
}: Props<T>) {
  const loading = !rows && !error;
  return (
    <section className="claudeTableCard">
      <div className="claudeTableHeader">
        <h2 className="claudeTableTitle">{title}</h2>
        {hint != null ? <span className="claudeTableHint">{hint}</span> : null}
      </div>
      {loading ? (
        <div className="claudeTableSkeleton" aria-hidden />
      ) : rows && rows.length === 0 ? (
        <p className="claudeAlert">{emptyMessage}</p>
      ) : rows ? (
        <table className="claudeTable">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={
                    col.align === "right"
                      ? "claudeTableColNum"
                      : "claudeTableColUser"
                  }
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={
                      col.align === "right"
                        ? "claudeTableColNum"
                        : "claudeTableColUser"
                    }
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
