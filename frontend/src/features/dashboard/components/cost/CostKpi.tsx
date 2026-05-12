"use client";

import type { ReactNode } from "react";

type Props = {
  label: string;
  value: ReactNode | null;
  hint?: ReactNode | null;
};

export default function CostKpi({ label, value, hint }: Props) {
  const ready = value !== null && value !== undefined;
  return (
    <div className="bqCostKpi">
      <span className="bqCostKpiLabel">{label}</span>
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
