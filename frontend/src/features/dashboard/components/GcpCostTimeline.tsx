"use client";

import { useMemo, useState, type ReactElement } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  type MouseHandlerDataParam,
} from "recharts";
import type { GcpBillingDailyPoint } from "@/services/api/gcp-billing";

type Granularity = "day" | "week" | "month" | "year";

type Props = {
  daily: GcpBillingDailyPoint[];
  /** Chamado ao clicar em um dia (só disponível na granularidade "Dia"). */
  onDaySelect?: (isoDay: string) => void;
};

function isoWeek(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function bucketKey(day: string, g: Granularity): string {
  if (g === "day") return day;
  if (g === "week") return isoWeek(day);
  if (g === "month") return day.slice(0, 7);
  return day.slice(0, 4);
}

function bucketLabel(key: string, g: Granularity): string {
  if (g === "day") {
    const [y, m, d] = key.split("-");
    return `${d}/${m}/${y}`;
  }
  if (g === "week") {
    const [, w] = key.split("-W");
    return `Sem. ${w}`;
  }
  if (g === "month") {
    const [y, m] = key.split("-");
    const months = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
    return `${months[Number(m) - 1]} ${y}`;
  }
  return key;
}

type ChartPoint = { key: string; label: string; usd: number; brl: number };

function aggregate(daily: GcpBillingDailyPoint[], g: Granularity): ChartPoint[] {
  const map = new Map<string, { usd: number; brl: number }>();
  for (const p of daily) {
    const k = bucketKey(p.day, g);
    const prev = map.get(k) ?? { usd: 0, brl: 0 };
    map.set(k, {
      usd: prev.usd + Number(p.cost_usd),
      brl: prev.brl + Number(p.cost_brl),
    });
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => ({ key: k, label: bucketLabel(k, g), usd: v.usd, brl: v.brl }));
}

const GRANULARITIES: { key: Granularity; label: string }[] = [
  { key: "day", label: "Dia" },
  { key: "week", label: "Semana" },
  { key: "month", label: "Mês" },
  { key: "year", label: "Ano" },
];

const CURRENCY_OPTIONS = [
  { key: "brl", label: "BRL" },
  { key: "usd", label: "USD" },
] as const;

type Currency = "brl" | "usd";

const ANOMALY_COLOR = "#f06292";

function formatTick(value: number, currency: Currency): string {
  if (value >= 1_000_000)
    return `${currency === "brl" ? "R$" : "US$"} ${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000)
    return `${currency === "brl" ? "R$" : "US$"} ${(value / 1_000).toFixed(0)}k`;
  return `${currency === "brl" ? "R$" : "US$"} ${value.toFixed(0)}`;
}

/** Dias fora do padrão: valor acima de (média móvel + 2σ) das amostras anteriores.
 * Só sinaliza picos (para cima) — que é o que dispara investigação de custo. */
function computeAnomalies(points: ChartPoint[], key: "usd" | "brl"): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < points.length; i++) {
    const prev = points.slice(Math.max(0, i - 7), i).map((p) => p[key]);
    if (prev.length < 4) continue;
    const mean = prev.reduce((a, b) => a + b, 0) / prev.length;
    const variance =
      prev.reduce((a, b) => a + (b - mean) ** 2, 0) / prev.length;
    const std = Math.sqrt(variance);
    if (std <= 0) continue;
    if (points[i][key] > mean + 2 * std) out.add(i);
  }
  return out;
}

export default function GcpCostTimeline({ daily, onDaySelect }: Props) {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [currency, setCurrency] = useState<Currency>("brl");

  const points = useMemo(
    () => aggregate(daily, granularity),
    [daily, granularity],
  );

  const dataKey = currency === "brl" ? "brl" : "usd";
  const prefix = currency === "brl" ? "R$" : "US$";

  const anomalies = useMemo(
    () => computeAnomalies(points, dataKey),
    [points, dataKey],
  );

  // Drill-down só faz sentido na granularidade "Dia" — nos demais buckets o
  // ponto agrega vários dias e não há uma data única para detalhar.
  const clickable = granularity === "day" && Boolean(onDaySelect);

  function handleChartClick(state: MouseHandlerDataParam) {
    if (!clickable) return;
    const idx = Number(state?.activeIndex);
    const point = Number.isInteger(idx) ? points[idx] : undefined;
    if (point) onDaySelect?.(point.key);
  }

  function renderDot(props: {
    cx?: number;
    cy?: number;
    index?: number;
  }): ReactElement {
    const { cx, cy, index } = props;
    if (index == null || cx == null || cy == null || !anomalies.has(index)) {
      return <g key={`dot-${index}`} />;
    }
    return (
      <circle
        key={`dot-${index}`}
        cx={cx}
        cy={cy}
        r={4}
        fill={ANOMALY_COLOR}
        stroke="#141414"
        strokeWidth={1.5}
      />
    );
  }

  return (
    <section className="claudeTableCard gcpTimeline">
      <div className="gcpTimelineHeader">
        <div className="gcpTimelineTitleGroup">
          <h2 className="claudeTableTitle">Custo ao longo do tempo</h2>
          {clickable ? (
            <span className="gcpTimelineHint">Clique em um dia para detalhar</span>
          ) : null}
          {anomalies.size > 0 ? (
            <span className="gcpTimelineHint" style={{ color: ANOMALY_COLOR }}>
              ● {anomalies.size}{" "}
              {anomalies.size === 1 ? "dia fora do padrão" : "dias fora do padrão"}
            </span>
          ) : null}
        </div>
        <div className="gcpTimelineControls">
          <div className="gcpServiceTabs">
            {CURRENCY_OPTIONS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`gcpServiceTab${currency === c.key ? " gcpServiceTabActive" : ""}`}
                onClick={() => setCurrency(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="gcpServiceTabs">
            {GRANULARITIES.map((g) => (
              <button
                key={g.key}
                type="button"
                className={`gcpServiceTab${granularity === g.key ? " gcpServiceTabActive" : ""}`}
                onClick={() => setGranularity(g.key)}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <AreaChart
          data={points}
          margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
          onClick={handleChartClick}
          style={clickable ? { cursor: "pointer" } : undefined}
        >
          <defs>
            <linearGradient id="gcpAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#7c6af7" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#7c6af7" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.05)"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: "#666" }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={(v) => formatTick(v, currency)}
            tick={{ fontSize: 10, fill: "#666" }}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <Tooltip
            formatter={(value) =>
              `${prefix} ${Number(value).toLocaleString("pt-BR", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}`
            }
            labelStyle={{ color: "#aaa", fontSize: 11, marginBottom: 4 }}
            contentStyle={{
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: 8,
              fontSize: 12,
              color: "#ededed",
            }}
            cursor={{ stroke: "rgba(255,255,255,0.1)", strokeWidth: 1 }}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke="#7c6af7"
            strokeWidth={1.5}
            fill="url(#gcpAreaGrad)"
            dot={renderDot}
            activeDot={{ r: 3, fill: "#7c6af7", strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </section>
  );
}
