"use client";

import { useMemo } from "react";
import {
  Line,
  ComposedChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BRL_INTEGER_FORMATTER } from "@/shared/charts/homeRecharts";

const IDEAL_TECH_COST_PCT = 12.5;

const INTEGER_FORMATTER = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 0,
});

const formatInteger = (value: number) =>
  INTEGER_FORMATTER.format(Math.round(value));

const formatBrlInteger = (value: number) =>
  BRL_INTEGER_FORMATTER.format(Math.round(value));

const formatUsd = (value: number) =>
  value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const formatPct = (value: number, fractionDigits = 2) =>
  `${value
    .toFixed(fractionDigits)
    .replace(".", ",")}%`;

const formatDeltaPP = (deltaPP: number) => {
  const sign = deltaPP > 0 ? "+" : deltaPP < 0 ? "−" : "";
  const magnitude = Math.abs(deltaPP).toFixed(1).replace(".", ",");
  return `${sign}${magnitude} p.p.`;
};

const formatDeltaPct = (delta: number) => {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const magnitude = Math.abs(delta).toFixed(1).replace(".", ",");
  return `${sign}${magnitude}%`;
};

export type HeroDailyPoint = {
  date: string;
  realized: number;
  target?: number | null;
  isToday?: boolean;
};

export type HeroSummaryProps = {
  consolidatedBrl: number;
  consolidatedUsd: number | null;
  investedBrl: number;
  investedDeltaPct?: number | null;
  investedSubtitle?: string;
  techCostPct: number | null;
  techCostTargetPct?: number;
  techCostDeltaPP?: number | null;
  daily?: HeroDailyPoint[];
  monthLabel?: string;
  periodDays?: number;
};

type TooltipPayloadEntry = {
  dataKey?: string | number;
  value?: number | string;
};

function HeroChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const realized = payload.find((p) => p.dataKey === "realized")?.value;
  const target = payload.find((p) => p.dataKey === "target")?.value;
  return (
    <div className="heroChartTooltip">
      <div>
        <span className="heroChartTooltipLbl">Dia</span>
        <span className="num">{label}</span>
      </div>
      {typeof realized === "number" ? (
        <div>
          <span className="heroChartTooltipLbl">Realizado</span>
          <span className="num">{formatBrlInteger(realized)}</span>
        </div>
      ) : null}
      {typeof target === "number" ? (
        <div>
          <span className="heroChartTooltipLbl">Meta</span>
          <span className="num">{formatBrlInteger(target)}</span>
        </div>
      ) : null}
    </div>
  );
}

