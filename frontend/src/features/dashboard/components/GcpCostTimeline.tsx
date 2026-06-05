"use client";

import { useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { GcpBillingDailyPoint } from "@/services/api/gcp-billing";

type Granularity = "day" | "week" | "month" | "year";

type Props = {
  daily: GcpBillingDailyPoint[];
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

function aggregate(
  daily: GcpBillingDailyPoint[],
  g: Granularity,
): { label: string; usd: number; brl: number }[] {
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
    .map(([k, v]) => ({ label: bucketLabel(k, g), usd: v.usd, brl: v.brl }));
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

function formatTick(value: number, currency: Currency): string {
  if (value >= 1_000_000)
    return `${currency === "brl" ? "R$" : "US$"} ${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000)
    return `${currency === "brl" ? "R$" : "US$"} ${(value / 1_000).toFixed(0)}k`;
  return `${currency === "brl" ? "R$" : "US$"} ${value.toFixed(0)}`;
}

export default function GcpCostTimeline({ daily }: Props) {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [currency, setCurrency] = useState<Currency>("brl");

  const points = useMemo(
    () => aggregate(daily, granularity),
    [daily, granularity],
  );

  const dataKey = currency === "brl" ? "brl" : "usd";
  const prefix = currency === "brl" ? "R$" : "US$";

  return (
    <section className="claudeTableCard gcpTimeline">
      <div className="gcpTimelineHeader">
        <h2 className="claudeTableTitle">Custo ao longo do tempo</h2>
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
        <AreaChart data={points} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
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
            dot={false}
            activeDot={{ r: 3, fill: "#7c6af7", strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </section>
  );
}
