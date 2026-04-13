"use client";

import { UserButton, useClerk, useUser } from "@clerk/nextjs";
import html2canvas from "html2canvas";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type JourneyRow = {
  token: string;
  cliente: string;
  campanha: string;
  account_management?: string;
  status: string;
  investido: number;
  total_plataformas: number;
  pct_investido: number;
  [platform: string]: string | number | undefined;
};

function rowCsLabel(row: JourneyRow): string {
  const s = String(row.account_management ?? "").trim();
  return s || "Sem CS";
}

type PlatformPageRow = {
  line: string;
  token: string;
  cliente: string;
  campanha: string;
  account_management: string;
  gasto: number;
  investido: number | null;
  pct_invest: number | null;
};

type StackAdaptSortKey =
  | "line"
  | "token"
  | "cliente"
  | "campanha"
  | "gasto"
  | "investido"
  | "pct_invest"
  | "total";
type StackAdaptSortDirection = "asc" | "desc";
type AttentionNoTokenSortKey = "platform" | "line" | "gasto";
type AttentionOutOfPeriodSortKey = "platform" | "token" | "cliente" | "campanha" | "account_management" | "vigencia" | "gasto";
type AttentionSortDirection = "asc" | "desc";

type BudgetData = {
  month_key: string;
  /** Percentuais 0–100 por plataforma (StackAdapt, DV360, Xandr); vindo do backend / env. */
  share_percent?: Partial<Record<string, number>>;
  general: {
    target_brl: number | null;
    spent_brl: number;
    progress_pct: number | null;
    remaining_brl: number | null;
  };
  platforms: Record<
    string,
    {
      target_brl: number | null;
      spent_brl: number;
      progress_pct: number | null;
      remaining_brl: number | null;
    }
  >;
};

type DashboardResponse = {
  period: { start: string; end: string };
  exchange_rate_usd_brl: number;
  total_brl: number;
  journey_status?: string;
  journey_message?: string;
  platform_results: Record<
    string,
    {
      status: "ok" | "error" | "no_credentials";
      message?: string;
      spend?: number;
      currency?: "USD" | "BRL";
      daily?: { date: string; spend: number }[];
      lines?: { name: string; spend: number }[];
    }
  >;
  dashboard: {
    spend_by_platform: { platform: string; spend_brl: number }[];
    daily: Array<{ date: string; total: number; [platform: string]: string | number }>;
    campaign_journey_rows: JourneyRow[];
    active_platforms: string[];
  };
  platform_pages: Record<
    string,
    {
      spend_brl: number;
      spend_usd?: number;
      currency?: "USD" | "BRL";
      rows?: PlatformPageRow[];
      impressions?: number;
      cap?: number;
      pct_cap?: number;
      campaigns?: { name: string; impressions: number }[];
      layouts?: {
        layout: string;
        impressions: number;
        creatives?: number;
        estimated_cost_brl?: number;
        pct_estimated_cost?: number;
      }[];
    }
  >;
  attention: {
    no_token_rows: { platform: string; line: string; gasto: number }[];
    no_token_total_brl: number;
    out_of_period_rows: {
      platform: string;
      token: string;
      line: string;
      cliente: string;
      campanha: string;
      account_management: string;
      vigencia_start: string | null;
      vigencia_end: string | null;
      gasto: number;
    }[];
    out_of_period_total_brl: number;
  };
  budget: BudgetData;
  nexd?: {
    status: "ok" | "error" | "no_credentials";
    message?: string;
    impressions?: number;
    cap?: number;
  };
  _meta?: {
    snapshot_at?: string;
    source?: string;
    cache_ttl_seconds?: number;
  };
};

type RefreshStatusResponse = {
  running?: boolean;
  run_id?: string | null;
  trigger?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  status?: string;
  error?: string | null;
};

type RefreshMetricsResponse = {
  window_hours: number;
  trigger: string;
  sample_size: number;
  avg_duration_seconds: number | null;
  p50_duration_seconds: number | null;
  p95_duration_seconds: number | null;
};

const PLATFORM_COLORS: Record<string, string> = {
  "StackAdapt": "#3b82f6",
  DV360: "#22c55e",
  Xandr: "#ef4444",
  "Amazon DSP": "#22c55e",
  Nexd: "#89cff0",
  Hivestack: "#e31c79",
  Total: "#ffffff",
};
const PLATFORM_LOGOS: Record<string, string> = {
  "StackAdapt": "/stackadapt-logo.png",
  DV360: "/dv360-logo.png",
  Xandr: "/xandr-logo-transparent.png",
  Amazon: "/amazon-logo.png",
  "Amazon DSP": "/amazon-logo.png",
  Nexd: "/nexd-logo.png",
  Hivestack: "/hivestack-logo.png",
};
const ACCOUNT_MANAGER_AVATARS: Record<string, string> = {
  "João Buzolin": "/account-managers/joao-buzolin.png",
  "Isaac Agiman": "/account-managers/isaac-agiman.png",
  "João Armelin": "/account-managers/joao-armelin.png",
  "Mariana Lewinski": "/account-managers/mariana-lewinski.png",
  "Beatriz Severine": "/account-managers/beatriz-severine.png",
  "Thiago Nascimento": "/account-managers/thiago-nascimento.png",
};
const ACCOUNT_MANAGER_WHATSAPP_NUMBERS: Record<string, string> = {
  "Isaac Agiman": "5511940764937",
  "João Buzolin": "5519996301552",
  "Joao Buzolin": "5519996301552",
  "João Armelin": "5511971400912",
  "Joao Armelin": "5511971400912",
  "Mariana Lewinski": "5511981298990",
  "Maiana Lewinski": "5511981298990",
  "Beatriz Severine": "5511963340543",
  "Thiago Nascimento": "5511948887830",
};
const FALLBACK_WHATSAPP_NUMBER = "5511999999999";

function getDspFilterLogoSrc(platform: string): string | undefined {
  const p = platform.trim();
  if (!p || p === "Outros") return undefined;
  if (PLATFORM_LOGOS[p]) return PLATFORM_LOGOS[p];
  if (p.startsWith("Amazon")) return PLATFORM_LOGOS["Amazon DSP"];
  return undefined;
}

function getAccountManagerAvatar(name: string | null | undefined): string | undefined {
  const key = (name ?? "").trim();
  if (!key) return undefined;
  return ACCOUNT_MANAGER_AVATARS[key];
}

function getAccountManagerWhatsAppUrl(
  name: string | null | undefined,
  context: {
    campanha: string;
    token: string;
    platform: string;
    vigencia_start: string | null;
    vigencia_end: string | null;
  }
): string {
  const managerName = (name ?? "").trim() || "time";
  const rawPhone = ACCOUNT_MANAGER_WHATSAPP_NUMBERS[managerName] ?? FALLBACK_WHATSAPP_NUMBER;
  const digitsOnly = rawPhone.replace(/\D/g, "");
  const vigenciaText = `${formatDateBr(context.vigencia_start)} até ${formatDateBr(context.vigencia_end)}`;
  const text = encodeURIComponent(
    `Oi ${managerName}, tudo bem? ` +
      `Sua campanha ${context.campanha} (token ${context.token}), na DSP ${context.platform}, ` +
      `está com a vigência fora do mês atual (${vigenciaText}). ` +
      `Pode revisar por favor?`
  );
  return `https://wa.me/${digitsOnly}?text=${text}`;
}

function getCampaignReferenceWhatsAppUrl(
  name: string | null | undefined,
  context: {
    campanha: string;
    token: string;
    platform?: string;
    line?: string;
  }
): string {
  const managerName = (name ?? "").trim() || "time";
  const rawPhone = ACCOUNT_MANAGER_WHATSAPP_NUMBERS[managerName] ?? FALLBACK_WHATSAPP_NUMBER;
  const digitsOnly = rawPhone.replace(/\D/g, "");
  const details = [
    `campanha ${context.campanha}`,
    `token ${context.token}`,
    context.platform ? `DSP ${context.platform}` : "",
    context.line ? `line ${context.line}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const text = encodeURIComponent(
    `Oi ${managerName}, tudo bem? Esta mensagem é referente à ${details}. Pode revisar por favor?`
  );
  return `https://wa.me/${digitsOnly}?text=${text}`;
}

const GENERAL_BUDGET_KEY = "__general__";
/** Fallback se o payload não trouxer share_percent (ex.: cache antigo). Igual aos padrões do backend. */
const DEFAULT_INVESTMENT_SHARE_PERCENT: Record<string, number> = {
  StackAdapt: 30,
  DV360: 50,
  Xandr: 13,
};
const URL_PARAM_STACK_SEARCH = "sa_q";
const URL_PARAM_STACK_NO_TOKEN_ONLY = "sa_no_token";
const URL_PARAM_STACK_SORT = "sa_sort";
const URL_PARAM_NO_TOKEN_SEARCH = "nt_q";
const URL_PARAM_NO_TOKEN_SORT = "nt_sort";
const URL_PARAM_NO_TOKEN_DSPS = "nt_dsps";
const URL_PARAM_OUT_SEARCH = "oop_q";
const URL_PARAM_OUT_SORT = "oop_sort";
const URL_PARAM_OUT_DSPS = "oop_dsps";
const URL_PARAM_CLIENTS = "clients";
const URL_PARAM_CS = "cs";
const URL_PARAM_CAMPAIGNS = "campaigns";
const URL_PARAM_CAMPAIGN_STATUS = "campaign_status";
/** Filtro por padrão no nome da campanha (Survey / RMNf / AON). */
const URL_PARAM_CAMPAIGN_TYPE = "tipo";
const URL_PARAM_MONTH = "month";
const CAMPAIGN_TYPE_OPTIONS = ["Survey", "RMNf", "AON"] as const;
const MONTH_KEY_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function campaignNameMatchesTypeOption(campanha: string, typeOption: string): boolean {
  const name = String(campanha ?? "").trim();
  const upper = name.toUpperCase();
  if (typeOption === "Survey") {
    return upper.endsWith("SURVEY") || upper.endsWith("SURVERY");
  }
  if (typeOption === "RMNf") {
    return upper.endsWith("RMNF");
  }
  if (typeOption === "AON") {
    return upper.startsWith("AON");
  }
  return false;
}

function rowMatchesCampaignTypes(campanha: string, selectedTypes: string[]): boolean {
  if (!selectedTypes.length) return true;
  return selectedTypes.some((t) => campaignNameMatchesTypeOption(campanha, t));
}
const BRL_FORMATTER = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2,
});
const BRL_INTEGER_FORMATTER = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});

type NavKey =
  | "Dashboard"
  | "⚠️ Lines sem token"
  | "🚨 Gasto fora do mês vigente"
  | "Nexd"
  | "StackAdapt"
  | "DV360"
  | "Xandr"
  | "Amazon DSP";

const NAV_LABELS: Record<NavKey, string> = {
  Dashboard: "DeepDive Dsps",
  "⚠️ Lines sem token": "⚠️ Lines sem token",
  "🚨 Gasto fora do mês vigente": "🚨 Gasto fora do mês vigente",
  Nexd: "Nexd",
  StackAdapt: "StackAdapt",
  DV360: "DV360",
  Xandr: "Xandr",
  "Amazon DSP": "Amazon DSP",
};

const PAGE_TO_SLUG: Record<Exclude<NavKey, "Dashboard">, string> = {
  "⚠️ Lines sem token": "lines-sem-token",
  "🚨 Gasto fora do mês vigente": "gasto-fora-mes-vigente",
  Nexd: "nexd",
  StackAdapt: "stack-adapt",
  DV360: "dv360",
  Xandr: "xandr",
  "Amazon DSP": "amazon-dsp",
};
const SLUG_TO_PAGE: Record<string, Exclude<NavKey, "Dashboard">> = {
  atencao: "⚠️ Lines sem token",
  "lines-sem-token": "⚠️ Lines sem token",
  "gasto-fora-mes-vigente": "🚨 Gasto fora do mês vigente",
  nexd: "Nexd",
  "stack-adapt": "StackAdapt",
  dv360: "DV360",
  xandr: "Xandr",
  "amazon-dsp": "Amazon DSP",
};

function routeForPage(page: NavKey) {
  if (page === "Dashboard") return "/";
  return `/${PAGE_TO_SLUG[page]}`;
}

function routeForCampaign(token: string, sourcePage?: NavKey) {
  const baseRoute = `/campaign/${encodeURIComponent(token)}`;
  if (!sourcePage || sourcePage === "Dashboard") return baseRoute;
  const sourceSlug = PAGE_TO_SLUG[sourcePage];
  return `${baseRoute}?source=${encodeURIComponent(sourceSlug)}`;
}

function hasCampaignToken(token: string | null | undefined) {
  const normalized = (token ?? "").trim();
  if (!normalized || normalized === "—" || normalized === "-") return false;
  return normalized.toLowerCase() !== "sem token";
}

function journeySnapshotForPlatformRow(
  row: PlatformPageRow,
  journeyByToken: Map<string, JourneyRow>
): JourneyRow {
  const t = String(row.token ?? "").trim();
  const journey = t && hasCampaignToken(t) ? journeyByToken.get(t) : undefined;
  return {
    token: row.token,
    cliente: row.cliente,
    campanha: row.campanha,
    account_management: row.account_management,
    status: journey?.status ?? "",
    investido: Number(journey?.investido ?? row.investido ?? 0),
    total_plataformas: Number(journey?.total_plataformas ?? 0),
    pct_investido: Number(journey?.pct_investido ?? 0),
  } as JourneyRow;
}

const fetcher = async (url: string) => {
  const timeoutMs = 45000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error("Falha ao carregar dados do backend.");
    }
    return response.json() as Promise<DashboardResponse>;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Timeout ao carregar dados. Tente novamente.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
};

function brl(value: number) {
  return BRL_FORMATTER.format(value);
}

function formatDonutCenterValue(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const millions = value / 1_000_000;
    return `R$ ${millions.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} mi`;
  }
  return BRL_INTEGER_FORMATTER.format(value);
}

function formatCurrencyAxisTick(value: number | string) {
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

function formatDateBr(value: string | null | undefined) {
  if (!value) return "?";
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  }
  return value;
}

function parseCsvList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => {
      try {
        return decodeURIComponent(item).trim();
      } catch {
        return item.trim();
      }
    })
    .filter(Boolean);
}

function stringifyCsvList(values: string[]): string | null {
  if (!values.length) return null;
  return values.map((value) => encodeURIComponent(value)).join(",");
}

function isValidMonthKey(value: string | null | undefined): value is string {
  if (!value) return false;
  return MONTH_KEY_REGEX.test(value.trim());
}

