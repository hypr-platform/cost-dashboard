"use client";

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { monoFor } from "./PlatformResendCard";

/** Soft Resend palette — used for all deep-dive charts. */
export const RESEND_CHART_COLORS: Record<string, string> = {
  DV360: "#6FCF73",
  Xandr: "#F87171",
  StackAdapt: "#A085FF",
  Nexd: "#5DB3F0",
  NEXD: "#5DB3F0",
  Hivestack: "#F06A99",
  Amazon: "#F2A93B",
  "Amazon DSP": "#F2A93B",
  Total: "#A1A1A1",
};

const BRL_INT = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });

const formatBrlValue = (value: number) => {
  if (!Number.isFinite(value)) return "R$ 0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const mi = value / 1_000_000;
    return `R$ ${mi.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}M`;
  }
  if (abs >= 10_000) {
    const k = value / 1_000;
    return `R$ ${k.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k`;
  }
  return `R$ ${BRL_INT.format(value)}`;
};

/** Compact total: R$ 75k, R$ 1,2M. Used in donut center. */
const formatCompactBrl = (value: number) => {
  if (!Number.isFinite(value)) return "R$ 0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const mi = value / 1_000_000;
    return `R$ ${mi.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}M`;
  }
  if (abs >= 1_000) {
    const k = value / 1_000;
    return `R$ ${k.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}k`;
  }
  return `R$ ${BRL_INT.format(value)}`;
};

const colorFor = (platform: string, fallback?: string) =>
  RESEND_CHART_COLORS[platform] ?? fallback ?? "#A1A1A1";

export type DeepDiveChartEntry = {
  platform: string;
  spend_brl: number;
  color?: string;
};

type ResendHbarsProps = {
  data: DeepDiveChartEntry[];
  total?: number;
  highlight?: string | null;
  onHighlight?: (platform: string | null) => void;
};