export function HeroSummary({
  consolidatedBrl,
  consolidatedUsd,
  investedBrl,
  investedDeltaPct,
  investedSubtitle = "Total investido das campanhas ativas no período",
  techCostPct,
  techCostTargetPct = IDEAL_TECH_COST_PCT,
  techCostDeltaPP,
  daily,
  monthLabel,
  periodDays,
}: HeroSummaryProps) {
  const techCostIsIdeal =
    techCostPct !== null && techCostPct <= techCostTargetPct;
  const techCostStatusLabel =
    techCostPct === null ? "sem base" : techCostIsIdeal ? "ideal" : "acima";
  const techCostStatusClass =
    techCostPct === null
      ? "heroStatus"
      : techCostIsIdeal
        ? "heroStatus heroStatusOk"
        : "heroStatus heroStatusCrit";

  const chartData = useMemo(() => {
    if (!daily || daily.length === 0) return [];
    return daily.map((point) => ({
      day: point.date.slice(8, 10),
      realized: point.realized,
      target:
        typeof point.target === "number" && Number.isFinite(point.target)
          ? point.target
          : null,
      isToday: point.isToday ?? false,
    }));
  }, [daily]);

  const todayPoint = chartData.find((p) => p.isToday);
  const yMax = chartData.reduce(
    (max, p) =>
      Math.max(
        max,
        typeof p.realized === "number" ? p.realized : 0,
        typeof p.target === "number" ? p.target : 0,
      ),
    0,
  );

  return (
    <section className="hero" aria-label="Resumo do período">
      <div className="heroCell">
        <div className="heroCellLabel">
          <span>Consolidado · BRL</span>
        </div>
        <div className="heroCellValue">
          <span className="heroCellCurrency">R$</span>
          <span className="num">{formatInteger(consolidatedBrl)}</span>
        </div>
        <div className="heroCellMeta">
          <span>Custo total da operação</span>
          {consolidatedUsd !== null ? (
            <>
              <span className="heroCellSep" aria-hidden="true">
                ·
              </span>
              <span className="num">USD {formatUsd(consolidatedUsd)}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="heroCell">
        <div className="heroCellLabel">
          <span>Investido</span>
        </div>
        <div className="heroCellValue">
          <span className="heroCellCurrency">R$</span>
          <span className="num">{formatInteger(investedBrl)}</span>
        </div>
        <div className="heroCellMeta">
          <span>{investedSubtitle}</span>
          {typeof investedDeltaPct === "number" &&
          Number.isFinite(investedDeltaPct) ? (
            <span
              className={
                investedDeltaPct > 0
                  ? "heroDelta heroDeltaUp"
                  : investedDeltaPct < 0
                    ? "heroDelta heroDeltaDown"
                    : "heroDelta heroDeltaFlat"
              }
            >
              {formatDeltaPct(investedDeltaPct)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="heroCell">
        <div className="heroCellLabel">
          <span>Tech Cost</span>
          <span className={techCostStatusClass}>{techCostStatusLabel}</span>
        </div>
        <div className="heroCellValue">
          <span className="heroCellPct num">
            {techCostPct === null ? "—" : formatPct(techCostPct)}
          </span>
        </div>
        <div className="heroCellMeta">
          <span>
            Meta &lt;{" "}
            {techCostTargetPct.toFixed(1).replace(".", ",")}%
          </span>
          {typeof techCostDeltaPP === "number" &&
          Number.isFinite(techCostDeltaPP) ? (
            <>
              <span className="heroCellSep" aria-hidden="true">
                ·
              </span>
              <span
                className="num"
                style={{
                  color:
                    techCostDeltaPP < 0
                      ? "var(--green)"
                      : techCostDeltaPP > 0
                        ? "var(--red)"
                        : "var(--fg-tertiary)",
                }}
              >
                {formatDeltaPP(techCostDeltaPP)}
              </span>
            </>
          ) : null}
        </div>
      </div>

      {chartData.length > 0 &&
      (typeof periodDays === "number" ? periodDays >= 7 : true) ? (
        <div className="heroChartWrap">
          <div className="heroChartHead">
            <div className="heroChartTitle">
              Gasto diário{monthLabel ? ` · ${monthLabel}` : ""}
            </div>
            <div className="heroLegend">
              <span className="heroLegendItem">
                <span
                  className="heroLegendSwatch"
                  style={{ background: "#fafafa" }}
                />
                Realizado
              </span>
              <span className="heroLegendItem">
                <span
                  className="heroLegendSwatch"
                  style={{ background: "var(--fg-quaternary)" }}
                />
                Meta diária
              </span>
              {todayPoint ? (
                <span className="heroLegendItem">
                  <span
                    className="heroLegendSwatch"
                    style={{ background: "var(--accent)" }}
                  />
                  Hoje
                </span>
              ) : null}
            </div>
          </div>
          <div className="heroChart">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={chartData}
                margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
              >
                <XAxis dataKey="day" hide />
                <YAxis hide domain={[0, yMax > 0 ? yMax * 1.1 : 1]} />
                <Tooltip
                  content={<HeroChartTooltip />}
                  cursor={{ stroke: "rgba(255,255,255,0.08)", strokeWidth: 1 }}
                />
                <Line
                  type="monotone"
                  dataKey="target"
                  stroke="var(--fg-quaternary)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="realized"
                  stroke="#fafafa"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                {todayPoint ? (
                  <ReferenceDot
                    x={todayPoint.day}
                    y={todayPoint.realized}
                    r={3}
                    fill="var(--accent)"
                    stroke="#0a0a0a"
                    strokeWidth={1.5}
                  />
                ) : null}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}
    </section>
  );
}
