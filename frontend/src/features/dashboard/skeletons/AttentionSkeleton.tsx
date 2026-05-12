import { Skeleton, SkeletonRepeat } from "@/shared/skeletons";

type AttentionTone = "warning" | "danger";

interface AttentionPageSkeletonProps {
  /** Visual tone: matches `dspResendHero--warning|--danger`. */
  tone: AttentionTone;
}

/**
 * Body skeleton for the "atenção" pages (Lines sem token / Gasto fora do mês).
 * Mirrors the real layout exactly: warning hero (eyebrow + title + big value +
 * 3 stats), pie chart card, then lines table card with chip filters.
 */
function AttentionPageSkeleton({ tone }: AttentionPageSkeletonProps) {
  return (
    <>
      <section
        className={`dspResendHero dspResendHero--${tone}`}
        aria-hidden="true"
      >
        <header className="dspResendHeroHead">
          <div className="dspResendHeroBrand">
            <Skeleton variant="block" width={36} height={36} />
            <div style={{ display: "grid", gap: 6, marginLeft: 4 }}>
              <Skeleton variant="eyebrow" />
              <Skeleton variant="title" width={200} height={22} />
            </div>
          </div>
          <Skeleton variant="block" width={180} height={36} />
        </header>
        <Skeleton variant="subtitleLarge" />
        <div className="dspResendHeroStats">
          {Array.from({ length: 3 }).map((_, idx) => (
            <div className="dspResendHeroStat" key={`hero-stat-${idx}`}>
              <Skeleton variant="eyebrow" />
              <Skeleton variant="title" width={120} height={22} />
              <Skeleton variant="subtitle" width={140} />
            </div>
          ))}
        </div>
      </section>

      <section className="dspResendChartCard" aria-hidden="true">
        <header className="dspResendChartCardHead">
          <div style={{ display: "grid", gap: 6 }}>
            <Skeleton variant="title" />
            <Skeleton variant="subtitle" width={220} />
          </div>
          <Skeleton variant="button" width={32} height={32} />
        </header>
        <Skeleton variant="chartInline" />
      </section>

      <section
        className="journeyResendCard dspResendLinesCard"
        aria-hidden="true"
      >
        <header className="journeyResendHeader">
          <div className="journeyResendHeaderTitle">
            <Skeleton variant="title" />
            <Skeleton variant="subtitle" width={220} />
          </div>
          <div
            className="journeyResendHeaderActions"
            style={{ display: "flex", gap: 8 }}
          >
            <Skeleton variant="buttonWide" />
            <Skeleton variant="button" width={32} height={32} />
          </div>
        </header>
        <div
          className="dspResendChipBar"
          aria-hidden="true"
          style={{ gap: 6 }}
        >
          <Skeleton variant="eyebrow" />
          <SkeletonRepeat
            count={6}
            variant="button"
            keyPrefix="dsp-chip"
          />
        </div>
        <Skeleton variant="table" />
      </section>
    </>
  );
}

export function NoTokenLinesSkeleton() {
  return <AttentionPageSkeleton tone="warning" />;
}

export function OutOfPeriodSkeleton() {
  return <AttentionPageSkeleton tone="danger" />;
}

/** @deprecated kept for backwards-compatibility — prefer the tone-specific exports. */
export const AttentionSkeleton = NoTokenLinesSkeleton;