export function ResendHbars({
  data,
  total,
  highlight = null,
  onHighlight,
}: ResendHbarsProps) {
  const max = Math.max(...data.map((d) => d.spend_brl), 1);
  const sumTotal =
    typeof total === "number" && total > 0
      ? total
      : data.reduce((acc, item) => acc + item.spend_brl, 0);
  const interactive = typeof onHighlight === "function";
  return (
    <div
      className="resendHbars"
      onMouseLeave={interactive ? () => onHighlight?.(null) : undefined}
    >
      {data.map((entry) => {
        const pct = (entry.spend_brl / max) * 100;
        const sharePct = sumTotal > 0 ? (entry.spend_brl / sumTotal) * 100 : 0;
        const mono = monoFor(entry.platform);
        const color = colorFor(entry.platform, entry.color);
        const isHighlighted = highlight === entry.platform;
        const isDimmed = highlight !== null && !isHighlighted;
        return (
          <div
            className={`resendHbarRow${interactive ? " resendHbarRowInteractive" : ""}${isHighlighted ? " resendHbarRowHighlight" : ""}${isDimmed ? " resendHbarRowDim" : ""}`}
            key={entry.platform}
            onMouseEnter={
              interactive ? () => onHighlight?.(entry.platform) : undefined
            }
            onFocus={
              interactive ? () => onHighlight?.(entry.platform) : undefined
            }
            onBlur={interactive ? () => onHighlight?.(null) : undefined}
            tabIndex={interactive ? 0 : undefined}
            role={interactive ? "button" : undefined}
            aria-label={
              interactive
                ? `${entry.platform}: ${formatBrlValue(entry.spend_brl)}, ${sharePct.toFixed(1).replace(".", ",")}% do total`
                : undefined
            }
          >
            <span className="resendHbarLabel">
              <span className={`platformMono platformMono-${mono.tone}`}>
                {mono.code}
              </span>
              <span className="resendHbarName">{entry.platform}</span>
            </span>
            <div className="resendHbarTrack">
              <div
                className="resendHbarFill"
                style={{
                  width: `${Math.max(0, Math.min(100, pct))}%`,
                  background: color,
                  opacity: entry.spend_brl > 0 ? 1 : 0.2,
                }}
              />
            </div>
            <span className="resendHbarValue">
              {formatBrlValue(entry.spend_brl)}
              {interactive && sumTotal > 0 ? (
                <span className="resendHbarPct">
                  {sharePct.toFixed(1).replace(".", ",")}%
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ResendDonutProps = {
  data: DeepDiveChartEntry[];
  total: number;
  highlight: string | null;
  onHighlight: (platform: string | null) => void;
};

export function ResendDonut({
  data,
  total,
  highlight,
  onHighlight,
}: ResendDonutProps) {
  const r = 56;
  const c = 2 * Math.PI * r;
  const cx = 70;
  const cy = 70;
  const safeTotal = total > 0 ? total : 1;
  const segments = data.reduce<
    { entry: DeepDiveChartEntry; len: number; offset: number }[]
  >((acc, entry) => {
    const len = (entry.spend_brl / safeTotal) * c;
    const offset = acc.length ? acc[acc.length - 1].offset + acc[acc.length - 1].len : 0;
    acc.push({ entry, len, offset });
    return acc;
  }, []);
  return (
    <div className="resendDonutWrap">
      <div className="resendDonut" onMouseLeave={() => onHighlight(null)}>
        <svg viewBox="0 0 140 140" aria-hidden>
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="#161616"
            strokeWidth={14}
          />
          {segments.map(({ entry, len, offset }) => {
            const dasharray = `${len} ${c - len}`;
            const dashoffset = -offset;
            const dim = highlight !== null && highlight !== entry.platform;
            const color = colorFor(entry.platform, entry.color);
            return (
              <circle
                key={entry.platform}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={color}
                strokeWidth={14}
                strokeDasharray={dasharray}
                strokeDashoffset={dashoffset}
                opacity={dim ? 0.3 : 1}
                onMouseEnter={() => onHighlight(entry.platform)}
                style={{
                  transform: "rotate(-90deg)",
                  transformOrigin: "70px 70px",
                  transition: "opacity 0.15s ease",
                }}
              />
            );
          })}
        </svg>
        <div className="resendDonutCenter">
          <div className="resendDonutCenterLabel">Total</div>
          <div className="resendDonutCenterValue">
            {formatCompactBrl(total)}
          </div>
        </div>
      </div>
      <ul className="resendDonutLegend">
        {data.map((entry) => {
          const pct = total > 0 ? (entry.spend_brl / total) * 100 : 0;
          const dim = highlight !== null && highlight !== entry.platform;
          const color = colorFor(entry.platform, entry.color);
          return (
            <li
              key={entry.platform}
              className="resendDonutLegendRow"
              onMouseEnter={() => onHighlight(entry.platform)}
              onMouseLeave={() => onHighlight(null)}
              style={{ opacity: dim ? 0.4 : 1 }}
            >
              <span
                className="resendDonutLegendSwatch"
                style={{ background: color }}
                aria-hidden
              />
              <span className="resendDonutLegendName">{entry.platform}</span>
              <span className="resendDonutLegendPct">
                {pct.toFixed(1).replace(".", ",")}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type DailyRow = {
  date: string;
  total: number;
  [key: string]: string | number;
};

type ResendDailyLineProps = {
  rows: DailyRow[];
  platforms: string[];
  /** null = all platforms; otherwise restrict to that one. */
  focused: string | null;
  /** ISO yyyy-mm-dd. Anything <= it is "real"; > is forecast. */
  todayIso: string;
};

const formatYAxisTick = (value: number) => {
  if (value === 0) return "R$ 0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const m = value / 1_000_000;
    return `R$ ${m.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}M`;
  }
  if (abs >= 1_000) {
    const k = value / 1_000;
    return `R$ ${k.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k`;
  }
  return `R$ ${BRL_INT.format(value)}`;
};

const formatShortDate = (iso: string) => {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}`;
};

export function ResendDailyLine({
  rows,
  platforms,
  focused,
  todayIso,
}: ResendDailyLineProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(800);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        if (w > 0) setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 220;
  const PADDING_TOP = 12;
  const PADDING_RIGHT = 16;
  const PADDING_BOTTOM = 28;
  const PADDING_LEFT = 56;

  const W = Math.max(280, width);
  const innerW = Math.max(1, W - PADDING_LEFT - PADDING_RIGHT);
  const innerH = H - PADDING_TOP - PADDING_BOTTOM;

  const series = focused ? [focused] : platforms;

  let max = 0;
  for (const row of rows) {
    for (const p of series) {
      const v = Number(row[p] ?? 0);
      if (v > max) max = v;
    }
  }
  if (max <= 0) max = 1;

  const xFor = (i: number) =>
    rows.length <= 1
      ? PADDING_LEFT + innerW / 2
      : PADDING_LEFT + (i / (rows.length - 1)) * innerW;
  const yFor = (v: number) =>
    PADDING_TOP + innerH - (Math.min(Math.max(v, 0), max) / max) * innerH;

  let todayIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const d = String(rows[i].date).slice(0, 10);
    if (d <= todayIso) {
      todayIdx = i;
    } else {
      break;
    }
  }
  const lastRealIdx = todayIdx >= 0 ? todayIdx : rows.length - 1;

  const labelCount = Math.min(5, rows.length);
  const labelIdxs =
    labelCount <= 1
      ? rows.length
        ? [0]
        : []
      : Array.from({ length: labelCount }, (_, i) =>
          Math.round((i / (labelCount - 1)) * (rows.length - 1)),
        );

  const yTicks = [0, max / 2, max];

  const buildSegment = (platform: string, fromIdx: number, toIdx: number) => {
    if (fromIdx > toIdx || fromIdx < 0) return "";
    const cmds: string[] = [];
    for (let i = fromIdx; i <= toIdx; i++) {
      const v = Number(rows[i][platform] ?? 0);
      cmds.push(`${i === fromIdx ? "M" : "L"}${xFor(i).toFixed(2)} ${yFor(v).toFixed(2)}`);
    }
    return cmds.join(" ");
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (rows.length === 0) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const xPx = ((event.clientX - rect.left) / rect.width) * W;
    if (xPx < PADDING_LEFT - 12 || xPx > W - PADDING_RIGHT + 12) {
      setHoverIdx(null);
      return;
    }
    const t = (xPx - PADDING_LEFT) / Math.max(1, innerW);
    const clamped = Math.max(0, Math.min(1, t));
    const idx =
      rows.length <= 1 ? 0 : Math.round(clamped * (rows.length - 1));
    setHoverIdx(idx);
  };

  const handlePointerLeave = () => setHoverIdx(null);

  const activeIdx =
    hoverIdx !== null && hoverIdx >= 0 && hoverIdx < rows.length
      ? hoverIdx
      : null;
  const activeRow = activeIdx !== null ? rows[activeIdx] : null;
  const tooltipX = activeIdx !== null ? xFor(activeIdx) : 0;
  const tooltipLeftPct = W > 0 ? (tooltipX / W) * 100 : 50;
  const anchorRight = tooltipLeftPct > 65;
  const tooltipSeries = activeRow
    ? series
        .map((platform) => ({
          platform,
          value: Number(activeRow[platform] ?? 0),
          color: colorFor(platform),
        }))
        .sort((a, b) => b.value - a.value)
    : [];
  const tooltipTotal = activeRow
    ? series.reduce((acc, p) => acc + Number(activeRow[p] ?? 0), 0)
    : 0;
  const isForecast =
    activeIdx !== null && lastRealIdx >= 0 && activeIdx > lastRealIdx;

  return (
    <div ref={wrapperRef} className="dailyChartWrap">
      {rows.length > 0 ? (
        <svg
          ref={svgRef}
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="dailyChartSvg"
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
        >
          {yTicks.map((tick) => {
            const y = yFor(tick);
            return (
              <g key={`y-${tick}`}>
                <line
                  x1={PADDING_LEFT}
                  x2={W - PADDING_RIGHT}
                  y1={y}
                  y2={y}
                  stroke="#161616"
                  strokeWidth={1}
                />
                <text
                  x={PADDING_LEFT - 8}
                  y={y + 3.5}
                  className="dailyChartTick"
                  textAnchor="end"
                >
                  {formatYAxisTick(tick)}
                </text>
              </g>
            );
          })}

          {labelIdxs.map((idx) => {
            const x = xFor(idx);
            return (
              <text
                key={`x-${idx}`}
                x={x}
                y={H - PADDING_BOTTOM + 16}
                className="dailyChartTick"
                textAnchor="middle"
              >
                {formatShortDate(String(rows[idx].date).slice(0, 10))}
              </text>
            );
          })}

          {todayIdx > -1 && todayIdx < rows.length - 1 ? (
            <line
              x1={xFor(todayIdx)}
              x2={xFor(todayIdx)}
              y1={PADDING_TOP}
              y2={H - PADDING_BOTTOM}
              stroke="#3397B9"
              strokeWidth={1}
              strokeDasharray="2 3"
              opacity={0.45}
            />
          ) : null}

          {series.map((platform) => {
            const color = colorFor(platform);
            const pastPath = buildSegment(platform, 0, lastRealIdx);
            const futurePath =
              lastRealIdx < rows.length - 1
                ? buildSegment(platform, lastRealIdx, rows.length - 1)
                : "";
            return (
              <g key={platform}>
                {pastPath ? (
                  <path
                    d={pastPath}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : null}
                {futurePath ? (
                  <path
                    d={futurePath}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.25}
                    strokeDasharray="3 3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.5}
                  />
                ) : null}
              </g>
            );
          })}

          {activeIdx !== null ? (
            <g pointerEvents="none">
              <line
                x1={xFor(activeIdx)}
                x2={xFor(activeIdx)}
                y1={PADDING_TOP}
                y2={H - PADDING_BOTTOM}
                stroke="#a1a1a1"
                strokeWidth={1}
                strokeDasharray="2 2"
                opacity={0.55}
              />
              {series.map((platform) => {
                const v = Number(rows[activeIdx][platform] ?? 0);
                const color = colorFor(platform);
                return (
                  <circle
                    key={`dot-${platform}`}
                    cx={xFor(activeIdx)}
                    cy={yFor(v)}
                    r={3.5}
                    fill="#0f0f0f"
                    stroke={color}
                    strokeWidth={1.6}
                  />
                );
              })}
            </g>
          ) : null}
        </svg>
      ) : null}
      {activeRow ? (
        <div
          className={`dailyChartTooltip${anchorRight ? " dailyChartTooltipRight" : ""}`}
          style={{ left: `${tooltipLeftPct}%` }}
          role="tooltip"
        >
          <div className="dailyChartTooltipHeader">
            <span className="dailyChartTooltipDate">
              {formatShortDate(String(activeRow.date).slice(0, 10))}
            </span>
            {isForecast ? (
              <span className="dailyChartTooltipBadge">previsto</span>
            ) : null}
          </div>
          <ul className="dailyChartTooltipList">
            {tooltipSeries.map((item) => (
              <li
                key={item.platform}
                className="dailyChartTooltipRow"
              >
                <span
                  className="dailyChartTooltipSwatch"
                  style={{ background: item.color }}
                />
                <span className="dailyChartTooltipName">{item.platform}</span>
                <span className="dailyChartTooltipValue">
                  {formatBrlValue(item.value)}
                </span>
              </li>
            ))}
            {tooltipSeries.length > 1 ? (
              <li className="dailyChartTooltipRow dailyChartTooltipRowTotal">
                <span className="dailyChartTooltipSwatch dailyChartTooltipSwatchTotal" />
                <span className="dailyChartTooltipName">Total</span>
                <span className="dailyChartTooltipValue">
                  {formatBrlValue(tooltipTotal)}
                </span>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
