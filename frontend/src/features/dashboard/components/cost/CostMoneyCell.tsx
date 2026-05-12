"use client";

import { formatBrl, formatUsd } from "@/features/dashboard/utils/cost-format";

type Props = {
  brl: string | number;
  usd: string | number;
};

export default function CostMoneyCell({ brl, usd }: Props) {
  return (
    <>
      <span className="claudeTableMoney">{formatBrl(brl)}</span>
      <span className="claudeTableMoneySecondary">{formatUsd(usd)}</span>
    </>
  );
}
