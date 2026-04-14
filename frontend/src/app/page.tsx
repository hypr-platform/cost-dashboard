"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import html2canvas from "html2canvas";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
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
  campaign_start?: string | null;
  campaign_end?: string | null;
  produto_vendido?: string;
  account_management?: string;
  status: string;
  investido: number;
  total_plataformas: number;
  pct_investido: number;
  [platform: string]: string | number | null | undefined;
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
type CampaignJourneySortKey =
  | "token"
  | "cliente"
  | "campanha"
  | "account_management"
  | "status"
  | "investido"
  | "total_plataformas"
  | "pct_investido"
  | "campaign_start"
  | "campaign_end"
  | `platform:${string}`;
type AttentionOutOfPeriodRow = {
  platform: string;
  token: string;
  line: string;
  cliente: string;
  campanha: string;
  account_management: string;
  vigencia_start: string | null;
  vigencia_end: string | null;
  gasto: number;
};

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
    daily_filtered?: Array<{ date: string; total: number; [platform: string]: string | number }>;
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
    out_of_period_rows: AttentionOutOfPeriodRow[];
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

type RefreshPhase = "idle" | "starting" | "running" | "success" | "error";

/** Cores únicas nos gráficos por DSP (pizza, linhas, atenção, etc.) */
const PLATFORM_COLORS: Record<string, string> = {
  StackAdapt: "#2563eb",
  DV360: "#22c55e",
  Xandr: "#dc2626",
  "Amazon DSP": "#f97316",
  Amazon: "#f97316",
  Nexd: "#7dd3fc",
  NEXD: "#7dd3fc",
  Hivestack: "#ec4899",
  Total: "#e2e8f0",
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

function getAccountManagerWhatsAppNumber(name: string | null | undefined): string | null {
  const managerName = (name ?? "").trim();
  if (!managerName) return null;
  return ACCOUNT_MANAGER_WHATSAPP_NUMBERS[managerName] ?? null;
}

function hasAccountManagerWhatsApp(name: string | null | undefined): boolean {
  return Boolean(getAccountManagerWhatsAppNumber(name));
}

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
  const rawPhone = getAccountManagerWhatsAppNumber(name) ?? "";
  const digitsOnly = rawPhone.replace(/\D/g, "");
  if (!digitsOnly) return "";
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
  const rawPhone = getAccountManagerWhatsAppNumber(name) ?? "";
  const digitsOnly = rawPhone.replace(/\D/g, "");
  if (!digitsOnly) return "";
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
/** Filtro por produto vendido da campanha. */
const URL_PARAM_CAMPAIGN_TYPE = "tipo";
const URL_PARAM_FEATURES = "features";
/** Quando `1`, inclui na visão principal o gasto em campanhas fora da vigência do período. Padrão: omitido (não incluir). */
const URL_PARAM_INCLUDE_OUT_OF_PERIOD = "include_oop";
/** Legado: removido da URL ao sincronizar; leitura ignorada. */
const URL_PARAM_HIDE_OUT_OF_PERIOD_LEGACY = "hide_oop";
const URL_PARAM_MONTH = "month";
const URL_PARAM_VIEW = "view";
const MONTH_KEY_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_KEY_REGEX = /^\d{4}$/;
const FEATURE_OPTIONS = ["RMN Físico", "Survey", "Topics", "P-DOOH", "Downloaded Apps"] as const;
type AnalysisViewMode = "month" | "year";
const ANALYSIS_VIEW_OPTIONS: ReadonlyArray<{ value: AnalysisViewMode; label: string }> = [
  { value: "month", label: "Mês" },
  { value: "year", label: "Ano" },
];
const AVAILABLE_YEAR_KEYS = ["2025", "2026"] as const;

function featuresFromLineName(lineName: string): string[] {
  const normalized = String(lineName ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const features: string[] = [];
  if (normalized.includes("RMNFISICO")) features.push("RMN Físico");
  if (normalized.includes("SURVEY")) features.push("Survey");
  if (normalized.includes("TOPICS")) features.push("Topics");
  if (normalized.includes("PDOOH")) features.push("P-DOOH");
  if (normalized.includes("DOWNLOADED_APPS")) features.push("Downloaded Apps");
  return features;
}

function rowMatchesCampaignProducts(produtoVendido: string | null | undefined, selectedProducts: string[]): boolean {
  if (!selectedProducts.length) return true;
  const normalized = String(produtoVendido ?? "").trim();
  return selectedProducts.includes(normalized);
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
  | "Hivestack"
  | "Amazon DSP";

const NAV_LABELS: Record<NavKey, string> = {
  Dashboard: "DeepDive Dsps",
  "⚠️ Lines sem token": "⚠️ Lines sem token",
  "🚨 Gasto fora do mês vigente": "🚨 Gasto fora do mês vigente",
  Nexd: "Nexd",
  StackAdapt: "StackAdapt",
  DV360: "DV360",
  Xandr: "Xandr",
  Hivestack: "Hivestack",
  "Amazon DSP": "Amazon DSP",
};

const PAGE_TO_SLUG: Record<Exclude<NavKey, "Dashboard">, string> = {
  "⚠️ Lines sem token": "lines-sem-token",
  "🚨 Gasto fora do mês vigente": "gasto-fora-mes-vigente",
  Nexd: "nexd",
  StackAdapt: "stack-adapt",
  DV360: "dv360",
  Xandr: "xandr",
  Hivestack: "hivestack",
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
  hivestack: "Hivestack",
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
    campaign_start: journey?.campaign_start ?? null,
    campaign_end: journey?.campaign_end ?? null,
    produto_vendido: journey?.produto_vendido ?? "",
    account_management: row.account_management,
    status: journey?.status ?? "",
    investido: Number(journey?.investido ?? row.investido ?? 0),
    total_plataformas: Number(journey?.total_plataformas ?? 0),
    pct_investido: Number(journey?.pct_investido ?? 0),
  } as JourneyRow;
}

function journeySnapshotForOutOfPeriodRow(
  row: AttentionOutOfPeriodRow,
  journeyByToken: Map<string, JourneyRow>
): JourneyRow {
  const t = String(row.token ?? "").trim();
  const journey = t && hasCampaignToken(t) ? journeyByToken.get(t) : undefined;
  return {
    token: row.token,
    cliente: row.cliente,
    campanha: row.campanha,
    campaign_start: journey?.campaign_start ?? row.vigencia_start ?? null,
    campaign_end: journey?.campaign_end ?? row.vigencia_end ?? null,
    produto_vendido: journey?.produto_vendido ?? "",
    account_management: row.account_management,
    status: journey?.status ?? "",
    investido: Number(journey?.investido ?? 0),
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

function isValidYearKey(value: string | null | undefined): value is string {
  if (!value) return false;
  return YEAR_KEY_REGEX.test(value.trim());
}

function getCurrentMonthKey(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

function getCurrentYearKey(): string {
  return String(new Date().getFullYear());
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

function isValidAnalysisViewMode(value: string | null | undefined): value is AnalysisViewMode {
  return value === "month" || value === "year";
}

function resolveAnalysisDateRange(viewMode: AnalysisViewMode, monthKey: string): { start: string; end: string } {
  if (viewMode === "month") {
    return monthKeyToDateRange(monthKey);
  }
  const year = isValidYearKey(monthKey) ? monthKey : getCurrentYearKey();
  return {
    start: `${year}-01-01`,
    end: `${year}-12-31`,
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

function capitalizeFirst(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDateBrShort(value: string | null | undefined): string {
  const full = formatDateBr(value);
  const match = full.match(/^(\d{2}\/\d{2})\/\d{4}$/);
  return match ? match[1] : full;
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
    backgroundColor: "#1e2a33",
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

type NumberTooltipPayloadEntry = {
  value?: number | string;
  name?: string;
  color?: string;
  fill?: string;
  stroke?: string;
  payload?: unknown;
};

/** Cor da série no tooltip (barra usa `fill`; linha usa `stroke`/`color`; fallback pelo payload ou label do eixo). */
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

function NumberTooltip({
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
              {pct !== null ? (
                <span className="tooltipNumberRowPct"> ({pct.toFixed(1)}% do total)</span>
              ) : null}
            </p>
          </div>
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

function DailyCostLegend({
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
              isSelected
                ? `Remover filtro de ${displayName}`
                : `Filtrar gráfico por ${displayName}`
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
  usdLine,
  badge,
  badgeTone,
  statusIndicator,
  dimmed,
  titleEmphasis,
  logoSrc,
  budget,
  variant,
  href,
  metric,
  summaryHighlight,
}: {
  title: string;
  value: string;
  subtitle?: ReactNode;
  /** Linha secundária em USD (menor peso visual que o valor em BRL). */
  usdLine?: string | null;
  /** Métrica extra label + valor (ex.: NEXD — Impressões). */
  metric?: { label: string; value: string };
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
  /** Destaque na linha de totais (Investido / Consolidado). */
  summaryHighlight?: boolean;
}) {
  const router = useRouter();
  const progressRaw = budget?.progress_pct ?? 0;
  const progressClamped = Math.max(0, Math.min(progressRaw, 100));
  const isOverTarget = progressRaw > 100;
  const hasBudgetTarget = budget?.target_brl !== null && budget?.target_brl !== undefined;
  const investmentSharePct = budget?.investment_share_pct;
  const budgetFillTone = isOverTarget ? "Over" : progressRaw >= 90 ? "Warn" : "Ok";

  const go = () => {
    if (href) router.push(href);
  };

  const hasSubtitle = subtitle !== undefined && subtitle !== null && subtitle !== false && subtitle !== "";

  return (
    <div
      className={`card ${dimmed ? "cardDimmed" : ""} ${variant === "premium" ? "cardPremium" : ""} ${href ? "cardClickable" : ""} ${
        badgeTone === "soon" && !dimmed
          ? title.startsWith("Amazon")
            ? "cardVisualSoonAmazon"
            : "cardVisualSoon"
          : ""
      } ${summaryHighlight ? "cardSummaryHighlight" : ""}`}
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
      <div className="cardKpiPrimary">
        <p className="cardValue">{value}</p>
        {usdLine ? <p className="cardUsdLine">{usdLine}</p> : null}
      </div>
      {metric ? (
        <div className="cardMetricBlock">
          <p className="cardMetricLabel">{metric.label}</p>
          <p className="cardMetricValue">{metric.value}</p>
        </div>
      ) : null}
      {hasSubtitle ? (
        <div
          className={`cardSubtitle ${usdLine || metric ? "cardSubtitleAfterUsd" : ""}`}
        >
          {subtitle}
        </div>
      ) : null}
      {budget && hasBudgetTarget ? (
        <div className="cardBudgetSlot">
          <div className="cardBudget">
            <div className="cardBudgetMetaBlock">
              <p className="cardBudgetMetaHeading">Meta</p>
              <p className="cardBudgetMetaFigures">
                <span className="cardBudgetMetaFiguresBrl">
                  {BRL_INTEGER_FORMATTER.format(budget.target_brl ?? 0)}
                </span>
                {investmentSharePct != null && Number.isFinite(investmentSharePct) ? (
                  <span className="cardBudgetMetaFiguresPct">
                    {" "}
                    ({Number(investmentSharePct).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}% do total)
                  </span>
                ) : null}
              </p>
            </div>
            <div className="budgetProgressTrack budgetProgressTrackCard" aria-hidden={!Number.isFinite(progressRaw)}>
              <div
                className={`budgetProgressFill budgetProgressFill${budgetFillTone}`}
                style={{ width: `${progressClamped}%` }}
              />
            </div>
            <div className={`cardBudgetCompareBlock ${isOverTarget ? "cardBudgetCompareBlockOver" : ""}`}>
              {isOverTarget ? (
                <>
                  <p className="cardBudgetCompare cardBudgetCompareOver">
                    +{Math.round((budget.progress_pct ?? 0) - 100)}% acima
                  </p>
                  <p className="cardBudgetCompareDetail">
                    {BRL_INTEGER_FORMATTER.format(Math.abs(budget.remaining_brl ?? 0))} acima
                  </p>
                </>
              ) : (
                <p className="cardBudgetCompare">
                  {(budget.progress_pct ?? 0).toFixed(1).replace(".", ",")}% do budget · Restante{" "}
                  {brl(budget.remaining_brl ?? 0)}
                </p>
              )}
            </div>
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
  compact = false,
}: {
  id: string;
  label: string;
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  showAvatar?: boolean;
  disabledOptions?: ReadonlySet<string>;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectedOptions = options.filter((opt) => value.includes(opt));
  const hasSelection = selectedOptions.length > 0;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = useMemo(() => {
    if (!normalizedQuery) return options;
    return options.filter((opt) => opt.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, options]);
  const selectableOptions = useMemo(
    () => visibleOptions.filter((opt) => !disabledOptions?.has(opt) || value.includes(opt)),
    [disabledOptions, value, visibleOptions]
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const summary =
    value.length === 0 ? placeholder : value.length === 1 ? value[0] : `${value.length} selecionados`;

  const compactValueDisplay =
    value.length === 1 ? value[0] : value.length > 1 ? String(value.length) : "";

  const isOptionDisabled = (opt: string) => Boolean(disabledOptions?.has(opt) && !value.includes(opt));

  const toggle = (opt: string) => {
    if (isOptionDisabled(opt)) return;
    if (value.includes(opt)) onChange(value.filter((x) => x !== opt));
    else onChange([...value, opt]);
  };
  const clearAll = () => onChange([]);

  const initialsFor = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("");

  return (
    <div className={`filterField ${compact ? "filterFieldCompact" : ""}`} ref={rootRef}>
      {compact ? null : (
        <label htmlFor={`${id}-trigger`} className="filterFieldLabel">
          {label}
        </label>
      )}
      <button
        type="button"
        id={`${id}-trigger`}
        className={`multiSelectTrigger ${hasSelection ? "multiSelectTriggerActive" : ""} ${
          compact ? "multiSelectTriggerCompact" : ""
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          compact && options.length && !value.length ? `${label}. ${placeholder}` : undefined
        }
        disabled={!options.length}
        onClick={() => {
          if (!options.length) return;
          setOpen((previous) => {
            const next = !previous;
            if (!next) setQuery("");
            return next;
          });
        }}
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
          {compact ? (
            <span className="multiSelectInlineSummary">
              {!options.length ? (
                <>
                  <span className="multiSelectInlineLabel">{label}</span>
                  <span className="multiSelectInlineSep" aria-hidden>
                    {"\u00A0•\u00A0"}
                  </span>
                  <span className="multiSelectTriggerLabel multiSelectTriggerLabelPlaceholder">Sem opções</span>
                </>
              ) : value.length === 0 ? (
                <span className="multiSelectInlineLabel multiSelectInlineLabelSolo">{label}</span>
              ) : (
                <>
                  <span className="multiSelectInlineLabel">{label}</span>
                  <span className="multiSelectInlineSep" aria-hidden>
                    {"\u00A0•\u00A0"}
                  </span>
                  <span
                    className={`multiSelectTriggerLabel ${
                      hasSelection ? "multiSelectTriggerLabelActive" : "multiSelectTriggerLabelPlaceholder"
                    }`}
                  >
                    {compactValueDisplay}
                  </span>
                </>
              )}
            </span>
          ) : (
            <span
              className={`multiSelectTriggerLabel ${
                hasSelection ? "multiSelectTriggerLabelActive" : "multiSelectTriggerLabelPlaceholder"
              }`}
            >
              {!options.length ? "Sem opções" : summary}
            </span>
          )}
        </span>
        <span className="multiSelectChevron" aria-hidden>
          {"\u25BC"}
        </span>
      </button>
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
          {selectableOptions.length ? selectableOptions.map((opt) => {
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
            <li className="multiSelectEmptyState">Nenhuma opção disponível para os filtros atuais.</li>
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
  if (minutes < 60) return `Atualizado há ${minutes}min`;
  if (minutes < 24 * 60) return `Atualizado há ${Math.floor(minutes / 60)}h`;
  return `Atualizado há ${Math.floor(minutes / (24 * 60))}d`;
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

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" className="buttonIcon">
      <path
        d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FilterPanelDrawerChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      className={`filterPanelDrawerChevron ${expanded ? "filterPanelDrawerChevronOpen" : ""}`}
    >
      <path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FilterLinesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="filterPanelTitleFilterIcon">
      <path
        d="M4 7h16M7 12h10M10 17h4"
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
        <div className="sidebarBrand">
          <Image
            src="/hypr-logo-white.png"
            alt="HYPR"
            width={188}
            height={48}
            className="sidebarBrandLogo"
            priority
          />
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
        <section className="homeAlertsSection" aria-hidden="true">
          <div className="homeAlertsSectionHeader">
            <div className="skeleton skeletonText skeletonEyebrow" />
          </div>
          <div className="gridCards homeAlertsRow">
            {Array.from({ length: 2 }).map((_, idx) => (
              <div key={`alert-skeleton-${idx}`} className="card skeleton skeletonBlock skeletonCard" />
            ))}
          </div>
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
  const [campaignJourneySort, setCampaignJourneySort] = useState<{
    key: CampaignJourneySortKey;
    direction: AttentionSortDirection;
  }>({ key: "total_plataformas", direction: "desc" });
  const [clientFilter, setClientFilter] = useState<string[]>(() => parseCsvList(searchParams.get(URL_PARAM_CLIENTS)));
  const [csFilter, setCsFilter] = useState<string[]>(() => parseCsvList(searchParams.get(URL_PARAM_CS)));
  const [campaignFilter, setCampaignFilter] = useState<string[]>(() => parseCsvList(searchParams.get(URL_PARAM_CAMPAIGNS)));
  const [campaignStatusFilter, setCampaignStatusFilter] = useState<string[]>(
    () => parseCsvList(searchParams.get(URL_PARAM_CAMPAIGN_STATUS))
  );
  const [featureFilter, setFeatureFilter] = useState<string[]>(() =>
    parseCsvList(searchParams.get(URL_PARAM_FEATURES)).filter((value) =>
      (FEATURE_OPTIONS as readonly string[]).includes(value)
    )
  );
  const [campaignTypeFilter, setCampaignTypeFilter] = useState<string[]>(() =>
    parseCsvList(searchParams.get(URL_PARAM_CAMPAIGN_TYPE))
  );
  const includeOutOfPeriodCampaigns = false;
  const [selectedViewMode, setSelectedViewMode] = useState<AnalysisViewMode>(() => {
    const paramView = searchParams.get(URL_PARAM_VIEW);
    return isValidAnalysisViewMode(paramView) ? paramView : "month";
  });
  const [selectedMonthKey, setSelectedMonthKey] = useState<string>(() => {
    const paramMonth = searchParams.get(URL_PARAM_MONTH);
    if (isValidMonthKey(paramMonth) || isValidYearKey(paramMonth)) {
      return paramMonth;
    }
    return getCurrentMonthKey();
  });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [toast, setToast] = useState<{ message: string; kind: "success" | "error" } | null>(null);
  const [copiedFieldKey, setCopiedFieldKey] = useState<string | null>(null);
  const [refreshPhase, setRefreshPhase] = useState<RefreshPhase>("idle");
  const [refreshRunStartedAt, setRefreshRunStartedAt] = useState<number | null>(null);
  const [refreshElapsedSeconds, setRefreshElapsedSeconds] = useState(0);
  const [refreshRequestedAt, setRefreshRequestedAt] = useState<number | null>(null);
  const [refreshObservedRunId, setRefreshObservedRunId] = useState<string | null>(null);
  const [refreshObservedStartedAt, setRefreshObservedStartedAt] = useState<string | null>(null);
  const [refreshHasSeenRunning, setRefreshHasSeenRunning] = useState(false);
  const [isDspsMenuExpanded, setIsDspsMenuExpanded] = useState(true);
  const [isDashboardFiltersExpanded, setIsDashboardFiltersExpanded] = useState(false);
  const [snapshotInfoOpen, setSnapshotInfoOpen] = useState(false);
  const [dailyCostFocusedSeries, setDailyCostFocusedSeries] = useState<string[]>([]);
  /** Hover no donut ou na legenda lateral (Distribuição): destaca fatia + linha. */
  const [distributionHighlightPlatform, setDistributionHighlightPlatform] = useState<string | null>(null);
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  const userEmail = user?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "";
  const isAllowedDomain = userEmail.endsWith("@hypr.mobi");
  const shouldFetchData = isUserLoaded && isSignedIn && isAllowedDomain;
  const selectedDateRange = useMemo(
    () => resolveAnalysisDateRange(selectedViewMode, selectedMonthKey),
    [selectedMonthKey, selectedViewMode]
  );
  const yearOptions = useMemo(() => [...AVAILABLE_YEAR_KEYS], []);
  const currentMonthKey = useMemo(() => getCurrentMonthKey(), []);
  const currentYearKey = useMemo(() => getCurrentYearKey(), []);
  const periodOptions = useMemo(() => {
    if (selectedViewMode === "year") return yearOptions;
    const options = buildRecentMonthKeys(18);
    if (options.includes(selectedMonthKey)) return options;
    return [selectedMonthKey, ...options];
  }, [selectedMonthKey, selectedViewMode, yearOptions]);
  const dashboardUrl = useMemo(() => {
    if (!shouldFetchData) return null;
    const query = new URLSearchParams({ start: selectedDateRange.start, end: selectedDateRange.end });
    const setCsvQuery = (key: string, values: string[]) => {
      const encoded = stringifyCsvList(values);
      if (encoded) query.set(key, encoded);
    };
    setCsvQuery(URL_PARAM_CLIENTS, clientFilter);
    setCsvQuery(URL_PARAM_CS, csFilter);
    setCsvQuery(URL_PARAM_CAMPAIGNS, campaignFilter);
    setCsvQuery(URL_PARAM_CAMPAIGN_STATUS, campaignStatusFilter);
    setCsvQuery(URL_PARAM_FEATURES, featureFilter);
    setCsvQuery(URL_PARAM_CAMPAIGN_TYPE, campaignTypeFilter);
    return `${apiBase}/api/dashboard?${query.toString()}`;
  }, [
    apiBase,
    campaignFilter,
    campaignStatusFilter,
    campaignTypeFilter,
    clientFilter,
    csFilter,
    featureFilter,
    selectedDateRange.end,
    selectedDateRange.start,
    shouldFetchData,
  ]);
  const { data, error, isLoading, isValidating, mutate } = useSWR<DashboardResponse>(dashboardUrl, fetcher, {
    keepPreviousData: true,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60000,
    onSuccess: (nextData) => {
      if (!nextData?._meta?.snapshot_at) return;
      const parsed = Date.parse(nextData._meta.snapshot_at);
      if (!Number.isNaN(parsed)) {
        setLastUpdatedAt(parsed);
      }
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
      refreshInterval: (status) =>
        status?.running || refreshPhase === "starting" || refreshPhase === "running" ? 2000 : 0,
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
  const isRefreshRunning = refreshPhase === "starting" || refreshPhase === "running" || Boolean(refreshStatus?.running);
  const spendByPlatformChartRef = useRef<HTMLDivElement | null>(null);
  const distributionChartRef = useRef<HTMLDivElement | null>(null);
  const dailyCostChartRef = useRef<HTMLDivElement | null>(null);
  const noTokenDistributionChartRef = useRef<HTMLDivElement | null>(null);
  const outOfPeriodDistributionChartRef = useRef<HTMLDivElement | null>(null);
  const nexdUsageChartRef = useRef<HTMLDivElement | null>(null);
  const snapshotInfoWrapRef = useRef<HTMLDivElement | null>(null);

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
    if (!snapshotInfoOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (snapshotInfoWrapRef.current && !snapshotInfoWrapRef.current.contains(e.target as Node)) {
        setSnapshotInfoOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSnapshotInfoOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [snapshotInfoOpen]);

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
    const nextFeatures = parseCsvList(searchParams.get(URL_PARAM_FEATURES)).filter((value) =>
      (FEATURE_OPTIONS as readonly string[]).includes(value)
    );
    const nextCampaignTypes = parseCsvList(searchParams.get(URL_PARAM_CAMPAIGN_TYPE));
    const nextView = searchParams.get(URL_PARAM_VIEW);
    const nextMonth = searchParams.get(URL_PARAM_MONTH);
    const normalizedView = isValidAnalysisViewMode(nextView) ? nextView : "month";
    const normalizedMonth =
      normalizedView === "year"
        ? isValidYearKey(nextMonth)
          ? nextMonth
          : currentYearKey
        : isValidMonthKey(nextMonth)
          ? nextMonth
          : currentMonthKey;

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
    setFeatureFilter((prev) => (prev.join("|") === nextFeatures.join("|") ? prev : nextFeatures));
    setCampaignTypeFilter((prev) => (prev.join("|") === nextCampaignTypes.join("|") ? prev : nextCampaignTypes));
    setSelectedViewMode((prev) => (prev === normalizedView ? prev : normalizedView));
    setSelectedMonthKey((prev) => (prev === normalizedMonth ? prev : normalizedMonth));
  }, [currentMonthKey, currentYearKey, searchParams]);

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
    setQueryValue(URL_PARAM_FEATURES, stringifyCsvList(featureFilter));
    setQueryValue(URL_PARAM_CAMPAIGN_TYPE, stringifyCsvList(campaignTypeFilter));
    nextParams.delete(URL_PARAM_INCLUDE_OUT_OF_PERIOD);
    nextParams.delete(URL_PARAM_HIDE_OUT_OF_PERIOD_LEGACY);
    setQueryValue(URL_PARAM_VIEW, selectedViewMode === "month" ? null : selectedViewMode);
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
    featureFilter,
    campaignTypeFilter,
    clientFilter,
    csFilter,
    dspLinesOnlyWithoutToken,
    pathname,
    router,
    searchParams,
    selectedViewMode,
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
  const tokenFeaturesByToken = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const platformPages = data?.platform_pages ?? {};
    for (const page of Object.values(platformPages)) {
      const rows = page?.rows ?? [];
      for (const row of rows) {
        const token = String(row.token ?? "").trim();
        if (!hasCampaignToken(token)) continue;
        const rowFeatures = featuresFromLineName(String(row.line ?? ""));
        if (!rowFeatures.length) continue;
        let set = map.get(token);
        if (!set) {
          set = new Set<string>();
          map.set(token, set);
        }
        for (const feature of rowFeatures) set.add(feature);
      }
    }
    return map;
  }, [data?.platform_pages]);
  const normalizeOutOfPeriodKeyPart = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();
  const outOfPeriodLineKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const row of data?.attention.out_of_period_rows ?? []) {
      const key = [
        normalizeOutOfPeriodKeyPart(row.platform),
        normalizeOutOfPeriodKeyPart(row.token),
        normalizeOutOfPeriodKeyPart(row.line),
        normalizeOutOfPeriodKeyPart(row.cliente),
        normalizeOutOfPeriodKeyPart(row.campanha),
        normalizeOutOfPeriodKeyPart(row.account_management),
      ].join("::");
      keys.add(key);
    }
    return keys;
  }, [data?.attention.out_of_period_rows]);
  const outOfPeriodSpendByTokenPlatform = useMemo(() => {
    const tokenMap = new Map<string, Map<string, number>>();
    for (const row of data?.attention.out_of_period_rows ?? []) {
      const token = String(row.token ?? "").trim();
      const platform = String(row.platform ?? "").trim();
      if (!hasCampaignToken(token) || !platform) continue;
      const currentToken = tokenMap.get(token) ?? new Map<string, number>();
      currentToken.set(platform, (currentToken.get(platform) ?? 0) + Number(row.gasto ?? 0));
      tokenMap.set(token, currentToken);
    }
    return tokenMap;
  }, [data?.attention.out_of_period_rows]);
  const adjustedJourneyRows = useMemo(() => {
    if (includeOutOfPeriodCampaigns) return journeyRows;
    const activePlatforms = data?.dashboard.active_platforms ?? [];
    if (!activePlatforms.length) return journeyRows;
    return journeyRows.map((row) => {
      const token = String(row.token ?? "").trim();
      if (!hasCampaignToken(token)) return row;
      const platformAdjustments = outOfPeriodSpendByTokenPlatform.get(token);
      if (!platformAdjustments) return row;
      let changed = false;
      const nextRow: JourneyRow = { ...row };
      for (const platform of activePlatforms) {
        const adjust = platformAdjustments.get(platform) ?? 0;
        if (adjust <= 0) continue;
        const currentSpend = Number(row[platform] ?? 0);
        const nextSpend = Math.max(0, currentSpend - adjust);
        if (nextSpend !== currentSpend) {
          nextRow[platform] = nextSpend;
          changed = true;
        }
      }
      if (!changed) return row;
      const recomputedTotal = activePlatforms.reduce((sum, platform) => sum + Number(nextRow[platform] ?? 0), 0);
      nextRow.total_plataformas = recomputedTotal;
      const invested = Number(row.investido ?? 0);
      nextRow.pct_investido = invested > 0 ? (recomputedTotal / invested) * 100 : 0;
      return nextRow;
    });
  }, [data?.dashboard.active_platforms, includeOutOfPeriodCampaigns, journeyRows, outOfPeriodSpendByTokenPlatform]);
  const shouldHideOutOfPeriodPlatformRow = useCallback(
    (row: PlatformPageRow, platformName: string | null) => {
      if (includeOutOfPeriodCampaigns || !platformName) return false;
      const key = [
        normalizeOutOfPeriodKeyPart(platformName),
        normalizeOutOfPeriodKeyPart(row.token),
        normalizeOutOfPeriodKeyPart(row.line),
        normalizeOutOfPeriodKeyPart(row.cliente),
        normalizeOutOfPeriodKeyPart(row.campanha),
        normalizeOutOfPeriodKeyPart(row.account_management),
      ].join("::");
      return outOfPeriodLineKeys.has(key);
    },
    [includeOutOfPeriodCampaigns, outOfPeriodLineKeys]
  );
  const hasDashboardFilters =
    clientFilter.length > 0 ||
    csFilter.length > 0 ||
    campaignFilter.length > 0 ||
    campaignStatusFilter.length > 0 ||
    featureFilter.length > 0 ||
    campaignTypeFilter.length > 0;
  const hasDashboardScopeFilters = hasDashboardFilters;
  const activeDashboardFilterCount =
    clientFilter.length +
    csFilter.length +
    campaignTypeFilter.length +
    featureFilter.length +
    campaignFilter.length +
    campaignStatusFilter.length;
  const clearDashboardFilters = useCallback(() => {
    setClientFilter([]);
    setCsFilter([]);
    setFeatureFilter([]);
    setCampaignTypeFilter([]);
    setCampaignFilter([]);
    setCampaignStatusFilter([]);
  }, []);
  const rowMatchesDashboardFilters = useCallback(
    (
      row: JourneyRow,
      filters: {
        clients: string[];
        cs: string[];
        campaigns: string[];
        statuses: string[];
        features: string[];
        campaignTypes: string[];
      }
    ) => {
      if (filters.clients.length && !filters.clients.includes(row.cliente)) return false;
      if (filters.cs.length && !filters.cs.includes(rowCsLabel(row))) return false;
      if (filters.campaigns.length && !filters.campaigns.includes(row.campanha)) return false;
      if (filters.statuses.length && !filters.statuses.includes(row.status)) return false;
      if (filters.features.length) {
        const token = String(row.token ?? "").trim();
        if (!hasCampaignToken(token)) return false;
        const featureSet = tokenFeaturesByToken.get(token);
        if (!featureSet) return false;
        if (!filters.features.some((feature) => featureSet.has(feature))) return false;
      }
      if (!rowMatchesCampaignProducts(row.produto_vendido, filters.campaignTypes)) return false;
      return true;
    },
    [tokenFeaturesByToken]
  );
  const dashboardFilteredRows = useMemo(() => {
    return adjustedJourneyRows.filter((row) => {
      if (Number(row.total_plataformas ?? 0) <= 0) return false;
      if (!hasDashboardFilters) return true;
      return rowMatchesDashboardFilters(row, {
        clients: clientFilter,
        cs: csFilter,
        campaigns: campaignFilter,
        statuses: campaignStatusFilter,
        features: featureFilter,
        campaignTypes: campaignTypeFilter,
      });
    });
  }, [
    campaignFilter,
    campaignStatusFilter,
    featureFilter,
    campaignTypeFilter,
    clientFilter,
    csFilter,
    adjustedJourneyRows,
    rowMatchesDashboardFilters,
    hasDashboardFilters,
  ]);

  const filteredSpendByPlatform = useMemo(() => {
    if (!hasDashboardScopeFilters || !data) return null;
    if (!dashboardFilteredRows.length) return null;
    const platforms = data.dashboard.active_platforms;
    const sums: Record<string, number> = Object.fromEntries(platforms.map((p) => [p, 0]));
    for (const row of dashboardFilteredRows) {
      for (const p of platforms) {
        sums[p] += Number(row[p] ?? 0);
      }
    }
    return sums;
  }, [hasDashboardScopeFilters, dashboardFilteredRows, data]);

  const spendData = useMemo(() => data?.dashboard.spend_by_platform ?? [], [data]);
  const chartData = useMemo(() => {
    const base = [...spendData].sort((a, b) => b.spend_brl - a.spend_brl);
    if (!hasDashboardScopeFilters || !filteredSpendByPlatform) {
      return base.map((item) => ({ ...item, color: PLATFORM_COLORS[item.platform] ?? "#64748b" }));
    }
    return base
      .map((item) => ({
        ...item,
        spend_brl: filteredSpendByPlatform[item.platform] ?? 0,
        color: PLATFORM_COLORS[item.platform] ?? "#64748b",
      }))
      .filter((item) => item.spend_brl > 0);
  }, [hasDashboardScopeFilters, filteredSpendByPlatform, spendData]);
  /** Barras horizontais: maior gasto no topo (mesma ordem que chartData — desc por valor). */
  const barChartData = useMemo(() => [...chartData], [chartData]);
  const periodTotalSpend = useMemo(() => chartData.reduce((sum, row) => sum + row.spend_brl, 0), [chartData]);
  const dominantChartShare = useMemo(() => {
    if (!chartData.length || periodTotalSpend <= 0) return 0;
    return chartData[0].spend_brl / periodTotalSpend;
  }, [chartData, periodTotalSpend]);
  const shouldFallbackPieChart = chartData.length <= 1 || dominantChartShare >= 0.9;
  useEffect(() => {
    setDistributionHighlightPlatform((cur) => {
      if (cur === null) return null;
      return chartData.some((r) => r.platform === cur) ? cur : null;
    });
  }, [chartData]);
  const dailyChartPlatforms = useMemo(() => {
    const platforms = (data?.dashboard.active_platforms ?? []).filter((platform) => platform !== "Hivestack");
    const daily = hasDashboardScopeFilters ? (data?.dashboard.daily_filtered ?? data?.dashboard.daily ?? []) : (data?.dashboard.daily ?? []);
    if (!daily.length || !platforms.length) return platforms;
    const totals = new Map<string, number>(platforms.map((p) => [p, 0]));
    for (const row of daily) {
      for (const p of platforms) {
        totals.set(p, (totals.get(p) ?? 0) + Number(row[p] ?? 0));
      }
    }
    return [...platforms].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  }, [data?.dashboard.active_platforms, data?.dashboard.daily, data?.dashboard.daily_filtered, hasDashboardScopeFilters]);
  const dailyChartRows = useMemo(
    () => (hasDashboardScopeFilters ? (data?.dashboard.daily_filtered ?? data?.dashboard.daily ?? []) : (data?.dashboard.daily ?? [])),
    [data?.dashboard.daily, data?.dashboard.daily_filtered, hasDashboardScopeFilters]
  );
  const hasDailyVariation = useMemo(() => {
    const rows = dailyChartRows;
    if (rows.length <= 1) return false;
    const baseline = rows[0];
    const keys = ["total", ...dailyChartPlatforms];
    return rows.some((row) =>
      keys.some((key) => {
        const baseValue = Number(baseline[key] ?? 0);
        const currentValue = Number(row[key] ?? 0);
        return Math.abs(currentValue - baseValue) > 0.01;
      })
    );
  }, [dailyChartPlatforms, dailyChartRows]);
  const dailyChartLegendPayload = useMemo<PlatformLegendEntry[]>(
    () => [
      ...dailyChartPlatforms.map((platform) => ({
        value: platform,
        color: PLATFORM_COLORS[platform] ?? "#4e1e9c",
      })),
      { value: "Total", color: PLATFORM_COLORS.Total ?? "#e2e8f0" },
    ],
    [dailyChartPlatforms]
  );
  useEffect(() => {
    setDailyCostFocusedSeries((current) => {
      if (!current.length) return current;
      const allowed = new Set<string>(["total", ...dailyChartPlatforms]);
      return current.filter((seriesKey) => allowed.has(seriesKey));
    });
  }, [dailyChartPlatforms]);
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
    const orderedPlatforms: NavKey[] = ["StackAdapt", "DV360", "Xandr", "Hivestack", "Amazon DSP"];
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
  const sortedCampaignRows = useMemo(() => {
    const rows = [...campaignRows];
    const { key, direction } = campaignJourneySort;
    const normalizeString = (value: unknown) => String(value ?? "").trim();
    const getValue = (row: JourneyRow): string | number => {
      if (key.startsWith("platform:")) {
        const platform = key.slice("platform:".length);
        return Number(row[platform] ?? 0);
      }
      if (key === "investido" || key === "total_plataformas" || key === "pct_investido") {
        return Number(row[key] ?? 0);
      }
      if (key === "campaign_start" || key === "campaign_end") {
        const raw = normalizeString(row[key]);
        const timestamp = raw ? Date.parse(raw) : Number.NaN;
        return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
      }
      return normalizeString(row[key]);
    };
    rows.sort((a, b) => {
      const valueA = getValue(a);
      const valueB = getValue(b);
      const compare =
        typeof valueA === "number" && typeof valueB === "number"
          ? valueA - valueB
          : String(valueA).localeCompare(String(valueB), "pt-BR", { numeric: true, sensitivity: "base" });
      return direction === "asc" ? compare : -compare;
    });
    return rows;
  }, [campaignJourneySort, campaignRows]);

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
  const productFilterOptions = useMemo(() => {
    return [...new Set(journeyRows.map((row) => String(row.produto_vendido ?? "").trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "pt-BR")
    );
  }, [journeyRows]);
  useEffect(() => {
    if (!productFilterOptions.length) return;
    const allowed = new Set(productFilterOptions);
    setCampaignTypeFilter((prev) => {
      const next = prev.filter((value) => allowed.has(value));
      return next.length === prev.length ? prev : next;
    });
  }, [productFilterOptions]);

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
                features: featureFilter,
                campaignTypes: campaignTypeFilter,
              })
            )
        )
      ),
    [
      campaignFilter,
      campaignStatusFilter,
      campaignTypeFilter,
      clients,
      csFilter,
      featureFilter,
      journeyRows,
      rowMatchesDashboardFilters,
    ]
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
                features: featureFilter,
                campaignTypes: campaignTypeFilter,
              })
            )
        )
      ),
    [
      campaignFilter,
      campaignStatusFilter,
      campaignTypeFilter,
      clientFilter,
      csFilterOptions,
      featureFilter,
      journeyRows,
      rowMatchesDashboardFilters,
    ]
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
                features: featureFilter,
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
      featureFilter,
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
                features: featureFilter,
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
      featureFilter,
      journeyRows,
      rowMatchesDashboardFilters,
    ]
  );
  const disabledFeatureOptions = useMemo(
    () =>
      new Set(
        [...FEATURE_OPTIONS].filter(
          (feature) =>
            !journeyRows.some((row) =>
              rowMatchesDashboardFilters(row, {
                clients: clientFilter,
                cs: csFilter,
                campaigns: campaignFilter,
                statuses: campaignStatusFilter,
                features: [feature],
                campaignTypes: campaignTypeFilter,
              })
            )
        )
      ),
    [campaignFilter, campaignStatusFilter, campaignTypeFilter, clientFilter, csFilter, journeyRows, rowMatchesDashboardFilters]
  );
  const disabledCampaignTypeOptions = useMemo(
    () =>
      new Set(
        productFilterOptions.filter(
          (produto) =>
            !journeyRows.some((row) =>
              rowMatchesDashboardFilters(row, {
                clients: clientFilter,
                cs: csFilter,
                campaigns: campaignFilter,
                statuses: campaignStatusFilter,
                features: featureFilter,
                campaignTypes: [produto],
              })
            )
        )
      ),
    [
      campaignFilter,
      campaignStatusFilter,
      clientFilter,
      csFilter,
      featureFilter,
      journeyRows,
      productFilterOptions,
      rowMatchesDashboardFilters,
    ]
  );

  const finalizeRefreshRun = useCallback(
    (result: "success" | "error", errorMessage?: string) => {
      if (result === "success") {
        void mutate();
        void mutateRefreshMetrics();
        setToast({ message: "Dados atualizados na fonte.", kind: "success" });
      } else {
        setToast({ message: errorMessage || "Atualizacao na fonte falhou.", kind: "error" });
      }
      setRefreshPhase("idle");
      setRefreshRunStartedAt(null);
      setRefreshElapsedSeconds(0);
      setRefreshRequestedAt(null);
      setRefreshObservedRunId(null);
      setRefreshObservedStartedAt(null);
      setRefreshHasSeenRunning(false);
    },
    [mutate, mutateRefreshMetrics]
  );

  const handleRefresh = async () => {
    if (!dashboardUrl) return;
    if (isRefreshRunning) return;

    const startedAtLocal = Date.now();
    setRefreshPhase("starting");
    setRefreshRequestedAt(startedAtLocal);
    setRefreshRunStartedAt(startedAtLocal);
    setRefreshElapsedSeconds(0);
    setRefreshObservedRunId(null);
    setRefreshObservedStartedAt(null);
    setRefreshHasSeenRunning(false);

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

      const latestStatus = await mutateRefreshStatus();
      if (latestStatus?.run_id) setRefreshObservedRunId(latestStatus.run_id);
      if (latestStatus?.started_at) {
        setRefreshObservedStartedAt(latestStatus.started_at);
        const parsed = Date.parse(latestStatus.started_at);
        if (!Number.isNaN(parsed)) setRefreshRunStartedAt(parsed);
      }
      if (latestStatus?.running) {
        setRefreshPhase("running");
        setRefreshHasSeenRunning(true);
      }
      showToast("Atualizacao da fonte iniciada.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Nao foi possivel atualizar na fonte.";
      setToast({ message, kind: "error" });
      setRefreshPhase("idle");
      setRefreshRunStartedAt(null);
      setRefreshElapsedSeconds(0);
      setRefreshRequestedAt(null);
      setRefreshObservedRunId(null);
      setRefreshObservedStartedAt(null);
      setRefreshHasSeenRunning(false);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const timeoutId = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timeoutId);
  }, [toast]);

  useEffect(() => {
    if (!copiedFieldKey) return;
    const timeoutId = setTimeout(() => setCopiedFieldKey(null), 1200);
    return () => clearTimeout(timeoutId);
  }, [copiedFieldKey]);

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
    if (refreshPhase !== "starting" && refreshPhase !== "running") return;
    if (!refreshRequestedAt) return;

    if (refreshStatus?.run_id && !refreshObservedRunId) {
      setRefreshObservedRunId(refreshStatus.run_id);
    }
    if (refreshStatus?.started_at && !refreshObservedStartedAt) {
      setRefreshObservedStartedAt(refreshStatus.started_at);
    }
    if (refreshStatus?.started_at) {
      const parsed = Date.parse(refreshStatus.started_at);
      if (!Number.isNaN(parsed)) {
        setRefreshRunStartedAt(parsed);
      }
    }

    if (refreshStatus?.running) {
      setRefreshPhase("running");
      setRefreshHasSeenRunning(true);
    }

    const backendStatus = String(refreshStatus?.status ?? "").toLowerCase();
    const isTerminalStatus = backendStatus === "success" || backendStatus === "error";
    const markerMatchesCurrentRun = (() => {
      if (refreshObservedRunId && refreshStatus?.run_id) {
        return refreshObservedRunId === refreshStatus.run_id;
      }
      if (refreshObservedStartedAt && refreshStatus?.started_at) {
        return refreshObservedStartedAt === refreshStatus.started_at;
      }
      if (refreshStatus?.started_at) {
        const parsed = Date.parse(refreshStatus.started_at);
        return !Number.isNaN(parsed) && parsed >= refreshRequestedAt - 5000;
      }
      return refreshHasSeenRunning;
    })();

    if (isTerminalStatus && markerMatchesCurrentRun) {
      if (backendStatus === "success") {
        finalizeRefreshRun("success");
      } else {
        finalizeRefreshRun("error", refreshStatus?.error || "Atualizacao na fonte falhou.");
      }
      return;
    }

    if (!refreshStatus?.running && refreshHasSeenRunning && markerMatchesCurrentRun) {
      finalizeRefreshRun("success");
    }
  }, [
    finalizeRefreshRun,
    refreshHasSeenRunning,
    refreshObservedRunId,
    refreshObservedStartedAt,
    refreshPhase,
    refreshRequestedAt,
    refreshStatus,
  ]);

  useEffect(() => {
    if (refreshPhase !== "starting" || !refreshRequestedAt) return;
    const timeoutMs = 30000;
    const elapsedMs = Date.now() - refreshRequestedAt;
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      finalizeRefreshRun("error", "Nao foi possivel confirmar inicio da atualizacao.");
      return;
    }
    const timeoutId = setTimeout(() => {
      finalizeRefreshRun("error", "Nao foi possivel confirmar inicio da atualizacao.");
    }, remainingMs);
    return () => clearTimeout(timeoutId);
  }, [finalizeRefreshRun, refreshPhase, refreshRequestedAt]);

  useEffect(() => {
    if (routeMatch.known) return;
    router.replace("/");
  }, [routeMatch.known, router]);

  const getBudgetForPlatform = (
    platform: string,
    spent: number,
    options?: { preferDisplayedSpend?: boolean }
  ) => {
    const entry =
      platform === GENERAL_BUDGET_KEY ? data?.budget.general : (data?.budget.platforms?.[platform] ?? null);
    const target = entry?.target_brl ?? null;
    const shouldPreferDisplayedSpend = options?.preferDisplayedSpend ?? false;
    const spentValue = shouldPreferDisplayedSpend ? spent : (entry?.spent_brl ?? spent);
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
    if (!normalized || normalized === "—") return false;
    try {
      await navigator.clipboard.writeText(normalized);
      showToast(`${label} copiado.`);
      return true;
    } catch {
      showToast(`Nao foi possivel copiar ${label.toLowerCase()}.`, "error");
      return false;
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

  const stackSortButtonClass = (key: StackAdaptSortKey) =>
    `stackSortButton ${stackAdaptSort.key === key ? "stackSortButtonActive" : ""}`;

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

  const toggleCampaignJourneySort = (key: CampaignJourneySortKey) => {
    setCampaignJourneySort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      const defaultDirection: AttentionSortDirection =
        key === "token" ||
        key === "cliente" ||
        key === "campanha" ||
        key === "account_management" ||
        key === "status" ||
        key === "campaign_start" ||
        key === "campaign_end"
          ? "asc"
          : "desc";
      return { key, direction: defaultDirection };
    });
  };

  const campaignJourneySortIndicator = (key: CampaignJourneySortKey) => {
    if (campaignJourneySort.key !== key) return "↕";
    return campaignJourneySort.direction === "asc" ? "↑" : "↓";
  };

  const detailedPlatformName = ["StackAdapt", "DV360", "Xandr", "Hivestack"].includes(resolvedActivePage)
    ? resolvedActivePage
    : null;
  const detailedPlatformRows = useMemo(() => {
    if (!data) return [] as PlatformPageRow[];
    if (!detailedPlatformName) return [] as PlatformPageRow[];
    return data.platform_pages[detailedPlatformName]?.rows ?? [];
  }, [data, detailedPlatformName]);

  const platformRowMatchesDashboardFilters = useCallback(
    (row: PlatformPageRow) => {
      if (shouldHideOutOfPeriodPlatformRow(row, detailedPlatformName)) return false;
      const pseudo = journeySnapshotForPlatformRow(row, journeyByToken);
      return rowMatchesDashboardFilters(pseudo, {
        clients: clientFilter,
        cs: csFilter,
        campaigns: campaignFilter,
        statuses: campaignStatusFilter,
        features: featureFilter,
        campaignTypes: campaignTypeFilter,
      });
    },
    [
      journeyByToken,
      clientFilter,
      csFilter,
      campaignFilter,
      campaignStatusFilter,
      featureFilter,
      campaignTypeFilter,
      rowMatchesDashboardFilters,
      detailedPlatformName,
      shouldHideOutOfPeriodPlatformRow,
    ]
  );

  const outOfPeriodRowMatchesDashboardFilters = useCallback(
    (row: AttentionOutOfPeriodRow) => {
      const pseudo = journeySnapshotForOutOfPeriodRow(row, journeyByToken);
      return rowMatchesDashboardFilters(pseudo, {
        clients: clientFilter,
        cs: csFilter,
        campaigns: campaignFilter,
        statuses: campaignStatusFilter,
        features: featureFilter,
        campaignTypes: campaignTypeFilter,
      });
    },
    [
      journeyByToken,
      clientFilter,
      csFilter,
      campaignFilter,
      campaignStatusFilter,
      featureFilter,
      campaignTypeFilter,
      rowMatchesDashboardFilters,
    ]
  );

  const filteredDetailedPlatformRows = useMemo(() => {
    return detailedPlatformRows.filter(platformRowMatchesDashboardFilters);
  }, [detailedPlatformRows, platformRowMatchesDashboardFilters]);

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
        color: PLATFORM_COLORS[platform] ?? "#4e1e9c",
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
      if (hasDashboardFilters && !outOfPeriodRowMatchesDashboardFilters(row)) return false;
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
  }, [
    attentionOutOfPeriodDspFilters,
    attentionOutOfPeriodSort,
    hasDashboardFilters,
    outOfPeriodRowMatchesDashboardFilters,
    outOfPeriodRows,
    outOfPeriodSearchNormalized,
  ]);

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
        color: PLATFORM_COLORS[platform] ?? "#4e1e9c",
      }))
      .sort((a, b) => b.spend_brl - a.spend_brl);
  }, [outOfPeriodRows]);
  const outOfPeriodPieTotal = useMemo(
    () => outOfPeriodPieChartData.reduce((sum, row) => sum + row.spend_brl, 0),
    [outOfPeriodPieChartData]
  );
  const homeNoTokenAlertCount = noTokenRows.length;
  const homeNoTokenAlertTotal = useMemo(
    () => noTokenRows.reduce((sum, row) => sum + Number(row.gasto ?? 0), 0),
    [noTokenRows]
  );
  const homeOutOfPeriodAlertRows = useMemo(() => outOfPeriodRows, [outOfPeriodRows]);
  const homeOutOfPeriodAlertCount = homeOutOfPeriodAlertRows.length;
  const homeOutOfPeriodAlertTotal = useMemo(
    () => homeOutOfPeriodAlertRows.reduce((sum, row) => sum + Number(row.gasto ?? 0), 0),
    [homeOutOfPeriodAlertRows]
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
  const periodStart = data?.period.start ?? selectedDateRange.start;
  const periodEnd = data?.period.end ?? selectedDateRange.end;
  const periodRangeCompactLabel =
    selectedViewMode === "year"
      ? `Ano completo • ${formatDateBrShort(periodStart)} → ${formatDateBrShort(periodEnd)}`
      : `${formatDateBrShort(periodStart)} → ${formatDateBrShort(periodEnd)}`;
  const periodHeroLabel =
    selectedViewMode === "year"
      ? `${isValidYearKey(selectedMonthKey) ? selectedMonthKey : getCurrentYearKey()}`
      : capitalizeFirst(formatMonthKeyLabel(selectedMonthKey));
  const snapshotAgeMinutes = displayedSnapshotAt ? Math.max(0, Math.floor((Date.now() - displayedSnapshotAt) / 60000)) : null;
  const snapshotStatus = isRefreshRunning
    ? { label: "Atualizando", tone: "processing" as const }
    : !displayedSnapshotAt
      ? { label: "Sem atualização", tone: "neutral" as const }
      : snapshotAgeMinutes !== null && snapshotAgeMinutes <= 90
        ? { label: "Atualizado", tone: "ok" as const }
        : snapshotAgeMinutes !== null && snapshotAgeMinutes <= 240
          ? { label: "Em atraso", tone: "warn" as const }
          : { label: "Desatualizado", tone: "danger" as const };

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
        "Start date campanha",
        "End date campanha",
      ];
      const rowsToExport = sortedCampaignRows.map((row) => [
        row.token,
        row.cliente,
        row.campanha,
        row.account_management,
        row.status,
        row.investido,
        ...data.dashboard.active_platforms.map((platform) => Number(row[platform] ?? 0)),
        row.total_plataformas,
        row.pct_investido,
        row.campaign_start ?? "",
        row.campaign_end ?? "",
      ]);
      downloadCsv("campaign-journey.csv", headers, rowsToExport);
    };

    const firstRowDspCards: Array<{
      title: string;
      value: string;
      subtitle?: ReactNode;
      usdLine?: string;
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
    const dspFiltered = filteredSpendByPlatform;

    const compareDspKpiCardsBySpendDesc = (
      a: { title: string; spendBrl?: number; dimmed?: boolean; badgeTone?: "soon" },
      b: { title: string; spendBrl?: number; dimmed?: boolean; badgeTone?: "soon" }
    ) => {
      const sa = a.dimmed && a.spendBrl == null ? Number.NEGATIVE_INFINITY : (a.spendBrl ?? 0);
      const sb = b.dimmed && b.spendBrl == null ? Number.NEGATIVE_INFINITY : (b.spendBrl ?? 0);
      if (sb !== sa) return sb - sa;
      const soonA = a.badgeTone === "soon" ? 1 : 0;
      const soonB = b.badgeTone === "soon" ? 1 : 0;
      if (soonA !== soonB) return soonA - soonB;
      if (Boolean(a.dimmed) !== Boolean(b.dimmed)) return Number(a.dimmed) - Number(b.dimmed);
      return String(a.title).localeCompare(String(b.title), "pt-BR", { sensitivity: "base" });
    };

    for (const name of ["StackAdapt", "DV360", "Xandr"] as const) {
      const result = data.platform_results[name];
      if (!result) continue;
      if (result.status === "ok") {
        const pageSpend = data.platform_pages[name]?.spend_brl ?? 0;
        const cardSpend = hasDashboardScopeFilters ? (dspFiltered?.[name] ?? 0) : pageSpend;
        const usdTotal = result.spend ?? 0;
        const rate = data.exchange_rate_usd_brl;
        const usdForSubtitle =
          hasDashboardScopeFilters
            ? pageSpend > 0
              ? (cardSpend / pageSpend) * usdTotal
              : rate > 0
                ? cardSpend / rate
                : 0
            : usdTotal;
        firstRowDspCards.push({
          title: name,
          value: brl(cardSpend),
          usdLine: `USD ${usdForSubtitle.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
          titleEmphasis: true,
          logoSrc: PLATFORM_LOGOS[name],
          platformKey: name,
          spendBrl: cardSpend,
        });
      } else if (result.status === "error") {
        firstRowDspCards.push({
          title: name,
          value: "—",
          subtitle: result.message ?? "Falha ao carregar",
          dimmed: true,
          titleEmphasis: true,
          logoSrc: PLATFORM_LOGOS[name],
        });
      }
    }

    firstRowDspCards.sort(compareDspKpiCardsBySpendDesc);

    const secondRowPlatformCards: Array<{
      title: string;
      value: string;
      subtitle?: ReactNode;
      usdLine?: string;
      metric?: { label: string; value: string };
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

    secondRowPlatformCards.push({
      title: "Amazon",
      value: brl(0),
      subtitle: "Indisponível",
      badge: "Em breve",
      badgeTone: "soon",
      titleEmphasis: true,
      logoSrc: PLATFORM_LOGOS.Amazon,
      platformKey: "Amazon",
      spendBrl: 0,
    });

    const nexdPage = data.platform_pages.Nexd;
    const nexdStatus = data.nexd?.status;
    if (!hasDashboardFilters) {
      if (nexdPage) {
        const impressions = Math.round(Number(nexdPage.impressions ?? 0));
        secondRowPlatformCards.push({
          title: "NEXD",
          value: brl(Number(nexdPage.spend_brl ?? 0)),
          usdLine:
            nexdPage.spend_usd != null && Number.isFinite(Number(nexdPage.spend_usd))
              ? `USD ${Number(nexdPage.spend_usd).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
              : undefined,
          metric: {
            label: "Impressões",
            value: impressions.toLocaleString("pt-BR"),
          },
          titleEmphasis: true,
          logoSrc: PLATFORM_LOGOS.Nexd,
          platformKey: "Nexd",
          spendBrl: Number(nexdPage.spend_brl ?? 0),
        });
      } else if (nexdStatus === "error") {
        secondRowPlatformCards.push({
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
        secondRowPlatformCards.push({
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
    }

    const hivestackPage = data.platform_pages.Hivestack;
    const hivestackStatus = data.platform_results.Hivestack?.status;
    if (hivestackPage) {
      const hiveSpend = Number(hivestackPage.spend_brl ?? 0);
      secondRowPlatformCards.push({
        title: "Hivestack",
        value: brl(hiveSpend),
        subtitle: hiveSpend <= 0 ? "Sem atividade no período" : "Consolidado em BRL",
        titleEmphasis: true,
        logoSrc: PLATFORM_LOGOS.Hivestack,
        platformKey: "Hivestack",
        spendBrl: hiveSpend,
      });
    } else if (hivestackStatus === "error") {
      secondRowPlatformCards.push({
        title: "Hivestack",
        value: "—",
        subtitle: data.platform_results.Hivestack?.message ?? "Falha ao carregar",
        dimmed: true,
        titleEmphasis: true,
        logoSrc: PLATFORM_LOGOS.Hivestack,
        platformKey: "Hivestack",
        spendBrl: 0,
      });
    } else {
      secondRowPlatformCards.push({
        title: "Hivestack",
        value: brl(0),
        subtitle: "Sem dados",
        badge: "Em breve",
        badgeTone: "soon",
        titleEmphasis: true,
        logoSrc: PLATFORM_LOGOS.Hivestack,
        platformKey: "Hivestack",
        spendBrl: 0,
      });
    }

    const homeDspPlatformKpiCards = [...secondRowPlatformCards].sort(compareDspKpiCardsBySpendDesc);

    const investedBaseRows = hasDashboardScopeFilters ? dashboardFilteredRows : journeyRows;
    const investedTotal = investedBaseRows.reduce((sum, row) => sum + Number(row.investido ?? 0), 0);

    const dspFilteredConsolidated = hasDashboardScopeFilters
      ? data.dashboard.active_platforms.reduce((sum, p) => sum + (dspFiltered?.[p] ?? 0), 0)
      : data.total_brl;
    const IDEAL_TECH_COST_PCT = 12.5;
    const techCostPct = investedTotal > 0 ? (dspFilteredConsolidated / investedTotal) * 100 : null;
    const techCostLabel = techCostPct === null ? "—" : `${techCostPct.toFixed(2).replace(".", ",")}%`;
    const isTechCostWithinIdeal = techCostPct !== null && techCostPct <= IDEAL_TECH_COST_PCT;

    const consolidatedCard: {
      title: string;
      value: string;
      subtitle?: string;
      usdLine?: string;
      titleEmphasis: boolean;
      platformKey: string;
      spendBrl: number;
      variant: "premium";
      summaryHighlight?: boolean;
    } = {
      title: "Consolidado",
      value: brl(hasDashboardScopeFilters ? dspFilteredConsolidated : data.total_brl),
      subtitle: hasDashboardFilters
        ? "Soma das DSPs nos filtros selecionados · Nexd, Hivestack e Amazon não entram neste total"
        : undefined,
      usdLine: hasDashboardScopeFilters
        ? undefined
        : `Câmbio: 1 USD = R$ ${data.exchange_rate_usd_brl.toLocaleString("pt-BR", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`,
      titleEmphasis: true,
      platformKey: GENERAL_BUDGET_KEY,
      spendBrl: hasDashboardScopeFilters ? dspFilteredConsolidated : data.total_brl,
      variant: "premium",
      summaryHighlight: true,
    };

    const homeInvestidoKpiCard = {
      title: "Investido",
      value: brl(investedTotal),
      subtitle: hasDashboardScopeFilters
        ? "Total investido das campanhas nos filtros selecionados"
        : "Total investido das campanhas ativas no período",
      titleEmphasis: true as const,
      summaryHighlight: true as const,
    };

    const homeTechCostKpiCard = {
      title: "Tech Cost",
      value: techCostLabel,
      statusIndicator: {
        label: techCostPct === null ? "Sem base" : isTechCostWithinIdeal ? "Ideal" : "Acima",
        tone: techCostPct === null ? "neutral" : isTechCostWithinIdeal ? "success" : "danger",
      } as const,
      subtitle:
        techCostPct === null
          ? "Sem investido para calcular"
          : (
              <div className="cardTechCostBreakdown">
                <p className="cardTechCostBreakdownLine">
                  Custo: <strong>{BRL_INTEGER_FORMATTER.format(dspFilteredConsolidated)}</strong>
                </p>
                <p className="cardTechCostBreakdownLine">
                  Investido: <strong>{BRL_INTEGER_FORMATTER.format(investedTotal)}</strong>
                </p>
                <p className="cardTechCostBreakdownLine cardTechCostBreakdownLineHint">
                  Ideal:{" "}
                  <strong>
                    &lt; {IDEAL_TECH_COST_PCT.toFixed(1).replace(".", ",")}%
                  </strong>
                </p>
              </div>
            ),
      titleEmphasis: true as const,
    };

    return (
      <>
        <section className="panel panelSub filterPanelCard filterPanelCardDashboard">
          <button
            type="button"
            className="filterPanelHeader filterPanelHeaderToggle"
            onClick={() => setIsDashboardFiltersExpanded((prev) => !prev)}
            aria-expanded={isDashboardFiltersExpanded}
            aria-controls="dashboard-filter-content"
            aria-label={
              isDashboardFiltersExpanded
                ? "Ocultar filtros do dashboard"
                : "Mostrar filtros do dashboard"
            }
          >
            <span className="filterPanelHeaderTitleBlock">
              <span className="filterPanelTitleRow" role="heading" aria-level={3}>
                <FilterLinesIcon />
                Filtros do dashboard
              </span>
            </span>
            <span className="filterPanelHeaderActions">
              <span className="filterPanelActiveCount">
                Filtros ({activeDashboardFilterCount.toLocaleString("pt-BR")})
              </span>
              <span className="filterPanelToggleChevron" aria-hidden="true">
                <FilterPanelDrawerChevron expanded={isDashboardFiltersExpanded} />
              </span>
            </span>
          </button>
          {isDashboardFiltersExpanded ? (
            <div id="dashboard-filter-content" className="filterPanelBody">
              <div className="filterToolbar filterToolbarDashboard">
                <MultiSelectFilter
                  id="filter-client"
                  label="Cliente"
                  options={clients}
                  value={clientFilter}
                  onChange={setClientFilter}
                  placeholder="Todos os clientes"
                  disabledOptions={disabledClientOptions}
                  compact
                />
                <MultiSelectFilter
                  id="filter-cs"
                  label="CS"
                  options={csFilterOptions}
                  value={csFilter}
                  onChange={setCsFilter}
                  placeholder="Todos os CS"
                  showAvatar
                  disabledOptions={disabledCsOptions}
                  compact
                />
                <MultiSelectFilter
                  id="filter-campaign-type"
                  label="Produto"
                  options={productFilterOptions}
                  value={campaignTypeFilter}
                  onChange={setCampaignTypeFilter}
                  placeholder="Todos os produtos"
                  disabledOptions={disabledCampaignTypeOptions}
                  compact
                />
                <MultiSelectFilter
                  id="filter-feature"
                  label="Feature"
                  options={[...FEATURE_OPTIONS]}
                  value={featureFilter}
                  onChange={setFeatureFilter}
                  placeholder="Todas as features"
                  disabledOptions={disabledFeatureOptions}
                  compact
                />
                <MultiSelectFilter
                  id="filter-campaign"
                  label="Campanha"
                  options={campaignFilterOptions}
                  value={campaignFilter}
                  onChange={setCampaignFilter}
                  placeholder="Todas as campanhas"
                  disabledOptions={disabledCampaignOptions}
                  compact
                />
                <MultiSelectFilter
                  id="filter-campaign-status"
                  label="Status"
                  options={campaignStatusOptions}
                  value={campaignStatusFilter}
                  onChange={setCampaignStatusFilter}
                  placeholder="Todos os status"
                  disabledOptions={disabledCampaignStatusOptions}
                  compact
                />
              </div>
              <div className="filterPanelFooterBar">
                {hasDashboardFilters ? (
                  <button type="button" className="filterPanelClearAllButton" onClick={clearDashboardFilters}>
                    Limpar tudo
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        <section className="gridCards homeDspRow">
          {firstRowDspCards.map((card) => (
            <KpiCard
              key={`${card.title}-${card.badge ?? "nobadge"}`}
              {...card}
              budget={
                hasDashboardFilters || !card.platformKey
                  ? undefined
                  : getBudgetForPlatform(card.platformKey, card.spendBrl ?? 0, {
                      preferDisplayedSpend: hasDashboardScopeFilters,
                    })
              }
            />
          ))}
        </section>
        <section className="gridCards homeDspPlatformsRow" aria-label="DSPs adicionais">
          {homeDspPlatformKpiCards.map((card) => (
            <KpiCard
              key={`${card.title}-${card.badge ?? "nobadge"}`}
              {...card}
              budget={
                hasDashboardFilters || !card.platformKey
                  ? undefined
                  : getBudgetForPlatform(card.platformKey, card.spendBrl ?? 0, {
                      preferDisplayedSpend: hasDashboardScopeFilters,
                    })
              }
            />
          ))}
        </section>
        <section className="gridCards homeSummaryRow" aria-label="Totais do período">
          <KpiCard key="dashboard-investido" {...homeInvestidoKpiCard} />
          <KpiCard key="dashboard-tech-cost" {...homeTechCostKpiCard} />
          <KpiCard
            key={`${consolidatedCard.title}-${consolidatedCard.variant ?? "default"}`}
            {...consolidatedCard}
            budget={
              hasDashboardFilters || !consolidatedCard.platformKey
                ? undefined
                : getBudgetForPlatform(consolidatedCard.platformKey, consolidatedCard.spendBrl ?? 0, {
                    preferDisplayedSpend: hasDashboardScopeFilters,
                  })
            }
          />
        </section>
        <section className="homeAlertsSection" aria-labelledby="home-dashboard-alerts-heading">
          <div className="homeAlertsSectionHeader">
            <h2 id="home-dashboard-alerts-heading" className="homeAlertsSectionTitle">
              <span aria-hidden="true">{"\u26A0\uFE0F"}</span> Alertas
            </h2>
          </div>
          <div className="gridCards homeAlertsRow">
            <div
              className={`card alertNavCard alertSignalCard ${
                homeNoTokenAlertCount > 0 ? "alertSignalCardWarning" : "alertSignalCardSafe"
              }`}
            >
              <p className="alertSignalBadge">
                {homeNoTokenAlertCount > 0 ? "Atenção necessária" : "Sem alerta"}
              </p>
              <p className="cardValue alertNavCardValueLead">
                {homeNoTokenAlertCount.toLocaleString("pt-BR")}
              </p>
              <p className="alertNavCardLabel">Lines sem token</p>
              <p className="cardSubtitle alertNavCardImpact">
                {brl(homeNoTokenAlertTotal)} impactados
              </p>
              <button
                type="button"
                className="alertCardDetailButton"
                onClick={() => router.push("/lines-sem-token")}
              >
                Ver detalhes →
              </button>
            </div>
            <div
              className={`card alertNavCard alertSignalCard ${
                homeOutOfPeriodAlertCount > 0 ? "alertSignalCardDanger" : "alertSignalCardSafe"
              }`}
            >
              <p className="alertSignalBadge">
                {homeOutOfPeriodAlertCount > 0 ? "Risco de vigência" : "Sem alerta"}
              </p>
              <p className="cardValue alertNavCardValueLead">
                {homeOutOfPeriodAlertCount.toLocaleString("pt-BR")}
              </p>
              <p className="alertNavCardLabel">Gastos fora do mês</p>
              <p className="cardSubtitle alertNavCardImpact">
                {brl(homeOutOfPeriodAlertTotal)} impactados
              </p>
              <button
                type="button"
                className="alertCardDetailButton"
                onClick={() => router.push("/gasto-fora-mes-vigente")}
              >
                Ver detalhes →
              </button>
            </div>
          </div>
        </section>

        <section className="gridTwo gridTwoCharts">
          <div className="panel panelChart">
            <div className="chartBlockHeading">
              <div className="chartBlockHeadingTop">
                <h2 className="chartBlockTitle">Gasto por plataforma</h2>
                <div className="chartBlockExport" role="group" aria-label="Exportar gasto por plataforma">
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall chartExportButton"
                    aria-label="Copiar gasto por plataforma como CSV"
                    onClick={() =>
                      copyObjectsAsCsv(
                        "gasto por plataforma",
                        chartData.map((entry) => ({
                          plataforma: entry.platform,
                          gasto_brl: entry.spend_brl.toFixed(2),
                          pct_total:
                            periodTotalSpend > 0 ? ((entry.spend_brl / periodTotalSpend) * 100).toFixed(2) : "0.00",
                        }))
                      )
                    }
                  >
                    <span className="buttonLabelWithIcon">
                      <DownloadIcon />
                      CSV
                    </span>
                  </button>
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall chartExportButton"
                    aria-label="Exportar gráfico de gasto por plataforma como PNG"
                    onClick={() => exportChartAsPng(spendByPlatformChartRef.current, "gasto por plataforma")}
                  >
                    PNG
                  </button>
                </div>
              </div>
              <p className="chartBlockSubtitle">Valores absolutos (R$)</p>
            </div>
            {!chartData.length ? (
              <p className="alertInfo">Nenhum gasto em DSP com os filtros selecionados.</p>
            ) : (
            <div
              className="chartWrap"
              ref={spendByPlatformChartRef}
              role="img"
              aria-label={`Gasto por plataforma em valores absolutos (reais), período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
            >
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={barChartData}
                  layout="vertical"
                  margin={{ top: 6, right: 58, bottom: 6, left: 2 }}
                >
                  <CartesianGrid
                    vertical
                    horizontal={false}
                    stroke="rgba(148, 163, 184, 0.07)"
                    strokeDasharray="2 10"
                  />
                  <XAxis
                    type="number"
                    stroke="rgba(148, 163, 184, 0.28)"
                    tick={{ fill: "rgba(148, 163, 184, 0.72)", fontSize: 10 }}
                    tickFormatter={formatCurrencyAxisTick}
                    tickCount={4}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="platform"
                    stroke="#cbd5e1"
                    width={140}
                    tickLine={false}
                    axisLine={false}
                    tick={<PlatformYAxisTick />}
                  />
                  <Tooltip
                    shared
                    content={<NumberTooltip totalValue={periodTotalSpend} />}
                    cursor={{ fill: "rgba(15, 23, 42, 0.28)", stroke: "none" }}
                    offset={{ x: 18, y: 4 }}
                    allowEscapeViewBox={{ x: false, y: true }}
                    animationDuration={120}
                  />
                  <Bar
                    dataKey="spend_brl"
                    name="Gasto"
                    barSize={20}
                    radius={[0, 10, 10, 0]}
                    label={{
                      position: "right",
                      fill: "#e2e8f0",
                      fontSize: 11,
                      fontWeight: 650,
                      formatter: (label) => {
                        const raw = Array.isArray(label) ? label[label.length - 1] : label;
                        const n = typeof raw === "number" ? raw : Number(raw);
                        return Number.isFinite(n) ? formatCurrencyAxisTick(n) : "";
                      },
                    }}
                  >
                    {barChartData.map((entry) => {
                      const fill = entry.color ?? PLATFORM_COLORS[entry.platform] ?? "#64748b";
                      return <Cell key={entry.platform} fill={fill} />;
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            )}
          </div>

          <div className="panel panelChart">
            <div className="chartBlockHeading">
              <div className="chartBlockHeadingTop">
                <h2 className="chartBlockTitle">Distribuição</h2>
                <div className="chartBlockExport" role="group" aria-label="Exportar distribuição de investimento">
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall chartExportButton"
                    aria-label="Copiar distribuição de investimento como CSV"
                    onClick={() =>
                      copyObjectsAsCsv(
                        "distribuição de investimento",
                        chartData.map((entry) => ({
                          plataforma: entry.platform,
                          gasto_brl: entry.spend_brl.toFixed(2),
                          pct_total:
                            periodTotalSpend > 0 ? ((entry.spend_brl / periodTotalSpend) * 100).toFixed(2) : "0.00",
                        }))
                      )
                    }
                  >
                    <span className="buttonLabelWithIcon">
                      <DownloadIcon />
                      CSV
                    </span>
                  </button>
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall chartExportButton"
                    aria-label="Exportar gráfico de distribuição como PNG"
                    onClick={() => exportChartAsPng(distributionChartRef.current, "distribuição de investimento")}
                  >
                    PNG
                  </button>
                </div>
              </div>
              <p className="chartBlockSubtitle">% do total investido</p>
            </div>
            {!chartData.length ? (
              <p className="alertInfo">Nenhum gasto em DSP com os filtros selecionados.</p>
            ) : (
            <div
              className="chartWrap"
              ref={distributionChartRef}
              role="img"
              aria-label={`Distribuição percentual do gasto por plataforma em relação ao total investido, período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
            >
              {shouldFallbackPieChart ? (
                <div className="chartFallback">
                  <p className="chartFallbackTitle">Distribuição muito concentrada para donut.</p>
                  <p className="chartFallbackSubtitle">Mostrando proporções em barras para leitura mais clara.</p>
                  <div className="chartFallbackList">
                    {chartData.map((entry, idx) => {
                      const pct = periodTotalSpend > 0 ? (entry.spend_brl / periodTotalSpend) * 100 : 0;
                      const isDominant = idx === 0;
                      const isHi =
                        distributionHighlightPlatform !== null &&
                        distributionHighlightPlatform === entry.platform;
                      const dim =
                        distributionHighlightPlatform !== null &&
                        distributionHighlightPlatform !== entry.platform;
                      return (
                        <div
                          key={entry.platform}
                          className={`chartFallbackItem${isDominant ? " chartFallbackItemDominant" : ""}${isHi ? " chartFallbackItemHighlight" : ""}`}
                          onMouseEnter={() => setDistributionHighlightPlatform(entry.platform)}
                          onMouseLeave={() => setDistributionHighlightPlatform(null)}
                          style={{ opacity: dim ? 0.35 : 1 }}
                        >
                          <div className="chartFallbackItemHeader">
                            <span>{entry.platform}</span>
                            <span>{pct.toFixed(1)}%</span>
                          </div>
                          <div className="chartFallbackBarTrack">
                            <div
                              className="chartFallbackBarFill"
                              style={{
                                width: `${Math.min(100, Math.max(0, pct))}%`,
                                backgroundColor: entry.color ?? PLATFORM_COLORS[entry.platform] ?? "#64748b",
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="chartDistributionSplit">
                  <div className="chartDistributionPie">
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie
                          data={chartData}
                          dataKey="spend_brl"
                          nameKey="platform"
                          innerRadius={66}
                          outerRadius={102}
                          paddingAngle={2}
                          stroke="rgba(28, 38, 47, 0.9)"
                          strokeWidth={2}
                          label={false}
                          onMouseEnter={(_entry, index) => {
                            const row = chartData[index];
                            if (row?.platform) setDistributionHighlightPlatform(row.platform);
                          }}
                          onMouseLeave={() => setDistributionHighlightPlatform(null)}
                        >
                          {chartData.map((entry) => {
                            const fill = entry.color ?? PLATFORM_COLORS[entry.platform] ?? "#64748b";
                            const dim =
                              distributionHighlightPlatform !== null &&
                              distributionHighlightPlatform !== entry.platform;
                            return (
                              <Cell
                                key={entry.platform}
                                fill={fill}
                                fillOpacity={dim ? 0.3 : 1}
                                stroke={dim ? "rgba(28, 38, 47, 0.35)" : "rgba(28, 38, 47, 0.9)"}
                              />
                            );
                          })}
                        </Pie>
                        <text
                          x="50%"
                          y="39%"
                          textAnchor="middle"
                          dominantBaseline="middle"
                          className="chartDonutInvestidoLabel"
                        >
                          Total
                        </text>
                        <text
                          x="50%"
                          y="46%"
                          textAnchor="middle"
                          dominantBaseline="middle"
                          className="chartDonutInvestidoLabel"
                        >
                          investido
                        </text>
                        <text
                          x="50%"
                          y="58%"
                          textAnchor="middle"
                          dominantBaseline="middle"
                          className="chartDonutInvestidoValue"
                        >
                          {formatDonutCenterValue(periodTotalSpend)}
                        </text>
                        <Tooltip content={<NumberTooltip totalValue={periodTotalSpend} />} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <aside className="chartDistributionPctList" aria-label="Percentual por plataforma">
                    {chartData.map((entry, idx) => {
                      const pct = periodTotalSpend > 0 ? (entry.spend_brl / periodTotalSpend) * 100 : 0;
                      const isDominant = idx === 0;
                      const isHi =
                        distributionHighlightPlatform !== null &&
                        distributionHighlightPlatform === entry.platform;
                      const dim =
                        distributionHighlightPlatform !== null &&
                        distributionHighlightPlatform !== entry.platform;
                      const fill = entry.color ?? PLATFORM_COLORS[entry.platform] ?? "#64748b";
                      return (
                        <div
                          key={entry.platform}
                          className={`chartDistributionPctRow${isDominant ? " chartDistributionPctRowDominant" : ""}${isHi ? " chartDistributionPctRowHighlight" : ""}`}
                          onMouseEnter={() => setDistributionHighlightPlatform(entry.platform)}
                          onMouseLeave={() => setDistributionHighlightPlatform(null)}
                          style={{ opacity: dim ? 0.38 : 1 }}
                        >
                          <span className="chartDistributionPctName">
                            <span
                              className="chartDistributionPctSwatch"
                              style={{ backgroundColor: fill }}
                              aria-hidden
                            />
                            {entry.platform}
                          </span>
                          <span className="chartDistributionPctValue">{pct.toFixed(1)}%</span>
                        </div>
                      );
                    })}
                  </aside>
                </div>
              )}
            </div>
            )}
          </div>
        </section>

        <section className="panel panelChart">
          <div className="chartBlockHeading">
            <div className="chartBlockHeadingTop">
              <h2 className="chartBlockTitle">Custo dia a dia</h2>
              <div className="chartBlockExport" role="group" aria-label="Exportar custo dia a dia">
                <button
                  type="button"
                  className="button buttonGhost buttonSmall chartExportButton"
                  aria-label="Copiar custo dia a dia como CSV"
                  onClick={() =>
                    copyObjectsAsCsv(
                      "custo dia a dia",
                      dailyChartRows.map((row) => {
                        const baseRow: Record<string, string | number> = {
                          data: formatDateBr(String(row.date)),
                          total_brl: Number(row.total ?? 0).toFixed(2),
                        };
                        for (const platform of dailyChartPlatforms) {
                          baseRow[`${platform}_brl`] = Number(row[platform] ?? 0).toFixed(2);
                        }
                        return baseRow;
                      })
                    )
                  }
                >
                  <span className="buttonLabelWithIcon">
                    <DownloadIcon />
                    CSV
                  </span>
                </button>
                <button
                  type="button"
                  className="button buttonGhost buttonSmall chartExportButton"
                  aria-label="Exportar gráfico de custo dia a dia como PNG"
                  onClick={() => exportChartAsPng(dailyCostChartRef.current, "custo dia a dia")}
                >
                  PNG
                </button>
              </div>
            </div>
            <p className="chartBlockSubtitle">Evolução diária por plataforma</p>
          </div>
          {!dailyChartRows.length ? (
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
                <LineChart data={dailyChartRows}>
                  <CartesianGrid
                    vertical
                    horizontal={false}
                    stroke="rgba(148, 163, 184, 0.07)"
                    strokeDasharray="2 10"
                  />
                  <XAxis
                    dataKey="date"
                    stroke="rgba(148, 163, 184, 0.28)"
                    tick={{ fill: "rgba(148, 163, 184, 0.72)", fontSize: 10 }}
                    tickFormatter={(value) => formatDateBr(String(value))}
                    tickCount={6}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="rgba(148, 163, 184, 0.28)"
                    tick={{ fill: "rgba(148, 163, 184, 0.72)", fontSize: 10 }}
                    tickFormatter={formatCurrencyAxisTick}
                    tickCount={4}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    shared
                    content={<NumberTooltip labelFormatter={(label) => formatDateBr(String(label))} />}
                    cursor={{ fill: "rgba(15, 23, 42, 0.28)", stroke: "none" }}
                    offset={{ x: 18, y: 4 }}
                    allowEscapeViewBox={{ x: false, y: true }}
                    animationDuration={120}
                  />
                  <Legend
                    content={
                      <DailyCostLegend
                        entries={dailyChartLegendPayload}
                        activeKeys={dailyCostFocusedSeries}
                        onToggle={(seriesKey) =>
                          setDailyCostFocusedSeries((current) =>
                            current.includes(seriesKey)
                              ? current.filter((value) => value !== seriesKey)
                              : [...current, seriesKey]
                          )
                        }
                      />
                    }
                  />
                  {dailyChartPlatforms.map((platform) => {
                    if (dailyCostFocusedSeries.length > 0 && !dailyCostFocusedSeries.includes(platform)) {
                      return null;
                    }
                    return (
                      <Line
                        key={platform}
                        type="monotone"
                        dataKey={platform}
                        stroke={PLATFORM_COLORS[platform] ?? "#4e1e9c"}
                        strokeWidth={2.5}
                        dot={false}
                        activeDot={{ r: 5, strokeWidth: 2, stroke: "#1c262f" }}
                      />
                    );
                  })}
                  {dailyCostFocusedSeries.length === 0 || dailyCostFocusedSeries.includes("total") ? (
                    <Line
                      type="monotone"
                      dataKey="total"
                      stroke="#e2e8f0"
                      strokeWidth={2.5}
                      strokeDasharray="4 4"
                      dot={false}
                      activeDot={{ r: 5, strokeWidth: 2, stroke: "#1c262f" }}
                    />
                  ) : null}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="panel panelChart">
          <div className="tableHeader">
            <h2>Jornada de Campanhas</h2>
            <button type="button" className="button buttonGhost buttonSmall" onClick={handleExportCampaignJourney}>
              <span className="buttonLabelWithIcon">
                <DownloadIcon />
                CSV
              </span>
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
          ) : !sortedCampaignRows.length ? (
            <p className="alertInfo">Nenhum token com gasto no mês corrente encontrado nas plataformas.</p>
          ) : (
            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      <button type="button" className="stackSortButton" onClick={() => toggleCampaignJourneySort("token")}>
                        <span>Token</span>
                        <span>{campaignJourneySortIndicator("token")}</span>
                      </button>
                    </th>
                    <th>
                      <button type="button" className="stackSortButton" onClick={() => toggleCampaignJourneySort("cliente")}>
                        <span>Cliente</span>
                        <span>{campaignJourneySortIndicator("cliente")}</span>
                      </button>
                    </th>
                    <th>
                      <button type="button" className="stackSortButton" onClick={() => toggleCampaignJourneySort("campanha")}>
                        <span>Campanha</span>
                        <span>{campaignJourneySortIndicator("campanha")}</span>
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="stackSortButton"
                        onClick={() => toggleCampaignJourneySort("account_management")}
                      >
                        <span>Account Management</span>
                        <span>{campaignJourneySortIndicator("account_management")}</span>
                      </button>
                    </th>
                    <th>
                      <button type="button" className="stackSortButton" onClick={() => toggleCampaignJourneySort("status")}>
                        <span>Status</span>
                        <span>{campaignJourneySortIndicator("status")}</span>
                      </button>
                    </th>
                    <th>
                      <button type="button" className="stackSortButton" onClick={() => toggleCampaignJourneySort("investido")}>
                        <span>Investido</span>
                        <span>{campaignJourneySortIndicator("investido")}</span>
                      </button>
                    </th>
                    {data.dashboard.active_platforms.map((platform) => (
                      <th key={platform}>
                        <button
                          type="button"
                          className="stackSortButton"
                          onClick={() => toggleCampaignJourneySort(`platform:${platform}`)}
                        >
                          <span>{platform}</span>
                          <span>{campaignJourneySortIndicator(`platform:${platform}`)}</span>
                        </button>
                      </th>
                    ))}
                    <th>
                      <button
                        type="button"
                        className="stackSortButton"
                        onClick={() => toggleCampaignJourneySort("total_plataformas")}
                      >
                        <span>Total Plataformas</span>
                        <span>{campaignJourneySortIndicator("total_plataformas")}</span>
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="stackSortButton"
                        onClick={() => toggleCampaignJourneySort("pct_investido")}
                      >
                        <span>% Investido</span>
                        <span>{campaignJourneySortIndicator("pct_investido")}</span>
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="stackSortButton"
                        onClick={() => toggleCampaignJourneySort("campaign_start")}
                      >
                        <span>
                          Start&nbsp;date
                          <br />
                          campanha
                        </span>
                        <span>{campaignJourneySortIndicator("campaign_start")}</span>
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="stackSortButton"
                        onClick={() => toggleCampaignJourneySort("campaign_end")}
                      >
                        <span>
                          End&nbsp;date
                          <br />
                          campanha
                        </span>
                        <span>{campaignJourneySortIndicator("campaign_end")}</span>
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedCampaignRows.map((row, index) => (
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
                            {hasAccountManagerWhatsApp(String(row.account_management)) ? (
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
                            ) : null}
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
                      <td>{row.campaign_start ? formatDateBr(row.campaign_start) : "—"}</td>
                      <td>{row.campaign_end ? formatDateBr(row.campaign_end) : "—"}</td>
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
      const progressColor = usedPct >= 80 ? "#f5272b" : usedPct >= 60 ? "#edd900" : "#3397b9";
      const nexdFormatPieData = (page.layouts ?? [])
        .map((row, index) => ({
          name: row.layout,
          value: Number(row.estimated_cost_brl ?? 0),
          color: [
            "#3397b9",
            "#018376",
            "#4e1e9c",
            "#4cb050",
            "#246c84",
            "#edd900",
            "#536872",
            "#8fd4ea",
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
                  color: "#a8b8c0",
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
                        stroke="rgba(28, 38, 47, 0.7)"
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
    const renderTokenValue = (token: string | null | undefined) => {
      if (hasCampaignToken(token)) return token;
      return (
        <span title="Sem token" aria-label="Sem token">
          —
        </span>
      );
    };
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
        hasDashboardScopeFilters || hasDashboardFilters || stackAdaptSearch.trim() !== "" || dspLinesOnlyWithoutToken;
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
          <section className="panel panelSub filterPanelCard filterPanelCardDashboard">
            <button
              type="button"
              className="filterPanelHeader filterPanelHeaderToggle"
              onClick={() => setIsDashboardFiltersExpanded((prev) => !prev)}
              aria-expanded={isDashboardFiltersExpanded}
              aria-controls={`dsp-dashboard-filter-content-${platformName}`}
              aria-label={
                isDashboardFiltersExpanded
                  ? "Ocultar filtros do dashboard"
                  : "Mostrar filtros do dashboard"
              }
            >
              <span className="filterPanelHeaderTitleBlock">
                <span className="filterPanelTitleRow" role="heading" aria-level={3}>
                  <FilterLinesIcon />
                  Filtros do dashboard
                </span>
              </span>
              <span className="filterPanelHeaderActions">
                <span className="filterPanelActiveCount">
                  Filtros ({activeDashboardFilterCount.toLocaleString("pt-BR")})
                </span>
                <span className="filterPanelToggleChevron" aria-hidden="true">
                  <FilterPanelDrawerChevron expanded={isDashboardFiltersExpanded} />
                </span>
              </span>
            </button>
            {isDashboardFiltersExpanded ? (
              <div id={`dsp-dashboard-filter-content-${platformName}`} className="filterPanelBody">
                <div className="filterToolbar filterToolbarDashboard">
                  <MultiSelectFilter
                    id={`dsp-filter-client-${platformName}`}
                    label="Cliente"
                    options={clients}
                    value={clientFilter}
                    onChange={setClientFilter}
                    placeholder="Todos os clientes"
                    disabledOptions={disabledClientOptions}
                    compact
                  />
                  <MultiSelectFilter
                    id={`dsp-filter-cs-${platformName}`}
                    label="CS"
                    options={csFilterOptions}
                    value={csFilter}
                    onChange={setCsFilter}
                    placeholder="Todos os CS"
                    showAvatar
                    disabledOptions={disabledCsOptions}
                    compact
                  />
                  <MultiSelectFilter
                    id={`dsp-filter-campaign-type-${platformName}`}
                    label="Produto"
                    options={productFilterOptions}
                    value={campaignTypeFilter}
                    onChange={setCampaignTypeFilter}
                    placeholder="Todos os produtos"
                    disabledOptions={disabledCampaignTypeOptions}
                    compact
                  />
                  <MultiSelectFilter
                    id={`dsp-filter-feature-${platformName}`}
                    label="Feature"
                    options={[...FEATURE_OPTIONS]}
                    value={featureFilter}
                    onChange={setFeatureFilter}
                    placeholder="Todas as features"
                    disabledOptions={disabledFeatureOptions}
                    compact
                  />
                  <MultiSelectFilter
                    id={`dsp-filter-campaign-${platformName}`}
                    label="Campanha"
                    options={campaignFilterOptions}
                    value={campaignFilter}
                    onChange={setCampaignFilter}
                    placeholder="Todas as campanhas"
                    disabledOptions={disabledCampaignOptions}
                    compact
                  />
                  <MultiSelectFilter
                    id={`dsp-filter-campaign-status-${platformName}`}
                    label="Status"
                    options={campaignStatusOptions}
                    value={campaignStatusFilter}
                    onChange={setCampaignStatusFilter}
                    placeholder="Todos os status"
                    disabledOptions={disabledCampaignStatusOptions}
                    compact
                  />
                </div>
                <div className="filterPanelFooterBar">
                  {hasDashboardFilters ? (
                    <button type="button" className="filterPanelClearAllButton" onClick={clearDashboardFilters}>
                      Limpar tudo
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>

          <section className="gridCards">
            <KpiCard
              title={platformName}
              value={brl(lineDetailFiltersActive ? filteredTotalGasto : page.spend_brl)}
              usdLine={
                !lineDetailFiltersActive && page.currency === "USD"
                  ? `USD ${(page.spend_usd ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                  : undefined
              }
              subtitle={undefined}
              titleEmphasis
              logoSrc={PLATFORM_LOGOS[platformName]}
              budget={budget}
            />
            <div className="card platformStatCard">
              <p className="cardValue">{rowsForPlatform.length.toLocaleString("pt-BR")}</p>
              <p className="cardTitle">Lines ativas</p>
              <p className="cardSubtitle">{rowsWithToken.toLocaleString("pt-BR")} com token identificado</p>
            </div>
            <button
              type="button"
              className={`card platformStatCard cardClickable platformStatCardNoTokenButton ${rowsWithoutToken > 0 ? "platformStatCardAlert" : ""} ${dspLinesOnlyWithoutToken ? "platformStatCardNoTokenActive" : ""}`}
              aria-pressed={dspLinesOnlyWithoutToken}
              aria-label="Alternar filtro: mostrar só lines sem token na tabela abaixo"
              onClick={() => setDspLinesOnlyWithoutToken((prev) => !prev)}
            >
              <p className="cardValue">{rowsWithoutToken.toLocaleString("pt-BR")}</p>
              <p className="cardTitle">Sem token</p>
              <p className="cardSubtitle">
                {rowsWithoutToken > 0 ? "Requer atenção imediata para auditoria" : "Todas as lines com token identificado"}
              </p>
            </button>
            <div className="card platformStatCard">
              <p className="cardValue">{activeCampaignsCount.toLocaleString("pt-BR")}</p>
              <p className="cardTitle">Campanhas ativas</p>
              <p className="cardSubtitle">Com gasto no período selecionado</p>
            </div>
          </section>

          {!rows.length ? (
            <p className="alertInfo">Nenhuma line com gasto encontrada.</p>
          ) : (
            <section className="card stackDetailCard">
              <div className="stackDetailHeader">
                <div>
                  <p className="cardTitle">Lines</p>
                </div>
                <div className="stackDetailHeaderActions stackDetailHeaderActionsColumn">
                  <div className="tableTopActions">
                    <button type="button" className="button buttonGhost buttonSmall" onClick={handleExportDetailedLines}>
                      <span className="buttonLabelWithIcon">
                        <DownloadIcon />
                        CSV
                      </span>
                    </button>
                  </div>
                  <div className="stackDetailFilterInline">
                    <label className="filterInlineToggle filterInlineToggleDashboard">
                      <input
                        type="checkbox"
                        checked={dspLinesOnlyWithoutToken}
                        onChange={(event) => setDspLinesOnlyWithoutToken(event.target.checked)}
                      />
                      Só lines sem token
                    </label>
                    <input
                      className="stackSearchInput"
                      type="search"
                      value={stackAdaptSearch}
                      onChange={(event) => setStackAdaptSearch(event.target.value)}
                      placeholder="Buscar line, token ou cliente"
                      aria-label={`Buscar lines da ${platformName}`}
                    />
                  </div>
                </div>
              </div>
              <p className="stackDetailCounter">
                {sortedRows.length.toLocaleString("pt-BR")} lines analisadas • {brl(filteredTotalGasto)} no período
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
                      <th className={stackAdaptSort.key === "line" ? "stackThSorted" : undefined}>
                        <button type="button" className={stackSortButtonClass("line")} onClick={() => toggleStackAdaptSort("line")}>
                          <span>Line</span>
                          <span className="stackSortIndicator">{stackSortIndicator("line")}</span>
                        </button>
                      </th>
                      <th className={stackAdaptSort.key === "token" ? "stackThSorted" : undefined}>
                        <button type="button" className={stackSortButtonClass("token")} onClick={() => toggleStackAdaptSort("token")}>
                          <span>Token</span>
                          <span className="stackSortIndicator">{stackSortIndicator("token")}</span>
                        </button>
                      </th>
                      <th className={stackAdaptSort.key === "cliente" ? "stackThSorted" : undefined}>
                        <button type="button" className={stackSortButtonClass("cliente")} onClick={() => toggleStackAdaptSort("cliente")}>
                          <span>Cliente</span>
                          <span className="stackSortIndicator">{stackSortIndicator("cliente")}</span>
                        </button>
                      </th>
                      <th className={stackAdaptSort.key === "campanha" ? "stackThSorted" : undefined}>
                        <button type="button" className={stackSortButtonClass("campanha")} onClick={() => toggleStackAdaptSort("campanha")}>
                          <span>Campanha</span>
                          <span className="stackSortIndicator">{stackSortIndicator("campanha")}</span>
                        </button>
                      </th>
                      <th
                        className={
                          stackAdaptSort.key === "gasto"
                            ? "stackThSorted stackThFinancial stackThNumeric"
                            : "stackThFinancial stackThNumeric"
                        }
                      >
                        <button type="button" className={stackSortButtonClass("gasto")} onClick={() => toggleStackAdaptSort("gasto")}>
                          <span>Gasto</span>
                          <span className="stackSortIndicator">{stackSortIndicator("gasto")}</span>
                        </button>
                      </th>
                      <th
                        className={
                          stackAdaptSort.key === "investido"
                            ? "stackThSorted stackThFinancial stackThNumeric"
                            : "stackThFinancial stackThNumeric"
                        }
                      >
                        <button type="button" className={stackSortButtonClass("investido")} onClick={() => toggleStackAdaptSort("investido")}>
                          <span>Investido</span>
                          <span className="stackSortIndicator">{stackSortIndicator("investido")}</span>
                        </button>
                      </th>
                      <th className={stackAdaptSort.key === "pct_invest" ? "stackThSorted stackThNumeric" : "stackThNumeric"}>
                        <button type="button" className={stackSortButtonClass("pct_invest")} onClick={() => toggleStackAdaptSort("pct_invest")}>
                          <span>% budget</span>
                          <span className="stackSortIndicator">{stackSortIndicator("pct_invest")}</span>
                        </button>
                      </th>
                      <th className={stackAdaptSort.key === "total" ? "stackThSorted stackThNumeric" : "stackThNumeric"}>
                        <button type="button" className={stackSortButtonClass("total")} onClick={() => toggleStackAdaptSort("total")}>
                          <span>Total</span>
                          <span className="stackSortIndicator">{stackSortIndicator("total")}</span>
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
                              title="Copiar line"
                              aria-label={`Copiar line ${row.line}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void (async () => {
                                  const copied = await copyToClipboard(row.line, "Line");
                                  if (copied) setCopiedFieldKey(`line-${index}`);
                                })();
                              }}
                            >
                              {copiedFieldKey === `line-${index}` ? "✓" : "⧉"}
                            </button>
                            <span className="stackLineValue" title={row.line}>
                              {row.line}
                            </span>
                          </div>
                        </td>
                        <td className="stackTokenCell">
                          <div className="copyCell">
                            <button
                              type="button"
                              className="copyIconButton"
                              title="Copiar token"
                              aria-label={`Copiar token ${row.token}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void (async () => {
                                  const copied = await copyToClipboard(row.token, "Token");
                                  if (copied) setCopiedFieldKey(`token-${index}`);
                                })();
                              }}
                              disabled={!row.token || row.token === "—"}
                            >
                              {copiedFieldKey === `token-${index}` ? "✓" : "⧉"}
                            </button>
                            <span>{renderTokenValue(row.token)}</span>
                          </div>
                        </td>
                        <td>{row.cliente}</td>
                        <td>{row.campanha}</td>
                        <td className="stackNumericCell stackNumericCellRight stackNumericCellFinancial stackGastoCell">
                          {brl(row.gasto)}
                        </td>
                        <td className="stackNumericCell stackNumericCellRight stackNumericCellFinancial">
                          {row.investido ? brl(row.investido) : "—"}
                        </td>
                        <td className="stackNumericCell stackNumericCellRight">
                          {row.pct_invest !== null ? `${row.pct_invest.toFixed(1)}%` : "—"}
                        </td>
                        <td className="stackNumericCell stackNumericCellRight">
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
                              {hasAccountManagerWhatsApp(row.account_management) ? (
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
                              ) : null}
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
                <span className="buttonLabelWithIcon">
                  <DownloadIcon />
                  CSV
                </span>
              </button>
            </div>
            <div className="stackDetailHeaderActions dspPanelTableToolbar">
              <label className="filterInlineToggle filterInlineToggleDashboard">
                <input
                  type="checkbox"
                  checked={dspLinesOnlyWithoutToken}
                  onChange={(event) => setDspLinesOnlyWithoutToken(event.target.checked)}
                />
                Só lines sem token
              </label>
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
                      <th className="stackThNumeric stackThFinancial">Gasto</th>
                      <th className="stackThNumeric stackThFinancial">Investido</th>
                      <th className="stackThNumeric">% budget</th>
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
                        <td>
                          <span className="stackLineValue" title={row.line}>
                            {row.line}
                          </span>
                        </td>
                        <td>{renderTokenValue(row.token)}</td>
                        <td>{row.cliente}</td>
                        <td>{row.campanha}</td>
                        <td className="stackNumericCellRight stackNumericCellFinancial">{brl(row.gasto)}</td>
                        <td className="stackNumericCellRight stackNumericCellFinancial">
                          {row.investido ? brl(row.investido) : "—"}
                        </td>
                        <td className="stackNumericCellRight">{row.pct_invest !== null ? `${row.pct_invest.toFixed(1)}%` : "—"}</td>
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
                              {hasAccountManagerWhatsApp(row.account_management) ? (
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
                              ) : null}
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
                      stroke="rgba(28, 38, 47, 0.9)"
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
                    <span className="buttonLabelWithIcon">
                      <DownloadIcon />
                      CSV
                    </span>
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
                      stroke="rgba(28, 38, 47, 0.9)"
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

        <section className="panel panelSub filterPanelCard">
          <h3>Filtros do dashboard</h3>
          <div className="filterToolbar">
            <MultiSelectFilter
              id="out-filter-client"
              label="Cliente"
              options={clients}
              value={clientFilter}
              onChange={setClientFilter}
              placeholder="Todos os clientes"
              disabledOptions={disabledClientOptions}
            />
            <MultiSelectFilter
              id="out-filter-cs"
              label="CS (Account Management)"
              options={csFilterOptions}
              value={csFilter}
              onChange={setCsFilter}
              placeholder="Todos os CS"
              showAvatar
              disabledOptions={disabledCsOptions}
            />
            <MultiSelectFilter
              id="out-filter-feature"
              label="Feature"
              options={[...FEATURE_OPTIONS]}
              value={featureFilter}
              onChange={setFeatureFilter}
              placeholder="Todas as features"
              disabledOptions={disabledFeatureOptions}
            />
            <MultiSelectFilter
              id="out-filter-campaign-type"
              label="Produto Vendido"
              options={productFilterOptions}
              value={campaignTypeFilter}
              onChange={setCampaignTypeFilter}
              placeholder="Todos os produtos vendidos"
              disabledOptions={disabledCampaignTypeOptions}
            />
            <MultiSelectFilter
              id="out-filter-campaign"
              label="Campanha"
              options={campaignFilterOptions}
              value={campaignFilter}
              onChange={setCampaignFilter}
              placeholder="Todas as campanhas"
              disabledOptions={disabledCampaignOptions}
            />
            <MultiSelectFilter
              id="out-filter-campaign-status"
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
                  setFeatureFilter([]);
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
                    <span className="buttonLabelWithIcon">
                      <DownloadIcon />
                      CSV
                    </span>
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
                              {hasAccountManagerWhatsApp(row.account_management) ? (
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
                              ) : null}
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
        <div className="sidebarBrand">
          <Image
            src="/hypr-logo-white.png"
            alt="HYPR"
            width={188}
            height={48}
            className="sidebarBrandLogo"
            priority
          />
        </div>
        <nav className="sidebarNav" aria-label="Navegacao principal">
          <section className="sidebarGroup" aria-label="Dsps">
            <button
              type="button"
              className="sidebarGroupToggle"
              aria-expanded={isDspsMenuExpanded}
              aria-controls="sidebar-dsps-items"
              onClick={() => setIsDspsMenuExpanded((current) => !current)}
            >
              <span className="sidebarGroupTitle">dsps</span>
              <span className={`sidebarGroupChevron ${isDspsMenuExpanded ? "sidebarGroupChevronOpen" : ""}`}>▾</span>
            </button>
            {isDspsMenuExpanded ? (
              <div id="sidebar-dsps-items" className="sidebarGroupItems">
                {navOptions.map((option) => (
                  <button
                    key={option}
                    className={`navButton navButtonNested ${resolvedActivePage === option ? "navButtonActive" : ""}`}
                    onClick={() => router.push(appendQueryToRoute(routeForPage(option)))}
                  >
                    {NAV_LABELS[option]}
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        </nav>
      </aside>

      <section className="content">
        <div className="platformTopBar">
          <div className="platformTopBarLeft">
            <div className="platformTopBarSummary">
              <p className="platformTopBarPeriod">{periodHeroLabel}</p>
              <p className="platformTopBarPeriodRange">{periodRangeCompactLabel}</p>
            </div>
          </div>
          <div className="platformTopBarRight">
            <div className="platformTopBarFiltersColumn" ref={snapshotInfoWrapRef}>
              <div className="platformTopBarFiltersInfoRow">
                <button
                  type="button"
                  className="platformSnapshotInfoButton"
                  aria-expanded={snapshotInfoOpen}
                  aria-controls="snapshot-info-popover"
                  onClick={() => setSnapshotInfoOpen((open) => !open)}
                  aria-label="Ver informações da última atualização dos dados"
                >
                  i
                </button>
                {snapshotInfoOpen ? (
                  <div
                    id="snapshot-info-popover"
                    className="platformSnapshotInfoPopover"
                    role="dialog"
                    aria-label="Última atualização"
                  >
                    <div className="platformTopBarSnapshot platformTopBarSnapshotPopover">
                      <div className="platformTopBarSnapshotHeader">
                        <p className={`platformTopBarSnapshotLabel ${isRefreshRunning ? "platformTopBarSnapshotLabelLoading" : ""}`}>
                          {isRefreshRunning ? "Atualizando dados..." : "Última atualização"}
                        </p>
                        {!isRefreshRunning ? (
                          <span className={`platformStatusBadge platformStatusBadge${snapshotStatus.tone}`}>
                            <span className={`platformStatusDot platformStatusDot${snapshotStatus.tone}`} aria-hidden="true" />
                            <span>{snapshotStatus.label}</span>
                          </span>
                        ) : null}
                      </div>
                      {isRefreshRunning ? (
                        <>
                          <p className="platformTopBarSnapshotRunningMeta">Iniciado há {formatDuration(refreshElapsedSeconds)}</p>
                          <p className="platformTopBarSnapshotSecondary">
                            Tempo médio:{" "}
                            {refreshMetrics?.sample_size ? formatDuration(refreshMetrics.avg_duration_seconds) : "sem histórico suficiente"}
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="platformTopBarSnapshotPrimary">
                            {displayedSnapshotAt ? formatDateTime(displayedSnapshotAt).replace(", ", " • ") : "—"}
                          </p>
                          <p className="platformTopBarSnapshotSecondary">
                            {formatAge(displayedSnapshotAt) || "Atualização pendente"}
                            {" • "}
                            Tempo médio:{" "}
                            {refreshMetrics?.sample_size ? formatDuration(refreshMetrics.avg_duration_seconds) : "sem histórico suficiente"}
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="platformTopBarFilters">
                <label className="monthFilterControl">
                  <span className="monthFilterLabel">Período</span>
                  <select
                    value={selectedViewMode}
                    disabled={isRefreshRunning}
                    onChange={(event) => {
                      const nextMode = event.target.value as AnalysisViewMode;
                      setSelectedViewMode(nextMode);
                      setSelectedMonthKey((prev) => {
                        if (nextMode === "year") {
                          if (isValidYearKey(prev)) return prev;
                          return currentYearKey;
                        }
                        if (isValidMonthKey(prev)) return prev;
                        return currentMonthKey;
                      });
                      const el = event.currentTarget;
                      requestAnimationFrame(() => el.blur());
                    }}
                    aria-label="Selecionar período de análise"
                  >
                    {ANALYSIS_VIEW_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="monthFilterControl">
                  <span className="monthFilterLabel">{selectedViewMode === "year" ? "Ano" : "Mês"}</span>
                  <select
                    value={selectedMonthKey}
                    disabled={isRefreshRunning}
                    onChange={(event) => {
                      setSelectedMonthKey(event.target.value);
                      const el = event.currentTarget;
                      requestAnimationFrame(() => el.blur());
                    }}
                    aria-label={selectedViewMode === "year" ? "Selecionar ano de análise" : "Selecionar mês de análise"}
                  >
                    {periodOptions.map((monthKey) => (
                      <option key={monthKey} value={monthKey}>
                        {selectedViewMode === "year" ? monthKey : capitalizeFirst(formatMonthKeyLabel(monthKey))}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <div className="platformTopBarActions">
              <button className="button buttonRefreshPrimary" onClick={handleRefresh} disabled={isValidating || isRefreshRunning}>
                <ReloadIcon spinning={isValidating || isRefreshRunning} />
                <span>{isValidating || isRefreshRunning ? "Atualizando…" : "Atualizar dados"}</span>
              </button>
            </div>
          </div>
        </div>
        <hr className="contentSectionDivider" aria-hidden="true" />

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
