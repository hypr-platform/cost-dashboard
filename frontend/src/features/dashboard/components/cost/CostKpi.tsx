"use client";

import type { ReactNode } from "react";

type Props = {
  label: string;
  value: ReactNode | null;
  hint?: ReactNode | null;
  tooltip?: string;
};

function InfoIcon({ tooltip }: { tooltip: string }) {
  return (
    <span className="bqCostKpiInfoWrap">
      <svg
        className="bqCostKpiInfoIcon"
        viewBox="0 0 14 14"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="5.5" />
        <path d="M7 6.5v3.5" />
        <circle cx="7" cy="4.5" r="0.6" fill="currentColor" stroke="none" />
      </svg>
      <span className="bqCostKpiTooltip" role="tooltip">{tooltip}</span>
    </span>
  );
}

export default function CostKpi({ label, value, hint, tooltip }: Props) {
  const ready = value !== null && value !== undefined;
  return (
    <div className="bqCostKpi">
      <span className="bqCostKpiLabel">
        {label}
        {tooltip ? <InfoIcon tooltip={tooltip} /> : null}
      </span>
      {ready ? (
        <>
          <span className="bqCostKpiValue">{value}</span>
          {hint != null ? <span className="bqCostKpiHint">{hint}</span> : null}
        </>
      ) : (
        <>
          <span className="bqCostKpiValueSkeleton" aria-hidden />
          <span className="bqCostKpiHintSkeleton" aria-hidden />
        </>
      )}
    </div>
  );
}