function getCurrentMonthKey(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

function monthKeyToDateRange(monthKey: string): { start: string; end: string } {
  const [yearRaw, monthRaw] = monthKey.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${yearRaw}-${monthRaw}-01`,
    end: `${yearRaw}-${monthRaw}-${String(lastDay).padStart(2, "0")}`,
  };
}

function buildRecentMonthKeys(count: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    keys.push(`${date.getFullYear()}-${month}`);
  }
  return keys;
}

function formatMonthKeyLabel(monthKey: string): string {
  const [yearRaw, monthRaw] = monthKey.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return monthKey;
  return new Date(year, month - 1, 1).toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
  });
}

function csvEscape(value: string | number | null | undefined): string {
  const normalized = String(value ?? "");
  if (!normalized.includes('"') && !normalized.includes(",") && !normalized.includes("\n")) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  const lines = [headers.map(csvEscape).join(","), ...rows.map((row) => row.map(csvEscape).join(","))];
  const csvContent = `\uFEFF${lines.join("\n")}`;
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function downloadElementPng(element: HTMLElement, filename: string) {
  const canvas = await html2canvas(element, {
    scale: 2,
    backgroundColor: "#0b1220",
    useCORS: true,
    allowTaint: true,
    logging: false,
  });
  const dataUrl = canvas.toDataURL("image/png");
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function parseStackSortParam(value: string | null): { key: StackAdaptSortKey; direction: StackAdaptSortDirection } {
  const [keyRaw, directionRaw] = (value ?? "").split(":");
  const key = keyRaw as StackAdaptSortKey;
  const direction = directionRaw as StackAdaptSortDirection;
  const validKeys: StackAdaptSortKey[] = ["line", "token", "cliente", "campanha", "gasto", "investido", "pct_invest", "total"];
  if (!validKeys.includes(key)) return { key: "gasto", direction: "desc" };
  return { key, direction: direction === "asc" ? "asc" : "desc" };
}

function parseNoTokenSortParam(value: string | null): { key: AttentionNoTokenSortKey; direction: AttentionSortDirection } {
  const [keyRaw, directionRaw] = (value ?? "").split(":");
  const key = keyRaw as AttentionNoTokenSortKey;
  const direction = directionRaw as AttentionSortDirection;
  const validKeys: AttentionNoTokenSortKey[] = ["platform", "line", "gasto"];
  if (!validKeys.includes(key)) return { key: "gasto", direction: "desc" };
  return { key, direction: direction === "asc" ? "asc" : "desc" };
}

function parseOutOfPeriodSortParam(
  value: string | null
): { key: AttentionOutOfPeriodSortKey; direction: AttentionSortDirection } {
  const [keyRaw, directionRaw] = (value ?? "").split(":");
  const key = keyRaw as AttentionOutOfPeriodSortKey;
  const direction = directionRaw as AttentionSortDirection;
  const validKeys: AttentionOutOfPeriodSortKey[] = ["platform", "token", "cliente", "campanha", "account_management", "vigencia", "gasto"];
  if (!validKeys.includes(key)) return { key: "gasto", direction: "desc" };
  return { key, direction: direction === "asc" ? "asc" : "desc" };
}

function NumberTooltip({
  active,
  payload,
  label,
  totalValue,
}: {
  active?: boolean;
  payload?: Array<{ value: number | string; name: string; color?: string }>;
  label?: string;
  totalValue?: number | null;
}) {
  if (!active || !payload?.length) {
    return null;
  }
  return (
    <div className="tooltip">
      {label ? <p>{label}</p> : null}
      {payload.map((entry) => {
        const numericValue = Number(entry.value ?? 0);
        const pct = totalValue && totalValue > 0 ? (numericValue / totalValue) * 100 : null;
        return (
          <p key={`${entry.name}-${entry.value}`} style={{ color: entry.color ?? "#d1d5db" }}>
            {entry.name}: {brl(numericValue)}
            {pct !== null ? ` (${pct.toFixed(1)}% do total)` : ""}
          </p>
        );
      })}
    </div>
  );
}

type PlatformLegendEntry = {
  value?: string | number;
  color?: string;
};

function PlatformLegend({ payload }: { payload?: PlatformLegendEntry[] }) {
  if (!payload?.length) return null;
  return (
    <div className="chartLegend">
      {payload.map((entry) => {
        const name = String(entry.value ?? "");
        const displayName = name === "total" ? "Total" : name;
        const logoSrc = PLATFORM_LOGOS[displayName];
        return (
          <div className="chartLegendItem" key={`${name}-${entry.color ?? "no-color"}`}>
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

function AttentionDspFilterChipButton({
  platform,
  pressed,
  onClick,
}: {
  platform: string;
  pressed: boolean;
  onClick: () => void;
}) {
  const logoSrc = getDspFilterLogoSrc(platform);
  return (
    <button
      type="button"
      className={`chip chipDspFilter chipDspFilterWithLogo ${pressed ? "chipDspFilterOn" : ""}`}
      onClick={onClick}
    >
      {logoSrc ? (
        <Image
          src={logoSrc}
          alt=""
          width={18}
          height={18}
          className={`chipDspFilterLogo ${platform === "Xandr" ? "cardLogoXandr" : ""} ${
            platform.startsWith("Amazon") ? "cardLogoAmazon" : ""
          } ${platform === "Nexd" ? "cardLogoNexd" : ""}`}
        />
      ) : (
        <span
          className="chipDspFilterLogoDot"
          style={{ backgroundColor: PLATFORM_COLORS[platform] ?? "#64748b" }}
 aria-hidden
        />
      )}
      <span>{platform}</span>
    </button>
  );
}

function PlatformYAxisTick({
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

function KpiCard({
  title,
  value,
  subtitle,
  badge,
  badgeTone,
  statusIndicator,
  dimmed,
  titleEmphasis,
  logoSrc,
  budget,
  variant,
  href,
}: {
  title: string;
  value: string;
  subtitle: ReactNode;
  badge?: string;
  badgeTone?: "soon";
  statusIndicator?: { label: string; tone: "success" | "danger" | "neutral" };
  dimmed?: boolean;
  titleEmphasis?: boolean;
  logoSrc?: string;
  budget?: {
    target_brl: number | null;
    spent_brl: number;
    progress_pct: number | null;
    remaining_brl: number | null;
    investment_share_pct?: number | null;
  };
  variant?: "default" | "premium";
  href?: string;
}) {
  const router = useRouter();
  const progress = budget?.progress_pct ?? 0;
  const progressClamped = Math.max(0, Math.min(progress, 100));
  const isOverTarget = progress > 100;
  const hasBudgetTarget = budget?.target_brl !== null && budget?.target_brl !== undefined;
  const investmentSharePct = budget?.investment_share_pct;

  const go = () => {
    if (href) router.push(href);
  };

  return (
    <div
      className={`card ${dimmed ? "cardDimmed" : ""} ${variant === "premium" ? "cardPremium" : ""} ${href ? "cardClickable" : ""}`}
      role={href ? "link" : undefined}
      tabIndex={href ? 0 : undefined}
      aria-label={href ? `Abrir ${title}` : undefined}
      onClick={href ? go : undefined}
      onKeyDown={
        href
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                go();
              }
            }
          : undefined
      }
    >
      {badge ? (
        <p className={`cardBadge ${badgeTone === "soon" ? "cardBadgeSoon" : ""}`}>
          {badgeTone === "soon" ? <span className="cardBadgeSoonDot" aria-hidden="true" /> : null}
          {badge}
        </p>
      ) : null}
      <div className="cardHeader">
        {logoSrc ? (
          <Image
            src={logoSrc}
            alt={`${title} logo`}
            width={28}
            height={28}
            className={`cardLogo ${title === "Xandr" ? "cardLogoXandr" : ""} ${title.startsWith("Amazon") ? "cardLogoAmazon" : ""} ${
              title.toUpperCase() === "NEXD" ? "cardLogoNexd" : ""
            } ${title === "Hivestack" ? "cardLogoHivestack" : ""}`}
          />
        ) : null}
        <p className={`cardTitle ${titleEmphasis ? "cardTitleEmphasis" : ""}`}>{title}</p>
        {statusIndicator ? (
          <span className={`cardStatusIndicator cardStatusIndicator${statusIndicator.tone}`}>
            <span className="cardStatusDot" aria-hidden="true" />
            {statusIndicator.label}
          </span>
        ) : null}
      </div>
      <p className="cardValue">{value}</p>
      <p className="cardSubtitle">{subtitle}</p>
      {budget && hasBudgetTarget ? (
        <div className="cardBudgetSlot">
          <div className="cardBudget">
            <p className="cardBudgetTargetLine">
              <span className="cardBudgetTargetLabel">Alvo de Share de Investimento</span>
              <span className="cardBudgetTargetValue">
                {brl(budget.target_brl ?? 0)}
                {investmentSharePct != null && Number.isFinite(investmentSharePct)
                  ? ` (${Number(investmentSharePct).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%)`
                  : ""}
              </span>
            </p>
            <div className="budgetProgressTrack budgetProgressTrackCard">
              <div
                className={`budgetProgressFill ${isOverTarget ? "budgetProgressFillOver" : ""}`}
                style={{ width: `${progressClamped}%` }}
              />
            </div>
            <p className={`cardBudgetText ${isOverTarget ? "alertErrorInline" : ""}`}>
              {isOverTarget
                ? `Budget extrapolado em ${((budget.progress_pct ?? 0) - 100).toFixed(1)}% (${brl(
                    Math.abs(budget.remaining_brl ?? 0)
                  )})`
                : `${(budget.progress_pct ?? 0).toFixed(1)}% • Restante: ${brl(budget.remaining_brl ?? 0)}`}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MultiSelectFilter({
  id,
  label,
  options,
  value,
  onChange,
  placeholder = "Todos",
  showAvatar = false,
  disabledOptions,
}: {
  id: string;
  label: string;
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  showAvatar?: boolean;
  disabledOptions?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectedOptions = options.filter((opt) => value.includes(opt));
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = useMemo(() => {
    if (!normalizedQuery) return options;
    return options.filter((opt) => opt.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, options]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const id = window.setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const summary =
    value.length === 0 ? placeholder : value.length === 1 ? value[0] : `${value.length} selecionados`;

  const isOptionDisabled = (opt: string) => Boolean(disabledOptions?.has(opt) && !value.includes(opt));

  const toggle = (opt: string) => {
    if (isOptionDisabled(opt)) return;
    if (value.includes(opt)) onChange(value.filter((x) => x !== opt));
    else onChange([...value, opt]);
  };
  const removeSelected = (opt: string) => onChange(value.filter((x) => x !== opt));
  const clearAll = () => onChange([]);

  const initialsFor = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("");

  return (
    <div className="filterField" ref={rootRef}>
      <label htmlFor={`${id}-trigger`} className="filterFieldLabel">
        {label}
      </label>
      <button
        type="button"
        id={`${id}-trigger`}
        className="multiSelectTrigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!options.length}
        onClick={() => options.length && setOpen((o) => !o)}
      >
        <span className="multiSelectTriggerMain">
          {showAvatar && selectedOptions.length > 0 ? (
            <span className="multiSelectSelectedAvatars" aria-hidden>
              {selectedOptions.slice(0, 3).map((opt) => {
                const avatar = getAccountManagerAvatar(opt);
                return avatar ? (
                  <Image key={opt} src={avatar} alt="" width={20} height={20} className="multiSelectAvatarThumb" />
                ) : (
                  <span key={opt} className="multiSelectAvatarFallbackThumb">
                    {initialsFor(opt)}
                  </span>
                );
              })}
            </span>
          ) : null}
          <span className="multiSelectTriggerLabel">{!options.length ? "Sem opções" : summary}</span>
        </span>
        <span className="multiSelectChevron" aria-hidden>
          {"\u25BC"}
        </span>
      </button>
      {selectedOptions.length ? (
        <div className="multiSelectChipsRow">
          <div className="multiSelectChips" aria-label={`Filtros selecionados para ${label}`}>
            {selectedOptions.map((opt) => (
              <button
                key={`${id}-chip-${opt}`}
                type="button"
                className="multiSelectChip"
                onClick={() => removeSelected(opt)}
                aria-label={`Remover ${opt}`}
              >
                <span>{opt}</span>
                <span className="multiSelectChipX" aria-hidden>
                  ×
                </span>
              </button>
            ))}
          </div>
          <button type="button" className="multiSelectClearAllButton" onClick={clearAll}>
            Limpar tudo
          </button>
        </div>
      ) : null}
      {open && options.length ? (
        <ul className="multiSelectList" role="listbox" aria-multiselectable="true">
          <li className="multiSelectSearchRow">
            <input
              ref={searchInputRef}
              type="text"
              className="multiSelectSearchInput"
              placeholder="Buscar..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {selectedOptions.length ? (
              <button type="button" className="multiSelectClearInlineButton" onClick={clearAll}>
                Limpar tudo
              </button>
            ) : null}
          </li>
          {visibleOptions.length ? visibleOptions.map((opt) => {
            const selected = value.includes(opt);
            const disabled = isOptionDisabled(opt);
            return (
            <li key={opt} role="option" aria-selected={selected} aria-disabled={disabled || undefined}>
              <label className={`multiSelectOption ${disabled ? "multiSelectOptionDisabled" : ""}`}>
                <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggle(opt)} />
                {showAvatar
                  ? getAccountManagerAvatar(opt)
                    ? (
                      <Image
                        src={getAccountManagerAvatar(opt)!}
                        alt=""
                        width={24}
                        height={24}
                        className="multiSelectOptionAvatar"
                      />
                    )
                    : (
                      <span className="multiSelectOptionAvatarFallback">{initialsFor(opt)}</span>
                    )
                  : null}
                <span>{opt}</span>
              </label>
            </li>
          );}) : (
            <li className="multiSelectEmptyState">Nenhum resultado encontrado.</li>
          )}
        </ul>
      ) : null}
    </div>
  );
}

function formatAge(from: number | null) {
  if (!from) return "";
  const diff = Math.floor((Date.now() - from) / 1000);
  const minutes = Math.floor(diff / 60);
  if (minutes <= 0) return "Atualizado há menos de 1min";
  return `Atualizado há ${minutes}min`;
}

function formatDateTime(value: number) {
  return new Date(value).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  if (minutes <= 0) return `${remainder}s`;
  return `${minutes}min ${String(remainder).padStart(2, "0")}s`;
}

function ReloadIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      className={`buttonIcon ${spinning ? "buttonIconSpinning" : ""}`}
    >
      <path
        d="M20 12a8 8 0 1 1-2.34-5.66"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M20 4v5h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" className="cardTextButtonEyeIcon">
      <path
        d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.7-1.2A9 9 0 1 0 12 3Zm0 16.3a7.2 7.2 0 0 1-3.7-1l-.3-.2-2.8.7.7-2.7-.2-.3A7.3 7.3 0 1 1 12 19.3Z"
        fill="currentColor"
      />
      <path
        d="M16.3 13.8c-.2-.1-1.1-.5-1.2-.6-.2-.1-.3-.1-.4.1-.1.2-.5.6-.6.7-.1.1-.2.2-.4.1a5.7 5.7 0 0 1-1.7-1.1 6.3 6.3 0 0 1-1.2-1.5c-.1-.2 0-.3.1-.4.1-.1.2-.2.3-.3.1-.1.1-.2.2-.3 0-.1 0-.2 0-.3 0-.1-.4-1.1-.6-1.5-.1-.3-.3-.2-.4-.2h-.4c-.1 0-.3.1-.4.2-.1.1-.6.5-.6 1.3s.6 1.6.6 1.7c.1.1 1.2 2 3 2.7.4.2.8.3 1.1.4.5.2 1 .1 1.4.1.4-.1 1.1-.4 1.3-.8.2-.4.2-.7.1-.8-.1-.1-.2-.1-.4-.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function DashboardSkeleton() {
  return (
    <main className="appLayout">
      <aside className="sidebar">
        <div>
          <div className="skeleton skeletonText skeletonTitle" />
          <div className="skeleton skeletonText skeletonSubtitle" />
        </div>

        <nav className="sidebarNav" aria-label="Carregando navegação">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={`nav-skeleton-${idx}`} className="skeleton skeletonNavItem" />
          ))}
        </nav>

      </aside>

      <section className="content">
        <header className="header">
          <div>
            <div className="skeleton skeletonText skeletonEyebrow" />
            <div className="skeleton skeletonText skeletonHeading" />
            <div className="skeleton skeletonText skeletonSubtitleLarge" />
          </div>
          <div className="headerActions">
            <div className="skeleton skeletonButtonWide" />
            <div className="skeleton skeletonText skeletonSubtitle" />
            <div className="skeleton skeletonText skeletonSubtitle" />
          </div>
        </header>

        <section className="gridCards homeDspRow">
          {Array.from({ length: 3 }).map((_, idx) => (
            <div key={`kpi-row1-skeleton-${idx}`} className="card skeleton skeletonBlock skeletonCard" />
          ))}
        </section>
        <section className="gridCards homeSummaryRow">
          {Array.from({ length: 3 }).map((_, idx) => (
            <div key={`kpi-row2-skeleton-${idx}`} className="card skeleton skeletonBlock skeletonCard" />
          ))}
        </section>
        <section className="gridCards homeAlertsRow">
          {Array.from({ length: 2 }).map((_, idx) => (
            <div key={`alert-skeleton-${idx}`} className="card skeleton skeletonBlock skeletonCard" />
          ))}
        </section>

        <section className="gridTwo gridTwoCharts">
          <div className="panel skeleton skeletonBlock skeletonChart" />
          <div className="panel skeleton skeletonBlock skeletonChart" />
        </section>

        <section className="panel skeleton skeletonBlock skeletonChartTall" />
        <section className="panel skeleton skeletonBlock skeletonTable" />
      </section>
    </main>
  );
}

function SessionLoading({ message }: { message: string }) {
  return (
    <main className="authContainer">
      <section className="authPanel panel sessionLoadingPanel">
        <div className="sessionLoadingHeader">
          <ReloadIcon spinning />
          <p>{message}</p>
        </div>
        <div className="sessionLoadingBody">
          <div className="skeleton skeletonText skeletonHeading" />
          <div className="skeleton skeletonText skeletonSubtitleLarge" />
          <div className="skeleton skeletonButtonWide" />
        </div>
      </section>
    </main>
  );
}

function HomeContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { signOut } = useClerk();
  const { isLoaded: isUserLoaded, isSignedIn, user } = useUser();
  const [stackAdaptSearch, setStackAdaptSearch] = useState(() => searchParams.get(URL_PARAM_STACK_SEARCH) ?? "");
  const [dspLinesOnlyWithoutToken, setDspLinesOnlyWithoutToken] = useState(
    () => searchParams.get(URL_PARAM_STACK_NO_TOKEN_ONLY) === "1"
  );
  const [stackAdaptSort, setStackAdaptSort] = useState<{
    key: StackAdaptSortKey;
    direction: StackAdaptSortDirection;
  }>(() => parseStackSortParam(searchParams.get(URL_PARAM_STACK_SORT)));
  const [attentionNoTokenSearch, setAttentionNoTokenSearch] = useState(() => searchParams.get(URL_PARAM_NO_TOKEN_SEARCH) ?? "");
  const [attentionNoTokenSort, setAttentionNoTokenSort] = useState<{
    key: AttentionNoTokenSortKey;
    direction: AttentionSortDirection;
  }>(() => parseNoTokenSortParam(searchParams.get(URL_PARAM_NO_TOKEN_SORT)));
  const [attentionOutOfPeriodSearch, setAttentionOutOfPeriodSearch] = useState(
    () => searchParams.get(URL_PARAM_OUT_SEARCH) ?? ""
  );
  const [attentionNoTokenDspFilters, setAttentionNoTokenDspFilters] = useState<string[]>(
    () => parseCsvList(searchParams.get(URL_PARAM_NO_TOKEN_DSPS))
  );
  const [attentionOutOfPeriodDspFilters, setAttentionOutOfPeriodDspFilters] = useState<string[]>(
    () => parseCsvList(searchParams.get(URL_PARAM_OUT_DSPS))
  );
  const [attentionOutOfPeriodSort, setAttentionOutOfPeriodSort] = useState<{
    key: AttentionOutOfPeriodSortKey;
    direction: AttentionSortDirection;
  }>(() => parseOutOfPeriodSortParam(searchParams.get(URL_PARAM_OUT_SORT)));
  const [clientFilter, setClientFilter] = useState<string[]>(() => parseCsvList(searchParams.get(URL_PARAM_CLIENTS)));
  const [csFilter, setCsFilter] = useState<string[]>(() => parseCsvList(searchParams.get(URL_PARAM_CS)));
  const [campaignFilter, setCampaignFilter] = useState<string[]>(() => parseCsvList(searchParams.get(URL_PARAM_CAMPAIGNS)));
  const [campaignStatusFilter, setCampaignStatusFilter] = useState<string[]>(
    () => parseCsvList(searchParams.get(URL_PARAM_CAMPAIGN_STATUS))
  );
  const [campaignTypeFilter, setCampaignTypeFilter] = useState<string[]>(() =>
    parseCsvList(searchParams.get(URL_PARAM_CAMPAIGN_TYPE)).filter((t) =>
      (CAMPAIGN_TYPE_OPTIONS as readonly string[]).includes(t)
    )
  );
  const [selectedMonthKey, setSelectedMonthKey] = useState<string>(() => {
    const paramMonth = searchParams.get(URL_PARAM_MONTH);
    return isValidMonthKey(paramMonth) ? paramMonth : getCurrentMonthKey();
  });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [toast, setToast] = useState<{ message: string; kind: "success" | "error" } | null>(null);
  const [isForceRefreshing, setIsForceRefreshing] = useState(false);
  const [refreshRunStartedAt, setRefreshRunStartedAt] = useState<number | null>(null);
  const [refreshElapsedSeconds, setRefreshElapsedSeconds] = useState(0);
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  const userEmail = user?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "";
  const userDisplayName =
    user?.firstName?.trim() ||
    user?.fullName?.trim() ||
    user?.primaryEmailAddress?.emailAddress?.split("@")[0] ||
    "pessoa";
  const isAllowedDomain = userEmail.endsWith("@hypr.mobi");
  const shouldFetchData = isUserLoaded && isSignedIn && isAllowedDomain;
  const selectedMonthRange = useMemo(() => monthKeyToDateRange(selectedMonthKey), [selectedMonthKey]);
  const availableMonthKeys = useMemo(() => {
    const options = buildRecentMonthKeys(18);
    if (options.includes(selectedMonthKey)) return options;
    return [selectedMonthKey, ...options];
  }, [selectedMonthKey]);
  const dashboardUrl = useMemo(() => {
    if (!shouldFetchData) return null;
    const query = new URLSearchParams({
      start: selectedMonthRange.start,
      end: selectedMonthRange.end,
    });
    return `${apiBase}/api/dashboard?${query.toString()}`;
  }, [apiBase, selectedMonthRange.end, selectedMonthRange.start, shouldFetchData]);
  const { data, error, isLoading, isValidating, mutate } = useSWR<DashboardResponse>(dashboardUrl, fetcher, {
    keepPreviousData: true,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60000,
    onSuccess: (nextData) => {
      if (nextData?._meta?.snapshot_at) {
        const parsed = Date.parse(nextData._meta.snapshot_at);
        setLastUpdatedAt(Number.isNaN(parsed) ? Date.now() : parsed);
        return;
      }
      setLastUpdatedAt(Date.now());
    },
  });
  const refreshMetricsUrl = shouldFetchData ? `${apiBase}/api/dashboard/refresh/metrics` : null;
  const {
    data: refreshMetrics,
    mutate: mutateRefreshMetrics,
  } = useSWR<RefreshMetricsResponse>(
    refreshMetricsUrl,
    async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Falha ao carregar métricas de atualização.");
      }
      return (await response.json()) as RefreshMetricsResponse;
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 60000,
    }
  );
  const refreshStatusUrl = shouldFetchData ? `${apiBase}/api/dashboard/refresh/status` : null;
  const {
    data: refreshStatus,
    mutate: mutateRefreshStatus,
  } = useSWR<RefreshStatusResponse>(
    refreshStatusUrl,
    async (url: string) => {
      const response = await fetch(`${url}?_=${Date.now()}`);
      if (!response.ok) {
        throw new Error("Falha ao carregar status de atualização.");
      }
      return (await response.json()) as RefreshStatusResponse;
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshInterval: (status) => (status?.running ? 2000 : 0),
      dedupingInterval: 1000,
    }
  );
  const displayedSnapshotAt = useMemo(() => {
    const fromPayload = data?._meta?.snapshot_at ? Date.parse(data._meta.snapshot_at) : Number.NaN;
    if (!Number.isNaN(fromPayload)) {
      return fromPayload;
    }
    if (lastUpdatedAt) {
      return lastUpdatedAt;
    }
    return null;
  }, [data?._meta?.snapshot_at, lastUpdatedAt]);
  const isRefreshRunning = Boolean(refreshStatus?.running) || isForceRefreshing;
  const previousRefreshRunningRef = useRef(false);
  const spendByPlatformChartRef = useRef<HTMLDivElement | null>(null);
  const distributionChartRef = useRef<HTMLDivElement | null>(null);
  const dailyCostChartRef = useRef<HTMLDivElement | null>(null);
  const noTokenDistributionChartRef = useRef<HTMLDivElement | null>(null);
  const outOfPeriodDistributionChartRef = useRef<HTMLDivElement | null>(null);
  const nexdUsageChartRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isUserLoaded) return;
    if (!isSignedIn) {
      router.replace("/sign-in");
      return;
    }
    if (!isAllowedDomain) {
      void signOut({ redirectUrl: "/unauthorized" });
    }
  }, [isAllowedDomain, isSignedIn, isUserLoaded, router, signOut]);

  useEffect(() => {
    const nextStackSort = parseStackSortParam(searchParams.get(URL_PARAM_STACK_SORT));
    const nextNoTokenSort = parseNoTokenSortParam(searchParams.get(URL_PARAM_NO_TOKEN_SORT));
    const nextOutSort = parseOutOfPeriodSortParam(searchParams.get(URL_PARAM_OUT_SORT));
    const nextNoTokenDsps = parseCsvList(searchParams.get(URL_PARAM_NO_TOKEN_DSPS));
    const nextOutDsps = parseCsvList(searchParams.get(URL_PARAM_OUT_DSPS));
    const nextClients = parseCsvList(searchParams.get(URL_PARAM_CLIENTS));
    const nextCs = parseCsvList(searchParams.get(URL_PARAM_CS));
    const nextCampaigns = parseCsvList(searchParams.get(URL_PARAM_CAMPAIGNS));
    const nextCampaignStatuses = parseCsvList(searchParams.get(URL_PARAM_CAMPAIGN_STATUS));
    const nextCampaignTypes = parseCsvList(searchParams.get(URL_PARAM_CAMPAIGN_TYPE)).filter((t) =>
      (CAMPAIGN_TYPE_OPTIONS as readonly string[]).includes(t)
    );
    const nextMonth = searchParams.get(URL_PARAM_MONTH);
    const normalizedMonth = isValidMonthKey(nextMonth) ? nextMonth : getCurrentMonthKey();

    setStackAdaptSearch(searchParams.get(URL_PARAM_STACK_SEARCH) ?? "");
    setDspLinesOnlyWithoutToken(searchParams.get(URL_PARAM_STACK_NO_TOKEN_ONLY) === "1");
    setAttentionNoTokenSearch(searchParams.get(URL_PARAM_NO_TOKEN_SEARCH) ?? "");
    setAttentionOutOfPeriodSearch(searchParams.get(URL_PARAM_OUT_SEARCH) ?? "");
    setStackAdaptSort((prev) =>
      prev.key === nextStackSort.key && prev.direction === nextStackSort.direction ? prev : nextStackSort
    );
    setAttentionNoTokenSort((prev) =>
      prev.key === nextNoTokenSort.key && prev.direction === nextNoTokenSort.direction ? prev : nextNoTokenSort
    );
    setAttentionOutOfPeriodSort((prev) =>
      prev.key === nextOutSort.key && prev.direction === nextOutSort.direction ? prev : nextOutSort
    );
    setAttentionNoTokenDspFilters((prev) =>
      prev.join("|") === nextNoTokenDsps.join("|") ? prev : nextNoTokenDsps
    );
    setAttentionOutOfPeriodDspFilters((prev) => (prev.join("|") === nextOutDsps.join("|") ? prev : nextOutDsps));
    setClientFilter((prev) => (prev.join("|") === nextClients.join("|") ? prev : nextClients));
    setCsFilter((prev) => (prev.join("|") === nextCs.join("|") ? prev : nextCs));
    setCampaignFilter((prev) => (prev.join("|") === nextCampaigns.join("|") ? prev : nextCampaigns));
    setCampaignStatusFilter((prev) =>
      prev.join("|") === nextCampaignStatuses.join("|") ? prev : nextCampaignStatuses
    );
    setCampaignTypeFilter((prev) => (prev.join("|") === nextCampaignTypes.join("|") ? prev : nextCampaignTypes));
    setSelectedMonthKey((prev) => (prev === normalizedMonth ? prev : normalizedMonth));
  }, [searchParams]);

  useEffect(() => {
    const nextParams = new URLSearchParams(searchParams.toString());
    const setQueryValue = (key: string, value: string | null) => {
      if (!value) {
        nextParams.delete(key);
      } else {
        nextParams.set(key, value);
      }
    };

    setQueryValue(URL_PARAM_STACK_SEARCH, stackAdaptSearch.trim() || null);
    setQueryValue(URL_PARAM_STACK_NO_TOKEN_ONLY, dspLinesOnlyWithoutToken ? "1" : null);
    setQueryValue(URL_PARAM_STACK_SORT, `${stackAdaptSort.key}:${stackAdaptSort.direction}`);
    setQueryValue(URL_PARAM_NO_TOKEN_SEARCH, attentionNoTokenSearch.trim() || null);
    setQueryValue(URL_PARAM_NO_TOKEN_SORT, `${attentionNoTokenSort.key}:${attentionNoTokenSort.direction}`);
    setQueryValue(URL_PARAM_NO_TOKEN_DSPS, stringifyCsvList(attentionNoTokenDspFilters));
    setQueryValue(URL_PARAM_OUT_SEARCH, attentionOutOfPeriodSearch.trim() || null);
    setQueryValue(URL_PARAM_OUT_SORT, `${attentionOutOfPeriodSort.key}:${attentionOutOfPeriodSort.direction}`);
    setQueryValue(URL_PARAM_OUT_DSPS, stringifyCsvList(attentionOutOfPeriodDspFilters));
    setQueryValue(URL_PARAM_CLIENTS, stringifyCsvList(clientFilter));
    setQueryValue(URL_PARAM_CS, stringifyCsvList(csFilter));
    setQueryValue(URL_PARAM_CAMPAIGNS, stringifyCsvList(campaignFilter));
    setQueryValue(URL_PARAM_CAMPAIGN_STATUS, stringifyCsvList(campaignStatusFilter));
    setQueryValue(URL_PARAM_CAMPAIGN_TYPE, stringifyCsvList(campaignTypeFilter));
    setQueryValue(URL_PARAM_MONTH, selectedMonthKey);

    const currentQuery = searchParams.toString();
    const nextQuery = nextParams.toString();
    if (currentQuery === nextQuery) return;
    router.replace(`${pathname}${nextQuery ? `?${nextQuery}` : ""}`, { scroll: false });
  }, [
    attentionNoTokenDspFilters,
    attentionNoTokenSearch,
    attentionNoTokenSort.direction,
    attentionNoTokenSort.key,
    attentionOutOfPeriodDspFilters,
    attentionOutOfPeriodSearch,
    attentionOutOfPeriodSort.direction,
    attentionOutOfPeriodSort.key,
    campaignFilter,
    campaignStatusFilter,
    campaignTypeFilter,
    clientFilter,
    csFilter,
    dspLinesOnlyWithoutToken,
    pathname,
    router,
    searchParams,
    selectedMonthKey,
    stackAdaptSearch,
    stackAdaptSort.direction,
    stackAdaptSort.key,
  ]);

  const journeyRows = useMemo(() => data?.dashboard.campaign_journey_rows ?? [], [data?.dashboard.campaign_journey_rows]);
  const journeyByToken = useMemo(() => {
    const m = new Map<string, JourneyRow>();
    for (const r of journeyRows) {
      const t = String(r.token ?? "").trim();
      if (t) m.set(t, r);
    }
    return m;
  }, [journeyRows]);
  const hasDashboardFilters =
    clientFilter.length > 0 ||
    csFilter.length > 0 ||
    campaignFilter.length > 0 ||
    campaignStatusFilter.length > 0 ||
    campaignTypeFilter.length > 0;
  const rowMatchesDashboardFilters = useCallback(
    (
      row: JourneyRow,
      filters: {
        clients: string[];
        cs: string[];
        campaigns: string[];
        statuses: string[];
        campaignTypes: string[];
      }
    ) => {
      if (filters.clients.length && !filters.clients.includes(row.cliente)) return false;
      if (filters.cs.length && !filters.cs.includes(rowCsLabel(row))) return false;
      if (filters.campaigns.length && !filters.campaigns.includes(row.campanha)) return false;
      if (filters.statuses.length && !filters.statuses.includes(row.status)) return false;
      if (!rowMatchesCampaignTypes(row.campanha, filters.campaignTypes)) return false;
      return true;
    },
    []
  );
  const dashboardFilteredRows = useMemo(() => {
    if (!hasDashboardFilters) return journeyRows;
    return journeyRows.filter((row) =>
      rowMatchesDashboardFilters(row, {
        clients: clientFilter,
        cs: csFilter,
        campaigns: campaignFilter,
        statuses: campaignStatusFilter,
        campaignTypes: campaignTypeFilter,
      })
    );
  }, [
    campaignFilter,
    campaignStatusFilter,
    campaignTypeFilter,
    clientFilter,
    csFilter,
    hasDashboardFilters,
    journeyRows,
    rowMatchesDashboardFilters,
  ]);

  const filteredSpendByPlatform = useMemo(() => {
    if (!dashboardFilteredRows.length || !hasDashboardFilters || !data) return null;
    const platforms = data.dashboard.active_platforms;
    const sums: Record<string, number> = Object.fromEntries(platforms.map((p) => [p, 0]));
    for (const row of dashboardFilteredRows) {
      for (const p of platforms) {
        sums[p] += Number(row[p] ?? 0);
      }
    }
    return sums;
  }, [dashboardFilteredRows, data, hasDashboardFilters]);

  const spendData = useMemo(() => data?.dashboard.spend_by_platform ?? [], [data]);
  const chartData = useMemo(() => {
    const base = [...spendData].sort((a, b) => b.spend_brl - a.spend_brl);
    if (!hasDashboardFilters || !filteredSpendByPlatform) {
      return base.map((item) => ({ ...item, color: PLATFORM_COLORS[item.platform] ?? "#6366f1" }));
    }
    return base
      .map((item) => ({
        ...item,
        spend_brl: filteredSpendByPlatform[item.platform] ?? 0,
        color: PLATFORM_COLORS[item.platform] ?? "#6366f1",
      }))
      .filter((item) => item.spend_brl > 0);
  }, [filteredSpendByPlatform, hasDashboardFilters, spendData]);
  const barChartData = useMemo(() => [...chartData].reverse(), [chartData]);
  const periodTotalSpend = useMemo(() => chartData.reduce((sum, row) => sum + row.spend_brl, 0), [chartData]);
  const dominantChartShare = useMemo(() => {
    if (!chartData.length || periodTotalSpend <= 0) return 0;
    return chartData[0].spend_brl / periodTotalSpend;
  }, [chartData, periodTotalSpend]);
  const shouldFallbackPieChart = chartData.length <= 1 || dominantChartShare >= 0.9;
  const hasDailyVariation = useMemo(() => {
    const rows = data?.dashboard.daily ?? [];
    if (rows.length <= 1) return false;
    const baseline = rows[0];
    const keys = ["total", ...(data?.dashboard.active_platforms ?? [])];
    return rows.some((row) =>
      keys.some((key) => {
        const baseValue = Number(baseline[key] ?? 0);
        const currentValue = Number(row[key] ?? 0);
        return Math.abs(currentValue - baseValue) > 0.01;
      })
    );
  }, [data?.dashboard.active_platforms, data?.dashboard.daily]);
  const routeMatch = useMemo<{ page: NavKey; known: boolean }>(() => {
    const normalizedPath = pathname && pathname !== "/" ? pathname.replace(/\/+$/, "") : "/";
    if (normalizedPath === "/") return { page: "Dashboard", known: true };
    const slug = normalizedPath.slice(1);
    const page = SLUG_TO_PAGE[slug];
    if (!page) return { page: "Dashboard", known: false };
    return { page, known: true };
  }, [pathname]);
  const requestedPage = routeMatch.page;

  const navOptions = useMemo<NavKey[]>(() => {
    if (!data) {
      const fallback: NavKey[] = ["Dashboard", "⚠️ Lines sem token", "🚨 Gasto fora do mês vigente"];
      if (!fallback.includes(requestedPage)) {
        fallback.splice(1, 0, requestedPage);
      }
      return fallback;
    }
    const pages: NavKey[] = ["Dashboard"];
    const orderedPlatforms: NavKey[] = ["StackAdapt", "DV360", "Xandr", "Amazon DSP"];
    for (const name of orderedPlatforms) {
      if (name === "DV360") {
        pages.push(name);
        continue;
      }
      const platform = data.platform_pages[name];
      if (platform && platform.spend_brl > 0) pages.push(name);
    }
    if (data.platform_pages.Nexd) pages.push("Nexd");
    pages.push("⚠️ Lines sem token", "🚨 Gasto fora do mês vigente");
    if (!pages.includes(requestedPage)) {
      const attentionIndex = pages.indexOf("⚠️ Lines sem token");
      pages.splice(attentionIndex >= 0 ? attentionIndex : pages.length, 0, requestedPage);
    }
    return pages;
  }, [data, requestedPage]);

  const resolvedActivePage: NavKey = requestedPage;

  const campaignRows = useMemo(() => dashboardFilteredRows, [dashboardFilteredRows]);

  const csFilterOptions = useMemo(() => {
    return [...new Set(journeyRows.map(rowCsLabel))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [journeyRows]);
  const campaignFilterOptions = useMemo(() => {
    return [...new Set(journeyRows.map((row) => String(row.campanha ?? "").trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "pt-BR")
    );
  }, [journeyRows]);
  const campaignStatusOptions = useMemo(() => {
    return [...new Set(journeyRows.map((row) => String(row.status ?? "").trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "pt-BR")
    );
  }, [journeyRows]);

  const clients = useMemo(() => {
    return [...new Set(journeyRows.map((row) => row.cliente).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "pt-BR")
    );
  }, [journeyRows]);
  const disabledClientOptions = useMemo(
    () =>
      new Set(
        clients.filter(
          (client) =>
            !journeyRows.some((row) =>
              rowMatchesDashboardFilters(row, {
                clients: [client],
                cs: csFilter,
                campaigns: campaignFilter,
                statuses: campaignStatusFilter,
                campaignTypes: campaignTypeFilter,
              })
            )
        )
      ),
    [campaignFilter, campaignStatusFilter, campaignTypeFilter, clients, csFilter, journeyRows, rowMatchesDashboardFilters]
  );
  const disabledCsOptions = useMemo(
    () =>
      new Set(
        csFilterOptions.filter(
          (cs) =>
            !journeyRows.some((row) =>
              rowMatchesDashboardFilters(row, {
                clients: clientFilter,
                cs: [cs],
                campaigns: campaignFilter,
                statuses: campaignStatusFilter,
                campaignTypes: campaignTypeFilter,
              })
            )
        )
      ),
    [campaignFilter, campaignStatusFilter, campaignTypeFilter, clientFilter, csFilterOptions, journeyRows, rowMatchesDashboardFilters]
  );
  const disabledCampaignOptions = useMemo(
    () =>
      new Set(
        campaignFilterOptions.filter(
          (campaign) =>
            !journeyRows.some((row) =>
              rowMatchesDashboardFilters(row, {
                clients: clientFilter,
                cs: csFilter,
                campaigns: [campaign],
                statuses: campaignStatusFilter,
                campaignTypes: campaignTypeFilter,
              })
            )
        )
      ),
    [
      campaignFilterOptions,
      campaignStatusFilter,
      campaignTypeFilter,
      clientFilter,
      csFilter,
      journeyRows,
      rowMatchesDashboardFilters,
    ]
  );
  const disabledCampaignStatusOptions = useMemo(
    () =>
      new Set(
        campaignStatusOptions.filter(
          (status) =>
            !journeyRows.some((row) =>
              rowMatchesDashboardFilters(row, {
                clients: clientFilter,
                cs: csFilter,
                campaigns: campaignFilter,
                statuses: [status],
                campaignTypes: campaignTypeFilter,
              })
            )
        )
      ),
    [
      campaignFilter,
      campaignStatusOptions,
      campaignTypeFilter,
      clientFilter,
      csFilter,
      journeyRows,
      rowMatchesDashboardFilters,
    ]
  );
  const disabledCampaignTypeOptions = useMemo(
    () =>
      new Set(
        [...CAMPAIGN_TYPE_OPTIONS].filter(
          (tipo) =>
            !journeyRows.some((row) =>
              rowMatchesDashboardFilters(row, {
                clients: clientFilter,
                cs: csFilter,
                campaigns: campaignFilter,
                statuses: campaignStatusFilter,
                campaignTypes: [tipo],
              })
            )
        )
      ),
    [campaignFilter, campaignStatusFilter, clientFilter, csFilter, journeyRows, rowMatchesDashboardFilters]
  );

  const handleRefresh = async () => {
    if (!dashboardUrl) return;
    if (isRefreshRunning) return;
    setIsForceRefreshing(true);
    setRefreshRunStartedAt(Date.now());
    setRefreshElapsedSeconds(0);
    try {
      const dashboardUri = new URL(dashboardUrl);
      const refreshQuery = new URLSearchParams();
      const start = dashboardUri.searchParams.get("start");
      const end = dashboardUri.searchParams.get("end");
      if (start) refreshQuery.set("start", start);
      if (end) refreshQuery.set("end", end);

      const refreshResponse = await fetch(
        `${apiBase}/api/dashboard/refresh${refreshQuery.toString() ? `?${refreshQuery.toString()}` : ""}`,
        { method: "POST" }
      );
      if (!refreshResponse.ok) {
        throw new Error("Falha ao disparar atualizacao na fonte.");
      }
      await mutateRefreshStatus();
      showToast("Atualizacao da fonte iniciada.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Nao foi possivel atualizar na fonte.";
      showToast(message, "error");
    } finally {
      setIsForceRefreshing(false);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const timeoutId = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timeoutId);
  }, [toast]);

  useEffect(() => {
    if (!isRefreshRunning || !refreshRunStartedAt) return;
    const updateElapsed = () => {
      setRefreshElapsedSeconds(Math.max(0, Math.floor((Date.now() - refreshRunStartedAt) / 1000)));
    };
    updateElapsed();
    const intervalId = setInterval(updateElapsed, 1000);
    return () => clearInterval(intervalId);
  }, [isRefreshRunning, refreshRunStartedAt]);

  useEffect(() => {
    if (!refreshStatus?.started_at) return;
    const parsed = Date.parse(refreshStatus.started_at);
    if (!Number.isNaN(parsed)) {
      setRefreshRunStartedAt(parsed);
    }
  }, [refreshStatus?.started_at]);

  useEffect(() => {
    const wasRunning = previousRefreshRunningRef.current;
    const isRunningNow = Boolean(refreshStatus?.running);
    if (wasRunning && !isRunningNow) {
      if (refreshStatus?.status === "success") {
        void mutate();
        void mutateRefreshMetrics();
        showToast("Dados atualizados na fonte.");
      } else if (refreshStatus?.status === "error") {
        showToast(refreshStatus.error || "Atualizacao na fonte falhou.", "error");
      }
      setRefreshRunStartedAt(null);
      setRefreshElapsedSeconds(0);
    }
    previousRefreshRunningRef.current = isRunningNow;
  }, [refreshStatus, mutate, mutateRefreshMetrics]);

  useEffect(() => {
    if (routeMatch.known) return;
    router.replace("/");
  }, [routeMatch.known, router]);

  const getBudgetForPlatform = (platform: string, spent: number) => {
    const entry =
      platform === GENERAL_BUDGET_KEY ? data?.budget.general : (data?.budget.platforms?.[platform] ?? null);
    const target = entry?.target_brl ?? null;
    const spentValue = entry?.spent_brl ?? spent;
    const progress = target && target > 0 ? (spentValue / target) * 100 : null;
    const remaining = target !== null ? target - spentValue : null;
    const fromApi = platform !== GENERAL_BUDGET_KEY ? data?.budget.share_percent?.[platform] : undefined;
    const investment_share_pct =
      platform === GENERAL_BUDGET_KEY
        ? null
        : (fromApi ?? DEFAULT_INVESTMENT_SHARE_PERCENT[platform] ?? null);
    return {
      target_brl: target,
      spent_brl: spentValue,
      progress_pct: progress,
      remaining_brl: remaining,
      investment_share_pct,
    };
  };

  const copyToClipboard = async (value: string, label: string) => {
    const normalized = value.trim();
    if (!normalized || normalized === "—") return;
    try {
      await navigator.clipboard.writeText(normalized);
      showToast(`${label} copiado.`);
    } catch {
      showToast(`Nao foi possivel copiar ${label.toLowerCase()}.`, "error");
    }
  };

  const showToast = (message: string, kind: "success" | "error" = "success") => {
    setToast({ message, kind });
  };

  const appendQueryToRoute = (route: string) => {
    const query = searchParams.toString();
    return query ? `${route}?${query}` : route;
  };

  const copyObjectsAsCsv = async (label: string, rows: Array<Record<string, string | number>>) => {
    if (!rows.length) {
      showToast(`Sem dados para copiar em ${label}.`, "error");
      return;
    }
    const headers = Object.keys(rows[0]);
    const escapeCsvCell = (value: string | number) => {
      const raw = String(value ?? "");
      const escaped = raw.replace(/"/g, "\"\"");
      return `"${escaped}"`;
    };
    const csv = [
      headers.join(";"),
      ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header] ?? "")).join(";")),
    ].join("\n");

    try {
      await navigator.clipboard.writeText(csv);
      showToast(`Dados de ${label} copiados em CSV.`);
    } catch {
      showToast("Não foi possível copiar os dados. Verifique as permissões do navegador.", "error");
    }
  };

  const exportChartAsPng = async (element: HTMLDivElement | null, chartName: string) => {
    if (!element) {
      showToast("Não foi possível capturar o gráfico.", "error");
      return;
    }
    try {
      const safeName = chartName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadElementPng(element, `${safeName}-${stamp}.png`);
      showToast(`Imagem exportada: ${chartName}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "erro desconhecido";
      showToast(`Falha ao exportar imagem (${message}).`, "error");
    }
  };

  const toggleStackAdaptSort = (key: StackAdaptSortKey) => {
    setStackAdaptSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: key === "line" || key === "cliente" || key === "campanha" ? "asc" : "desc" };
    });
  };

  const stackSortIndicator = (key: StackAdaptSortKey) => {
    if (stackAdaptSort.key !== key) return "↕";
    return stackAdaptSort.direction === "asc" ? "↑" : "↓";
  };

  const toggleAttentionNoTokenSort = (key: AttentionNoTokenSortKey) => {
    setAttentionNoTokenSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: key === "platform" || key === "line" ? "asc" : "desc" };
    });
  };

  const attentionNoTokenSortIndicator = (key: AttentionNoTokenSortKey) => {
    if (attentionNoTokenSort.key !== key) return "↕";
    return attentionNoTokenSort.direction === "asc" ? "↑" : "↓";
  };

  const toggleAttentionOutOfPeriodSort = (key: AttentionOutOfPeriodSortKey) => {
    setAttentionOutOfPeriodSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return {
        key,
        direction:
          key === "platform" ||
          key === "token" ||
          key === "cliente" ||
          key === "campanha" ||
          key === "account_management" ||
          key === "vigencia"
            ? "asc"
            : "desc",
      };
    });
  };

  const attentionOutOfPeriodSortIndicator = (key: AttentionOutOfPeriodSortKey) => {
    if (attentionOutOfPeriodSort.key !== key) return "↕";
    return attentionOutOfPeriodSort.direction === "asc" ? "↑" : "↓";
  };

  const detailedPlatformRows = useMemo(() => {
    if (!data) return [] as PlatformPageRow[];
    if (!["StackAdapt", "DV360", "Xandr"].includes(resolvedActivePage)) return [] as PlatformPageRow[];
    return data.platform_pages[resolvedActivePage]?.rows ?? [];
  }, [data, resolvedActivePage]);

  const platformRowMatchesDashboardFilters = useCallback(
    (row: PlatformPageRow) => {
      const pseudo = journeySnapshotForPlatformRow(row, journeyByToken);
      return rowMatchesDashboardFilters(pseudo, {
        clients: clientFilter,
        cs: csFilter,
        campaigns: campaignFilter,
        statuses: campaignStatusFilter,
        campaignTypes: campaignTypeFilter,
      });
    },
    [
      journeyByToken,
      clientFilter,
      csFilter,
      campaignFilter,
      campaignStatusFilter,
      campaignTypeFilter,
      rowMatchesDashboardFilters,
    ]
  );

  const filteredDetailedPlatformRows = useMemo(() => {
    if (!hasDashboardFilters) return detailedPlatformRows;
    return detailedPlatformRows.filter(platformRowMatchesDashboardFilters);
  }, [detailedPlatformRows, hasDashboardFilters, platformRowMatchesDashboardFilters]);

  const detailedPlatformDerived = useMemo(() => {
    const rows = filteredDetailedPlatformRows;
    const rowsWithToken = rows.filter((row) => hasCampaignToken(row.token)).length;
    const rowsWithoutToken = Math.max(0, rows.length - rowsWithToken);
    const activeCampaignsCount = new Set(
      rows
        .filter((row) => row.gasto > 0)
        .map((row) => row.campanha?.trim())
        .filter((campanha): campanha is string => Boolean(campanha))
    ).size;
    const normalizedSearch = stackAdaptSearch.trim().toLowerCase();
    const searchFilteredRows = rows.filter((row) => {
      if (!normalizedSearch) return true;
      const hasBudget = typeof row.investido === "number" && row.investido > 0;
      const budgetText = hasBudget ? brl(row.investido ?? 0) : "sem budget";
      const budgetTag = hasBudget ? "com budget" : "sem budget";
      const searchableText = [
        row.line,
        row.token,
        row.cliente,
        row.campanha,
        row.account_management,
        budgetText,
        row.investido !== null && row.investido !== undefined ? String(row.investido) : "",
        budgetTag,
      ]
        .join(" ")
        .toLowerCase();
      return searchableText.includes(normalizedSearch);
    });
    const tokenFilteredRows = dspLinesOnlyWithoutToken
      ? searchFilteredRows.filter((row) => !hasCampaignToken(row.token))
      : searchFilteredRows;
    const filteredTotalGasto = tokenFilteredRows.reduce((acc, row) => acc + row.gasto, 0);
    const sortedRows = [...tokenFilteredRows].sort((a, b) => {
      const totalA = filteredTotalGasto > 0 ? a.gasto / filteredTotalGasto : 0;
      const totalB = filteredTotalGasto > 0 ? b.gasto / filteredTotalGasto : 0;
      const valueA: string | number =
        stackAdaptSort.key === "total"
          ? totalA
          : stackAdaptSort.key === "investido"
            ? (a.investido ?? -1)
            : stackAdaptSort.key === "pct_invest"
              ? (a.pct_invest ?? -1)
              : a[stackAdaptSort.key];
      const valueB: string | number =
        stackAdaptSort.key === "total"
          ? totalB
          : stackAdaptSort.key === "investido"
            ? (b.investido ?? -1)
            : stackAdaptSort.key === "pct_invest"
              ? (b.pct_invest ?? -1)
              : b[stackAdaptSort.key];
      let compare = 0;
      if (typeof valueA === "number" && typeof valueB === "number") {
        compare = valueA - valueB;
      } else {
        compare = String(valueA).localeCompare(String(valueB), "pt-BR", { numeric: true, sensitivity: "base" });
      }
      return stackAdaptSort.direction === "asc" ? compare : -compare;
    });
    return { rowsWithToken, rowsWithoutToken, activeCampaignsCount, sortedRows, filteredTotalGasto };
  }, [filteredDetailedPlatformRows, stackAdaptSearch, stackAdaptSort, dspLinesOnlyWithoutToken]);

  const noTokenRows = useMemo(() => data?.attention.no_token_rows ?? [], [data?.attention.no_token_rows]);
  const noTokenSearchNormalized = attentionNoTokenSearch.trim().toLowerCase();
  const noTokenDerived = useMemo(() => {
    const filteredRows = noTokenRows.filter((row) => {
      const p = (row.platform ?? "").trim() || "Outros";
      if (attentionNoTokenDspFilters.length > 0 && !attentionNoTokenDspFilters.includes(p)) return false;
      if (!noTokenSearchNormalized) return true;
      const searchableText = [row.platform, row.line, brl(row.gasto), String(row.gasto)].join(" ").toLowerCase();
      return searchableText.includes(noTokenSearchNormalized);
    });
    const sortedRows = [...filteredRows].sort((a, b) => {
      const valueA = attentionNoTokenSort.key === "gasto" ? a.gasto : a[attentionNoTokenSort.key];
      const valueB = attentionNoTokenSort.key === "gasto" ? b.gasto : b[attentionNoTokenSort.key];
      const compare =
        typeof valueA === "number" && typeof valueB === "number"
          ? valueA - valueB
          : String(valueA).localeCompare(String(valueB), "pt-BR", { numeric: true, sensitivity: "base" });
      return attentionNoTokenSort.direction === "asc" ? compare : -compare;
    });
    const filteredTotal = filteredRows.reduce((sum, row) => sum + row.gasto, 0);
    return { sortedRows, filteredTotal };
  }, [attentionNoTokenDspFilters, attentionNoTokenSort, noTokenRows, noTokenSearchNormalized]);

  const noTokenUniquePlatforms = useMemo(
    () =>
      [...new Set(noTokenRows.map((row) => (row.platform ?? "").trim() || "Outros"))].sort((a, b) =>
        a.localeCompare(b, "pt-BR", { sensitivity: "base" })
      ),
    [noTokenRows]
  );

  const noTokenPieChartData = useMemo(() => {
    const byPlatform = new Map<string, number>();
    for (const row of noTokenRows) {
      const p = (row.platform ?? "").trim() || "Outros";
      byPlatform.set(p, (byPlatform.get(p) ?? 0) + row.gasto);
    }
    return [...byPlatform.entries()]
      .map(([platform, spend_brl]) => ({
        platform,
        spend_brl,
        color: PLATFORM_COLORS[platform] ?? "#6366f1",
      }))
      .sort((a, b) => b.spend_brl - a.spend_brl);
  }, [noTokenRows]);
  const noTokenPieTotal = useMemo(
    () => noTokenPieChartData.reduce((sum, row) => sum + row.spend_brl, 0),
    [noTokenPieChartData]
  );

  const outOfPeriodRows = useMemo(() => data?.attention.out_of_period_rows ?? [], [data?.attention.out_of_period_rows]);
  const outOfPeriodSearchNormalized = attentionOutOfPeriodSearch.trim().toLowerCase();
  const outOfPeriodDerived = useMemo(() => {
    const filteredRows = outOfPeriodRows.filter((row) => {
      const p = (row.platform ?? "").trim() || "Outros";
      if (attentionOutOfPeriodDspFilters.length > 0 && !attentionOutOfPeriodDspFilters.includes(p)) return false;
      if (!outOfPeriodSearchNormalized) return true;
      const searchableText = [
        row.platform,
        row.token,
        row.line,
        row.cliente,
        row.campanha,
        row.account_management,
        formatDateBr(row.vigencia_start),
        formatDateBr(row.vigencia_end),
        brl(row.gasto),
        String(row.gasto),
      ]
        .join(" ")
        .toLowerCase();
      return searchableText.includes(outOfPeriodSearchNormalized);
    });
    const sortedRows = [...filteredRows].sort((a, b) => {
      const valueA: string | number =
        attentionOutOfPeriodSort.key === "gasto"
          ? a.gasto
          : attentionOutOfPeriodSort.key === "vigencia"
            ? `${a.vigencia_start ?? ""}-${a.vigencia_end ?? ""}`
            : a[attentionOutOfPeriodSort.key];
      const valueB: string | number =
        attentionOutOfPeriodSort.key === "gasto"
          ? b.gasto
          : attentionOutOfPeriodSort.key === "vigencia"
            ? `${b.vigencia_start ?? ""}-${b.vigencia_end ?? ""}`
            : b[attentionOutOfPeriodSort.key];
      const compare =
        typeof valueA === "number" && typeof valueB === "number"
          ? valueA - valueB
          : String(valueA).localeCompare(String(valueB), "pt-BR", { numeric: true, sensitivity: "base" });
      return attentionOutOfPeriodSort.direction === "asc" ? compare : -compare;
    });
    const filteredTotal = filteredRows.reduce((sum, row) => sum + row.gasto, 0);
    return { sortedRows, filteredTotal };
  }, [attentionOutOfPeriodDspFilters, attentionOutOfPeriodSort, outOfPeriodRows, outOfPeriodSearchNormalized]);

  const outOfPeriodUniquePlatforms = useMemo(
    () =>
      [...new Set(outOfPeriodRows.map((row) => (row.platform ?? "").trim() || "Outros"))].sort((a, b) =>
        a.localeCompare(b, "pt-BR", { sensitivity: "base" })
      ),
    [outOfPeriodRows]
  );

  const outOfPeriodPieChartData = useMemo(() => {
    const byPlatform = new Map<string, number>();
    for (const row of outOfPeriodRows) {
      const p = (row.platform ?? "").trim() || "Outros";
      byPlatform.set(p, (byPlatform.get(p) ?? 0) + row.gasto);
    }
    return [...byPlatform.entries()]
      .map(([platform, spend_brl]) => ({
        platform,
        spend_brl,
        color: PLATFORM_COLORS[platform] ?? "#6366f1",
      }))
      .sort((a, b) => b.spend_brl - a.spend_brl);
  }, [outOfPeriodRows]);
  const outOfPeriodPieTotal = useMemo(
    () => outOfPeriodPieChartData.reduce((sum, row) => sum + row.spend_brl, 0),
    [outOfPeriodPieChartData]
  );

  if (!isUserLoaded) return <SessionLoading message="Validando sessão..." />;
  if (!isSignedIn) return <SessionLoading message="Redirecionando para login..." />;
  if (!isAllowedDomain) return <SessionLoading message="Validando domínio..." />;
  const showInitialDashboardSkeleton = shouldFetchData && !data && !error && isLoading;
  if (showInitialDashboardSkeleton) return <DashboardSkeleton />;

  const dashboardLoadFailed = Boolean(error || !data);
  const dashboardErrorMessage =
    error instanceof Error ? error.message : "Nao foi possivel sincronizar os dados no momento.";
  const dashboardErrorIsTimeout = dashboardErrorMessage.toLowerCase().includes("timeout");
  const periodRangeLabel = data
    ? `${formatDateBr(data.period.start)} → ${formatDateBr(data.period.end)}`
    : `${formatDateBr(selectedMonthRange.start)} → ${formatDateBr(selectedMonthRange.end)}`;

  const renderDashboardPage = () => {
    if (!data) return null;
    const handleExportCampaignJourney = () => {
      const headers = [
        "Token",
        "Cliente",
        "Campanha",
        "Account Management",
        "Status",
        "Investido",
        ...data.dashboard.active_platforms,
        "Total Plataformas",
        "% Investido",
      ];
      const rowsToExport = campaignRows.map((row) => [
        row.token,
        row.cliente,
        row.campanha,
        row.account_management,
        row.status,
        row.investido,
        ...data.dashboard.active_platforms.map((platform) => Number(row[platform] ?? 0)),
        row.total_plataformas,
        row.pct_investido,
      ]);
      downloadCsv("campaign-journey.csv", headers, rowsToExport);
    };

    const firstRowDspCards: Array<{
      title: string;
      value: string;
      subtitle: ReactNode;
      badge?: string;
      badgeTone?: "soon";
      statusIndicator?: { label: string; tone: "success" | "danger" | "neutral" };
      dimmed?: boolean;
      titleEmphasis?: boolean;
      logoSrc?: string;
      platformKey?: string;
      spendBrl?: number;
      href?: string;
    }> = [];
    const secondRowDspCards: Array<{
      title: string;
      value: string;
      subtitle: ReactNode;
      badge?: string;
      badgeTone?: "soon";
      statusIndicator?: { label: string; tone: "success" | "danger" | "neutral" };
      dimmed?: boolean;
      titleEmphasis?: boolean;
      logoSrc?: string;
      platformKey?: string;
      spendBrl?: number;
      href?: string;
    }> = [];
    const dashboardFilterOn = hasDashboardFilters;
    const dspFiltered = filteredSpendByPlatform;

    for (const name of ["StackAdapt", "DV360", "Xandr"] as const) {
      const result = data.platform_results[name];
      if (!result) continue;
      if (result.status === "ok") {
        const pageSpend = data.platform_pages[name]?.spend_brl ?? 0;
        const cardSpend = dashboardFilterOn ? (dspFiltered?.[name] ?? 0) : pageSpend;
        firstRowDspCards.push({
          title: name,
          value: brl(cardSpend),
          subtitle: dashboardFilterOn
            ? cardSpend > 0
              ? "Volume atribuível aos filtros"
              : "Sem gasto com os filtros"
            : `USD ${(result.spend ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
          titleEmphasis: true,
          logoSrc: PLATFORM_LOGOS[name],
          platformKey: name,
          spendBrl: cardSpend,
          href: routeForPage(name),
        });
      } else if (result.status === "error") {
        firstRowDspCards.push({
          title: name,
          value: "—",
          subtitle: result.message ?? "Falha ao carregar",
          dimmed: true,
          titleEmphasis: true,
          logoSrc: PLATFORM_LOGOS[name],
          href: routeForPage(name),
        });
      }
    }

    secondRowDspCards.push({
      title: "Amazon",
      value: brl(0),
      subtitle: "USD 0.00",
      badge: "Em breve",
      badgeTone: "soon",
      titleEmphasis: true,
      logoSrc: PLATFORM_LOGOS.Amazon,
      platformKey: "Amazon",
      spendBrl: 0,
    });

    const nexdPage = data.platform_pages.Nexd;
    const nexdStatus = data.nexd?.status;
    if (nexdPage) {
      const impressions = Math.round(Number(nexdPage.impressions ?? 0));
      secondRowDspCards.push({
        title: "NEXD",
        value: brl(Number(nexdPage.spend_brl ?? 0)),
        subtitle: `${impressions.toLocaleString("pt-BR")} impressões`,
        titleEmphasis: true,
        logoSrc: PLATFORM_LOGOS.Nexd,
        platformKey: "Nexd",
        spendBrl: Number(nexdPage.spend_brl ?? 0),
        href: routeForPage("Nexd"),
      });
    } else if (nexdStatus === "error") {
      secondRowDspCards.push({
        title: "NEXD",
        value: "—",
        subtitle: data.nexd?.message ?? "Falha ao carregar",
        dimmed: true,
        titleEmphasis: true,
        logoSrc: PLATFORM_LOGOS.Nexd,
        platformKey: "Nexd",
        spendBrl: 0,
      });
    } else {
      secondRowDspCards.push({
        title: "NEXD",
        value: brl(0),
        subtitle: "Sem dados",
        badge: "Em breve",
        badgeTone: "soon",
        titleEmphasis: true,
        logoSrc: PLATFORM_LOGOS.Nexd,
        platformKey: "Nexd",
        spendBrl: 0,
      });
    }

    secondRowDspCards.push({
      title: "Hivestack",
      value: brl(0),
      subtitle: "USD 0.00",
      badge: "Em breve",
      badgeTone: "soon",
      titleEmphasis: true,
      logoSrc: PLATFORM_LOGOS.Hivestack,
      spendBrl: 0,
    });

    const investedTotal = dashboardFilteredRows.reduce((sum, row) => sum + Number(row.investido ?? 0), 0);

    const dspFilteredConsolidated = dashboardFilterOn
      ? data.dashboard.active_platforms.reduce((sum, p) => sum + (dspFiltered?.[p] ?? 0), 0)
      : data.total_brl;
    const IDEAL_TECH_COST_PCT = 12.5;
    const techCostPct = investedTotal > 0 ? (dspFilteredConsolidated / investedTotal) * 100 : null;
    const techCostLabel = techCostPct === null ? "—" : `${techCostPct.toFixed(2).replace(".", ",")}%`;
    const isTechCostWithinIdeal = techCostPct !== null && techCostPct <= IDEAL_TECH_COST_PCT;

    const consolidatedCard: {
      title: string;
      value: string;
      subtitle: string;
      titleEmphasis: boolean;
      platformKey: string;
      spendBrl: number;
      variant: "premium";
    } = {
      title: "Consolidado",
      value: brl(dashboardFilterOn ? dspFilteredConsolidated : data.total_brl),
      subtitle: dashboardFilterOn
        ? "Soma das DSPs nos filtros selecionados · Nexd, Hivestack e Amazon não entram neste total"
        : `USD 1 = R$ ${data.exchange_rate_usd_brl.toFixed(4)}`,
      titleEmphasis: true,
      platformKey: GENERAL_BUDGET_KEY,
      spendBrl: dashboardFilterOn ? dspFilteredConsolidated : data.total_brl,
      variant: "premium",
    };

    secondRowDspCards.push({
      title: "Investido",
      value: brl(investedTotal),
      subtitle: dashboardFilterOn
        ? "Total investido das campanhas nos filtros selecionados"
        : "Total investido das campanhas ativas no período",
      titleEmphasis: true,
    });

    secondRowDspCards.push({
      title: "Tech Cost",
      value: techCostLabel,
      statusIndicator: {
        label: techCostPct === null ? "Sem base" : isTechCostWithinIdeal ? "Ideal" : "Acima",
        tone: techCostPct === null ? "neutral" : isTechCostWithinIdeal ? "success" : "danger",
      },
      subtitle:
        techCostPct === null
          ? "Sem investido para calcular"
          : (
              <>
                <span>
                  Custo (<strong>{brl(dspFilteredConsolidated)}</strong>) sobre investido (
                  <strong>{brl(investedTotal)}</strong>).
                </span>
                <span className="cardTechCostHint">Ideal: abaixo de {IDEAL_TECH_COST_PCT.toFixed(1).replace(".", ",")}%.</span>
              </>
            ),
      titleEmphasis: true,
    });

    return (
      <>
        <section className="panel panelSub filterPanelCard">
          <h3>Filtros do dashboard</h3>
          <p className="muted filterPanelHint">
            Os filtros recalculam cards e gráficos de DSP. Nexd segue o total mensal (sem rateio por
            token); o&nbsp;consolidado filtrado soma apenas DSPs.
          </p>
          <div className="filterToolbar">
            <MultiSelectFilter
              id="filter-client"
              label="Cliente"
              options={clients}
              value={clientFilter}
              onChange={setClientFilter}
              placeholder="Todos os clientes"
              disabledOptions={disabledClientOptions}
            />
            <MultiSelectFilter
              id="filter-cs"
              label="CS (Account Management)"
              options={csFilterOptions}
              value={csFilter}
              onChange={setCsFilter}
              placeholder="Todos os CS"
              showAvatar
              disabledOptions={disabledCsOptions}
            />
            <MultiSelectFilter
              id="filter-campaign-type"
              label="Tipo"
              options={[...CAMPAIGN_TYPE_OPTIONS]}
              value={campaignTypeFilter}
              onChange={setCampaignTypeFilter}
              placeholder="Todos os tipos"
              disabledOptions={disabledCampaignTypeOptions}
            />
            <MultiSelectFilter
              id="filter-campaign"
              label="Campanha"
              options={campaignFilterOptions}
              value={campaignFilter}
              onChange={setCampaignFilter}
              placeholder="Todas as campanhas"
              disabledOptions={disabledCampaignOptions}
            />
            <MultiSelectFilter
              id="filter-campaign-status"
              label="Status da campanha"
              options={campaignStatusOptions}
              value={campaignStatusFilter}
              onChange={setCampaignStatusFilter}
              placeholder="Todos os status"
              disabledOptions={disabledCampaignStatusOptions}
            />
            {hasDashboardFilters ? (
              <button
                type="button"
                className="button buttonGhost buttonSmall filterClearButton"
                onClick={() => {
                  setClientFilter([]);
                  setCsFilter([]);
                  setCampaignTypeFilter([]);
                  setCampaignFilter([]);
                  setCampaignStatusFilter([]);
                }}
              >
                Limpar filtros
              </button>
            ) : null}
          </div>
        </section>

        <section className="gridCards homeDspRow">
          {firstRowDspCards.map((card) => (
            <KpiCard
              key={`${card.title}-${card.badge ?? "nobadge"}`}
              {...card}
              budget={
                dashboardFilterOn || !card.platformKey
                  ? undefined
                  : getBudgetForPlatform(card.platformKey, card.spendBrl ?? 0)
              }
            />
          ))}
        </section>
        <section className="gridCards homeSummaryRow">
          {secondRowDspCards.map((card) => (
            <KpiCard
              key={`${card.title}-${card.badge ?? "nobadge"}`}
              {...card}
              budget={
                dashboardFilterOn || !card.platformKey
                  ? undefined
                  : getBudgetForPlatform(card.platformKey, card.spendBrl ?? 0)
              }
            />
          ))}
          <KpiCard
            key={`${consolidatedCard.title}-${consolidatedCard.variant ?? "default"}`}
            {...consolidatedCard}
            budget={
              dashboardFilterOn || !consolidatedCard.platformKey
                ? undefined
                : getBudgetForPlatform(consolidatedCard.platformKey, consolidatedCard.spendBrl ?? 0)
            }
          />
        </section>
        <section className="gridCards homeAlertsRow">
          <div
            className={`card alertNavCard alertSignalCard ${
              data.attention.no_token_rows.length > 0 ? "alertSignalCardWarning" : "alertSignalCardSafe"
            }`}
          >
            <button
              className="cardTextButton alertCardTextButton"
              type="button"
              onClick={() => router.push("/lines-sem-token")}
            >
              <span>Ver mais</span>
              <EyeIcon />
            </button>
            <p className="alertSignalBadge">
              {data.attention.no_token_rows.length > 0 ? "Atenção necessária" : "Sem alerta"}
            </p>
            <p className="cardTitle">Lines sem token</p>
            <p className="cardValue">{data.attention.no_token_rows.length.toLocaleString("pt-BR")}</p>
            <p className="cardSubtitle">
              {brl(data.attention.no_token_total_brl)} sem possibilidade de cruzamento
            </p>
          </div>
          <div
            className={`card alertNavCard alertSignalCard ${
              data.attention.out_of_period_rows.length > 0 ? "alertSignalCardDanger" : "alertSignalCardSafe"
            }`}
          >
            <button
              className="cardTextButton alertCardTextButton"
              type="button"
              onClick={() => router.push("/gasto-fora-mes-vigente")}
            >
              <span>Ver mais</span>
              <EyeIcon />
            </button>
            <p className="alertSignalBadge">
              {data.attention.out_of_period_rows.length > 0 ? "Risco de vigência" : "Sem alerta"}
            </p>
            <p className="cardTitle">Gastos fora do mês</p>
            <p className="cardValue">{data.attention.out_of_period_rows.length.toLocaleString("pt-BR")}</p>
            <p className="cardSubtitle">Total impactado: {brl(data.attention.out_of_period_total_brl)}</p>
          </div>
        </section>

        <section className="gridTwo">
          <div className="panel panelChart">
            <div className="panelHeading">
              <div>
                <h2>Gasto por plataforma</h2>
                <p>Comparativo do mês corrente por DSP</p>
              </div>
              <div className="panelHeadingActions">
                <button
                  type="button"
                  className="button buttonGhost buttonSmall"
                  onClick={() =>
                    copyObjectsAsCsv(
                      "gasto por plataforma",
                      chartData.map((entry) => ({
                        plataforma: entry.platform,
                        gasto_brl: entry.spend_brl.toFixed(2),
                        pct_total: periodTotalSpend > 0 ? ((entry.spend_brl / periodTotalSpend) * 100).toFixed(2) : "0.00",
                      }))
                    )
                  }
                >
                  Copiar dados CSV
                </button>
                <button
                  type="button"
                  className="button buttonGhost buttonSmall"
                  onClick={() => exportChartAsPng(spendByPlatformChartRef.current, "gasto por plataforma")}
                >
                  Exportar PNG
                </button>
              </div>
            </div>
            {!chartData.length ? (
              <p className="alertInfo">Nenhum gasto em DSP com os filtros selecionados.</p>
            ) : (
            <div
              className="chartWrap"
              ref={spendByPlatformChartRef}
              role="img"
              aria-label={`Gráfico de gasto por plataforma no período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
            >
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={barChartData} layout="vertical">
                  <defs>
                    <linearGradient id="platformBarGradient" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="#22c55e" stopOpacity={0.95} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#334155" strokeDasharray="2 4" opacity={0.45} />
                  <XAxis type="number" stroke="#94a3b8" tickFormatter={formatCurrencyAxisTick} />
                  <YAxis
                    type="category"
                    dataKey="platform"
                    stroke="#cbd5e1"
                    width={140}
                    tickLine={false}
                    axisLine={false}
                    tick={<PlatformYAxisTick />}
                  />
                  <Tooltip content={<NumberTooltip totalValue={periodTotalSpend} />} />
                  <Bar dataKey="spend_brl" name="Gasto" barSize={20} radius={[0, 10, 10, 0]}>
                    {barChartData.map((entry) => (
                      <Cell key={entry.platform} fill={entry.color ?? "url(#platformBarGradient)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            )}
          </div>

          <div className="panel panelChart">
            <div className="panelHeading">
              <div>
                <h2>Distribuição</h2>
                <p>Participação de investimento</p>
              </div>
              <div className="panelHeadingActions">
                <button
                  type="button"
                  className="button buttonGhost buttonSmall"
                  onClick={() =>
                    copyObjectsAsCsv(
                      "distribuição de investimento",
                      chartData.map((entry) => ({
                        plataforma: entry.platform,
                        gasto_brl: entry.spend_brl.toFixed(2),
                        pct_total: periodTotalSpend > 0 ? ((entry.spend_brl / periodTotalSpend) * 100).toFixed(2) : "0.00",
                      }))
                    )
                  }
                >
                  Copiar dados CSV
                </button>
                <button
                  type="button"
                  className="button buttonGhost buttonSmall"
                  onClick={() => exportChartAsPng(distributionChartRef.current, "distribuição de investimento")}
                >
                  Exportar PNG
                </button>
              </div>
            </div>
            {!chartData.length ? (
              <p className="alertInfo">Nenhum gasto em DSP com os filtros selecionados.</p>
            ) : (
            <div
              className="chartWrap"
              ref={distributionChartRef}
              role="img"
              aria-label={`Gráfico de distribuição de gasto por plataforma no período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
            >
              {shouldFallbackPieChart ? (
                <div className="chartFallback">
                  <p className="chartFallbackTitle">Distribuição muito concentrada para donut.</p>
                  <p className="chartFallbackSubtitle">Mostrando proporções em barras para leitura mais clara.</p>
                  <div className="chartFallbackList">
                    {chartData.map((entry) => {
                      const pct = periodTotalSpend > 0 ? (entry.spend_brl / periodTotalSpend) * 100 : 0;
                      return (
                        <div key={entry.platform} className="chartFallbackItem">
                          <div className="chartFallbackItemHeader">
                            <span>{entry.platform}</span>
                            <span>{pct.toFixed(1)}%</span>
                          </div>
                          <div className="chartFallbackBarTrack">
                            <div
                              className="chartFallbackBarFill"
                              style={{ width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: entry.color }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={chartData}
                      dataKey="spend_brl"
                      nameKey="platform"
                      innerRadius={55}
                      outerRadius={92}
                      paddingAngle={2}
                      stroke="rgba(15, 23, 42, 0.9)"
                      strokeWidth={2}
                      label={({ percent }) => (percent && percent >= 0.08 ? `${(percent * 100).toFixed(0)}%` : "")}
                      labelLine={false}
                    >
                      {chartData.map((entry) => (
                        <Cell key={entry.platform} fill={entry.color} />
                      ))}
                    </Pie>
                    <text x="50%" y="46%" textAnchor="middle" dominantBaseline="middle" className="chartDonutLabel">
                      Total período
                    </text>
                    <text x="50%" y="56%" textAnchor="middle" dominantBaseline="middle" className="chartDonutValue">
                      {formatDonutCenterValue(periodTotalSpend)}
                    </text>
                    <Legend content={<PlatformLegend />} verticalAlign="bottom" align="center" />
                    <Tooltip content={<NumberTooltip totalValue={periodTotalSpend} />} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            )}
          </div>
        </section>

        <section className="panel panelChart">
          <div className="panelHeading">
            <div>
              <h2>Custo dia a dia</h2>
              <p>Evolução diária por plataforma</p>
            </div>
            <div className="panelHeadingActions">
              <button
                type="button"
                className="button buttonGhost buttonSmall"
                onClick={() =>
                  copyObjectsAsCsv(
                    "custo dia a dia",
                    data.dashboard.daily.map((row) => {
                      const baseRow: Record<string, string | number> = {
                        data: formatDateBr(String(row.date)),
                        total_brl: Number(row.total ?? 0).toFixed(2),
                      };
                      for (const platform of data.dashboard.active_platforms) {
                        baseRow[`${platform}_brl`] = Number(row[platform] ?? 0).toFixed(2);
                      }
                      return baseRow;
                    })
                  )
                }
              >
                Copiar dados CSV
              </button>
              <button
                type="button"
                className="button buttonGhost buttonSmall"
                onClick={() => exportChartAsPng(dailyCostChartRef.current, "custo dia a dia")}
              >
                Exportar PNG
              </button>
            </div>
          </div>
          {!data.dashboard.daily.length ? (
            <p className="alertInfo">Sem série diária disponível neste período.</p>
          ) : !hasDailyVariation ? (
            <p className="alertInfo">Sem variação diária neste período.</p>
          ) : (
            <div
              className="chartWrap chartWrapTall"
              ref={dailyCostChartRef}
              role="img"
              aria-label={`Gráfico de custo diário por plataforma no período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
            >
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={data.dashboard.daily}>
                  <CartesianGrid stroke="#334155" strokeDasharray="2 4" opacity={0.45} />
                  <XAxis
                    dataKey="date"
                    stroke="#94a3b8"
                    tickFormatter={(value) => formatDateBr(String(value))}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="#94a3b8"
                    tickFormatter={formatCurrencyAxisTick}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip content={<NumberTooltip />} labelFormatter={(label) => formatDateBr(String(label))} />
                  <Legend content={<PlatformLegend />} />
                  {data.dashboard.active_platforms.map((platform) => (
                    <Line
                      key={platform}
                      type="monotone"
                      dataKey={platform}
                      stroke={PLATFORM_COLORS[platform] ?? "#6366f1"}
                      strokeWidth={2.5}
                      dot={false}
                      activeDot={{ r: 5, strokeWidth: 2, stroke: "#0f172a" }}
                    />
                  ))}
                  <Line
                    type="monotone"
                    dataKey="total"
                    stroke="#e2e8f0"
                    strokeWidth={2.5}
                    strokeDasharray="4 4"
                    dot={false}
                    activeDot={{ r: 5, strokeWidth: 2, stroke: "#0f172a" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="panel panelChart">
          <div className="tableHeader">
            <h2>Jornada de Campanhas</h2>
            <button type="button" className="button buttonGhost buttonSmall" onClick={handleExportCampaignJourney}>
              Exportar CSV
            </button>
          </div>
          <div className="filterChips">
            {clients.map((client) => {
              const selected = clientFilter.includes(client);
              return (
                <button
                  key={client}
                  className={`chip ${selected ? "chipActive" : ""}`}
                  onClick={() =>
                    setClientFilter((prev) =>
                      prev.includes(client) ? prev.filter((c) => c !== client) : [...prev, client]
                    )
                  }
                >
                  {client}
                </button>
              );
            })}
          </div>

          {data.journey_status === "error" ? (
            <p className="alertError">Erro ao ler planilha: {data.journey_message ?? "erro desconhecido"}</p>
          ) : !campaignRows.length ? (
            <p className="alertInfo">Nenhum token com gasto no mês corrente encontrado nas plataformas.</p>
          ) : (
            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Cliente</th>
                    <th>Campanha</th>
                    <th>Account Management</th>
                    <th>Status</th>
                    <th>Investido</th>
                    {data.dashboard.active_platforms.map((platform) => (
                      <th key={platform}>{platform}</th>
                    ))}
                    <th>Total Plataformas</th>
                    <th>% Investido</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignRows.map((row, index) => (
                    <tr
                      key={`${row.token}-${row.campanha}-${index}`}
                      className="campaignJourneyRow"
                      role="button"
                      tabIndex={0}
                      onClick={() => router.push(routeForCampaign(row.token, resolvedActivePage))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          router.push(routeForCampaign(row.token, resolvedActivePage));
                        }
                      }}
                    >
                      <td>{row.token}</td>
                      <td>{row.cliente}</td>
                      <td>{row.campanha}</td>
                      <td>
                        {String(row.account_management ?? "").trim() ? (
                          <span className="accountManagerCell">
                            {getAccountManagerAvatar(String(row.account_management)) ? (
                              <Image
                                src={getAccountManagerAvatar(String(row.account_management))!}
                                alt={`Foto de ${String(row.account_management)}`}
                                width={22}
                                height={22}
                                className="accountManagerAvatar"
                              />
                            ) : null}
                            <span>{String(row.account_management)}</span>
                            <a
                              href={getCampaignReferenceWhatsAppUrl(String(row.account_management), {
                                campanha: row.campanha,
                                token: row.token,
                              })}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="accountManagerWhatsappLink"
                              aria-label={`Conversar com ${String(row.account_management)} no WhatsApp`}
                              title="Abrir conversa no WhatsApp"
                            >
                              <WhatsAppIcon />
                            </a>
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{row.status}</td>
                      <td>{brl(row.investido)}</td>
                      {data.dashboard.active_platforms.map((platform) => (
                        <td key={`${row.token}-${platform}`}>{brl(Number(row[platform] ?? 0))}</td>
                      ))}
                      <td>{brl(row.total_plataformas)}</td>
                      <td>{row.pct_investido.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </>
    );
  };

  const renderPlatformPage = (
    platformName: Exclude<NavKey, "Dashboard" | "⚠️ Lines sem token" | "🚨 Gasto fora do mês vigente">
  ) => {
    if (!data) return null;
    const page = data.platform_pages[platformName];
    if (!page) return <p className="alertInfo">Sem dados desta plataforma no período.</p>;
    if (platformName === "Nexd") {
      const cap = page.cap ?? 1;
      const impressions = page.impressions ?? 0;
      const usedPct = Math.max(0, Math.min(100, cap > 0 ? (impressions / cap) * 100 : 0));
      const remainingImpressions = Math.max(0, cap - impressions);
      const remainingPct = Math.max(0, 100 - usedPct);
      const progressColor = usedPct >= 80 ? "#ef4444" : usedPct >= 60 ? "#f59e0b" : "#3b82f6";
      const nexdFormatPieData = (page.layouts ?? [])
        .map((row, index) => ({
          name: row.layout,
          value: Number(row.estimated_cost_brl ?? 0),
          color: [
            "#3b82f6",
            "#06b6d4",
            "#8b5cf6",
            "#22c55e",
            "#f59e0b",
            "#ef4444",
            "#14b8a6",
            "#a855f7",
          ][index % 8],
        }))
        .filter((row) => row.value > 0);
      const nexdFormatPieTotal = nexdFormatPieData.reduce((sum, row) => sum + row.value, 0);
      return (
        <section className="panel">
          <h2>Nexd</h2>
          <p className="muted nexdSummaryLine">{brl(page.spend_brl)} • {impressions.toLocaleString("pt-BR")} impressões</p>
          <div className="panelSub" ref={nexdUsageChartRef}>
            <div className="panelSubHeading">
              <h3>Uso do pacote</h3>
              <button
                type="button"
                className="button buttonGhost buttonSmall"
                onClick={() => exportChartAsPng(nexdUsageChartRef.current, "nexd uso do pacote")}
              >
                Exportar PNG
              </button>
            </div>
            <div style={{ padding: "8px 4px 4px" }}>
              <div
                style={{
                  width: "100%",
                  height: "18px",
                  borderRadius: "999px",
                  background: "rgba(148, 163, 184, 0.25)",
                  overflow: "hidden",
                }}
                aria-label="Uso do pacote Nexd"
              >
                <div
                  style={{
                    width: `${usedPct.toFixed(2)}%`,
                    height: "100%",
                    borderRadius: "999px",
                    background: progressColor,
                    transition: "width 0.35s ease",
                  }}
                />
              </div>
              <div
                style={{
                  marginTop: "10px",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "12px",
                  color: "#9fb0c8",
                  fontSize: "0.95rem",
                }}
              >
                <span>{usedPct.toFixed(1)}% usado</span>
                <span>{remainingPct.toFixed(1)}% restante</span>
              </div>
            </div>
            <p className="muted">
              Cap: {cap.toLocaleString("pt-BR")} • Restam: {remainingImpressions.toLocaleString("pt-BR")}
            </p>
          </div>

          <div className="panelSub">
            <h3>Por campanha</h3>
            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th>Campanha</th>
                    <th>Impressões</th>
                    <th>% do total</th>
                  </tr>
                </thead>
                <tbody>
                  {(page.campaigns ?? []).map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td>{row.impressions.toLocaleString("pt-BR")}</td>
                      <td>{impressions > 0 ? `${((row.impressions / impressions) * 100).toFixed(1)}%` : "0.0%"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {(page.layouts ?? []).length ? (
            <div className="panelSub">
              <div className="panelSubHeading">
                <div className="panelSubTitleWithInfo">
                  <h3>Por formato</h3>
                  <span
                    className="infoTooltipIcon"
                    title="Custo estimado por formato = impressões do formato x 0,0014 BRL (CPM fixo de R$ 1,40). A API da Nexd não retorna custo real por formato."
                    aria-label="Disclaimer: custo por formato é estimado por CPM fixo"
                  >
                    i
                  </span>
                </div>
              </div>
              {nexdFormatPieData.length ? (
                <>
                <div className="chartWrap chartWrapSmall">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={nexdFormatPieData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={62}
                        outerRadius={96}
                        paddingAngle={2}
                        stroke="rgba(15, 23, 42, 0.7)"
                        strokeWidth={1}
                      >
                        {nexdFormatPieData.map((entry) => (
                          <Cell key={entry.name} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value) => brl(Number(Array.isArray(value) ? value[0] : value ?? 0))}
                        labelFormatter={(label) => `Formato: ${label}`}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="chartLegend">
                  {nexdFormatPieData.map((entry) => (
                    <div className="chartLegendItem" key={`nexd-format-${entry.name}`}>
                      <span className="chartLegendDot" style={{ backgroundColor: entry.color }} />
                      <span>
                        {entry.name}{" "}
                        {nexdFormatPieTotal > 0 ? `(${((entry.value / nexdFormatPieTotal) * 100).toFixed(1)}%)` : "(0.0%)"}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="muted">Total do custo estimado por formato: {brl(nexdFormatPieTotal)}</p>
                </>
              ) : null}
              <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>Formato</th>
                      <th>Impressões</th>
                      <th>Custo estimado (BRL)</th>
                      <th>% custo estimado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(page.layouts ?? []).map((row) => (
                      <tr key={row.layout}>
                        <td>{row.layout}</td>
                        <td>{row.impressions.toLocaleString("pt-BR")}</td>
                        <td>{brl(Number(row.estimated_cost_brl ?? 0))}</td>
                        <td>{`${Number(row.pct_estimated_cost ?? 0).toFixed(1)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </section>
      );
    }

    const rows = page.rows ?? [];
    const isDetailedLinePlatform = ["StackAdapt", "DV360", "Xandr"].includes(platformName);
    if (isDetailedLinePlatform) {
      const rowsForPlatform = platformName === resolvedActivePage ? filteredDetailedPlatformRows : rows;
      const {
        rowsWithToken,
        rowsWithoutToken,
        activeCampaignsCount,
        sortedRows,
        filteredTotalGasto,
      } = detailedPlatformDerived;
      const lineDetailFiltersActive =
        hasDashboardFilters || stackAdaptSearch.trim() !== "" || dspLinesOnlyWithoutToken;
      const budget = getBudgetForPlatform(platformName, page.spend_brl);
      const handleExportDetailedLines = () => {
        const headers = [
          "Line",
          "Token",
          "Cliente",
          "Campanha",
          "Gasto",
          "Investido",
          "% do budget investido",
          "% do total",
          "Account Management",
        ];
        const rowsToExport = sortedRows.map((row) => [
          row.line,
          row.token,
          row.cliente,
          row.campanha,
          row.gasto,
          row.investido,
          row.pct_invest,
          filteredTotalGasto > 0 ? (row.gasto / filteredTotalGasto) * 100 : 0,
          row.account_management,
        ]);
        downloadCsv(`lines-${platformName.toLowerCase().replace(/\s+/g, "-")}.csv`, headers, rowsToExport);
      };

      return (
        <>
          <section className="panel panelSub filterPanelCard">
            <h3>Filtros do dashboard</h3>
            <p className="muted filterPanelHint">
              Os mesmos filtros da home (Cliente, CS, Tipo, Campanha e Status). Eles refinam os cards, os
              contadores e a tabela desta DSP; a busca e o chip &quot;só sem token&quot; continuam valendo
              por cima.
            </p>
            <div className="filterToolbar">
              <MultiSelectFilter
                id={`dsp-filter-client-${platformName}`}
                label="Cliente"
                options={clients}
                value={clientFilter}
                onChange={setClientFilter}
                placeholder="Todos os clientes"
                disabledOptions={disabledClientOptions}
              />
              <MultiSelectFilter
                id={`dsp-filter-cs-${platformName}`}
                label="CS (Account Management)"
                options={csFilterOptions}
                value={csFilter}
                onChange={setCsFilter}
                placeholder="Todos os CS"
                showAvatar
                disabledOptions={disabledCsOptions}
              />
              <MultiSelectFilter
                id={`dsp-filter-campaign-type-${platformName}`}
                label="Tipo"
                options={[...CAMPAIGN_TYPE_OPTIONS]}
                value={campaignTypeFilter}
                onChange={setCampaignTypeFilter}
                placeholder="Todos os tipos"
                disabledOptions={disabledCampaignTypeOptions}
              />
              <MultiSelectFilter
                id={`dsp-filter-campaign-${platformName}`}
                label="Campanha"
                options={campaignFilterOptions}
                value={campaignFilter}
                onChange={setCampaignFilter}
                placeholder="Todas as campanhas"
                disabledOptions={disabledCampaignOptions}
              />
              <MultiSelectFilter
                id={`dsp-filter-campaign-status-${platformName}`}
                label="Status da campanha"
                options={campaignStatusOptions}
                value={campaignStatusFilter}
                onChange={setCampaignStatusFilter}
                placeholder="Todos os status"
                disabledOptions={disabledCampaignStatusOptions}
              />
              {hasDashboardFilters ? (
                <button
                  type="button"
                  className="button buttonGhost buttonSmall filterClearButton"
                  onClick={() => {
                    setClientFilter([]);
                    setCsFilter([]);
                    setCampaignTypeFilter([]);
                    setCampaignFilter([]);
                    setCampaignStatusFilter([]);
                  }}
                >
                  Limpar filtros
                </button>
              ) : null}
            </div>
          </section>

          <section className="gridCards">
            <KpiCard
              title={platformName}
              value={brl(lineDetailFiltersActive ? filteredTotalGasto : page.spend_brl)}
              subtitle={
                lineDetailFiltersActive
                  ? "Subtotal em BRL das lines exibidas na tabela (após filtros e busca)."
                  : page.currency === "USD"
                    ? `USD ${(page.spend_usd ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                    : "Consolidado no período"
              }
              titleEmphasis
              logoSrc={PLATFORM_LOGOS[platformName]}
              budget={budget}
            />
            <div className="card platformStatCard">
              <p className="cardTitle">Lines ativas</p>
              <p className="cardValue">{rowsForPlatform.length.toLocaleString("pt-BR")}</p>
              <p className="cardSubtitle">{rowsWithToken.toLocaleString("pt-BR")} com token identificado</p>
            </div>
            <button
              type="button"
              className={`card platformStatCard cardClickable platformStatCardNoTokenButton ${rowsWithoutToken > 0 ? "platformStatCardAlert" : ""} ${dspLinesOnlyWithoutToken ? "platformStatCardNoTokenActive" : ""}`}
              aria-pressed={dspLinesOnlyWithoutToken}
              aria-label="Alternar filtro: mostrar só lines sem token na tabela abaixo"
              onClick={() => setDspLinesOnlyWithoutToken((prev) => !prev)}
            >
              <p className="cardTitle">Lines sem token</p>
              <p className="cardValue">{rowsWithoutToken.toLocaleString("pt-BR")}</p>
              <p className="cardSubtitle">
                {rowsWithoutToken > 0 ? "Requer atenção imediata para auditoria" : "Todas as lines com token identificado"}
              </p>
            </button>
            <div className="card platformStatCard">
              <p className="cardTitle">Campanhas ativas</p>
              <p className="cardValue">{activeCampaignsCount.toLocaleString("pt-BR")}</p>
              <p className="cardSubtitle">Com gasto no período selecionado</p>
            </div>
          </section>

          {!rows.length ? (
            <p className="alertInfo">Nenhuma line com gasto encontrada.</p>
          ) : (
            <section className="card stackDetailCard">
              <div className="stackDetailHeader">
                <div>
                  <p className="cardTitle">Detalhamento de lines</p>
                </div>
                <div className="stackDetailHeaderActions stackDetailHeaderActionsColumn">
                  <div className="tableTopActions">
                    <button type="button" className="button buttonGhost buttonSmall" onClick={handleExportDetailedLines}>
                      Exportar CSV
                    </button>
                  </div>
                  <div className="stackDetailFilterInline">
                    <button
                      type="button"
                      className={`chip chipDspFilter ${dspLinesOnlyWithoutToken ? "chipDspFilterOn" : ""}`}
                      aria-pressed={dspLinesOnlyWithoutToken}
                      onClick={() => setDspLinesOnlyWithoutToken((prev) => !prev)}
                    >
                      Só lines sem token
                    </button>
                    <input
                      className="stackSearchInput"
                      type="search"
                      value={stackAdaptSearch}
                      onChange={(event) => setStackAdaptSearch(event.target.value)}
                      placeholder="Buscar por id, token, cliente e campanha"
                      aria-label={`Buscar lines da ${platformName}`}
                    />
                  </div>
                </div>
              </div>
              <p className="stackDetailCounter">
                {sortedRows.length.toLocaleString("pt-BR")} linha(s) encontrada(s) • Total: {brl(filteredTotalGasto)}
              </p>
              <div className="tableWrap">
                <table className="stackDetailTable">
                  <colgroup>
                    <col className="stackColLine" />
                    <col className="stackColToken" />
                    <col className="stackColCliente" />
                    <col className="stackColCampanha" />
                    <col className="stackColGasto" />
                    <col className="stackColInvestido" />
                    <col className="stackColPct" />
                    <col className="stackColTotal" />
                    <col className="stackColAccountManager" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>
                        <button type="button" className="stackSortButton" onClick={() => toggleStackAdaptSort("line")}>
                          <span>Line</span>
                          <span>{stackSortIndicator("line")}</span>
                        </button>
                      </th>
                      <th>
                        <button type="button" className="stackSortButton" onClick={() => toggleStackAdaptSort("token")}>
                          <span>Token</span>
                          <span>{stackSortIndicator("token")}</span>
                        </button>
                      </th>
                      <th>
                        <button type="button" className="stackSortButton" onClick={() => toggleStackAdaptSort("cliente")}>
                          <span>Cliente</span>
                          <span>{stackSortIndicator("cliente")}</span>
                        </button>
                      </th>
                      <th>
                        <button type="button" className="stackSortButton" onClick={() => toggleStackAdaptSort("campanha")}>
                          <span>Campanha</span>
                          <span>{stackSortIndicator("campanha")}</span>
                        </button>
                      </th>
                      <th>
                        <button type="button" className="stackSortButton" onClick={() => toggleStackAdaptSort("gasto")}>
                          <span>Gasto</span>
                          <span>{stackSortIndicator("gasto")}</span>
                        </button>
                      </th>
                      <th>
                        <button type="button" className="stackSortButton" onClick={() => toggleStackAdaptSort("investido")}>
                          <span>Investido</span>
                          <span>{stackSortIndicator("investido")}</span>
                        </button>
                      </th>
                      <th>
                        <button type="button" className="stackSortButton" onClick={() => toggleStackAdaptSort("pct_invest")}>
                          <span>% budget</span>
                          <span>{stackSortIndicator("pct_invest")}</span>
                        </button>
                      </th>
                      <th>
                        <button type="button" className="stackSortButton" onClick={() => toggleStackAdaptSort("total")}>
                          <span>Total</span>
                          <span>{stackSortIndicator("total")}</span>
                        </button>
                      </th>
                      <th>Account Management</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row, index) => (
                      <tr
                        key={`${row.line}-${row.token}-${row.cliente}-${row.campanha}-${index}`}
                        className={hasCampaignToken(row.token) ? "campaignJourneyRow" : "missingTokenRow"}
                        role={hasCampaignToken(row.token) ? "button" : undefined}
                        tabIndex={hasCampaignToken(row.token) ? 0 : undefined}
                        onClick={() => {
                          if (!hasCampaignToken(row.token)) return;
                          router.push(routeForCampaign(row.token, resolvedActivePage));
                        }}
                        onKeyDown={(event) => {
                          if (!hasCampaignToken(row.token)) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            router.push(routeForCampaign(row.token, resolvedActivePage));
                          }
                        }}
                      >
                        <td className="stackLineCell">
                          <div className="copyCell">
                            <button
                              type="button"
                              className="copyIconButton"
                              aria-label={`Copiar line ${row.line}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void copyToClipboard(row.line, "Line");
                              }}
                            >
                              ⧉
                            </button>
                            <span>{row.line}</span>
                          </div>
                        </td>
                        <td className="stackTokenCell">
                          <div className="copyCell">
                            <button
                              type="button"
                              className="copyIconButton"
                              aria-label={`Copiar token ${row.token}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void copyToClipboard(row.token, "Token");
                              }}
                              disabled={!row.token || row.token === "—"}
                            >
                              ⧉
                            </button>
                            <span>{row.token}</span>
                          </div>
                        </td>
                        <td>{row.cliente}</td>
                        <td>{row.campanha}</td>
                        <td className="stackNumericCell stackGastoCell">{brl(row.gasto)}</td>
                        <td className="stackNumericCell">{row.investido ? brl(row.investido) : "—"}</td>
                        <td className="stackNumericCell">{row.pct_invest !== null ? `${row.pct_invest.toFixed(1)}%` : "—"}</td>
                        <td className="stackNumericCell">
                          {filteredTotalGasto > 0 ? `${((row.gasto / filteredTotalGasto) * 100).toFixed(1)}%` : "0.0%"}
                        </td>
                        <td className="stackAccountManagerCell">
                          {row.account_management && row.account_management !== "—" ? (
                            <span className="accountManagerCell">
                              {getAccountManagerAvatar(row.account_management) ? (
                                <Image
                                  src={getAccountManagerAvatar(row.account_management)!}
                                  alt={`Foto de ${row.account_management}`}
                                  width={22}
                                  height={22}
                                  className="accountManagerAvatar"
                                />
                              ) : null}
                              <span className="accountManagerName">{row.account_management}</span>
                              <a
                                href={getCampaignReferenceWhatsAppUrl(row.account_management, {
                                  campanha: row.campanha,
                                  token: row.token,
                                  platform: platformName,
                                  line: row.line,
                                })}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="accountManagerWhatsappLink"
                                aria-label={`Conversar com ${row.account_management} no WhatsApp`}
                                title="Abrir conversa no WhatsApp"
                              >
                                <WhatsAppIcon />
                              </a>
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!sortedRows.length ? (
                <p className="alertInfo">Nenhuma line encontrada para a busca ou o filtro ativo.</p>
              ) : null}
            </section>
          )}
        </>
      );
    }

    const simpleDspTableRows = dspLinesOnlyWithoutToken
      ? rows.filter((row) => !hasCampaignToken(row.token))
      : rows;
    const handleExportSimpleDspRows = () => {
      const headers = ["Line", "Token", "Cliente", "Campanha", "Gasto", "Investido", "% do budget investido", "Account Management"];
      const rowsToExport = simpleDspTableRows.map((row) => [
        row.line,
        row.token,
        row.cliente,
        row.campanha,
        row.gasto,
        row.investido,
        row.pct_invest,
        row.account_management,
      ]);
      downloadCsv(`lines-${platformName.toLowerCase().replace(/\s+/g, "-")}.csv`, headers, rowsToExport);
    };

    return (
      <section className="panel">
        <h2>{platformName}</h2>
        <p className="muted">
          {brl(page.spend_brl)}
          {page.currency === "USD" ? ` • USD ${(page.spend_usd ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : ""}
        </p>
        {!rows.length ? (
          <p className="alertInfo">Nenhuma line com gasto encontrada.</p>
        ) : (
          <>
            <div className="tableTopActions">
              <button type="button" className="button buttonGhost buttonSmall" onClick={handleExportSimpleDspRows}>
                Exportar CSV
              </button>
            </div>
            <div className="stackDetailHeaderActions dspPanelTableToolbar">
              <button
                type="button"
                className={`chip chipDspFilter ${dspLinesOnlyWithoutToken ? "chipDspFilterOn" : ""}`}
                aria-pressed={dspLinesOnlyWithoutToken}
                onClick={() => setDspLinesOnlyWithoutToken((prev) => !prev)}
              >
                Só lines sem token
              </button>
            </div>
            {!simpleDspTableRows.length ? (
              <p className="alertInfo">Nenhuma line encontrada para o filtro ativo.</p>
            ) : (
              <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>Token</th>
                      <th>Cliente</th>
                      <th>Campanha</th>
                      <th>Gasto</th>
                      <th>Investido</th>
                      <th>% budget</th>
                      <th>Account Management</th>
                    </tr>
                  </thead>
                  <tbody>
                    {simpleDspTableRows.map((row, index) => (
                      <tr
                        key={`${row.line}-${row.token}-${row.cliente}-${row.campanha}-${index}`}
                        className={hasCampaignToken(row.token) ? "campaignJourneyRow" : "missingTokenRow"}
                        role={hasCampaignToken(row.token) ? "button" : undefined}
                        tabIndex={hasCampaignToken(row.token) ? 0 : undefined}
                        onClick={() => {
                          if (!hasCampaignToken(row.token)) return;
                          router.push(routeForCampaign(row.token, resolvedActivePage));
                        }}
                        onKeyDown={(event) => {
                          if (!hasCampaignToken(row.token)) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            router.push(routeForCampaign(row.token, resolvedActivePage));
                          }
                        }}
                      >
                        <td>{row.line}</td>
                        <td>{row.token}</td>
                        <td>{row.cliente}</td>
                        <td>{row.campanha}</td>
                        <td>{brl(row.gasto)}</td>
                        <td>{row.investido ? brl(row.investido) : "—"}</td>
                        <td>{row.pct_invest !== null ? `${row.pct_invest.toFixed(1)}%` : "—"}</td>
                        <td className="stackAccountManagerCell">
                          {row.account_management && row.account_management !== "—" ? (
                            <span className="accountManagerCell">
                              {getAccountManagerAvatar(row.account_management) ? (
                                <Image
                                  src={getAccountManagerAvatar(row.account_management)!}
                                  alt={`Foto de ${row.account_management}`}
                                  width={22}
                                  height={22}
                                  className="accountManagerAvatar"
                                />
                              ) : null}
                              <span className="accountManagerName">{row.account_management}</span>
                              <a
                                href={getCampaignReferenceWhatsAppUrl(row.account_management, {
                                  campanha: row.campanha,
                                  token: row.token,
                                  platform: platformName,
                                  line: row.line,
                                })}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="accountManagerWhatsappLink"
                                aria-label={`Conversar com ${row.account_management} no WhatsApp`}
                                title="Abrir conversa no WhatsApp"
                              >
                                <WhatsAppIcon />
                              </a>
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    );
  };

  const renderNoTokenAttentionPage = () => {
    if (!data) return null;
    const sortedNoTokenRows = noTokenDerived.sortedRows;
    const filteredNoTokenTotal = noTokenDerived.filteredTotal;
    const handleExportNoToken = () => {
      const headers = ["Plataforma", "Line", "Gasto"];
      const rowsToExport = sortedNoTokenRows.map((row) => [row.platform, row.line, row.gasto]);
      downloadCsv("lines-sem-token.csv", headers, rowsToExport);
    };

    return (
      <>
        <section className="attentionNoTokenTopRow" aria-label="Resumo lines sem token">
          <div className="attentionNoTokenKpiStack">
            <div className="card platformStatCard">
              <p className="cardTitle">Total de lines</p>
              <p className="cardValue">{noTokenRows.length.toLocaleString("pt-BR")}</p>
              <p className="cardSubtitle">Sem token identificado no período</p>
            </div>
            <div className="card platformStatCard">
              <p className="cardTitle">Total de gasto</p>
              <p className="cardValue">{brl(data.attention.no_token_total_brl)}</p>
              <p className="cardSubtitle">Sem cruzamento com a planilha</p>
            </div>
          </div>
          <div className="panel panelChart attentionNoTokenPiePanel">
            <div className="panelHeading">
              <div>
                <h2>Gasto por DSP</h2>
                <p>Distribuição do gasto sem token</p>
              </div>
              <button
                type="button"
                className="button buttonGhost buttonSmall"
                onClick={() => exportChartAsPng(noTokenDistributionChartRef.current, "gasto sem token por dsp")}
              >
                Exportar PNG
              </button>
            </div>
            <div
              className="chartWrap"
              ref={noTokenDistributionChartRef}
              role="img"
              aria-label={`Gráfico de distribuição de gasto sem token no período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
            >
              {noTokenPieChartData.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={noTokenPieChartData}
                      dataKey="spend_brl"
                      nameKey="platform"
                      innerRadius={55}
                      outerRadius={92}
                      paddingAngle={2}
                      stroke="rgba(15, 23, 42, 0.9)"
                      strokeWidth={2}
                    >
                      {noTokenPieChartData.map((entry) => (
                        <Cell key={entry.platform} fill={entry.color} />
                      ))}
                    </Pie>
                    <Legend content={<PlatformLegend />} verticalAlign="bottom" align="center" />
                    <Tooltip content={<NumberTooltip totalValue={noTokenPieTotal} />} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="alertInfo attentionNoTokenPieEmpty">Nenhum gasto por plataforma para exibir.</p>
              )}
            </div>
          </div>
        </section>

        <section className="card stackDetailCard alertSignalCard alertSignalCardWarning">
          <p className="alertSignalBadge">Atenção necessária</p>
          <section id="lines-sem-token">
            <div className="stackDetailHeader">
              <div>
                <p className="cardTitle">Lines sem token</p>
                <p className="stackDetailSubtitle">Gasto que não pode ser cruzado com a planilha</p>
              </div>
              <div className="stackDetailHeaderSearchColumn">
                <div className="tableTopActions">
                  <button type="button" className="button buttonGhost buttonSmall" onClick={handleExportNoToken}>
                    Exportar CSV
                  </button>
                </div>
                <input
                  className="stackSearchInput"
                  type="search"
                  value={attentionNoTokenSearch}
                  onChange={(event) => setAttentionNoTokenSearch(event.target.value)}
                  placeholder="Buscar por plataforma, line e gasto"
                  aria-label="Buscar lines sem token"
                />
                {noTokenRows.length > 0 && noTokenUniquePlatforms.length > 0 ? (
                  <div className="stackDetailFilterInline attentionDspFilterRow" role="group" aria-label="Filtrar por DSP">
                    <span className="attentionDspFilterLabel">DSPs</span>
                    <button
                      type="button"
                      className={`chip chipDspFilter ${attentionNoTokenDspFilters.length === 0 ? "chipDspFilterOn" : ""}`}
                      onClick={() => setAttentionNoTokenDspFilters([])}
                    >
                      Todas
                    </button>
                    {noTokenUniquePlatforms.map((platform) => (
                      <AttentionDspFilterChipButton
                        key={platform}
                        platform={platform}
                        pressed={attentionNoTokenDspFilters.includes(platform)}
                        onClick={() => {
                          setAttentionNoTokenDspFilters((prev) => {
                            if (prev.length === 0) return [platform];
                            if (prev.includes(platform)) return prev.filter((p) => p !== platform);
                            return [...prev, platform];
                          });
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            {noTokenRows.length ? (
              <>
                <p className="stackDetailCounter">
                  {sortedNoTokenRows.length.toLocaleString("pt-BR")} linha(s) encontrada(s) • Total filtrado:{" "}
                  {brl(filteredNoTokenTotal)}
                </p>
              <div className="tableWrap">
                <table className="attentionDetailTable">
                  <thead>
                    <tr>
                      <th>
                        <button
                          type="button"
                          className="stackSortButton"
                          onClick={() => toggleAttentionNoTokenSort("platform")}
                        >
                          <span>Plataforma</span>
                          <span>{attentionNoTokenSortIndicator("platform")}</span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="stackSortButton"
                          onClick={() => toggleAttentionNoTokenSort("line")}
                        >
                          <span>Line</span>
                          <span>{attentionNoTokenSortIndicator("line")}</span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="stackSortButton"
                          onClick={() => toggleAttentionNoTokenSort("gasto")}
                        >
                          <span>Gasto</span>
                          <span>{attentionNoTokenSortIndicator("gasto")}</span>
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedNoTokenRows.map((row, index) => (
                      <tr key={`${row.platform}-${row.line}-${index}`}>
                        <td>{row.platform}</td>
                        <td>{row.line}</td>
                        <td>{brl(row.gasto)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!sortedNoTokenRows.length ? (
                <p className="alertInfo">Nenhuma line sem token encontrada para a busca informada.</p>
              ) : null}
            </>
          ) : (
            <p className="alertSuccess">Todas as lines têm token identificado.</p>
          )}
        </section>
      </section>
      </>
    );
  };

  const renderOutOfPeriodAttentionPage = () => {
    if (!data) return null;
    const outRows = outOfPeriodRows;
    const sortedOutRows = outOfPeriodDerived.sortedRows;
    const filteredOutRowsTotal = outOfPeriodDerived.filteredTotal;
    const handleExportOutOfPeriod = () => {
      const headers = [
        "Plataforma",
        "Token",
        "Cliente",
        "Campanha",
        "Account Management",
        "Vigência Início",
        "Vigência Fim",
        "Gasto",
      ];
      const rowsToExport = sortedOutRows.map((row) => [
        row.platform,
        row.token,
        row.cliente,
        row.campanha,
        row.account_management,
        row.vigencia_start,
        row.vigencia_end,
        row.gasto,
      ]);
      downloadCsv("gasto-fora-mes-vigente.csv", headers, rowsToExport);
    };

    return (
      <>
        <section className="attentionNoTokenTopRow" aria-label="Resumo gasto fora do mês vigente">
          <div className="attentionNoTokenKpiStack">
            <div className="card platformStatCard">
              <p className="cardTitle">Total de campanhas</p>
              <p className="cardValue">{outOfPeriodRows.length.toLocaleString("pt-BR")}</p>
              <p className="cardSubtitle">Fora do período vigente</p>
            </div>
            <div className="card platformStatCard">
              <p className="cardTitle">Total de gasto</p>
              <p className="cardValue">{brl(data.attention.out_of_period_total_brl)}</p>
              <p className="cardSubtitle">Sem cobertura de vigência no período atual</p>
            </div>
          </div>
          <div className="panel panelChart attentionNoTokenPiePanel">
            <div className="panelHeading">
              <div>
                <h2>Gasto por DSP</h2>
                <p>Distribuição do gasto fora do mês vigente</p>
              </div>
              <button
                type="button"
                className="button buttonGhost buttonSmall"
                onClick={() => exportChartAsPng(outOfPeriodDistributionChartRef.current, "gasto fora do mês por dsp")}
              >
                Exportar PNG
              </button>
            </div>
            <div
              className="chartWrap"
              ref={outOfPeriodDistributionChartRef}
              role="img"
              aria-label={`Gráfico de distribuição de gasto fora do mês vigente no período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
            >
              {outOfPeriodPieChartData.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={outOfPeriodPieChartData}
                      dataKey="spend_brl"
                      nameKey="platform"
                      innerRadius={55}
                      outerRadius={92}
                      paddingAngle={2}
                      stroke="rgba(15, 23, 42, 0.9)"
                      strokeWidth={2}
                    >
                      {outOfPeriodPieChartData.map((entry) => (
                        <Cell key={entry.platform} fill={entry.color} />
                      ))}
                    </Pie>
                    <Legend content={<PlatformLegend />} verticalAlign="bottom" align="center" />
                    <Tooltip content={<NumberTooltip totalValue={outOfPeriodPieTotal} />} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="alertInfo attentionNoTokenPieEmpty">Nenhum gasto por plataforma para exibir.</p>
              )}
            </div>
          </div>
        </section>

        <section className="card stackDetailCard alertSignalCard alertSignalCardDanger">
          <p className="alertSignalBadge">Risco de vigência</p>
          <section id="gasto-fora-mes">
            <div className="stackDetailHeader">
              <div>
                <p className="cardTitle">Gasto fora do mês vigente</p>
                <p className="stackDetailSubtitle">Campanhas cujas datas não cobrem o período atual</p>
              </div>
              <div className="stackDetailHeaderSearchColumn">
                <div className="tableTopActions">
                  <button type="button" className="button buttonGhost buttonSmall" onClick={handleExportOutOfPeriod}>
                    Exportar CSV
                  </button>
                </div>
                <input
                  className="stackSearchInput"
                  type="search"
                  value={attentionOutOfPeriodSearch}
                  onChange={(event) => setAttentionOutOfPeriodSearch(event.target.value)}
                  placeholder="Buscar por token, cliente, campanha, account e vigência"
                  aria-label="Buscar gastos fora do mês vigente"
                />
                {outRows.length > 0 && outOfPeriodUniquePlatforms.length > 0 ? (
                  <div className="stackDetailFilterInline attentionDspFilterRow" role="group" aria-label="Filtrar por DSP">
                    <span className="attentionDspFilterLabel">DSPs</span>
                    <button
                      type="button"
                      className={`chip chipDspFilter ${attentionOutOfPeriodDspFilters.length === 0 ? "chipDspFilterOn" : ""}`}
                      onClick={() => setAttentionOutOfPeriodDspFilters([])}
                    >
                      Todas
                    </button>
                    {outOfPeriodUniquePlatforms.map((platform) => (
                      <AttentionDspFilterChipButton
                        key={platform}
                        platform={platform}
                        pressed={attentionOutOfPeriodDspFilters.includes(platform)}
                        onClick={() => {
                          setAttentionOutOfPeriodDspFilters((prev) => {
                            if (prev.length === 0) return [platform];
                            if (prev.includes(platform)) return prev.filter((p) => p !== platform);
                            return [...prev, platform];
                          });
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            {outRows.length ? (
              <>
                <p className="stackDetailCounter">
                  {sortedOutRows.length.toLocaleString("pt-BR")} campanha(s) encontrada(s) • Total filtrado:{" "}
                  {brl(filteredOutRowsTotal)}
                </p>
                <div className="tableWrap">
                <table className="attentionDetailTable">
                  <thead>
                    <tr>
                      <th>
                        <button
                          type="button"
                          className="stackSortButton"
                          onClick={() => toggleAttentionOutOfPeriodSort("platform")}
                        >
                          <span>Plataforma</span>
                          <span>{attentionOutOfPeriodSortIndicator("platform")}</span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="stackSortButton"
                          onClick={() => toggleAttentionOutOfPeriodSort("token")}
                        >
                          <span>Token</span>
                          <span>{attentionOutOfPeriodSortIndicator("token")}</span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="stackSortButton"
                          onClick={() => toggleAttentionOutOfPeriodSort("cliente")}
                        >
                          <span>Cliente</span>
                          <span>{attentionOutOfPeriodSortIndicator("cliente")}</span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="stackSortButton"
                          onClick={() => toggleAttentionOutOfPeriodSort("campanha")}
                        >
                          <span>Campanha</span>
                          <span>{attentionOutOfPeriodSortIndicator("campanha")}</span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="stackSortButton"
                          onClick={() => toggleAttentionOutOfPeriodSort("account_management")}
                        >
                          <span>Account Management</span>
                          <span>{attentionOutOfPeriodSortIndicator("account_management")}</span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="stackSortButton"
                          onClick={() => toggleAttentionOutOfPeriodSort("vigencia")}
                        >
                          <span>Vigência</span>
                          <span>{attentionOutOfPeriodSortIndicator("vigencia")}</span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="stackSortButton"
                          onClick={() => toggleAttentionOutOfPeriodSort("gasto")}
                        >
                          <span>Gasto</span>
                          <span>{attentionOutOfPeriodSortIndicator("gasto")}</span>
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedOutRows.map((row, index) => (
                      <tr
                        key={`${row.platform}-${row.token}-${row.cliente}-${row.campanha}-${row.vigencia_start ?? ""}-${row.vigencia_end ?? ""}-${index}`}
                      >
                        <td>{row.platform}</td>
                        <td>{row.token}</td>
                        <td>{row.cliente}</td>
                        <td>{row.campanha}</td>
                        <td>
                          {row.account_management ? (
                            <span className="accountManagerCell">
                              {getAccountManagerAvatar(row.account_management) ? (
                                <Image
                                  src={getAccountManagerAvatar(row.account_management)!}
                                  alt={`Foto de ${row.account_management}`}
                                  width={22}
                                  height={22}
                                  className="accountManagerAvatar"
                                />
                              ) : null}
                              <span>{row.account_management}</span>
                              <a
                                href={getAccountManagerWhatsAppUrl(row.account_management, {
                                  campanha: row.campanha,
                                  token: row.token,
                                  platform: row.platform,
                                  vigencia_start: row.vigencia_start,
                                  vigencia_end: row.vigencia_end,
                                })}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="accountManagerWhatsappLink"
                                aria-label={`Conversar com ${row.account_management} no WhatsApp`}
                                title="Abrir conversa no WhatsApp"
                              >
                                <WhatsAppIcon />
                              </a>
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          {formatDateBr(row.vigencia_start)} {"→"} {formatDateBr(row.vigencia_end)}
                        </td>
                        <td>{brl(row.gasto)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
                {!sortedOutRows.length ? (
                  <p className="alertInfo">Nenhuma campanha fora do mês vigente encontrada para a busca informada.</p>
                ) : null}
              </>
            ) : (
              <p className="alertSuccess">Nenhum gasto em campanhas fora do mês vigente.</p>
            )}
          </section>
        </section>
      </>
    );
  };

  return (
    <main className="appLayout">
      <aside className="sidebar">
        <div>
          <p className="sidebarTitle">Painel de Custos</p>
          <p className="sidebarSubtitle">{periodRangeLabel}</p>
        </div>
        <nav className="sidebarNav">
          {navOptions.map((option) => (
            <button
              key={option}
              className={`navButton ${resolvedActivePage === option ? "navButtonActive" : ""}`}
              onClick={() => router.push(appendQueryToRoute(routeForPage(option)))}
            >
              {NAV_LABELS[option]}
            </button>
          ))}
        </nav>
      </aside>

      <section className="content">
        <header className="header">
          <div className="headerMain">
            <div>
              {resolvedActivePage === "Dashboard" ? (
                <p className="welcomeMessage">Olá, {userDisplayName}</p>
              ) : null}
              <h1>{NAV_LABELS[resolvedActivePage]}</h1>
              <p className="muted">{periodRangeLabel}</p>
            </div>
            <label className="monthFilterControl">
              <span className="monthFilterLabel">Mês de análise</span>
              <select
                value={selectedMonthKey}
                onChange={(event) => setSelectedMonthKey(event.target.value)}
                aria-label="Selecionar mês de análise"
              >
                {availableMonthKeys.map((monthKey) => (
                  <option key={monthKey} value={monthKey}>
                    {formatMonthKeyLabel(monthKey)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="headerActions">
            <div className="headerUserButtonWrap">
              <UserButton />
            </div>
            <button className="button" onClick={handleRefresh} disabled={isValidating || isRefreshRunning}>
              <ReloadIcon spinning={isValidating || isRefreshRunning} />
              <span>{isValidating || isRefreshRunning ? "Atualizando na fonte..." : "Forçar atualização na fonte"}</span>
            </button>
            {isRefreshRunning ? (
              <p className="headerRefreshState">Atualização em andamento • iniciado há {formatDuration(refreshElapsedSeconds)}</p>
            ) : null}
            <p className="headerSnapshotPrimary">
              Última atualização exibida: {displayedSnapshotAt ? formatDateTime(displayedSnapshotAt) : "—"}
            </p>
            <p className="headerSnapshotSecondary">
              {formatAge(displayedSnapshotAt) || "Atualização pendente"}
              {" • "}
              Tempo médio ({refreshMetrics?.window_hours ?? 24}h):{" "}
              {refreshMetrics?.sample_size ? formatDuration(refreshMetrics.avg_duration_seconds) : "sem histórico suficiente"}
            </p>
          </div>
        </header>

        {dashboardLoadFailed ? (
          <div className="contentErrorWrap">
            <section className="errorStateCard">
              <p className="errorStateEyebrow">Ops! Algo saiu do esperado</p>
              <h1 className="errorStateTitle">Nao conseguimos carregar o dashboard agora.</h1>
              <p className="errorStateMessage">{dashboardErrorMessage}</p>
              <p className="errorStateHint">
                {dashboardErrorIsTimeout
                  ? "A atualizacao completa pode levar ate 2 minutos quando busca dados novos nas plataformas."
                  : "Pode ser uma instabilidade temporaria. Tente novamente para restabelecer a conexao."}
              </p>
              <div className="errorStateActions">
                <button className="button" onClick={() => mutate()} disabled={isValidating}>
                  <ReloadIcon spinning={isValidating} />
                  <span>{isValidating ? "Tentando novamente..." : "Tentar novamente"}</span>
                </button>
                <button className="button buttonGhost" onClick={handleRefresh} disabled={isValidating || isRefreshRunning}>
                  Recarregar dados completos
                </button>
              </div>
            </section>
          </div>
        ) : (
          <>
            {resolvedActivePage === "Dashboard" ? renderDashboardPage() : null}
            {resolvedActivePage === "\u26A0\uFE0F Lines sem token" ? renderNoTokenAttentionPage() : null}
            {resolvedActivePage === "\u{1F6A8} Gasto fora do m\u{EA}s vigente"
              ? renderOutOfPeriodAttentionPage()
              : null}
            {resolvedActivePage !== "Dashboard" &&
            resolvedActivePage !== "\u26A0\uFE0F Lines sem token" &&
            resolvedActivePage !== "\u{1F6A8} Gasto fora do m\u{EA}s vigente"
              ? renderPlatformPage(resolvedActivePage)
              : null}
          </>
        )}

      </section>

      {toast ? (
        <div className={`toast ${toast.kind === "success" ? "toastSuccess" : "toastError"}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      ) : null}
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<SessionLoading message="Carregando dashboard..." />}>
      <HomeContent />
    </Suspense>
  );
}
