import { Skeleton, SkeletonRepeat } from "@/shared/skeletons";

/**
 * Body skeleton for the BigQuery costs tab. Mirrors BigQueryTab's layout:
 * header + date range controls, 3 KPIs, 3 breakdown tables, top queries table.
 */
export function BigQuerySkeleton() {
  return (
    <div className="claudeTab bqCostTab" aria-hidden="true">
      <header className="claudeHeader">
        <div className="claudeHeaderTitle">
          <Skeleton variant="heading" />
          <Skeleton variant="subtitleLarge" />
          <Skeleton variant="eyebrow" />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Skeleton variant="buttonWide" />
          <Skeleton variant="buttonWide" />
          <Skeleton variant="buttonWide" />
          <Skeleton variant="button" />
        </div>
      </header>

      <section className="bqCostKpis">
        <SkeletonRepeat
          count={3}
          variant="card"
          className="card"
          keyPrefix="bq-kpi"
        />
      </section>

      {Array.from({ length: 3 }).map((_, idx) => (
        <section
          key={`bq-table-${idx}`}
          className="claudeTableCard"
          style={{ marginTop: 12 }}
        >
          <div className="claudeTableHeader">
            <Skeleton variant="title" />
            <Skeleton variant="eyebrow" />
          </div>
          <Skeleton variant="table" />
        </section>
      ))}

      <section className="claudeTableCard" style={{ marginTop: 12 }}>
        <div className="claudeTableHeader">
          <Skeleton variant="title" />
          <Skeleton variant="eyebrow" />
        </div>
        <Skeleton variant="table" />
      </section>
    </div>
  );
}
