"use client";

import { useState, type ReactNode } from "react";

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
  defaultCollapsed?: boolean;
};

export default function CostBreakdownTable<T>({
  title,
  hint,
  rows,
  error,
  rowKey,
  columns,
  emptyMessage = "Sem dados no intervalo.",
  defaultCollapsed = false,
}: Props<T>) {
  const loading = !rows && !error;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <section className="claudeTableCard">
      <button
        type="button"
        className="claudeTableHeaderBtn"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className="claudeTableHeaderBtnLeft">
          <svg
            className={`claudeTableChevron${collapsed ? " claudeTableChevronCollapsed" : ""}`}
            viewBox="0 0 12 12"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
          </svg>
          <h2 className="claudeTableTitle">{title}</h2>
        </span>
        {hint != null ? <span className="claudeTableHint">{hint}</span> : null}
      </button>

      {!collapsed ? (
        loading ? (
          <table className="claudeTable claudeTableLoading" aria-hidden>
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
              {Array.from({ length: 6 }).map((_, rowIdx) => (
                <tr key={`sk-${rowIdx}`}>
                  {columns.map((col, colIdx) => (
                    <td
                      key={col.key}
                      className={
                        col.align === "right"
                          ? "claudeTableColNum"
                          : "claudeTableColUser"
                      }
                    >
                      <span
                        className={
                          colIdx === 0
                            ? "claudeTableCellSkeleton claudeTableCellSkeletonText"
                            : "claudeTableCellSkeleton claudeTableCellSkeletonNum"
                        }
                      />
                      {colIdx === 0 ? (
                        <span className="claudeTableCellSkeleton claudeTableCellSkeletonSub" />
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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
        ) : null
      ) : null}
    </section>
  );
}
