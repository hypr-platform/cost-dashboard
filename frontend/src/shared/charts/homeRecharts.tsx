"use client";

import type { CSSProperties, ReactNode } from "react";
import Image from "next/image";
import { PLATFORM_COLORS, PLATFORM_LOGOS } from "@/shared/constants/platform";

export const BRL_FORMATTER = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2,
});

export const BRL_INTEGER_FORMATTER = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});

export function brl(value: number) {
  return BRL_FORMATTER.format(value);
}

/** Converte #RGB / #RRGGBB em rgba() para borda/glow do tooltip alinhado à cor da barra. */
function hexToRgba(hex: string, alpha: number): string {
  const raw = hex.trim().replace("#", "");
  if (raw.length === 3) {
    const r = parseInt(raw[0] + raw[0], 16);
    const g = parseInt(raw[1] + raw[1], 16);
    const b = parseInt(raw[2] + raw[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (raw.length === 6) {
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return `rgba(100, 116, 139, ${alpha})`;
}

export function formatDonutCenterValue(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const millions = value / 1_000_000;
    return `R$ ${millions.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} mi`;
  }
  return BRL_INTEGER_FORMATTER.format(value);
}

export function formatCurrencyAxisTick(value: number | string) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "R$ 0";
  const abs = Math.abs(numeric);
  if (abs < 10_000) return brl(numeric);
  if (abs < 1_000_000) {
    const inThousands = numeric / 1_000;
    return `R$ ${inThousands.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k`;
  }
  const inMillions = numeric / 1_000_000;
  return `R$ ${inMillions.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}M`;
}

type NumberTooltipPayloadEntry = {
  value?: number | string;
  name?: string;
  color?: string;
  fill?: string;
  stroke?: string;
  payload?: unknown;
};

function tooltipEntryVisualColor(entry: NumberTooltipPayloadEntry, categoryLabel?: ReactNode): string {
  const nameKey = typeof entry.name === "string" ? entry.name.trim() : "";
  if (nameKey) {
    if (PLATFORM_COLORS[nameKey]) {
      return PLATFORM_COLORS[nameKey];
    }
    if (nameKey.toLowerCase() === "total" && PLATFORM_COLORS.Total) {
      return PLATFORM_COLORS.Total;
    }
  }
  const fromShape = entry.fill ?? entry.color ?? entry.stroke;
  if (typeof fromShape === "string" && fromShape && fromShape !== "none" && fromShape !== "transparent") {
    return fromShape;
  }
  const raw = entry.payload;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const p = raw as Record<string, unknown>;
    if (typeof p.color === "string" && p.color) {
      return p.color;
    }
    if (typeof p.platform === "string" && PLATFORM_COLORS[p.platform]) {
      return PLATFORM_COLORS[p.platform];
    }
  }
  if (categoryLabel != null && categoryLabel !== "") {
    const key = String(categoryLabel);
    if (PLATFORM_COLORS[key]) {
      return PLATFORM_COLORS[key];
    }
  }
  return "#64748b";
}

export function NumberTooltip({
  active,
  payload,
  label,
  totalValue,
  labelFormatter,
}: {
  active?: boolean;
  payload?: NumberTooltipPayloadEntry[];
  label?: ReactNode;
  totalValue?: number | null;
  labelFormatter?: (label: ReactNode) => ReactNode;
}) {
  if (!active || !payload?.length) {
    return null;
  }
  const resolvedLabel = labelFormatter && label != null && label !== "" ? labelFormatter(label) : label;
  const showLabel = resolvedLabel != null && resolvedLabel !== "";
  const accent = tooltipEntryVisualColor(payload[0], showLabel ? resolvedLabel : undefined);
  const shellStyle = {
    "--number-tooltip-border": hexToRgba(accent, 0.32),
    "--number-tooltip-glow": hexToRgba(accent, 0.2),
  } as CSSProperties;
  return (
    <div className="tooltipNumberShell" style={shellStyle}>
      {showLabel ? <div className="tooltipNumberLabel">{resolvedLabel}</div> : null}
      {payload.map((entry) => {
        const numericValue = Number(entry.value ?? 0);
        const pct = totalValue && totalValue > 0 ? (numericValue / totalValue) * 100 : null;
        const rowColor = tooltipEntryVisualColor(entry, showLabel ? resolvedLabel : undefined);
        return (
          <div key={`${entry.name}-${entry.value}`} className="tooltipNumberRow">
            <span className="tooltipNumberSwatch" style={{ backgroundColor: rowColor }} aria-hidden />
            <p className="tooltipNumberRowText">
              <span className="tooltipNumberRowName">{entry.name}</span>
              {": "}
              <span className="tooltipNumberRowAmount">{brl(numericValue)}</span>
              {pct !== null ? <span className="tooltipNumberRowPct"> ({pct.toFixed(1)}% do total)</span> : null}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export type PlatformLegendEntry = {
  value?: string | number;
  color?: string;
};

export function PlatformLegend({ payload }: { payload?: PlatformLegendEntry[] }) {
  if (!payload?.length) return null;
  return (
    <div className="chartLegend">
      {payload.map((entry) => {
        const name = String(entry.value ?? "");
        const seriesKey = name === "Total" ? "total" : name;
        const displayName = seriesKey === "total" ? "Total" : name;
        const logoSrc = PLATFORM_LOGOS[displayName];
        return (
          <div className="chartLegendItem" key={`${seriesKey}-${entry.color ?? "no-color"}`}>
            {logoSrc ? (
              <Image
                src={logoSrc}
                alt={`${displayName} logo`}
                width={24}
                height={24}
                className={`chartLegendLogo ${displayName === "Xandr" ? "cardLogoXandr" : ""} ${
                  displayName.startsWith("Amazon") ? "cardLogoAmazon" : ""
                } ${displayName === "Nexd" ? "cardLogoNexd" : ""}`}
              />
            ) : (
              <span className="chartLegendDot" style={{ backgroundColor: entry.color ?? "#64748b" }} />
            )}
            <span>{displayName}</span>
          </div>
        );
      })}
    </div>
  );
}

export function PlatformYAxisTick({
  x,
  y,
  payload,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string | number };
}) {
  if (x === undefined || y === undefined) return null;
  const platform = String(payload?.value ?? "");
  const logoSrc = PLATFORM_LOGOS[platform];
  const isAmazonLogo = platform.startsWith("Amazon");
  return (
    <g transform={`translate(${x},${y})`}>
      {logoSrc ? (
        <image
          href={logoSrc}
          x={isAmazonLogo ? -132 : -120}
          y={-10}
          width={isAmazonLogo ? 32 : 20}
          height={20}
          preserveAspectRatio="xMidYMid meet"
        />
      ) : (
        <circle cx={-111} cy={0} r={4} fill={PLATFORM_COLORS[platform] ?? "#64748b"} />
      )}
      <text x={-86} y={4} fill="#cbd5e1" fontSize={12} textAnchor="start">
        {platform}
      </text>
    </g>
  );
}

/** Legenda clicável do gráfico de custo diário / timeline (igual à home). */
export function DailyCostLegend({
  entries,
  activeKeys,
  onToggle,
}: {
  entries: PlatformLegendEntry[];
  activeKeys: string[];
  onToggle: (seriesKey: string) => void;
}) {
  if (!entries.length) return null;
  const hasFilter = activeKeys.length > 0;
  return (
    <div className="chartLegend chartLegendFilterable">
      {entries.map((entry) => {
        const name = String(entry.value ?? "");
        const seriesKey = name === "Total" ? "total" : name;
        const displayName = seriesKey === "total" ? "Total" : name;
        const logoSrc = PLATFORM_LOGOS[displayName];
        const isSelected = activeKeys.includes(seriesKey);
        const isActive = !hasFilter || isSelected;
        return (
          <button
            key={`${seriesKey}-${entry.color ?? "no-color"}`}
            type="button"
            className={`chartLegendItem chartLegendItemFilter ${
              isActive ? "chartLegendItemFilterOn" : "chartLegendItemFilterOff"
            }`}
            onClick={() => onToggle(seriesKey)}
            aria-pressed={isSelected}
            aria-label={
              isSelected ? `Remover filtro de ${displayName}` : `Filtrar gráfico por ${displayName}`
            }
          >
            {logoSrc ? (
              <Image
                src={logoSrc}
                alt=""
                width={24}
                height={24}
                className={`chartLegendLogo ${displayName === "Xandr" ? "cardLogoXandr" : ""} ${
                  displayName.startsWith("Amazon") ? "cardLogoAmazon" : ""
                } ${displayName === "Nexd" ? "cardLogoNexd" : ""}`}
              />
            ) : (
              <span className="chartLegendDot" style={{ backgroundColor: entry.color ?? "#64748b" }} aria-hidden />
            )}
            <span>{displayName}</span>
          </button>
        );
      })}
    </div>
  );
}
