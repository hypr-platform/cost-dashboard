import { Skeleton, SkeletonRepeat } from "@/shared/skeletons";

export function VercelSkeleton() {
  return (
    <div className="claudeTab bqCostTab vercelCostTab" aria-hidden="true">
      <header className="claudeHeader">
        <div className="claudeHeaderTitle">
          <Skeleton variant="heading" />
          <Skeleton variant="eyebrow" />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Skeleton variant="buttonWide" />
          <Skeleton variant="buttonWide" />
          <Skeleton variant="button" />
        </div>
      </header>

      <section className="bqCostKpis">
        <SkeletonRepeat count={4} variant="card" className="card" keyPrefix="vercel-kpi" />
      </section>

      <section className="claudeTableCard" style={{ marginTop: 12 }}>
        <div className="claudeTableHeader">
          <Skeleton variant="title" />
        </div>
        <Skeleton variant="table" />
      </section>

      <section className="claudeTableCard" style={{ marginTop: 12 }}>
        <div className="claudeTableHeader">
          <Skeleton variant="title" />
        </div>
        <Skeleton variant="table" />
      </section>
    </div>
  );
}
