import type { CSSProperties, ReactNode } from "react";

type SkeletonVariant =
  | "text"
  | "title"
  | "heading"
  | "eyebrow"
  | "subtitle"
  | "subtitleLarge"
  | "button"
  | "buttonWide"
  | "navItem"
  | "block"
  | "card"
  | "chart"
  | "chartTall"
  | "chartInline"
  | "chartInlineTall"
  | "table";

const VARIANT_CLASS: Record<SkeletonVariant, string> = {
  text: "skeletonText",
  title: "skeletonTitle",
  heading: "skeletonText skeletonHeading",
  eyebrow: "skeletonText skeletonEyebrow",
  subtitle: "skeletonText skeletonSubtitle",
  subtitleLarge: "skeletonText skeletonSubtitleLarge",
  button: "skeletonButton",
  buttonWide: "skeletonButtonWide",
  navItem: "skeletonNavItem",
  block: "skeletonBlock",
  card: "skeletonBlock skeletonCard",
  chart: "skeletonBlock skeletonChart",
  chartTall: "skeletonBlock skeletonChartTall",
  chartInline: "skeletonChartInline",
  chartInlineTall: "skeletonChartInline skeletonChartInlineTall",
  table: "skeletonTable",
};

export interface SkeletonProps {
  variant?: SkeletonVariant;
  className?: string;
  style?: CSSProperties;
  width?: number | string;
  height?: number | string;
  as?: "div" | "span";
  children?: ReactNode;
}

/**
 * Single source of truth for shimmer placeholders. Composes the global
 * `.skeleton` shimmer with a variant class. Use `width`/`height` for one-offs
 * instead of inventing new CSS classes.
 */
export function Skeleton({
  variant = "block",
  className,
  style,
  width,
  height,
  as = "div",
  children,
}: SkeletonProps) {
  const Tag = as;
  const composedStyle: CSSProperties = {
    ...(width !== undefined ? { width } : null),
    ...(height !== undefined ? { height } : null),
    ...style,
  };
  const composedClassName = [
    "skeleton",
    VARIANT_CLASS[variant],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag
      className={composedClassName}
      style={composedStyle}
      aria-hidden="true"
    >
      {children}
    </Tag>
  );
}

/** Render N skeletons of the same variant — common for nav lists, KPI rows. */
export function SkeletonRepeat({
  count,
  variant,
  className,
  keyPrefix = "sk",
}: {
  count: number;
  variant: SkeletonVariant;
  className?: string;
  keyPrefix?: string;
}) {
  return (
    <>
      {Array.from({ length: count }).map((_, idx) => (
        <Skeleton
          key={`${keyPrefix}-${idx}`}
          variant={variant}
          className={className}
        />
      ))}
    </>
  );
}
