import { Skeleton, SkeletonRepeat } from "@/shared/skeletons";

/**
 * Body skeleton for platform pages (DV360, Xandr, StackAdapt, Nexd, Hivestack,
 * Amazon DSP). Header → KPIs → chart → lines table.
 */
export function PlatformPageSkeleton() {
  return (
    <>
      <section className="panel" aria-hidden="true" style={{ padding: 16 }}>
        <Skeleton variant="heading" />
        <Skeleton variant="subtitleLarge" />
      </section>

      <section
        className="gridCards"
        aria-hidden="true"
        style={{ marginTop: 12 }}
      >
        <SkeletonRepeat
          count={4}
          variant="card"
          className="card"
          keyPrefix="platform-kpi"
        />
      </section>

      <section
        className="panel"
        aria-hidden="true"
        style={{ marginTop: 12, padding: 16 }}
      >
        <Skeleton variant="eyebrow" />
        <Skeleton variant="chartInline" />
      </section>

      <section
        className="panel"
        aria-hidden="true"
        style={{ marginTop: 12, padding: 16 }}
      >
        <Skeleton variant="heading" />
        <Skeleton variant="table" />
      </section>
    </>
  );
}
