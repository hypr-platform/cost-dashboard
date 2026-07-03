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
  Legend,
} from "recharts";
import type { BqCostUserDailyPoint } from "@/services/api/bigquery-cost";
import { emailLabel } from "@/features/dashboard/utils/cost-format";

type Props = {
  daily: BqCostUserDailyPoint[];
};

type Currency = "brl" | "usd";

const TOP_N = 8;
const OTHERS = "Outros";

const COLORS = [
  "#7c6af7", "#4f9cf9", "#34c78a", "#f59e42", "#f06292",
  "#a78bfa", "#38bdf8", "#fb923c", "#4ade80",
];

const CURRENCY_OPTIONS = [
  { key: "brl", label: "BRL" },
  { key: "usd", label: "USD" },
] as const;

function dayLabelShort(key: string): string {
  const [, m, d] = key.split("-");
  return `${d}/${m}`;
}

function formatTick(value: number, currency: Currency): string {
  const prefix = currency === "brl" ? "R$" : "US$";
  if (value >= 1_000) return `${prefix} ${(value / 1_000).toFixed(0)}k`;
  return `${prefix} ${value.toFixed(0)}`;
}

export default function BqUserTimeline({ daily }: Props) {
  const [currency, setCurrency] = useState<Currency>("brl");

  const { rows, series } = useMemo(() => {
    const field = currency === "brl" ? "cost_brl" : "cost_usd";

    // Ranking de usuários por custo total no período.
    const totals = new Map<string, number>();
    for (const p of daily) {
      totals.set(
        p.user_email,
        (totals.get(p.user_email) ?? 0) + Number(p[field]),
      );
    }
    const ranked = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([u]) => u);
    const top = ranked.slice(0, TOP_N);
    const topSet = new Set(top);
    const hasOthers = ranked.length > top.length;
    const seriesKeys = [...top, ...(hasOthers ? [OTHERS] : [])];

    // Pivot dia → { user: custo }.
    const byDay = new Map<string, Record<string, number>>();
    for (const p of daily) {
      const bucket = byDay.get(p.day) ?? {};
      const key = topSet.has(p.user_email) ? p.user_email : OTHERS;
      bucket[key] = (bucket[key] ?? 0) + Number(p[field]);
      byDay.set(p.day, bucket);
    }

    const days = [...byDay.keys()].sort();
    const builtRows = days.map((d) => {
      const base: Record<string, number | string> = { day: d, label: dayLabelShort(d) };
      for (const k of seriesKeys) base[k] = 0;
      Object.assign(base, byDay.get(d) ?? {});
      return base;
    });

    return { rows: builtRows, series: seriesKeys };
  }, [daily, currency]);

  const prefix = currency === "brl" ? "R$" : "US$";

  return (
    <section className="claudeTableCard gcpTimeline">
      <div className="gcpTimelineHeader">
        <h2 className="claudeTableTitle">Custo de query por usuário ao longo do tempo</h2>
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
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
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
            formatter={(value, name) => [
              `${prefix} ${Number(value).toLocaleString("pt-BR", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}`,
              name === OTHERS ? OTHERS : emailLabel(String(name)),
            ]}
            labelStyle={{ color: "#aaa", fontSize: 11, marginBottom: 4 }}
            contentStyle={{
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: 8,
              fontSize: 12,
              color: "#ededed",
            }}
            itemSorter={(item) => -Number(item.value)}
          />
          <Legend
            iconType="circle"
            iconSize={8}
            formatter={(value) => (
              <span style={{ fontSize: 11, color: "#aaa" }}>
                {value === OTHERS ? OTHERS : emailLabel(String(value))}
              </span>
            )}
          />
          {series.map((key, i) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stackId="1"
              stroke={key === OTHERS ? "#555" : COLORS[i % COLORS.length]}
              fill={key === OTHERS ? "#555" : COLORS[i % COLORS.length]}
              fillOpacity={0.5}
              strokeWidth={1}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </section>
  );
}
