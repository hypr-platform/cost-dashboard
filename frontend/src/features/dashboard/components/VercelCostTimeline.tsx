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
import type { VercelCategoryDailyPoint } from "@/services/api/vercel-cost";

type Currency = "brl" | "usd";

type Props = {
  daily: VercelCategoryDailyPoint[];
  categories: string[];
};

/**
 * Paleta inspirada na Vercel/Resend: base violeta + tons frios distintos, alto
 * contraste sobre fundo escuro. Cicla se houver mais categorias que cores.
 */
const PALETTE = [
  "#7c6af7",
  "#22d3ee",
  "#f472b6",
  "#34d399",
  "#fbbf24",
  "#60a5fa",
  "#f87171",
  "#a78bfa",
  "#2dd4bf",
  "#fb923c",
];

const CURRENCY_OPTIONS: { key: Currency; label: string }[] = [
  { key: "brl", label: "BRL" },
  { key: "usd", label: "USD" },
];

function formatTick(value: number, currency: Currency): string {
  const prefix = currency === "brl" ? "R$" : "US$";
  if (value >= 1_000_000) return `${prefix} ${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${prefix} ${(value / 1_000).toFixed(0)}k`;
  return `${prefix} ${value.toFixed(0)}`;
}

function gradId(category: string): string {
  return `vercelGrad-${category.replace(/\W/g, "")}`;
}

type ChartRow = { label: string } & Record<string, number | string>;

function pivot(
  daily: VercelCategoryDailyPoint[],
  categories: string[],
  currency: Currency,
): ChartRow[] {
  const field = currency === "brl" ? "billed_brl" : "billed_usd";
  const byDay = new Map<string, ChartRow>();
  for (const point of daily) {
    const [, m, d] = point.day.split("-");
    const label = `${d}/${m}`;
    let row = byDay.get(point.day);
    if (!row) {
      row = { label };
      for (const category of categories) row[category] = 0;
      byDay.set(point.day, row);
    }
    const current = Number(row[point.category] ?? 0);
    row[point.category] = current + Number(point[field]);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row);
}

export default function VercelCostTimeline({ daily, categories }: Props) {
  const [currency, setCurrency] = useState<Currency>("brl");
  // Filtro por categoria (multi-seleção). Vazio = mostra todas — mesma UX das DSPs.
  const [activeKeys, setActiveKeys] = useState<string[]>([]);
  const prefix = currency === "brl" ? "R$" : "US$";

  // Cor estável por categoria, na ordem original do backend (não muda ao filtrar).
  const colorFor = useMemo(() => {
    const map = new Map<string, string>();
    categories.forEach((c, i) => map.set(c, PALETTE[i % PALETTE.length]));
    return map;
  }, [categories]);

  // Só categorias que de fato têm custo no período entram na legenda/gráfico.
  const fundedCategories = useMemo(() => {
    const totals = new Map<string, number>();
    for (const point of daily) {
      totals.set(
        point.category,
        (totals.get(point.category) ?? 0) + Number(point.billed_usd),
      );
    }
    return categories.filter((c) => Math.abs(totals.get(c) ?? 0) > 0.005);
  }, [daily, categories]);

  const hasFilter = activeKeys.length > 0;
  const shownCategories = hasFilter
    ? fundedCategories.filter((c) => activeKeys.includes(c))
    : fundedCategories;

  const rows = useMemo(
    () => pivot(daily, fundedCategories, currency),
    [daily, fundedCategories, currency],
  );

  function toggle(category: string) {
    setActiveKeys((prev) =>
      prev.includes(category)
        ? prev.filter((c) => c !== category)
        : [...prev, category],
    );
  }

  return (
    <section className="claudeTableCard gcpTimeline">
      <div className="gcpTimelineHeader">
        <div className="gcpTimelineTitleGroup">
          <h2 className="claudeTableTitle">Custo ao longo do tempo</h2>
          <span className="gcpTimelineHint">
            {hasFilter
              ? "Filtrado — clique para limpar"
              : "Empilhado por categoria · clique na legenda para filtrar"}
          </span>
        </div>
        <div className="gcpTimelineControls">
          <div className="gcpServiceTabs">
            {CURRENCY_OPTIONS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`gcpServiceTab${
                  currency === c.key ? " gcpServiceTabActive" : ""
                }`}
                onClick={() => setCurrency(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <defs>
            {shownCategories.map((category) => {
              const color = colorFor.get(category) ?? PALETTE[0];
              return (
                <linearGradient
                  key={category}
                  id={gradId(category)}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="5%" stopColor={color} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              );
            })}
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
            tickFormatter={(v) => formatTick(Number(v), currency)}
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
              name,
            ]}
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
          {shownCategories.map((category) => {
            const color = colorFor.get(category) ?? PALETTE[0];
            return (
              <Area
                key={category}
                type="monotone"
                dataKey={category}
                stackId="cost"
                stroke={color}
                strokeWidth={1.5}
                fill={`url(#${gradId(category)})`}
                activeDot={{ r: 3, fill: color, strokeWidth: 0 }}
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>

      {fundedCategories.length > 0 ? (
        <div className="chartLegend chartLegendFilterable">
          {fundedCategories.map((category) => {
            const isSelected = activeKeys.includes(category);
            const isActive = !hasFilter || isSelected;
            return (
              <button
                key={category}
                type="button"
                className={`chartLegendItem chartLegendItemFilter ${
                  isActive
                    ? "chartLegendItemFilterOn"
                    : "chartLegendItemFilterOff"
                }`}
                onClick={() => toggle(category)}
                aria-pressed={isSelected}
                aria-label={
                  isSelected
                    ? `Remover filtro de ${category}`
                    : `Filtrar gráfico por ${category}`
                }
              >
                <span
                  className="chartLegendDot"
                  style={{ backgroundColor: colorFor.get(category) }}
                  aria-hidden
                />
                <span>{category}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
