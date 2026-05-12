import { Skeleton, SkeletonRepeat } from "@/shared/skeletons";

/**
 * Body skeleton for "Jornada de campanhas". Mirrors the real layout: filter
 * toolbar (6 multi-select filters), then the journey card with header
 * (title + breakdown actions) and the campaign table.
 */
export function JourneySkeleton() {
  return (
    <>
      <div
        className="filterBar filterToolbar filterToolbarDashboard"
        aria-hidden="true"
        style={{ gap: 10 }}
      >
        <SkeletonRepeat
          count={6}
          variant="buttonWide"
          keyPrefix="journey-filter"
        />
      </div>

      <section className="journeyResendCard" aria-hidden="true">
        <header className="journeyResendHeader">
          <div className="journeyResendHeaderTitle">
            <Skeleton variant="title" width={180} height={22} />
            <Skeleton variant="subtitleLarge" />
          </div>
          <div
            className="journeyResendHeaderActions"
            style={{ display: "flex", gap: 8 }}
          >
            <Skeleton variant="buttonWide" />
            <Skeleton variant="button" width={32} height={32} />
          </div>
        </header>
        <Skeleton variant="table" />
      </section>
    </>
  );
}
