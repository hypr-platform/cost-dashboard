import { Skeleton, SkeletonRepeat } from "@/shared/skeletons";

/** Body skeleton for the Home / DeepDive page. */
export function HomeDashboardSkeleton() {
  return (
    <>
      <section className="hero" aria-hidden="true">
        {Array.from({ length: 3 }).map((_, idx) => (
          <div className="heroCell" key={`hero-cell-${idx}`}>
            <div className="heroCellLabel">
              <Skeleton variant="eyebrow" />
            </div>
            <div className="heroCellValue">
              <Skeleton variant="heading" />
            </div>
            <div className="heroCellMeta">
              <Skeleton variant="subtitleLarge" />
            </div>
          </div>
        ))}
        <div className="heroChartWrap">
          <div className="heroChartHead">
            <Skeleton variant="eyebrow" />
          </div>
          <Skeleton variant="block" className="heroChart" />
        </div>
      </section>

      <section className="platformsSection" aria-hidden="true">
        <header className="platformsSectionHeader">
          <Skeleton variant="heading" />
        </header>
        <div className="gridCards platformsGrid">
          <SkeletonRepeat count={6} variant="card" className="card" keyPrefix="home-platform" />
        </div>
      </section>

      <section className="gridTwo gridTwoCharts gridTwoChartsHome" aria-hidden="true">
        <Skeleton variant="chart" className="panel" />
        <Skeleton variant="chart" className="panel" />
      </section>

      <Skeleton variant="chartTall" as="div" className="panel" />
    </>
  );
}
