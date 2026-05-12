"use client";

import { Fragment, type ReactNode } from "react";
import { todayKey } from "@/features/dashboard/utils/cost-format";

type Props = {
  from: string;
  to: string;
  onChangeFrom: (value: string) => void;
  onChangeTo: (value: string) => void;
  onRefresh: () => void;
  isValidating: boolean;
  extraFields?: ReactNode;
};

export default function CostDateRangeControls({
  from,
  to,
  onChangeFrom,
  onChangeTo,
  onRefresh,
  isValidating,
  extraFields,
}: Props) {
  return (
    <div className="claudeHeaderControls bqCostControls">
      <label className="bqCostField">
        <span className="bqCostFieldLabel">De</span>
        <input
          type="date"
          className="claudeDayInput"
          value={from}
          max={to}
          onChange={(e) => {
            if (e.target.value) onChangeFrom(e.target.value);
          }}
        />
      </label>
      <label className="bqCostField">
        <span className="bqCostFieldLabel">Até</span>
        <input
          type="date"
          className="claudeDayInput"
          value={to}
          max={todayKey()}
          min={from}
          onChange={(e) => {
            if (e.target.value) onChangeTo(e.target.value);
          }}
        />
      </label>
      {extraFields ? <Fragment>{extraFields}</Fragment> : null}
      <button
        type="button"
        className="claudeRefresh"
        onClick={onRefresh}
        disabled={isValidating}
        aria-label="Atualizar"
      >
        {isValidating ? "Atualizando…" : "Atualizar"}
      </button>
    </div>
  );
}
