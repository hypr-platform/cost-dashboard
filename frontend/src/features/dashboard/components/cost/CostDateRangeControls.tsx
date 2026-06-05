"use client";

import { Fragment, type ReactNode } from "react";
import { todayKey } from "@/features/dashboard/utils/cost-format";
import BRDateInput from "./BRDateInput";

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
        <BRDateInput
          className="claudeDayInput"
          value={from}
          max={to}
          onChange={onChangeFrom}
          ariaLabel="Data inicial"
        />
      </label>
      <label className="bqCostField">
        <span className="bqCostFieldLabel">Até</span>
        <BRDateInput
          className="claudeDayInput"
          value={to}
          min={from}
          max={todayKey()}
          onChange={onChangeTo}
          ariaLabel="Data final"
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
