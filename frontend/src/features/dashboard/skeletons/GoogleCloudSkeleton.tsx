import { Skeleton, SkeletonRepeat } from "@/shared/skeletons";

/** Body skeleton for the Google Cloud billing tab. */
export function GoogleCloudSkeleton() {
  return (
    <div className="claudeTab" aria-hidden="true">
      <header className="claudeHeader">
        <div className="claudeHeaderTitle">
          <Skeleton variant="heading" />
          <Skeleton variant="subtitleLarge" />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Skeleton variant="buttonWide" />
          <Skeleton variant="button" />
        </div>
      </header>

      <section className="bqCostKpis">
        <SkeletonRepeat
          count={4}
          variant="card"
          className="card"
          keyPrefix="gcp-kpi"
        />
      </section>

      <section className="panel" style={{ marginTop: 12, padding: 16 }}>
        <Skeleton variant="title" />
        <Skeleton variant="chart" />
      </section>

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
