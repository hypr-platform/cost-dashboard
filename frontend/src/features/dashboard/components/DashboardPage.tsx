"use client";

import type {
  AnalysisViewMode,
  AttentionNoTokenSortKey,
  AttentionOutOfPeriodSortKey,
  AttentionSortDirection,
  CampaignJourneySortKey,
  NexdFormatSortKey,
  RefreshPhase,
  StackAdaptSortDirection,
  StackAdaptSortKey,
} from "@/features/dashboard/types/dashboard";
import {
  fetchDashboard,
  fetchRefreshMetrics,
  fetchRefreshStatus,
  saveNoTokenLineName,
  saveNoTokenObservation,
  triggerDashboardRefresh,
} from "@/services/api/dashboard";
import type {
  AttentionOutOfPeriodRow,
  DashboardResponse,
  JourneyRow,
  PlatformPageRow,
  RefreshMetricsResponse,
  RefreshStatusResponse,
} from "@/services/api/types";
import {
  brl,
  BRL_INTEGER_FORMATTER,
  formatDonutCenterValue,
  NumberTooltip,
  PlatformLegend,
} from "@/shared/charts/homeRecharts";
import { PLATFORM_COLORS, PLATFORM_LOGOS } from "@/shared/constants/platform";
import {
  dv360AdvertiserRootUrl,
  dv360LineItemUrlGuess,
} from "@/shared/utils/dv360Links";
import {
  getAccountManagerAvatar,
  getAccountManagerWhatsAppNumber,
} from "@/shared/utils/accountManagers";
import {
  TOOL_TAB_BY_KEY,
  TOOL_TAB_KEYS,
  VISIBLE_TOOL_SLUG_TO_KEY,
  VISIBLE_TOOL_TABS,
  type ToolTabKey,
} from "@/features/dashboard/config/tool-tabs";
import { PageSkeleton } from "@/features/dashboard/skeletons";
import { SessionLoading } from "@/features/auth/components/SessionLoading";
import { HeroSummary } from "@/features/dashboard/components/HeroSummary";
import { PlatformResendCard } from "@/features/dashboard/components/PlatformResendCard";
import {
  RESEND_CHART_COLORS,
  ResendDailyLine,
  ResendDonut,
  ResendHbars,
} from "@/features/dashboard/components/DeepDiveCharts";
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
import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import useSWR from "swr";

function rowCsLabel(row: JourneyRow): string {
  const s = String(row.account_management ?? "").trim();
  return s || "Sem CS";
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

function getAccountManagerWhatsAppUrl(
  name: string | null | undefined,
  context: {
    campanha: string;
    token: string;
    platform: string;
    vigencia_start: string | null;
    vigencia_end: string | null;
  },
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
      `Pode revisar por favor?`,
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
  },
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
    `Oi ${managerName}, tudo bem? Esta mensagem é referente à ${details}. Pode revisar por favor?`,
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
const DAY_KEY_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const WEEK_KEY_REGEX = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const FEATURE_OPTIONS = [
  "RMN Físico",
  "Survey",
  "Topics",
  "P-DOOH",
  "Downloaded Apps",
] as const;
const ANALYSIS_VIEW_OPTIONS: ReadonlyArray<{
  value: AnalysisViewMode;
  label: string;
  disabled?: boolean;
}> = [
  { value: "day", label: "Dia" },
  { value: "week", label: "Semana" },
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

function rowMatchesCampaignProducts(
  produtoVendido: string | null | undefined,
  selectedProducts: string[],
): boolean {
  if (!selectedProducts.length) return true;
  const normalized = String(produtoVendido ?? "").trim();
  return selectedProducts.includes(normalized);
}
type NavKey =
  | "Dashboard"
  | "Jornada de campanhas"
  | "⚠️ Lines sem token"
  | "🚨 Gasto fora do mês vigente"
  | "Nexd"
  | "StackAdapt"
  | "DV360"
  | "Xandr"
  | "Hivestack"
  | "Amazon DSP"
  | "BigQuery"
  | "GoogleCloud";

const NAV_LABELS: Record<NavKey, string> = {
  Dashboard: "DeepDive",
  "Jornada de campanhas": "Campaign Journey",
  "⚠️ Lines sem token": "⚠️ Lines sem token",
  "🚨 Gasto fora do mês vigente": "🚨 Gasto fora do mês vigente",
  Nexd: "Nexd",
  StackAdapt: "StackAdapt",
  DV360: "DV360",
  Xandr: "Xandr",
  Hivestack: "Hivestack",
  "Amazon DSP": "Amazon DSP",
  BigQuery: "BigQuery",
  GoogleCloud: "Google Cloud",
};

const PAGE_TO_SLUG: Record<Exclude<NavKey, "Dashboard">, string> = {
  "Jornada de campanhas": "jornada-campanhas",
  "⚠️ Lines sem token": "lines-sem-token",
  "🚨 Gasto fora do mês vigente": "gasto-fora-mes-vigente",
  Nexd: "nexd",
  StackAdapt: "stack-adapt",
  DV360: "dv360",
  Xandr: "xandr",
  Hivestack: "hivestack",
  "Amazon DSP": "amazon-dsp",
  BigQuery: "bigquery",
  GoogleCloud: "google-cloud",
};
/**
 * Mapeamento slug → página. Para tabs-ferramenta, deriva do registry e
 * inclui apenas as visíveis — slugs de tabs ocultas caem no fallback
 * (Dashboard), o que esconde a aba também via deep-link.
 */
const SLUG_TO_PAGE: Record<string, Exclude<NavKey, "Dashboard">> = {
  atencao: "⚠️ Lines sem token",
  "lines-sem-token": "⚠️ Lines sem token",
  "gasto-fora-mes-vigente": "🚨 Gasto fora do mês vigente",
  "jornada-campanhas": "Jornada de campanhas",
  nexd: "Nexd",
  "stack-adapt": "StackAdapt",
  dv360: "DV360",
  xandr: "Xandr",
  hivestack: "Hivestack",
  "amazon-dsp": "Amazon DSP",
  ...(VISIBLE_TOOL_SLUG_TO_KEY as Record<string, Exclude<NavKey, "Dashboard">>),
};

/**
 * Páginas externas (ferramentas) — não vêm dos dados do dashboard. Inclui
 * todas as chaves do registry (mesmo ocultas) para que a UI nunca caia no
 * branch de `renderPlatformPage` para uma chave de ferramenta.
 */
const EXTERNAL_PAGES: ReadonlySet<NavKey> = TOOL_TAB_KEYS as ReadonlySet<NavKey>;

const NAV_LETTERS: Partial<Record<NavKey, string>> = {
  DV360: "D",
  Xandr: "X",
  StackAdapt: "S",
  Nexd: "N",
  Hivestack: "H",
  "Amazon DSP": "A",
};

function StackedIcon() {
  return (
    <svg
      className="brandIconSvg"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2 2 5l6 3 6-3-6-3Z" />
      <path d="M2 8l6 3 6-3" />
      <path d="M2 11l6 3 6-3" />
    </svg>
  );
}

function routeForPage(page: NavKey) {
  if (page === "Dashboard") return "/";
  return `/${PAGE_TO_SLUG[page]}`;
}

const PLATFORM_TITLE_TO_NAV: Record<string, NavKey> = {
  DV360: "DV360",
  Xandr: "Xandr",
  StackAdapt: "StackAdapt",
  NEXD: "Nexd",
  Nexd: "Nexd",
  Hivestack: "Hivestack",
  Amazon: "Amazon DSP",
  "Amazon DSP": "Amazon DSP",
};

function hrefForPlatformTitle(title: string): string | undefined {
  const navKey = PLATFORM_TITLE_TO_NAV[title.trim()];
  return navKey ? routeForPage(navKey) : undefined;
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
  journeyByToken: Map<string, JourneyRow>,
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
  journeyByToken: Map<string, JourneyRow>,
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

function isValidDayKey(value: string | null | undefined): value is string {
  if (!value) return false;
  return DAY_KEY_REGEX.test(value.trim());
}

function isValidWeekKey(value: string | null | undefined): value is string {
  if (!value) return false;
  return WEEK_KEY_REGEX.test(value.trim());
}

function getCurrentMonthKey(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

function getCurrentYearKey(): string {
  return String(new Date().getFullYear());
}

function getCurrentDayKey(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function getISOWeekParts(date: Date): { year: number; week: number } {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return { year: d.getUTCFullYear(), week };
}

function getCurrentWeekKey(): string {
  const { year, week } = getISOWeekParts(new Date());
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function formatISODate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
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

function dayKeyToDateRange(dayKey: string): { start: string; end: string } {
  return { start: dayKey, end: dayKey };
}

function weekKeyToDateRange(weekKey: string): { start: string; end: string } {
  const [yearRaw, weekRaw] = weekKey.split("-W");
  const year = Number(yearRaw);
  const week = Number(weekRaw);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(Date.UTC(year, 0, 4 - jan4Day + 1));
  const start = new Date(week1Mon.getTime() + (week - 1) * 7 * 86_400_000);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return { start: formatISODate(start), end: formatISODate(end) };
}

function isValidAnalysisViewMode(
  value: string | null | undefined,
): value is AnalysisViewMode {
  return (
    value === "day" ||
    value === "week" ||
    value === "month" ||
    value === "year"
  );
}

function resolveAnalysisDateRange(
  viewMode: AnalysisViewMode,
  periodKey: string,
): { start: string; end: string } {
  if (viewMode === "day") {
    return dayKeyToDateRange(
      isValidDayKey(periodKey) ? periodKey : getCurrentDayKey(),
    );
  }
  if (viewMode === "week") {
    return weekKeyToDateRange(
      isValidWeekKey(periodKey) ? periodKey : getCurrentWeekKey(),
    );
  }
  if (viewMode === "month") {
    return monthKeyToDateRange(
      isValidMonthKey(periodKey) ? periodKey : getCurrentMonthKey(),
    );
  }
  const year = isValidYearKey(periodKey) ? periodKey : getCurrentYearKey();
  return { start: `${year}-01-01`, end: `${year}-12-31` };
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

function buildRecentDayKeys(count: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    keys.push(`${d.getFullYear()}-${month}-${day}`);
  }
  return keys;
}

function buildRecentWeekKeys(count: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const d = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - offset * 7,
    );
    const { year, week } = getISOWeekParts(d);
    const k = `${year}-W${String(week).padStart(2, "0")}`;
    if (!keys.includes(k)) keys.push(k);
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

function formatDayKeyLabel(dayKey: string): string {
  if (!isValidDayKey(dayKey)) return dayKey;
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function formatWeekKeyLabel(weekKey: string): string {
  if (!isValidWeekKey(weekKey)) return weekKey;
  const { start, end } = weekKeyToDateRange(weekKey);
  const [, weekRaw] = weekKey.split("-W");
  return `Semana ${Number(weekRaw)} · ${formatDateBrShort(start)} → ${formatDateBrShort(end)}`;
}

function formatPeriodKeyLabel(
  viewMode: AnalysisViewMode,
  periodKey: string,
): string {
  if (viewMode === "day") return formatDayKeyLabel(periodKey);
  if (viewMode === "week") return formatWeekKeyLabel(periodKey);
  if (viewMode === "year") return periodKey;
  return capitalizeFirst(formatMonthKeyLabel(periodKey));
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

/** Impressões em texto curto (ex.: 4,9 mi) para cabeçalhos e destaques Nexd */
function formatImpressionsCompactPt(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (n >= 10_000)
    return `${Math.round(n / 1_000).toLocaleString("pt-BR")} mil`;
  return n.toLocaleString("pt-BR");
}

/** Cap em leitura curta (ex.: 10M, 4,9M, 500 mil) — linha de contexto Nexd. */
function formatNexdCapSizePt(cap: number): string {
  if (!Number.isFinite(cap) || cap <= 0) return "0";
  if (cap >= 1_000_000) {
    const m = cap / 1_000_000;
    const s = Number.isInteger(m)
      ? String(m)
      : m.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
    return `${s}M`;
  }
  if (cap >= 10_000) {
    return `${Math.round(cap / 1_000).toLocaleString("pt-BR")} mil`;
  }
  return cap.toLocaleString("pt-BR");
}

/** Mês abreviado pt-BR (ex.: "mar" → "Mar"). */
function nexdMonthAbbrPt(d: Date): string {
  const raw = d
    .toLocaleDateString("pt-BR", { month: "short" })
    .replace(/\./g, "")
    .trim();
  return capitalizeFirst(raw);
}

/** Linha curta tipo "Mar–Abr" ou "Mar '25–Abr '26". */
function formatNexdPeriodMonthRangeUltraPt(
  isoStart: string,
  isoEnd: string,
): string {
  const s = new Date(String(isoStart).slice(0, 10));
  const e = new Date(String(isoEnd).slice(0, 10));
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return "";
  const ms = s.getMonth();
  const ys = s.getFullYear();
  const me = e.getMonth();
  const ye = e.getFullYear();
  if (ms === me && ys === ye) return `${nexdMonthAbbrPt(s)} ${ys}`;
  if (ys === ye) return `${nexdMonthAbbrPt(s)}–${nexdMonthAbbrPt(e)}`;
  const y2 = (y: number) => String(y).slice(-2);
  return `${nexdMonthAbbrPt(s)} '${y2(ys)}–${nexdMonthAbbrPt(e)} '${y2(ye)}`;
}

function nexdParseIsoDateLocal(iso: string): Date | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(String(iso))) return null;
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  const x = new Date(y, m - 1, d);
  if (Number.isNaN(x.getTime())) return null;
  x.setHours(0, 0, 0, 0);
  return x;
}

function nexdInclusiveDaysLocal(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
}

/**
 * % do cap ao fim do período, extrapolando o ritmo atual (uso% / fração de tempo já decorrida).
 * `null` no início do período (poucos dias) para evitar leitura instável.
 */
/** Dias decorridos no período, total de dias e dias restantes (hoje → fim), para ritmo e textos temporais. */
function nexdPeriodPacingContext(
  periodStartIso: string,
  periodEndIso: string,
): {
  elapsedDays: number;
  totalDays: number;
  daysLeftInPeriod: number;
} | null {
  const s = nexdParseIsoDateLocal(periodStartIso);
  const e = nexdParseIsoDateLocal(periodEndIso);
  if (!s || !e || e.getTime() < s.getTime()) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (today.getTime() < s.getTime()) return null;
  const refEnd = today.getTime() > e.getTime() ? e : today;
  const elapsedDays = nexdInclusiveDaysLocal(s, refEnd);
  const totalDays = nexdInclusiveDaysLocal(s, e);
  const daysLeftInPeriod =
    today.getTime() > e.getTime() ? 0 : nexdInclusiveDaysLocal(today, e);
  return { elapsedDays, totalDays, daysLeftInPeriod };
}

function nexdDateToIsoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nexdForecastEndPeriodCapPct(
  periodStartIso: string,
  periodEndIso: string,
  usedPct: number,
): { forecastPct: number } | null {
  const s = nexdParseIsoDateLocal(periodStartIso);
  const e = nexdParseIsoDateLocal(periodEndIso);
  if (!s || !e || e.getTime() < s.getTime()) return null;
  const totalDays = nexdInclusiveDaysLocal(s, e);
  if (totalDays < 1) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (today.getTime() < s.getTime()) return null;

  const refEnd = today.getTime() > e.getTime() ? e : today;
  const elapsedDays = nexdInclusiveDaysLocal(s, refEnd);
  const timeFracEarly = elapsedDays / totalDays;
  if (
    today.getTime() <= e.getTime() &&
    elapsedDays < 3 &&
    timeFracEarly < 0.12
  ) {
    return null;
  }

  const timeFrac = Math.max(timeFracEarly, 1e-6);
  const forecastPct = Math.min(300, Math.max(0, usedPct / timeFrac));
  return { forecastPct };
}

function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

type NexdCapTone = "ok" | "warn" | "risk" | "neutral";

function nexdCapConsumptionStatus(usedPct: number): {
  tone: NexdCapTone;
  label: string;
  helper: string;
} {
  if (usedPct >= 80) {
    return {
      tone: "risk",
      label: "Risco de estourar o cap",
      helper: "Consumo muito próximo do limite mensal contratado.",
    };
  }
  if (usedPct >= 60) {
    return {
      tone: "warn",
      label: "Atenção ao cap",
      helper: "Ritmo elevado — vale acompanhar o restante do mês.",
    };
  }
  if (usedPct >= 35) {
    return {
      tone: "neutral",
      label: "Ritmo moderado",
      helper: "Uso intermediário do pacote no período.",
    };
  }
  return {
    tone: "ok",
    label: "Saudável",
    helper: "Ainda há folga confortável em relação ao cap mensal.",
  };
}

/**
 * % do cap esperado **hoje** com ritmo uniforme no **período selecionado** (início → fim),
 * usando a mesma fração de tempo que a previsão (`elapsedDays / totalDays` × 100).
 * Evita comparar 50% usado com “100% esperado” só porque o fim do período cai no último dia do mês.
 */
function nexdLinearExpectedCapPctForPeriod(
  periodStartIso: string | undefined,
  periodEndIso: string | undefined,
): number | null {
  if (!periodStartIso || !periodEndIso) return null;
  const s = nexdParseIsoDateLocal(periodStartIso);
  const e = nexdParseIsoDateLocal(periodEndIso);
  if (!s || !e || e.getTime() < s.getTime()) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (today.getTime() < s.getTime()) return null;
  const refEnd = today.getTime() > e.getTime() ? e : today;
  const totalDays = nexdInclusiveDaysLocal(s, e);
  if (totalDays < 1) return null;
  const elapsedDays = nexdInclusiveDaysLocal(s, refEnd);
  return (elapsedDays / totalDays) * 100;
}

type NexdPaceVsCalendar = "above" | "below" | "on";

function nexdPaceVsExpected(
  usedPct: number,
  periodStartIso: string | undefined,
  periodEndIso: string | undefined,
): {
  expectedPct: number | null;
  vs: NexdPaceVsCalendar;
} {
  const expectedPct = nexdLinearExpectedCapPctForPeriod(
    periodStartIso,
    periodEndIso,
  );
  if (expectedPct == null) {
    return { expectedPct: null, vs: "on" };
  }
  const diff = usedPct - expectedPct;
  if (diff > 15) {
    return { expectedPct, vs: "above" };
  }
  if (diff < -15) {
    return { expectedPct, vs: "below" };
  }
  return { expectedPct, vs: "on" };
}

/** Tendência alinhada à previsão (evita contradizer o alerta de >100%). */
function nexdCapTrendBodyCoherent(
  forecastRounded: number | null,
  vs: NexdPaceVsCalendar,
): string {
  if (forecastRounded != null) {
    if (forecastRounded > 100)
      return "Ritmo atual tende a fechar acima do cap contratado.";
    if (forecastRounded < 100) return "Não vai consumir todo o cap.";
    return "No limite do cap ao fechar o período.";
  }
  if (vs === "below") return "Não vai consumir todo o cap.";
  if (vs === "above") return "Pode apertar o cap antes do fim.";
  return "Em linha com o calendário do mês.";
}

/** Excesso sobre 100% do cap, para leitura direta (ex.: 0,7%). */
function nexdForecastExcessPctPt(forecastPct: number): string {
  const over = forecastPct - 100;
  if (over <= 0) return "0%";
  if (over < 10) return `${over.toFixed(1).replace(".", ",")}%`;
  return `${Math.round(over)}%`;
}

/** Linha única: previsão + excesso, sem repetir “vai ultrapassar”. */
function nexdForecastDetailLinePt(forecastPct: number): string {
  const rounded = Math.round(forecastPct);
  return `Previsão: ${rounded}% (excesso de ${nexdForecastExcessPctPt(forecastPct)})`;
}

/** Cor da barra de uso Nexd: previsão e risco real pesam mais que o verde “folga”. */
function nexdCapBarFillClass(
  usedPct: number,
  forecastRounded: number | null,
): string {
  if (forecastRounded != null) {
    if (forecastRounded > 100)
      return forecastRounded >= 115
        ? "budgetProgressFillOver"
        : "budgetProgressFillWarn";
    if (forecastRounded >= 95) return "budgetProgressFillWarn";
  }
  if (usedPct >= 80) return "budgetProgressFillOver";
  if (usedPct >= 60) return "budgetProgressFillWarn";
  return "budgetProgressFillOk";
}

/** Alinha rótulos “Hoje” / “Esperado” ao longo da barra sem estourar as bordas. */
function nexdCapUsageBarFlyLabelStyle(pct: number): CSSProperties {
  const p = Math.min(100, Math.max(0, pct));
  if (p <= 10) return { left: "0%", transform: "translateX(0)" };
  if (p >= 90) return { left: "100%", transform: "translateX(-100%)" };
  return { left: `${p}%`, transform: "translateX(-50%)" };
}

function nexdCapBarVisualTone(fillClass: string): "ok" | "warn" | "risk" {
  if (fillClass.includes("Over")) return "risk";
  if (fillClass.includes("Warn")) return "warn";
  return "ok";
}

function nexdPaceCalendarHintPt(vs: NexdPaceVsCalendar): string {
  if (vs === "below") return "↓ abaixo do esperado";
  if (vs === "above") return "↑ acima do esperado";
  return "≈ alinhado ao esperado";
}

/** Ritmo/emoji do resumo Nexd: se a previsão fecha >100%, sobe alerta em vez de “moderado” + “alinhado”. */
function nexdNexdSummaryRhythmPresentation(
  usedPct: number,
  paceVs: { expectedPct: number | null; vs: NexdPaceVsCalendar },
  forecastRounded: number | null,
): {
  tone: NexdCapTone;
  label: string;
  emoji: string;
  paceHint: string | null;
} {
  const base = nexdCapConsumptionStatus(usedPct);
  if (forecastRounded != null && forecastRounded > 100) {
    const tone: NexdCapTone = forecastRounded >= 115 ? "risk" : "warn";
    return {
      tone,
      label: "Alerta — fechamento acima do cap",
      emoji: tone === "risk" ? "🔴" : "⚠️",
      paceHint: null,
    };
  }
  const emoji =
    base.tone === "risk"
      ? "🔴"
      : base.tone === "warn"
        ? "🟡"
        : base.tone === "neutral"
          ? "🟡"
          : "🟢";
  return {
    tone: base.tone,
    label: base.label,
    emoji,
    paceHint:
      paceVs.expectedPct != null ? nexdPaceCalendarHintPt(paceVs.vs) : null,
  };
}

function csvEscape(value: string | number | null | undefined): string {
  const normalized = String(value ?? "");
  if (
    !normalized.includes('"') &&
    !normalized.includes(",") &&
    !normalized.includes("\n")
  ) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '""')}"`;
}

function downloadCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
) {
  const lines = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => row.map(csvEscape).join(",")),
  ];
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

async function downloadElementPng(
  element: HTMLElement,
  filename: string,
  backgroundColor: string = "#1e2a33",
) {
  const canvas = await html2canvas(element, {
    scale: 2,
    backgroundColor,
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

function parseStackSortParam(value: string | null): {
  key: StackAdaptSortKey;
  direction: StackAdaptSortDirection;
} {
  const [keyRaw, directionRaw] = (value ?? "").split(":");
  const key = keyRaw as StackAdaptSortKey;
  const direction = directionRaw as StackAdaptSortDirection;
  const validKeys: StackAdaptSortKey[] = [
    "line",
    "token",
    "cliente",
    "campanha",
    "gasto",
    "investido",
    "pct_invest",
    "total",
  ];
  if (!validKeys.includes(key)) return { key: "gasto", direction: "desc" };
  return { key, direction: direction === "asc" ? "asc" : "desc" };
}

function parseNoTokenSortParam(value: string | null): {
  key: AttentionNoTokenSortKey;
  direction: AttentionSortDirection;
} {
  const [keyRaw, directionRaw] = (value ?? "").split(":");
  const key = keyRaw as AttentionNoTokenSortKey;
  const direction = directionRaw as AttentionSortDirection;
  const validKeys: AttentionNoTokenSortKey[] = ["platform", "line", "gasto"];
  if (!validKeys.includes(key)) return { key: "gasto", direction: "desc" };
  return { key, direction: direction === "asc" ? "asc" : "desc" };
}

function parseOutOfPeriodSortParam(value: string | null): {
  key: AttentionOutOfPeriodSortKey;
  direction: AttentionSortDirection;
} {
  const [keyRaw, directionRaw] = (value ?? "").split(":");
  const key = keyRaw as AttentionOutOfPeriodSortKey;
  const direction = directionRaw as AttentionSortDirection;
  const validKeys: AttentionOutOfPeriodSortKey[] = [
    "platform",
    "token",
    "cliente",
    "campanha",
    "account_management",
    "vigencia",
    "gasto",
  ];
  if (!validKeys.includes(key)) return { key: "gasto", direction: "desc" };
  return { key, direction: direction === "asc" ? "asc" : "desc" };
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
  metrics,
  nexdSummary,
  nexdSpendSecondary,
  nexdTrendLine,
  nexdFoldDetails,
  summaryHighlight,
}: {
  title: string;
  value: string;
  subtitle?: ReactNode;
  /** Linha secundária em USD (menor peso visual que o valor em BRL). */
  usdLine?: string | null;
  /** Nexd: gasto em BRL/USD abaixo do KPI principal (% do cap), sem competir com o título. */
  nexdSpendSecondary?: { brl: string; usd?: string | null } | null;
  /** Nexd: uma linha de tendência entre o KPI e os detalhes colapsáveis. */
  nexdTrendLine?: string | null;
  /** Nexd: métricas + bloco de ritmo ficam dentro de &lt;details&gt;. */
  nexdFoldDetails?: boolean;
  /** Métrica extra label + valor (ex.: NEXD — Impressões). */
  metric?: { label: string; value: string };
  /** Várias métricas; se definido, tem precedência sobre `metric`. `label` omitido = linha única (ex.: % do cap). */
  metrics?: Array<{ label?: string; value: string }>;
  /** Resumo Nexd: ritmo do cap + leitura vs linear + previsão compacta. */
  nexdSummary?: {
    rhythmEmoji: string;
    rhythmLabel: string;
    rhythmTone: NexdCapTone;
    paceHint: string | null;
    forecastLeft?: { line: string; hot: boolean } | null;
  };
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
  const hasBudgetTarget =
    budget?.target_brl !== null && budget?.target_brl !== undefined;
  const investmentSharePct = budget?.investment_share_pct;
  const budgetFillTone = isOverTarget
    ? "Over"
    : progressRaw >= 90
      ? "Warn"
      : "Ok";

  const go = () => {
    if (href) router.push(href);
  };

  const hasSubtitle =
    subtitle !== undefined &&
    subtitle !== null &&
    subtitle !== false &&
    subtitle !== "";
  const resolvedMetrics =
    metrics && metrics.length > 0
      ? metrics
      : metric
        ? [{ label: metric.label, value: metric.value }]
        : [];
  const hasMetricBlocks = resolvedMetrics.length > 0;
  const showMetricsAboveFold = hasMetricBlocks && !nexdFoldDetails;

  const metricsBlock = resolvedMetrics.map((m, idx) => {
    const labelTrim = m.label != null ? String(m.label).trim() : "";
    if (labelTrim) {
      return (
        <div key={`m-${idx}`} className="cardMetricBlock">
          <p className="cardMetricLabel">{labelTrim}</p>
          <p className="cardMetricValue">{m.value}</p>
        </div>
      );
    }
    return (
      <p key={`m-${idx}`} className="cardKpiContextLine">
        {m.value}
      </p>
    );
  });

  const nexdSummaryBlock = nexdSummary ? (
    <div
      className={`cardNexdSummary cardNexdSummary--${nexdSummary.rhythmTone}`}
    >
      <p
        className="cardNexdSummaryRhythm"
        role="status"
        title={nexdSummary.rhythmLabel}
        aria-label={`${nexdSummary.rhythmLabel}`}
      >
        <span className="cardNexdSummaryRhythmEmoji" aria-hidden="true">
          {nexdSummary.rhythmEmoji}
        </span>
        <span>{nexdSummary.rhythmLabel}</span>
      </p>
      {nexdSummary.paceHint ? (
        <p
          className="cardNexdSummaryPace muted"
          aria-label={nexdSummary.paceHint}
        >
          {nexdSummary.paceHint}
        </p>
      ) : null}
      {nexdSummary.forecastLeft ? (
        <p
          className={`cardNexdForecastLeft${nexdSummary.forecastLeft.hot ? " cardNexdForecastLeft--hot" : ""}`}
          aria-label={nexdSummary.forecastLeft.line}
        >
          {nexdSummary.forecastLeft.line}
        </p>
      ) : null}
    </div>
  ) : null;

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
        <p
          className={`cardBadge ${badgeTone === "soon" ? "cardBadgeSoon" : ""}`}
        >
          {badgeTone === "soon" ? (
            <span className="cardBadgeSoonDot" aria-hidden="true" />
          ) : null}
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
        <p className={`cardTitle ${titleEmphasis ? "cardTitleEmphasis" : ""}`}>
          {title}
        </p>
        {statusIndicator ? (
          <span
            className={`cardStatusIndicator cardStatusIndicator${statusIndicator.tone}`}
          >
            <span className="cardStatusDot" aria-hidden="true" />
            {statusIndicator.label}
          </span>
        ) : null}
      </div>
      <div className="cardKpiPrimary">
        <p
          className={`cardValue${nexdSpendSecondary ? " cardValueNexdCapLead" : ""}`}
        >
          {value}
        </p>
        {nexdSpendSecondary ? (
          <div className="cardNexdSpendSecondary">
            <p className="cardNexdSpendSecondaryBrl">
              {nexdSpendSecondary.brl}
            </p>
            {nexdSpendSecondary.usd ? (
              <p className="cardNexdSpendSecondaryUsd">
                {nexdSpendSecondary.usd}
              </p>
            ) : null}
          </div>
        ) : usdLine ? (
          <p className="cardUsdLine">{usdLine}</p>
        ) : null}
      </div>
      {nexdTrendLine ? (
        <p className="cardNexdTrendLine muted" role="status">
          {nexdTrendLine}
        </p>
      ) : null}
      {showMetricsAboveFold ? metricsBlock : null}
      {nexdFoldDetails && (hasMetricBlocks || nexdSummaryBlock) ? (
        <details className="cardNexdDetails">
          <summary className="cardNexdDetailsSummary">
            Detalhes do pacote
          </summary>
          <div className="cardNexdDetailsBody">
            {nexdSummaryBlock}
            {hasMetricBlocks ? metricsBlock : null}
          </div>
        </details>
      ) : (
        nexdSummaryBlock
      )}
      {hasSubtitle ? (
        <div
          className={`cardSubtitle ${
            usdLine ||
            nexdSpendSecondary ||
            showMetricsAboveFold ||
            nexdTrendLine ||
            nexdFoldDetails
              ? "cardSubtitleAfterUsd"
              : ""
          }`}
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
                {investmentSharePct != null &&
                Number.isFinite(investmentSharePct) ? (
                  <span className="cardBudgetMetaFiguresPct">
                    {" "}
                    (
                    {Number(investmentSharePct).toLocaleString("pt-BR", {
                      maximumFractionDigits: 0,
                    })}
                    % do total)
                  </span>
                ) : null}
              </p>
            </div>
            <div
              className="budgetProgressTrack budgetProgressTrackCard"
              aria-hidden={!Number.isFinite(progressRaw)}
            >
              <div
                className={`budgetProgressFill budgetProgressFill${budgetFillTone}`}
                style={{ width: `${progressClamped}%` }}
              />
            </div>
            <div
              className={`cardBudgetCompareBlock ${isOverTarget ? "cardBudgetCompareBlockOver" : ""}`}
            >
              {isOverTarget ? (
                <>
                  <p className="cardBudgetCompare cardBudgetCompareOver">
                    +{Math.round((budget.progress_pct ?? 0) - 100)}% acima
                  </p>
                  <p className="cardBudgetCompareDetail">
                    {BRL_INTEGER_FORMATTER.format(
                      Math.abs(budget.remaining_brl ?? 0),
                    )}{" "}
                    acima
                  </p>
                </>
              ) : (
                <p className="cardBudgetCompare">
                  {(budget.progress_pct ?? 0).toFixed(1).replace(".", ",")}% do
                  budget · Restante {brl(budget.remaining_brl ?? 0)}
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
    () =>
      visibleOptions.filter(
        (opt) => !disabledOptions?.has(opt) || value.includes(opt),
      ),
    [disabledOptions, value, visibleOptions],
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
    value.length === 0
      ? placeholder
      : value.length === 1
        ? value[0]
        : `${value.length} selecionados`;

  const compactValueDisplay =
    value.length === 1
      ? value[0]
      : value.length > 1
        ? String(value.length)
        : "";

  const isOptionDisabled = (opt: string) =>
    Boolean(disabledOptions?.has(opt) && !value.includes(opt));

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
    <div
      className={`filterField ${compact ? "filterFieldCompact" : ""}`}
      ref={rootRef}
    >
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
          compact && options.length && !value.length
            ? `${label}. ${placeholder}`
            : undefined
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
                  <Image
                    key={opt}
                    src={avatar}
                    alt=""
                    width={20}
                    height={20}
                    className="multiSelectAvatarThumb"
                  />
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
                  <span className="multiSelectTriggerLabel multiSelectTriggerLabelPlaceholder">
                    Sem opções
                  </span>
                </>
              ) : value.length === 0 ? (
                <>
                  <span className="multiSelectInlineLabel">{label}</span>
                  <span className="multiSelectTriggerLabel multiSelectTriggerLabelPlaceholder">
                    {placeholder}
                  </span>
                </>
              ) : (
                <>
                  <span className="multiSelectInlineLabel">{label}</span>
                  <span className="multiSelectInlineSep" aria-hidden>
                    {"\u00A0•\u00A0"}
                  </span>
                  <span
                    className={`multiSelectTriggerLabel ${
                      hasSelection
                        ? "multiSelectTriggerLabelActive"
                        : "multiSelectTriggerLabelPlaceholder"
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
                hasSelection
                  ? "multiSelectTriggerLabelActive"
                  : "multiSelectTriggerLabelPlaceholder"
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
        <ul
          className="multiSelectList"
          role="listbox"
          aria-multiselectable="true"
        >
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
              <button
                type="button"
                className="multiSelectClearInlineButton"
                onClick={clearAll}
              >
                Limpar tudo
              </button>
            ) : null}
          </li>
          {selectableOptions.length ? (
            selectableOptions.map((opt) => {
              const selected = value.includes(opt);
              const disabled = isOptionDisabled(opt);
              return (
                <li
                  key={opt}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={disabled || undefined}
                >
                  <label
                    className={`multiSelectOption ${disabled ? "multiSelectOptionDisabled" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={disabled}
                      onChange={() => toggle(opt)}
                    />
                    {showAvatar ? (
                      getAccountManagerAvatar(opt) ? (
                        <Image
                          src={getAccountManagerAvatar(opt)!}
                          alt=""
                          width={24}
                          height={24}
                          className="multiSelectOptionAvatar"
                        />
                      ) : (
                        <span className="multiSelectOptionAvatarFallback">
                          {initialsFor(opt)}
                        </span>
                      )
                    ) : null}
                    <span>{opt}</span>
                  </label>
                </li>
              );
            })
          ) : (
            <li className="multiSelectEmptyState">
              Nenhuma opção disponível para os filtros atuais.
            </li>
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
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds))
    return "—";
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

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      aria-hidden="true"
      className="buttonIcon"
    >
      <circle
        cx="11"
        cy="11"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M20 20l-3.5-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ColumnsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      aria-hidden="true"
      className="buttonIcon"
    >
      <path
        d="M4 5h16v14H4zM10 5v14M16 5v14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      aria-hidden="true"
      className="buttonIcon"
    >
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
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      className="filterPanelTitleFilterIcon"
    >
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

function SearchEmptyStateIllustration() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="44"
      height="44"
      aria-hidden="true"
      className="tableEmptyStateSvg"
    >
      <circle
        cx="11"
        cy="11"
        r="6.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.65"
      />
      <path
        d="M20 20l-4.35-4.35"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DspLinesNoDataEmptyState() {
  return (
    <div
      className="tableEmptyState tableEmptyStateStandalone dspEmptyStateCard"
      role="status"
    >
      <div className="dspEmptyStateIllustration" aria-hidden="true">
        <svg
          viewBox="0 0 96 96"
          width="96"
          height="96"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect
            x="14"
            y="22"
            width="68"
            height="52"
            rx="8"
            className="dspEmptyStateCardShape"
            strokeWidth="1.8"
          />
          <line
            x1="14"
            y1="34"
            x2="82"
            y2="34"
            className="dspEmptyStateCardShape"
            strokeWidth="1.8"
          />
          <circle
            cx="22"
            cy="28"
            r="1.6"
            className="dspEmptyStateDot"
            fill="currentColor"
            stroke="none"
          />
          <circle
            cx="28"
            cy="28"
            r="1.6"
            className="dspEmptyStateDot"
            fill="currentColor"
            stroke="none"
          />
          <line
            x1="24"
            y1="46"
            x2="60"
            y2="46"
            className="dspEmptyStateLine"
            strokeWidth="1.6"
          />
          <line
            x1="24"
            y1="54"
            x2="52"
            y2="54"
            className="dspEmptyStateLine"
            strokeWidth="1.6"
          />
          <line
            x1="24"
            y1="62"
            x2="44"
            y2="62"
            className="dspEmptyStateLine"
            strokeWidth="1.6"
          />
        </svg>
      </div>
      <p className="tableEmptyStateTitle">Sem lines no período selecionado</p>
      <p className="tableEmptyStateSubtitle">
        Quando houver gasto cadastrado nesta DSP, as lines aparecerão aqui.
        Tente ajustar o intervalo no topo da página.
      </p>
    </div>
  );
}

function DspLinesFilteredEmptyState({
  onClearFilters,
}: {
  onClearFilters: () => void;
}) {
  return (
    <div className="tableEmptyState tableEmptyStateInTable" role="status">
      <div className="tableEmptyStateIconWrap" aria-hidden="true">
        <SearchEmptyStateIllustration />
      </div>
      <p className="tableEmptyStateTitle">
        Nenhum resultado com os filtros aplicados
      </p>
      <p className="tableEmptyStateSubtitle">
        Tente ajustar ou remover os filtros aplicados.
      </p>
      <button
        type="button"
        className="button buttonGhost tableEmptyStateClearButton"
        onClick={onClearFilters}
      >
        Limpar filtros
      </button>
    </div>
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

function HomeContent() {
  const JOURNEY_RETURN_ANCHOR_KEY = "campaignJourneyReturnAnchor";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { signOut } = useClerk();
  const { isLoaded: isUserLoaded, isSignedIn, user } = useUser();
  const [stackAdaptSearch, setStackAdaptSearch] = useState(
    () => searchParams.get(URL_PARAM_STACK_SEARCH) ?? "",
  );
  const [dspLinesOnlyWithoutToken, setDspLinesOnlyWithoutToken] = useState(
    () => searchParams.get(URL_PARAM_STACK_NO_TOKEN_ONLY) === "1",
  );
  const [stackAdaptSort, setStackAdaptSort] = useState<{
    key: StackAdaptSortKey;
    direction: StackAdaptSortDirection;
  }>(() => parseStackSortParam(searchParams.get(URL_PARAM_STACK_SORT)));
  const [attentionNoTokenSearch, setAttentionNoTokenSearch] = useState(
    () => searchParams.get(URL_PARAM_NO_TOKEN_SEARCH) ?? "",
  );
  const [attentionNoTokenSort, setAttentionNoTokenSort] = useState<{
    key: AttentionNoTokenSortKey;
    direction: AttentionSortDirection;
  }>(() => parseNoTokenSortParam(searchParams.get(URL_PARAM_NO_TOKEN_SORT)));
  const [attentionOutOfPeriodSearch, setAttentionOutOfPeriodSearch] = useState(
    () => searchParams.get(URL_PARAM_OUT_SEARCH) ?? "",
  );
  const [attentionNoTokenDspFilters, setAttentionNoTokenDspFilters] = useState<
    string[]
  >(() => parseCsvList(searchParams.get(URL_PARAM_NO_TOKEN_DSPS)));
  const [attentionOutOfPeriodDspFilters, setAttentionOutOfPeriodDspFilters] =
    useState<string[]>(() =>
      parseCsvList(searchParams.get(URL_PARAM_OUT_DSPS)),
    );
  const [attentionOutOfPeriodSort, setAttentionOutOfPeriodSort] = useState<{
    key: AttentionOutOfPeriodSortKey;
    direction: AttentionSortDirection;
  }>(() => parseOutOfPeriodSortParam(searchParams.get(URL_PARAM_OUT_SORT)));
  const [campaignJourneySort, setCampaignJourneySort] = useState<{
    key: CampaignJourneySortKey;
    direction: AttentionSortDirection;
  }>({ key: "total_plataformas", direction: "desc" });
  const [nexdFormatSort, setNexdFormatSort] = useState<{
    key: NexdFormatSortKey;
    direction: AttentionSortDirection;
  }>({ key: "impressions", direction: "desc" });
  const [clientFilter, setClientFilter] = useState<string[]>(() =>
    parseCsvList(searchParams.get(URL_PARAM_CLIENTS)),
  );
  const [csFilter, setCsFilter] = useState<string[]>(() =>
    parseCsvList(searchParams.get(URL_PARAM_CS)),
  );
  const [campaignFilter, setCampaignFilter] = useState<string[]>(() =>
    parseCsvList(searchParams.get(URL_PARAM_CAMPAIGNS)),
  );
  const [campaignStatusFilter, setCampaignStatusFilter] = useState<string[]>(
    () => parseCsvList(searchParams.get(URL_PARAM_CAMPAIGN_STATUS)),
  );
  const [featureFilter, setFeatureFilter] = useState<string[]>(() =>
    parseCsvList(searchParams.get(URL_PARAM_FEATURES)).filter((value) =>
      (FEATURE_OPTIONS as readonly string[]).includes(value),
    ),
  );
  const [campaignTypeFilter, setCampaignTypeFilter] = useState<string[]>(() =>
    parseCsvList(searchParams.get(URL_PARAM_CAMPAIGN_TYPE)),
  );
  const includeOutOfPeriodCampaigns = false;
  const [selectedViewMode, setSelectedViewMode] = useState<AnalysisViewMode>(
    () => {
      const paramView = searchParams.get(URL_PARAM_VIEW);
      return isValidAnalysisViewMode(paramView) ? paramView : "month";
    },
  );
  const [selectedMonthKey, setSelectedMonthKey] = useState<string>(() => {
    const paramMonth = searchParams.get(URL_PARAM_MONTH);
    if (
      isValidDayKey(paramMonth) ||
      isValidWeekKey(paramMonth) ||
      isValidMonthKey(paramMonth) ||
      isValidYearKey(paramMonth)
    ) {
      return paramMonth;
    }
    return getCurrentMonthKey();
  });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    kind: "success" | "error";
  } | null>(null);
  const [noTokenObsModalRow, setNoTokenObsModalRow] = useState<
    DashboardResponse["attention"]["no_token_rows"][number] | null
  >(null);
  const [noTokenObsModalText, setNoTokenObsModalText] = useState("");
  const [noTokenObsModalSaving, setNoTokenObsModalSaving] = useState(false);
  const [noTokenNameModalRow, setNoTokenNameModalRow] = useState<
    DashboardResponse["attention"]["no_token_rows"][number] | null
  >(null);
  const [noTokenNameModalText, setNoTokenNameModalText] = useState("");
  const [noTokenNameModalSaving, setNoTokenNameModalSaving] = useState(false);
  const [noTokenActionMenuKey, setNoTokenActionMenuKey] = useState<
    string | null
  >(null);
  const [noTokenRowTooltip, setNoTokenRowTooltip] = useState<{
    text: string;
    anchorCenterX: number;
    anchorBottom: number;
  } | null>(null);
  const noTokenTooltipHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [copiedFieldKey, setCopiedFieldKey] = useState<string | null>(null);
  const [refreshPhase, setRefreshPhase] = useState<RefreshPhase>("idle");
  const [refreshRunStartedAt, setRefreshRunStartedAt] = useState<number | null>(
    null,
  );
  const [refreshElapsedSeconds, setRefreshElapsedSeconds] = useState(0);
  const [refreshRequestedAt, setRefreshRequestedAt] = useState<number | null>(
    null,
  );
  const [refreshObservedRunId, setRefreshObservedRunId] = useState<
    string | null
  >(null);
  const [refreshObservedStartedAt, setRefreshObservedStartedAt] = useState<
    string | null
  >(null);
  const [refreshHasSeenRunning, setRefreshHasSeenRunning] = useState(false);
  const [currentTimestamp, setCurrentTimestamp] = useState<number>(() =>
    new Date().getTime(),
  );
  const [isDashboardFiltersExpanded, setIsDashboardFiltersExpanded] =
    useState(false);
  const [dspLinesPage, setDspLinesPage] = useState(1);
  const [isJourneyBreakdownExpanded, setIsJourneyBreakdownExpanded] =
    useState(false);
  /** Nexd — tabela “Por campanha”: expandir além do top N. */
  const [nexdCampaignTableShowAll, setNexdCampaignTableShowAll] =
    useState(false);
  /** Segmented control da home (Custo dia a dia): null = "Tudo", caso contrário plataforma. */
  const [dailyCostFocus, setDailyCostFocus] = useState<string | null>(null);
  /** Hover no donut ou na legenda lateral (Distribuição): destaca fatia + linha. */
  const [distributionHighlightPlatform, setDistributionHighlightPlatform] =
    useState<string | null>(null);
  /** Hover no donut de gasto fora do mês: destaca fatia + linha. */
  const [
    outOfPeriodDistributionHighlightPlatform,
    setOutOfPeriodDistributionHighlightPlatform,
  ] = useState<string | null>(null);
  const apiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  const userEmail =
    user?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "";
  const isAllowedDomain = userEmail.endsWith("@hypr.mobi");
  const shouldFetchData = isUserLoaded && isSignedIn && isAllowedDomain;
  const selectedDateRange = useMemo(
    () => resolveAnalysisDateRange(selectedViewMode, selectedMonthKey),
    [selectedMonthKey, selectedViewMode],
  );
  const yearOptions = useMemo(() => [...AVAILABLE_YEAR_KEYS], []);
  const currentMonthKey = useMemo(() => getCurrentMonthKey(), []);
  const currentYearKey = useMemo(() => getCurrentYearKey(), []);
  const periodOptions = useMemo(() => {
    if (selectedViewMode === "year") return yearOptions;
    let options: string[];
    if (selectedViewMode === "day") options = buildRecentDayKeys(60);
    else if (selectedViewMode === "week") options = buildRecentWeekKeys(26);
    else options = buildRecentMonthKeys(18);
    if (options.includes(selectedMonthKey)) return options;
    return [selectedMonthKey, ...options];
  }, [selectedMonthKey, selectedViewMode, yearOptions]);
  const dashboardUrl = useMemo(() => {
    if (!shouldFetchData) return null;
    const query = new URLSearchParams({
      start: selectedDateRange.start,
      end: selectedDateRange.end,
    });
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
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<DashboardResponse>(dashboardUrl, fetchDashboard, {
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
  const refreshMetricsUrl = shouldFetchData
    ? `${apiBase}/api/dashboard/refresh/metrics`
    : null;
  const { data: refreshMetrics, mutate: mutateRefreshMetrics } =
    useSWR<RefreshMetricsResponse>(refreshMetricsUrl, fetchRefreshMetrics, {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 60000,
    });
  const refreshStatusUrl = shouldFetchData
    ? `${apiBase}/api/dashboard/refresh/status`
    : null;
  const { data: refreshStatus, mutate: mutateRefreshStatus } =
    useSWR<RefreshStatusResponse>(refreshStatusUrl, fetchRefreshStatus, {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshInterval: (status) =>
        status?.running ||
        refreshPhase === "starting" ||
        refreshPhase === "running"
          ? 2000
          : 0,
      dedupingInterval: 1000,
    });
  const displayedSnapshotAt = useMemo(() => {
    const fromPayload = data?._meta?.snapshot_at
      ? Date.parse(data._meta.snapshot_at)
      : Number.NaN;
    if (!Number.isNaN(fromPayload)) {
      return fromPayload;
    }
    if (lastUpdatedAt) {
      return lastUpdatedAt;
    }
    return null;
  }, [data?._meta?.snapshot_at, lastUpdatedAt]);
  const isRefreshRunning =
    refreshPhase === "starting" ||
    refreshPhase === "running" ||
    Boolean(refreshStatus?.running);
  /* Only blocks UI when the *user* clicked Atualizar. Background workers
     (scheduled_hourly) write to line_costs but the dashboard query reads
     from BQ live — there is no consistency issue with changing the period
     mid-worker-run, and the worker takes ~2.5min, which is too long to
     lock the filter for everyone. */
  const isUserRefreshRunning =
    refreshPhase === "starting" || refreshPhase === "running";

  const cancelHideNoTokenRowTooltip = useCallback(() => {
    if (noTokenTooltipHideTimerRef.current !== null) {
      clearTimeout(noTokenTooltipHideTimerRef.current);
      noTokenTooltipHideTimerRef.current = null;
    }
  }, []);

  const scheduleHideNoTokenRowTooltip = useCallback(() => {
    cancelHideNoTokenRowTooltip();
    noTokenTooltipHideTimerRef.current = setTimeout(() => {
      setNoTokenRowTooltip(null);
      noTokenTooltipHideTimerRef.current = null;
    }, 220);
  }, [cancelHideNoTokenRowTooltip]);

  const showNoTokenRowTooltipFromRect = useCallback(
    (text: string, rect: DOMRect) => {
      cancelHideNoTokenRowTooltip();
      setNoTokenRowTooltip({
        text,
        anchorCenterX: rect.left + rect.width / 2,
        anchorBottom: rect.bottom,
      });
    },
    [cancelHideNoTokenRowTooltip],
  );

  const closeNoTokenObservationModal = useCallback(() => {
    cancelHideNoTokenRowTooltip();
    setNoTokenRowTooltip(null);
    setNoTokenObsModalRow(null);
    setNoTokenObsModalText("");
    setNoTokenObsModalSaving(false);
  }, [cancelHideNoTokenRowTooltip]);

  const closeNoTokenNameModal = useCallback(() => {
    cancelHideNoTokenRowTooltip();
    setNoTokenRowTooltip(null);
    setNoTokenNameModalRow(null);
    setNoTokenNameModalText("");
    setNoTokenNameModalSaving(false);
  }, [cancelHideNoTokenRowTooltip]);

  const saveNoTokenObservationFromModal = useCallback(async () => {
    if (!noTokenObsModalRow) return;
    setNoTokenObsModalSaving(true);
    try {
      await saveNoTokenObservation(apiBase, {
        platform: noTokenObsModalRow.platform,
        line: noTokenObsModalRow.line,
        line_item_id: noTokenObsModalRow.line_item_id,
        observation: noTokenObsModalText,
      });
      setToast({ kind: "success", message: "Observação salva." });
      closeNoTokenObservationModal();
      await mutate();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Falha ao salvar observação.";
      setToast({ kind: "error", message: msg });
    } finally {
      setNoTokenObsModalSaving(false);
    }
  }, [
    apiBase,
    closeNoTokenObservationModal,
    mutate,
    noTokenObsModalRow,
    noTokenObsModalText,
  ]);

  const saveNoTokenNameFromModal = useCallback(async () => {
    if (!noTokenNameModalRow) return;
    setNoTokenNameModalSaving(true);
    try {
      const result = await saveNoTokenLineName(apiBase, {
        platform: noTokenNameModalRow.platform,
        line: noTokenNameModalRow.line,
        line_item_id: noTokenNameModalRow.line_item_id,
        line_name: noTokenNameModalText,
        updated_by: userEmail || null,
      });
      setToast({
        kind: "success",
        message: `Line associada ao token ${result.token}.`,
      });
      closeNoTokenNameModal();
      await mutate();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Falha ao salvar nome da line.";
      setToast({ kind: "error", message: msg });
    } finally {
      setNoTokenNameModalSaving(false);
    }
  }, [
    apiBase,
    closeNoTokenNameModal,
    mutate,
    noTokenNameModalRow,
    noTokenNameModalText,
    userEmail,
  ]);

  const spendByPlatformChartRef = useRef<HTMLDivElement | null>(null);
  const distributionChartRef = useRef<HTMLDivElement | null>(null);
  const dailyCostChartRef = useRef<HTMLElement | null>(null);
  const noTokenDistributionChartRef = useRef<HTMLDivElement | null>(null);
  const noTokenObsTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const noTokenNameInputRef = useRef<HTMLInputElement | null>(null);
  const outOfPeriodDistributionChartRef = useRef<HTMLDivElement | null>(null);
  const nexdUsageChartRef = useRef<HTMLDivElement | null>(null);
  const journeyInvestidoSortWrapRef = useRef<HTMLDivElement | null>(null);
  const [journeyInvestidoSortMenuOpen, setJourneyInvestidoSortMenuOpen] =
    useState(false);

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
    if (!journeyInvestidoSortMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (
        journeyInvestidoSortWrapRef.current &&
        !journeyInvestidoSortWrapRef.current.contains(e.target as Node)
      ) {
        setJourneyInvestidoSortMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setJourneyInvestidoSortMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [journeyInvestidoSortMenuOpen]);

  useEffect(() => {
    if (!noTokenObsModalRow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNoTokenObservationModal();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [noTokenObsModalRow, closeNoTokenObservationModal]);

  useEffect(() => {
    if (!noTokenNameModalRow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNoTokenNameModal();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [noTokenNameModalRow, closeNoTokenNameModal]);

  useEffect(() => {
    if (!noTokenObsModalRow) return;
    const id = window.requestAnimationFrame(() => {
      noTokenObsTextareaRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [noTokenObsModalRow]);

  useEffect(() => {
    if (!noTokenNameModalRow) return;
    const id = window.requestAnimationFrame(() => {
      noTokenNameInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [noTokenNameModalRow]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCurrentTimestamp(new Date().getTime());
    }, 60000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const nextStackSort = parseStackSortParam(
      searchParams.get(URL_PARAM_STACK_SORT),
    );
    const nextNoTokenSort = parseNoTokenSortParam(
      searchParams.get(URL_PARAM_NO_TOKEN_SORT),
    );
    const nextOutSort = parseOutOfPeriodSortParam(
      searchParams.get(URL_PARAM_OUT_SORT),
    );
    const nextNoTokenDsps = parseCsvList(
      searchParams.get(URL_PARAM_NO_TOKEN_DSPS),
    );
    const nextOutDsps = parseCsvList(searchParams.get(URL_PARAM_OUT_DSPS));
    const nextClients = parseCsvList(searchParams.get(URL_PARAM_CLIENTS));
    const nextCs = parseCsvList(searchParams.get(URL_PARAM_CS));
    const nextCampaigns = parseCsvList(searchParams.get(URL_PARAM_CAMPAIGNS));
    const nextCampaignStatuses = parseCsvList(
      searchParams.get(URL_PARAM_CAMPAIGN_STATUS),
    );
    const nextFeatures = parseCsvList(
      searchParams.get(URL_PARAM_FEATURES),
    ).filter((value) => (FEATURE_OPTIONS as readonly string[]).includes(value));
    const nextCampaignTypes = parseCsvList(
      searchParams.get(URL_PARAM_CAMPAIGN_TYPE),
    );
    const nextView = searchParams.get(URL_PARAM_VIEW);
    const nextMonth = searchParams.get(URL_PARAM_MONTH);
    const normalizedView = isValidAnalysisViewMode(nextView)
      ? nextView
      : "month";
    const normalizedMonth =
      normalizedView === "day"
        ? isValidDayKey(nextMonth)
          ? nextMonth
          : getCurrentDayKey()
        : normalizedView === "week"
          ? isValidWeekKey(nextMonth)
            ? nextMonth
            : getCurrentWeekKey()
          : normalizedView === "year"
            ? isValidYearKey(nextMonth)
              ? nextMonth
              : currentYearKey
            : isValidMonthKey(nextMonth)
              ? nextMonth
              : currentMonthKey;

    setStackAdaptSearch(searchParams.get(URL_PARAM_STACK_SEARCH) ?? "");
    setDspLinesOnlyWithoutToken(
      searchParams.get(URL_PARAM_STACK_NO_TOKEN_ONLY) === "1",
    );
    setAttentionNoTokenSearch(
      searchParams.get(URL_PARAM_NO_TOKEN_SEARCH) ?? "",
    );
    setAttentionOutOfPeriodSearch(searchParams.get(URL_PARAM_OUT_SEARCH) ?? "");
    setStackAdaptSort((prev) =>
      prev.key === nextStackSort.key &&
      prev.direction === nextStackSort.direction
        ? prev
        : nextStackSort,
    );
    setAttentionNoTokenSort((prev) =>
      prev.key === nextNoTokenSort.key &&
      prev.direction === nextNoTokenSort.direction
        ? prev
        : nextNoTokenSort,
    );
    setAttentionOutOfPeriodSort((prev) =>
      prev.key === nextOutSort.key && prev.direction === nextOutSort.direction
        ? prev
        : nextOutSort,
    );
    setAttentionNoTokenDspFilters((prev) =>
      prev.join("|") === nextNoTokenDsps.join("|") ? prev : nextNoTokenDsps,
    );
    setAttentionOutOfPeriodDspFilters((prev) =>
      prev.join("|") === nextOutDsps.join("|") ? prev : nextOutDsps,
    );
    setClientFilter((prev) =>
      prev.join("|") === nextClients.join("|") ? prev : nextClients,
    );
    setCsFilter((prev) =>
      prev.join("|") === nextCs.join("|") ? prev : nextCs,
    );
    setCampaignFilter((prev) =>
      prev.join("|") === nextCampaigns.join("|") ? prev : nextCampaigns,
    );
    setCampaignStatusFilter((prev) =>
      prev.join("|") === nextCampaignStatuses.join("|")
        ? prev
        : nextCampaignStatuses,
    );
    setFeatureFilter((prev) =>
      prev.join("|") === nextFeatures.join("|") ? prev : nextFeatures,
    );
    setCampaignTypeFilter((prev) =>
      prev.join("|") === nextCampaignTypes.join("|") ? prev : nextCampaignTypes,
    );
    setSelectedViewMode((prev) =>
      prev === normalizedView ? prev : normalizedView,
    );
    setSelectedMonthKey((prev) =>
      prev === normalizedMonth ? prev : normalizedMonth,
    );
  }, [currentMonthKey, currentYearKey, searchParams]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedReturnUrl = window.sessionStorage.getItem(
      JOURNEY_RETURN_ANCHOR_KEY,
    );
    if (!storedReturnUrl) return;
    const storedUrl = new URL(storedReturnUrl, window.location.origin);
    if (storedUrl.pathname !== window.location.pathname) return;
    const currentWithoutHash = `${window.location.pathname}${window.location.search}`;
    const desiredWithoutHash = `${storedUrl.pathname}${storedUrl.search}`;
    if (currentWithoutHash !== desiredWithoutHash) {
      router.replace(`${desiredWithoutHash}${storedUrl.hash}`, {
        scroll: false,
      });
      return;
    }
    if (storedUrl.hash && window.location.hash !== storedUrl.hash) {
      window.history.replaceState(
        window.history.state,
        "",
        `${desiredWithoutHash}${storedUrl.hash}`,
      );
    }
    const scrollToJourney = () => {
      const target = document.getElementById("jornada-campanhas");
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "auto" });
      }
      window.sessionStorage.removeItem(JOURNEY_RETURN_ANCHOR_KEY);
    };
    const raf = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(scrollToJourney);
    });
    return () => window.cancelAnimationFrame(raf);
  }, [pathname, router, searchParams, JOURNEY_RETURN_ANCHOR_KEY]);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.sessionStorage.getItem(JOURNEY_RETURN_ANCHOR_KEY)
    ) {
      // Enquanto há retorno pendente da Jornada, pausa o sync padrão de query para evitar disputa.
      return;
    }

    const nextParams = new URLSearchParams(searchParams.toString());
    const setQueryValue = (key: string, value: string | null) => {
      if (!value) {
        nextParams.delete(key);
      } else {
        nextParams.set(key, value);
      }
    };

    setQueryValue(URL_PARAM_STACK_SEARCH, stackAdaptSearch.trim() || null);
    setQueryValue(
      URL_PARAM_STACK_NO_TOKEN_ONLY,
      dspLinesOnlyWithoutToken ? "1" : null,
    );
    setQueryValue(
      URL_PARAM_STACK_SORT,
      `${stackAdaptSort.key}:${stackAdaptSort.direction}`,
    );
    setQueryValue(
      URL_PARAM_NO_TOKEN_SEARCH,
      attentionNoTokenSearch.trim() || null,
    );
    setQueryValue(
      URL_PARAM_NO_TOKEN_SORT,
      `${attentionNoTokenSort.key}:${attentionNoTokenSort.direction}`,
    );
    setQueryValue(
      URL_PARAM_NO_TOKEN_DSPS,
      stringifyCsvList(attentionNoTokenDspFilters),
    );
    setQueryValue(
      URL_PARAM_OUT_SEARCH,
      attentionOutOfPeriodSearch.trim() || null,
    );
    setQueryValue(
      URL_PARAM_OUT_SORT,
      `${attentionOutOfPeriodSort.key}:${attentionOutOfPeriodSort.direction}`,
    );
    setQueryValue(
      URL_PARAM_OUT_DSPS,
      stringifyCsvList(attentionOutOfPeriodDspFilters),
    );
    setQueryValue(URL_PARAM_CLIENTS, stringifyCsvList(clientFilter));
    setQueryValue(URL_PARAM_CS, stringifyCsvList(csFilter));
    setQueryValue(URL_PARAM_CAMPAIGNS, stringifyCsvList(campaignFilter));
    setQueryValue(
      URL_PARAM_CAMPAIGN_STATUS,
      stringifyCsvList(campaignStatusFilter),
    );
    setQueryValue(URL_PARAM_FEATURES, stringifyCsvList(featureFilter));
    setQueryValue(
      URL_PARAM_CAMPAIGN_TYPE,
      stringifyCsvList(campaignTypeFilter),
    );
    nextParams.delete(URL_PARAM_INCLUDE_OUT_OF_PERIOD);
    nextParams.delete(URL_PARAM_HIDE_OUT_OF_PERIOD_LEGACY);
    setQueryValue(
      URL_PARAM_VIEW,
      selectedViewMode === "month" ? null : selectedViewMode,
    );
    setQueryValue(URL_PARAM_MONTH, selectedMonthKey);

    const currentQuery = searchParams.toString();
    const nextQuery = nextParams.toString();
    if (currentQuery === nextQuery) return;
    const currentHash =
      typeof window !== "undefined" ? window.location.hash : "";
    router.replace(
      `${pathname}${nextQuery ? `?${nextQuery}` : ""}${currentHash}`,
      { scroll: false },
    );
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

  const journeyRows = useMemo(
    () => data?.dashboard.campaign_journey_rows ?? [],
    [data?.dashboard.campaign_journey_rows],
  );
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
  const normalizeOutOfPeriodKeyPart = (value: string | null | undefined) =>
    String(value ?? "")
      .trim()
      .toLowerCase();
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
      currentToken.set(
        platform,
        (currentToken.get(platform) ?? 0) + Number(row.gasto ?? 0),
      );
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
      const recomputedTotal = activePlatforms.reduce(
        (sum, platform) => sum + Number(nextRow[platform] ?? 0),
        0,
      );
      nextRow.total_plataformas = recomputedTotal;
      const invested = Number(row.investido ?? 0);
      nextRow.pct_investido =
        invested > 0 ? (recomputedTotal / invested) * 100 : 0;
      return nextRow;
    });
  }, [
    data?.dashboard.active_platforms,
    includeOutOfPeriodCampaigns,
    journeyRows,
    outOfPeriodSpendByTokenPlatform,
  ]);
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
    [includeOutOfPeriodCampaigns, outOfPeriodLineKeys],
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
  const clearDspLineTableFilters = useCallback(() => {
    clearDashboardFilters();
    setStackAdaptSearch("");
    setDspLinesOnlyWithoutToken(false);
  }, [clearDashboardFilters]);
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
      },
    ) => {
      if (filters.clients.length && !filters.clients.includes(row.cliente))
        return false;
      if (filters.cs.length && !filters.cs.includes(rowCsLabel(row)))
        return false;
      if (filters.campaigns.length && !filters.campaigns.includes(row.campanha))
        return false;
      if (filters.statuses.length && !filters.statuses.includes(row.status))
        return false;
      if (filters.features.length) {
        const token = String(row.token ?? "").trim();
        if (!hasCampaignToken(token)) return false;
        const featureSet = tokenFeaturesByToken.get(token);
        if (!featureSet) return false;
        if (!filters.features.some((feature) => featureSet.has(feature)))
          return false;
      }
      if (
        !rowMatchesCampaignProducts(row.produto_vendido, filters.campaignTypes)
      )
        return false;
      return true;
    },
    [tokenFeaturesByToken],
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
    const sums: Record<string, number> = Object.fromEntries(
      platforms.map((p) => [p, 0]),
    );
    for (const row of dashboardFilteredRows) {
      for (const p of platforms) {
        sums[p] += Number(row[p] ?? 0);
      }
    }
    return sums;
  }, [hasDashboardScopeFilters, dashboardFilteredRows, data]);

  const spendData = useMemo(
    () => data?.dashboard.spend_by_platform ?? [],
    [data],
  );
  const chartData = useMemo(() => {
    const base = [...spendData].sort((a, b) => b.spend_brl - a.spend_brl);
    if (!hasDashboardScopeFilters || !filteredSpendByPlatform) {
      return base.map((item) => ({
        ...item,
        color: PLATFORM_COLORS[item.platform] ?? "#64748b",
      }));
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
  const periodTotalSpend = useMemo(
    () => chartData.reduce((sum, row) => sum + row.spend_brl, 0),
    [chartData],
  );
  const dominantChartShare = useMemo(() => {
    if (!chartData.length || periodTotalSpend <= 0) return 0;
    return chartData[0].spend_brl / periodTotalSpend;
  }, [chartData, periodTotalSpend]);
  const shouldFallbackPieChart =
    chartData.length <= 1 || dominantChartShare >= 0.9;
  useEffect(() => {
    setDistributionHighlightPlatform((cur) => {
      if (cur === null) return null;
      return chartData.some((r) => r.platform === cur) ? cur : null;
    });
  }, [chartData]);
  const dailyChartPlatforms = useMemo(() => {
    const platforms = (data?.dashboard.active_platforms ?? []).filter(
      (platform) => platform !== "Hivestack",
    );
    const daily = hasDashboardScopeFilters
      ? (data?.dashboard.daily_filtered ?? data?.dashboard.daily ?? [])
      : (data?.dashboard.daily ?? []);
    if (!daily.length || !platforms.length) return platforms;
    const totals = new Map<string, number>(platforms.map((p) => [p, 0]));
    for (const row of daily) {
      for (const p of platforms) {
        totals.set(p, (totals.get(p) ?? 0) + Number(row[p] ?? 0));
      }
    }
    return [...platforms].sort(
      (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0),
    );
  }, [
    data?.dashboard.active_platforms,
    data?.dashboard.daily,
    data?.dashboard.daily_filtered,
    hasDashboardScopeFilters,
  ]);
  const dailyChartRows = useMemo(
    () =>
      hasDashboardScopeFilters
        ? (data?.dashboard.daily_filtered ?? data?.dashboard.daily ?? [])
        : (data?.dashboard.daily ?? []),
    [
      data?.dashboard.daily,
      data?.dashboard.daily_filtered,
      hasDashboardScopeFilters,
    ],
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
      }),
    );
  }, [dailyChartPlatforms, dailyChartRows]);
  useEffect(() => {
    setDailyCostFocus((current) => {
      if (current === null) return current;
      return dailyChartPlatforms.includes(current) ? current : null;
    });
  }, [dailyChartPlatforms]);
  const routeMatch = useMemo<{ page: NavKey; known: boolean }>(() => {
    const normalizedPath =
      pathname && pathname !== "/" ? pathname.replace(/\/+$/, "") : "/";
    if (normalizedPath === "/") return { page: "Dashboard", known: true };
    const slug = normalizedPath.slice(1);
    const page = SLUG_TO_PAGE[slug];
    if (!page) return { page: "Dashboard", known: false };
    return { page, known: true };
  }, [pathname]);
  const requestedPage = routeMatch.page;

  const navOptions = useMemo<NavKey[]>(() => {
    // DSPs are always visible regardless of spend or data availability —
    // browsing to an empty platform page is preferable to hiding the nav and
    // surprising the user when spend appears.
    // Amazon DSP is intentionally omitted — we don't ingest data for it yet,
    // so the page would render empty. Re-add when the integration ships.
    const pages: NavKey[] = [
      "Dashboard",
      "Jornada de campanhas",
      "StackAdapt",
      "DV360",
      "Xandr",
      "Hivestack",
      "Nexd",
      "⚠️ Lines sem token",
      "🚨 Gasto fora do mês vigente",
    ];
    if (!EXTERNAL_PAGES.has(requestedPage) && !pages.includes(requestedPage)) {
      const attentionIndex = pages.indexOf("⚠️ Lines sem token");
      pages.splice(
        attentionIndex >= 0 ? attentionIndex : pages.length,
        0,
        requestedPage,
      );
    }
    return pages;
  }, [requestedPage]);

  const resolvedActivePage: NavKey = requestedPage;

  useEffect(() => {
    cancelHideNoTokenRowTooltip();
    setNoTokenRowTooltip(null);
    setNoTokenActionMenuKey(null);
  }, [resolvedActivePage, cancelHideNoTokenRowTooltip]);

  useEffect(() => {
    setDspLinesPage(1);
  }, [
    resolvedActivePage,
    stackAdaptSearch,
    stackAdaptSort.direction,
    stackAdaptSort.key,
    clientFilter,
    csFilter,
    campaignTypeFilter,
    featureFilter,
    campaignFilter,
    campaignStatusFilter,
    dspLinesOnlyWithoutToken,
  ]);

  const campaignRows = useMemo(
    () => dashboardFilteredRows,
    [dashboardFilteredRows],
  );
  const sortedCampaignRows = useMemo(() => {
    const rows = [...campaignRows];
    const { key, direction } = campaignJourneySort;
    const normalizeString = (value: unknown) => String(value ?? "").trim();
    const getValue = (row: JourneyRow): string | number => {
      if (key.startsWith("platform:")) {
        const platform = key.slice("platform:".length);
        return Number(row[platform] ?? 0);
      }
      if (
        key === "investido" ||
        key === "total_plataformas" ||
        key === "pct_investido"
      ) {
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
          : String(valueA).localeCompare(String(valueB), "pt-BR", {
              numeric: true,
              sensitivity: "base",
            });
      return direction === "asc" ? compare : -compare;
    });
    return rows;
  }, [campaignJourneySort, campaignRows]);
  const campaignJourneySummary = useMemo(() => {
    const investedTotal = sortedCampaignRows.reduce(
      (sum, row) => sum + Number(row.investido ?? 0),
      0,
    );
    const activeCount = sortedCampaignRows.filter(
      (row) =>
        String(row.status ?? "")
          .trim()
          .toLowerCase() === "ativa",
    ).length;
    const endedCount = sortedCampaignRows.filter(
      (row) =>
        String(row.status ?? "")
          .trim()
          .toLowerCase() === "encerrada",
    ).length;
    return {
      totalCount: sortedCampaignRows.length,
      investedTotal,
      activeCount,
      endedCount,
    };
  }, [sortedCampaignRows]);

  const csFilterOptions = useMemo(() => {
    return [...new Set(journeyRows.map(rowCsLabel))].sort((a, b) =>
      a.localeCompare(b, "pt-BR"),
    );
  }, [journeyRows]);
  const campaignFilterOptions = useMemo(() => {
    return [
      ...new Set(
        journeyRows
          .map((row) => String(row.campanha ?? "").trim())
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [journeyRows]);
  const campaignStatusOptions = useMemo(() => {
    return [
      ...new Set(
        journeyRows
          .map((row) => String(row.status ?? "").trim())
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [journeyRows]);
  const productFilterOptions = useMemo(() => {
    return [
      ...new Set(
        journeyRows
          .map((row) => String(row.produto_vendido ?? "").trim())
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b, "pt-BR"));
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
    return [
      ...new Set(journeyRows.map((row) => row.cliente).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b, "pt-BR"));
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
              }),
            ),
        ),
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
    ],
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
              }),
            ),
        ),
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
    ],
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
              }),
            ),
        ),
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
    ],
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
              }),
            ),
        ),
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
    ],
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
              }),
            ),
        ),
      ),
    [
      campaignFilter,
      campaignStatusFilter,
      campaignTypeFilter,
      clientFilter,
      csFilter,
      journeyRows,
      rowMatchesDashboardFilters,
    ],
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
              }),
            ),
        ),
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
    ],
  );

  const finalizeRefreshRun = useCallback(
    (result: "success" | "error", errorMessage?: string) => {
      if (result === "success") {
        void mutate();
        void mutateRefreshMetrics();
        setToast({ message: "Dados atualizados na fonte.", kind: "success" });
      } else {
        setToast({
          message: errorMessage || "Atualizacao na fonte falhou.",
          kind: "error",
        });
      }
      setRefreshPhase("idle");
      setRefreshRunStartedAt(null);
      setRefreshElapsedSeconds(0);
      setRefreshRequestedAt(null);
      setRefreshObservedRunId(null);
      setRefreshObservedStartedAt(null);
      setRefreshHasSeenRunning(false);
    },
    [mutate, mutateRefreshMetrics],
  );

  const handleRefresh = async () => {
    if (!dashboardUrl) return;
    if (isRefreshRunning) return;

    const startedAtLocal = new Date().getTime();
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

      await triggerDashboardRefresh(
        `${apiBase}/api/dashboard/refresh${refreshQuery.toString() ? `?${refreshQuery.toString()}` : ""}`,
      );

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
      const message =
        error instanceof Error
          ? error.message
          : "Nao foi possivel atualizar na fonte.";
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
      setRefreshElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - refreshRunStartedAt) / 1000)),
      );
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
    const isTerminalStatus =
      backendStatus === "success" || backendStatus === "error";
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
        finalizeRefreshRun(
          "error",
          refreshStatus?.error || "Atualizacao na fonte falhou.",
        );
      }
      return;
    }

    if (
      !refreshStatus?.running &&
      refreshHasSeenRunning &&
      markerMatchesCurrentRun
    ) {
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
      finalizeRefreshRun(
        "error",
        "Nao foi possivel confirmar inicio da atualizacao.",
      );
      return;
    }
    const timeoutId = setTimeout(() => {
      finalizeRefreshRun(
        "error",
        "Nao foi possivel confirmar inicio da atualizacao.",
      );
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
    options?: { preferDisplayedSpend?: boolean },
  ) => {
    const entry =
      platform === GENERAL_BUDGET_KEY
        ? data?.budget.general
        : (data?.budget.platforms?.[platform] ?? null);
    const target = entry?.target_brl ?? null;
    const shouldPreferDisplayedSpend = options?.preferDisplayedSpend ?? false;
    const spentValue = shouldPreferDisplayedSpend
      ? spent
      : (entry?.spent_brl ?? spent);
    const progress = target && target > 0 ? (spentValue / target) * 100 : null;
    const remaining = target !== null ? target - spentValue : null;
    const fromApi =
      platform !== GENERAL_BUDGET_KEY
        ? data?.budget.share_percent?.[platform]
        : undefined;
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

  const showToast = (
    message: string,
    kind: "success" | "error" = "success",
  ) => {
    setToast({ message, kind });
  };

  const appendQueryToRoute = (route: string) => {
    const query = searchParams.toString();
    return query ? `${route}?${query}` : route;
  };

  const copyObjectsAsCsv = async (
    label: string,
    rows: Array<Record<string, string | number>>,
  ) => {
    if (!rows.length) {
      showToast(`Sem dados para copiar em ${label}.`, "error");
      return;
    }
    const headers = Object.keys(rows[0]);
    const escapeCsvCell = (value: string | number) => {
      const raw = String(value ?? "");
      const escaped = raw.replace(/"/g, '""');
      return `"${escaped}"`;
    };
    const csv = [
      headers.join(";"),
      ...rows.map((row) =>
        headers.map((header) => escapeCsvCell(row[header] ?? "")).join(";"),
      ),
    ].join("\n");

    try {
      await navigator.clipboard.writeText(csv);
      showToast(`Dados de ${label} copiados em CSV.`);
    } catch {
      showToast(
        "Não foi possível copiar os dados. Verifique as permissões do navegador.",
        "error",
      );
    }
  };

  const exportChartAsPng = async (
    element: HTMLElement | null,
    chartName: string,
    backgroundColor?: string,
  ) => {
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
      await downloadElementPng(element, `${safeName}-${stamp}.png`, backgroundColor);
      showToast(`Imagem exportada: ${chartName}.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "erro desconhecido";
      showToast(`Falha ao exportar imagem (${message}).`, "error");
    }
  };

  const toggleStackAdaptSort = (key: StackAdaptSortKey) => {
    setStackAdaptSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return {
        key,
        direction:
          key === "line" || key === "cliente" || key === "campanha"
            ? "asc"
            : "desc",
      };
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
      return {
        key,
        direction: key === "platform" || key === "line" ? "asc" : "desc",
      };
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

  const attentionOutOfPeriodSortIndicator = (
    key: AttentionOutOfPeriodSortKey,
  ) => {
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

  const campaignJourneySortButtonClass = (key: CampaignJourneySortKey) =>
    `stackSortButton ${campaignJourneySort.key === key ? "stackSortButtonActive" : ""}`;

  const campaignJourneyInvestidoSortHeaderActive =
    campaignJourneySort.key === "investido" ||
    campaignJourneySort.key === "pct_investido";

  const campaignJourneyInvestidoSortIndicator = () => {
    if (!campaignJourneyInvestidoSortHeaderActive) return "↕";
    return campaignJourneySort.direction === "asc" ? "↑" : "↓";
  };

  const selectJourneyInvestidoSortKey = (key: "investido" | "pct_investido") => {
    setCampaignJourneySort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: "desc" };
    });
    setJourneyInvestidoSortMenuOpen(false);
  };

  const toggleNexdFormatSort = (key: NexdFormatSortKey) => {
    setNexdFormatSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: key === "layout" ? "asc" : "desc" };
    });
  };

  const nexdFormatSortIndicator = (key: NexdFormatSortKey) => {
    if (nexdFormatSort.key !== key) return "↕";
    return nexdFormatSort.direction === "asc" ? "↑" : "↓";
  };

  const nexdFormatSortButtonClass = (key: NexdFormatSortKey) =>
    `stackSortButton ${nexdFormatSort.key === key ? "stackSortButtonActive" : ""}`;

  const campaignStatusBadgeClass = (status: string) => {
    const normalized = status.trim().toLowerCase();
    if (normalized === "ativa")
      return "campaignStatusBadge campaignStatusBadgeSuccess";
    if (normalized === "encerrada")
      return "campaignStatusBadge campaignStatusBadgeDanger";
    return "campaignStatusBadge campaignStatusBadgeNeutral";
  };

  const campaignBudgetSpentPct = (row: JourneyRow) => {
    const raw = Number(row.pct_investido ?? 0);
    return Number.isFinite(raw) ? raw : 0;
  };

  const campaignBudgetProgressFillPct = (row: JourneyRow) => {
    const pct = campaignBudgetSpentPct(row);
    return Math.max(0, Math.min(100, pct));
  };

  const detailedPlatformName = [
    "StackAdapt",
    "DV360",
    "Xandr",
    "Hivestack",
  ].includes(resolvedActivePage)
    ? resolvedActivePage
    : null;
  const detailedPlatformRows = useMemo(() => {
    if (!data) return [] as PlatformPageRow[];
    if (!detailedPlatformName) return [] as PlatformPageRow[];
    return data.platform_pages[detailedPlatformName]?.rows ?? [];
  }, [data, detailedPlatformName]);

  const platformRowMatchesDashboardFilters = useCallback(
    (row: PlatformPageRow) => {
      if (shouldHideOutOfPeriodPlatformRow(row, detailedPlatformName))
        return false;
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
    ],
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
    ],
  );

  const filteredDetailedPlatformRows = useMemo(() => {
    return detailedPlatformRows.filter(platformRowMatchesDashboardFilters);
  }, [detailedPlatformRows, platformRowMatchesDashboardFilters]);

  const detailedPlatformDerived = useMemo(() => {
    const rows = filteredDetailedPlatformRows;
    const rowsWithToken = rows.filter((row) =>
      hasCampaignToken(row.token),
    ).length;
    const rowsWithoutToken = Math.max(0, rows.length - rowsWithToken);
    const activeCampaignsCount = new Set(
      rows
        .filter((row) => row.gasto > 0)
        .map((row) => row.campanha?.trim())
        .filter((campanha): campanha is string => Boolean(campanha)),
    ).size;
    const normalizedSearch = stackAdaptSearch.trim().toLowerCase();
    const searchFilteredRows = rows.filter((row) => {
      if (!normalizedSearch) return true;
      const hasBudget = typeof row.investido === "number" && row.investido > 0;
      const budgetText = hasBudget ? brl(row.investido ?? 0) : "sem budget";
      const budgetTag = hasBudget ? "com budget" : "sem budget";
      const searchableText = [
        row.line,
        row.line_item_id ?? "",
        row.dv360_advertiser_id ?? "",
        row.dv360_insertion_order_id ?? "",
        row.dv360_campaign_id ?? "",
        row.dv360_entity_status ?? "",
        row.dv360_partner_id ?? "",
        row.token,
        row.cliente,
        row.campanha,
        row.account_management,
        budgetText,
        row.investido !== null && row.investido !== undefined
          ? String(row.investido)
          : "",
        budgetTag,
      ]
        .join(" ")
        .toLowerCase();
      return searchableText.includes(normalizedSearch);
    });
    const tokenFilteredRows = dspLinesOnlyWithoutToken
      ? searchFilteredRows.filter((row) => !hasCampaignToken(row.token))
      : searchFilteredRows;
    const filteredTotalGasto = tokenFilteredRows.reduce(
      (acc, row) => acc + row.gasto,
      0,
    );
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
        compare = String(valueA).localeCompare(String(valueB), "pt-BR", {
          numeric: true,
          sensitivity: "base",
        });
      }
      return stackAdaptSort.direction === "asc" ? compare : -compare;
    });
    return {
      rowsWithToken,
      rowsWithoutToken,
      activeCampaignsCount,
      sortedRows,
      filteredTotalGasto,
    };
  }, [
    filteredDetailedPlatformRows,
    stackAdaptSearch,
    stackAdaptSort,
    dspLinesOnlyWithoutToken,
  ]);

  const noTokenRows = useMemo(
    () => data?.attention.no_token_rows ?? [],
    [data?.attention.no_token_rows],
  );
  const noTokenSearchNormalized = attentionNoTokenSearch.trim().toLowerCase();
  const noTokenDerived = useMemo(() => {
    const filteredRows = noTokenRows.filter((row) => {
      const p = (row.platform ?? "").trim() || "Outros";
      if (
        attentionNoTokenDspFilters.length > 0 &&
        !attentionNoTokenDspFilters.includes(p)
      )
        return false;
      if (!noTokenSearchNormalized) return true;
      const searchableText = [
        row.platform,
        row.line,
        row.line_item_id ?? "",
        row.observation ?? "",
        row.dv360_advertiser_id ?? "",
        row.dv360_insertion_order_id ?? "",
        row.dv360_campaign_id ?? "",
        row.dv360_entity_status ?? "",
        row.dv360_partner_id ?? "",
        brl(row.gasto),
        String(row.gasto),
      ]
        .join(" ")
        .toLowerCase();
      return searchableText.includes(noTokenSearchNormalized);
    });
    const sortedRows = [...filteredRows].sort((a, b) => {
      const valueA =
        attentionNoTokenSort.key === "gasto"
          ? a.gasto
          : a[attentionNoTokenSort.key];
      const valueB =
        attentionNoTokenSort.key === "gasto"
          ? b.gasto
          : b[attentionNoTokenSort.key];
      const compare =
        typeof valueA === "number" && typeof valueB === "number"
          ? valueA - valueB
          : String(valueA).localeCompare(String(valueB), "pt-BR", {
              numeric: true,
              sensitivity: "base",
            });
      return attentionNoTokenSort.direction === "asc" ? compare : -compare;
    });
    const filteredTotal = filteredRows.reduce((sum, row) => sum + row.gasto, 0);
    return { sortedRows, filteredTotal };
  }, [
    attentionNoTokenDspFilters,
    attentionNoTokenSort,
    noTokenRows,
    noTokenSearchNormalized,
  ]);

  const noTokenUniquePlatforms = useMemo(
    () =>
      [
        ...new Set(
          noTokenRows.map((row) => (row.platform ?? "").trim() || "Outros"),
        ),
      ].sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" })),
    [noTokenRows],
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
    [noTokenPieChartData],
  );

  const outOfPeriodRows = useMemo(
    () => data?.attention.out_of_period_rows ?? [],
    [data?.attention.out_of_period_rows],
  );
  const outOfPeriodSearchNormalized = attentionOutOfPeriodSearch
    .trim()
    .toLowerCase();
  const outOfPeriodDerived = useMemo(() => {
    const filteredRows = outOfPeriodRows.filter((row) => {
      const p = (row.platform ?? "").trim() || "Outros";
      if (
        attentionOutOfPeriodDspFilters.length > 0 &&
        !attentionOutOfPeriodDspFilters.includes(p)
      )
        return false;
      if (hasDashboardFilters && !outOfPeriodRowMatchesDashboardFilters(row))
        return false;
      if (!outOfPeriodSearchNormalized) return true;
      const searchableText = [
        row.platform,
        row.token,
        row.line,
        row.line_item_id ?? "",
        row.dv360_advertiser_id ?? "",
        row.dv360_insertion_order_id ?? "",
        row.dv360_campaign_id ?? "",
        row.dv360_entity_status ?? "",
        row.dv360_partner_id ?? "",
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
          : String(valueA).localeCompare(String(valueB), "pt-BR", {
              numeric: true,
              sensitivity: "base",
            });
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
      [
        ...new Set(
          outOfPeriodRows.map((row) => (row.platform ?? "").trim() || "Outros"),
        ),
      ].sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" })),
    [outOfPeriodRows],
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
    [outOfPeriodPieChartData],
  );
  const outOfPeriodDominantShare = useMemo(() => {
    if (!outOfPeriodPieChartData.length || outOfPeriodPieTotal <= 0) return 0;
    return outOfPeriodPieChartData[0].spend_brl / outOfPeriodPieTotal;
  }, [outOfPeriodPieChartData, outOfPeriodPieTotal]);
  const shouldFallbackOutOfPeriodPieChart =
    outOfPeriodPieChartData.length <= 1 || outOfPeriodDominantShare >= 0.9;
  useEffect(() => {
    setOutOfPeriodDistributionHighlightPlatform((cur) => {
      if (cur === null) return null;
      return outOfPeriodPieChartData.some((row) => row.platform === cur)
        ? cur
        : null;
    });
  }, [outOfPeriodPieChartData]);
  const homeNoTokenAlertCount = noTokenRows.length;
  const homeNoTokenAlertTotal = useMemo(
    () => noTokenRows.reduce((sum, row) => sum + Number(row.gasto ?? 0), 0),
    [noTokenRows],
  );
  const homeOutOfPeriodAlertRows = useMemo(
    () => outOfPeriodRows,
    [outOfPeriodRows],
  );
  const homeOutOfPeriodAlertCount = homeOutOfPeriodAlertRows.length;
  const homeOutOfPeriodAlertTotal = useMemo(
    () =>
      homeOutOfPeriodAlertRows.reduce(
        (sum, row) => sum + Number(row.gasto ?? 0),
        0,
      ),
    [homeOutOfPeriodAlertRows],
  );

  if (!isUserLoaded) return <SessionLoading message="Validando sessão..." />;
  if (!isSignedIn)
    return <SessionLoading message="Redirecionando para login..." />;
  if (!isAllowedDomain)
    return <SessionLoading message="Validando domínio..." />;
  const showInitialDashboardSkeleton =
    shouldFetchData && !data && !error && isLoading;
  if (showInitialDashboardSkeleton)
    return <PageSkeleton page={resolvedActivePage} />;

  const dashboardLoadFailed = Boolean(error || !data);
  const dashboardErrorMessage =
    error instanceof Error
      ? error.message
      : "Nao foi possivel sincronizar os dados no momento.";
  const dashboardErrorIsTimeout = dashboardErrorMessage
    .toLowerCase()
    .includes("timeout");
  const periodStart = selectedDateRange.start;
  const periodEnd = selectedDateRange.end;
  const isPeriodStale =
    !!data &&
    (data.period.start !== selectedDateRange.start ||
      data.period.end !== selectedDateRange.end);
  // While the user has changed the period filter and SWR is refetching, the
  // previous data is now mismatched with the selected range. Showing the page
  // skeleton (instead of the stale numbers) makes filter changes feel
  // responsive on DSP / Campaign Journey / Attention pages.
  const showFilterChangeSkeleton =
    shouldFetchData && isPeriodStale && (isValidating || isLoading);
  if (showFilterChangeSkeleton)
    return <PageSkeleton page={resolvedActivePage} />;
  const periodRangeCompactLabel =
    selectedViewMode === "year"
      ? `Ano completo • ${formatDateBrShort(periodStart)} → ${formatDateBrShort(periodEnd)}`
      : `${formatDateBrShort(periodStart)} → ${formatDateBrShort(periodEnd)}`;
  const periodHeroLabel = formatPeriodKeyLabel(
    selectedViewMode,
    selectedMonthKey,
  );
  const snapshotAgeMinutes = displayedSnapshotAt
    ? Math.max(0, Math.floor((currentTimestamp - displayedSnapshotAt) / 60000))
    : null;
  const snapshotStatus = isRefreshRunning
    ? { label: "Atualizando", tone: "processing" as const }
    : !displayedSnapshotAt
      ? { label: "Sem atualização", tone: "neutral" as const }
      : snapshotAgeMinutes !== null && snapshotAgeMinutes <= 90
        ? { label: "Atualizado", tone: "ok" as const }
        : snapshotAgeMinutes !== null && snapshotAgeMinutes <= 240
          ? { label: "Em atraso", tone: "warn" as const }
          : { label: "Desatualizado", tone: "danger" as const };

  const renderDashboardPage = (mode: "home" | "journey" = "home") => {
    if (!data) return null;
    const navigateToCampaignFromJourney = (token: string) => {
      if (typeof window !== "undefined") {
        const pathWithQuery = `${window.location.pathname}${window.location.search}`;
        const anchoredPath = `${pathWithQuery}#jornada-campanhas`;
        window.sessionStorage.setItem(JOURNEY_RETURN_ANCHOR_KEY, anchoredPath);
        if (window.location.hash !== "#jornada-campanhas") {
          window.history.replaceState(window.history.state, "", anchoredPath);
        }
      }
      router.push(routeForCampaign(token, resolvedActivePage));
    };
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
        ...data.dashboard.active_platforms.map((platform) =>
          Number(row[platform] ?? 0),
        ),
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
      statusIndicator?: {
        label: string;
        tone: "success" | "danger" | "neutral";
      };
      dimmed?: boolean;
      titleEmphasis?: boolean;
      logoSrc?: string;
      platformKey?: string;
      spendBrl?: number;
      href?: string;
    }> = [];
    const dspFiltered = filteredSpendByPlatform;

    for (const name of ["StackAdapt", "DV360", "Xandr"] as const) {
      const result = data.platform_results[name];
      if (!result) continue;
      if (result.status === "ok") {
        const pageSpend = data.platform_pages[name]?.spend_brl ?? 0;
        const cardSpend = hasDashboardScopeFilters
          ? (dspFiltered?.[name] ?? 0)
          : pageSpend;
        const usdTotal = result.spend ?? 0;
        const rate = data.exchange_rate_usd_brl;
        const usdForSubtitle = hasDashboardScopeFilters
          ? pageSpend > 0
            ? (cardSpend / pageSpend) * usdTotal
            : rate > 0
              ? cardSpend / rate
              : 0
          : usdTotal;
        firstRowDspCards.push({
          title: name,
          value: brl(cardSpend),
          usdLine:
            result.currency === "USD"
              ? `USD ${usdForSubtitle.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
              : undefined,
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

    const FIRST_ROW_ORDER = ["DV360", "Xandr", "StackAdapt"];
    firstRowDspCards.sort((a, b) => {
      const ai = FIRST_ROW_ORDER.indexOf(a.title);
      const bi = FIRST_ROW_ORDER.indexOf(b.title);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const secondRowPlatformCards: Array<{
      title: string;
      value: string;
      subtitle?: ReactNode;
      usdLine?: string;
      metric?: { label: string; value: string };
      metrics?: Array<{ label?: string; value: string }>;
      nexdSpendSecondary?: { brl: string; usd?: string | null };
      nexdTrendLine?: string | null;
      nexdFoldDetails?: boolean;
      nexdSummary?: {
        rhythmEmoji: string;
        rhythmLabel: string;
        rhythmTone: NexdCapTone;
        paceHint: string | null;
        forecastLeft?: { line: string; hot: boolean } | null;
      };
      badge?: string;
      badgeTone?: "soon";
      statusIndicator?: {
        label: string;
        tone: "success" | "danger" | "neutral";
      };
      dimmed?: boolean;
      titleEmphasis?: boolean;
      logoSrc?: string;
      platformKey?: string;
      spendBrl?: number;
      href?: string;
      capPct?: number;
      metaLineOverride?: { label: string; value: string };
      spec?: Array<{ label: string; value: string; mono?: boolean }>;
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
        const cap = Number(nexdPage.cap ?? 0) || 1;
        const usedCapPct = Math.max(
          0,
          Math.min(100, (impressions / cap) * 100),
        );
        const paceVsHome = nexdPaceVsExpected(
          usedCapPct,
          data.period.start,
          data.period.end,
        );
        const nexdForecastHome = nexdForecastEndPeriodCapPct(
          data.period.start,
          data.period.end,
          usedCapPct,
        );
        const frHome = nexdForecastHome
          ? Math.round(nexdForecastHome.forecastPct)
          : null;
        const forecastHomeHot = frHome != null && frHome > 100;
        const nexdSummaryRhythmHome = nexdNexdSummaryRhythmPresentation(
          usedCapPct,
          paceVsHome,
          frHome,
        );
        const nexdForecastLeftHome =
          nexdForecastHome != null && frHome != null && !forecastHomeHot
            ? {
                line: `Previsão: ~${frHome}% do cap`,
                hot: false,
              }
            : null;
        secondRowPlatformCards.push({
          title: "NEXD",
          value: `${usedCapPct.toFixed(1).replace(".", ",")}% usado`,
          nexdSpendSecondary: {
            brl: brl(Number(nexdPage.spend_brl ?? 0)),
            usd:
              nexdPage.spend_usd != null &&
              Number.isFinite(Number(nexdPage.spend_usd))
                ? `USD ${Number(nexdPage.spend_usd).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                : undefined,
          },
          nexdTrendLine: forecastHomeHot
            ? null
            : nexdCapTrendBodyCoherent(frHome, paceVsHome.vs),
          metrics: [
            { label: "Impressões", value: impressions.toLocaleString("pt-BR") },
          ],
          nexdFoldDetails: true,
          nexdSummary: {
            rhythmEmoji: nexdSummaryRhythmHome.emoji,
            rhythmLabel: nexdSummaryRhythmHome.label,
            rhythmTone: nexdSummaryRhythmHome.tone,
            paceHint: nexdSummaryRhythmHome.paceHint,
            forecastLeft: nexdForecastLeftHome,
          },
          titleEmphasis: true,
          logoSrc: PLATFORM_LOGOS.Nexd,
          platformKey: "Nexd",
          spendBrl: 862.44,
          capPct: 6.2,
          metaLineOverride: {
            label: "6,2% usado · Cap",
            value: "R$ 14.020",
          },
          spec: [
            { label: "Status", value: "≈ alinhado ao esperado" },
            { label: "Previsão", value: "~32% do cap" },
            { label: "Impressões", value: "616.032", mono: true },
          ],
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
        subtitle:
          hiveSpend <= 0 ? "Sem atividade no período" : "Consolidado em BRL",
        titleEmphasis: true,
        logoSrc: PLATFORM_LOGOS.Hivestack,
        platformKey: "Hivestack",
        spendBrl: hiveSpend,
      });
    } else if (hivestackStatus === "error") {
      secondRowPlatformCards.push({
        title: "Hivestack",
        value: "—",
        subtitle:
          data.platform_results.Hivestack?.message ?? "Falha ao carregar",
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

    const SECOND_ROW_ORDER = ["NEXD", "Hivestack", "Amazon"];
    const homeDspPlatformKpiCards = [...secondRowPlatformCards].sort(
      (a, b) => {
        const ai = SECOND_ROW_ORDER.indexOf(a.title);
        const bi = SECOND_ROW_ORDER.indexOf(b.title);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      },
    );

    const investedBaseRows = hasDashboardScopeFilters
      ? dashboardFilteredRows
      : journeyRows;
    /* Sem filtros, usa o total global vindo de checklist_info (faturado
       bruto no período, inclui tokens sem gasto). Com filtros ativos cai pro
       row-sum, que respeita os filtros mas perde a parcela sem gasto. */
    const investedRowSum = investedBaseRows.reduce(
      (sum, row) => sum + Number(row.investido ?? 0),
      0,
    );
    const investedTotal = hasDashboardScopeFilters
      ? investedRowSum
      : (data.dashboard.total_invested_brl ?? investedRowSum);

    const dspFilteredConsolidated = hasDashboardScopeFilters
      ? data.dashboard.active_platforms.reduce(
          (sum, p) => sum + (dspFiltered?.[p] ?? 0),
          0,
        )
      : data.total_brl;
    const IDEAL_TECH_COST_PCT = 12.5;
    const techCostPct =
      investedTotal > 0
        ? (dspFilteredConsolidated / investedTotal) * 100
        : null;
    const techCostLabel =
      techCostPct === null
        ? "—"
        : `${techCostPct.toFixed(2).replace(".", ",")}%`;
    const isTechCostWithinIdeal =
      techCostPct !== null && techCostPct <= IDEAL_TECH_COST_PCT;

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
      value: brl(
        hasDashboardScopeFilters ? dspFilteredConsolidated : data.total_brl,
      ),
      subtitle: hasDashboardFilters
        ? "Soma das DSPs nos filtros selecionados · Nexd, Hivestack e Amazon não entram neste total"
        : undefined,
      usdLine: hasDashboardScopeFilters
        ? undefined
        : `Câmbio: 1 USD = R$ ${data.exchange_rate_usd_brl.toLocaleString(
            "pt-BR",
            {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            },
          )}`,
      titleEmphasis: true,
      platformKey: GENERAL_BUDGET_KEY,
      spendBrl: hasDashboardScopeFilters
        ? dspFilteredConsolidated
        : data.total_brl,
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
        label:
          techCostPct === null
            ? "Sem base"
            : isTechCostWithinIdeal
              ? "Ideal"
              : "Acima",
        tone:
          techCostPct === null
            ? "neutral"
            : isTechCostWithinIdeal
              ? "success"
              : "danger",
      } as const,
      subtitle:
        techCostPct === null ? (
          "Sem investido para calcular"
        ) : (
          <div className="cardTechCostBreakdown">
            <p className="cardTechCostBreakdownLine">
              Custo:{" "}
              <strong>
                {BRL_INTEGER_FORMATTER.format(dspFilteredConsolidated)}
              </strong>
            </p>
            <p className="cardTechCostBreakdownLine">
              Investido:{" "}
              <strong>{BRL_INTEGER_FORMATTER.format(investedTotal)}</strong>
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

    const consolidatedBrlValue = hasDashboardScopeFilters
      ? dspFilteredConsolidated
      : data.total_brl;
    const consolidatedUsdValue =
      data.exchange_rate_usd_brl > 0
        ? consolidatedBrlValue / data.exchange_rate_usd_brl
        : null;
    const todayIso = new Date().toISOString().slice(0, 10);
    const heroDailySource = hasDashboardScopeFilters
      ? (data.dashboard.daily_filtered ?? data.dashboard.daily)
      : data.dashboard.daily;
    const heroDaily = (heroDailySource ?? []).map((point) => ({
      date: String(point.date),
      realized: Number(point.total ?? 0),
      target: null,
      isToday: String(point.date) === todayIso,
    }));
    const periodStartMs = Date.parse(`${periodStart}T00:00:00`);
    const periodEndMs = Date.parse(`${periodEnd}T00:00:00`);
    const heroPeriodDays =
      Number.isFinite(periodStartMs) && Number.isFinite(periodEndMs)
        ? Math.max(
            1,
            Math.round((periodEndMs - periodStartMs) / 86400000) + 1,
          )
        : undefined;

    return (
      <>
      {mode === "home" && (
      <>
        <div className="filterBar filterToolbar filterToolbarDashboard">
          <MultiSelectFilter
            id="filter-client"
            label="Cliente"
            options={clients}
            value={clientFilter}
            onChange={setClientFilter}
            placeholder="Todos"
            disabledOptions={disabledClientOptions}
            compact
          />
          <MultiSelectFilter
            id="filter-cs"
            label="CS"
            options={csFilterOptions}
            value={csFilter}
            onChange={setCsFilter}
            placeholder="Todos"
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
            placeholder="Todos"
            disabledOptions={disabledCampaignTypeOptions}
            compact
          />
          <MultiSelectFilter
            id="filter-feature"
            label="Feature"
            options={[...FEATURE_OPTIONS]}
            value={featureFilter}
            onChange={setFeatureFilter}
            placeholder="Todas"
            disabledOptions={disabledFeatureOptions}
            compact
          />
          <MultiSelectFilter
            id="filter-campaign"
            label="Campanha"
            options={campaignFilterOptions}
            value={campaignFilter}
            onChange={setCampaignFilter}
            placeholder="Todas"
            disabledOptions={disabledCampaignOptions}
            compact
          />
          <MultiSelectFilter
            id="filter-campaign-status"
            label="Status"
            options={campaignStatusOptions}
            value={campaignStatusFilter}
            onChange={setCampaignStatusFilter}
            placeholder="Todos"
            disabledOptions={disabledCampaignStatusOptions}
            compact
          />
          {hasDashboardFilters ? (
            <button
              type="button"
              className="filterClearInline"
              onClick={clearDashboardFilters}
            >
              Limpar filtros
            </button>
          ) : null}
        </div>

        <HeroSummary
          consolidatedBrl={consolidatedBrlValue}
          consolidatedUsd={consolidatedUsdValue}
          investedBrl={investedTotal}
          investedSubtitle={
            hasDashboardScopeFilters
              ? "Total investido das campanhas nos filtros selecionados"
              : "Total faturado no período (start_date do contrato)"
          }
          techCostPct={techCostPct}
          techCostTargetPct={IDEAL_TECH_COST_PCT}
          daily={heroDaily}
          monthLabel={periodHeroLabel}
          periodDays={heroPeriodDays}
        />

        <section className="platformsSection" aria-label="Plataformas">
          <header className="platformsSectionHeader">
            <h2 className="platformsSectionTitle">
              Plataformas
              <span className="platformsSectionCount" aria-hidden="true">
                · {firstRowDspCards.length + homeDspPlatformKpiCards.length}
              </span>
            </h2>
            <span className="platformsSectionHint">
              Clique para abrir o detalhe
            </span>
          </header>
          <div className="gridCards platformsGrid">
            {firstRowDspCards.map((card) => {
              const budget =
                hasDashboardFilters || !card.platformKey
                  ? undefined
                  : getBudgetForPlatform(card.platformKey, card.spendBrl ?? 0, {
                      preferDisplayedSpend: hasDashboardScopeFilters,
                    });
              return (
                <PlatformResendCard
                  key={`p1-${card.title}-${card.badge ?? "nobadge"}`}
                  title={card.title}
                  spendBrl={card.spendBrl ?? 0}
                  badge={card.badge}
                  badgeTone={card.badgeTone}
                  dimmed={card.dimmed}
                  href={card.href ?? hrefForPlatformTitle(card.title)}
                  loading={isValidating}
                  budget={
                    budget
                      ? {
                          target_brl: budget.target_brl,
                          progress_pct: budget.progress_pct,
                        }
                      : undefined
                  }
                />
              );
            })}
            {homeDspPlatformKpiCards.map((card) => {
              const budget =
                hasDashboardFilters || !card.platformKey
                  ? undefined
                  : getBudgetForPlatform(card.platformKey, card.spendBrl ?? 0, {
                      preferDisplayedSpend: hasDashboardScopeFilters,
                    });
              const capPct = card.capPct;
              const hasCap = typeof capPct === "number" && Number.isFinite(capPct);
              const capPctLabel = hasCap
                ? `${capPct.toFixed(1).replace(".", ",")}%`
                : null;
              const capStatusTone: "ok" | "warn" | "crit" = hasCap
                ? capPct >= 100
                  ? "crit"
                  : capPct >= 80
                    ? "warn"
                    : "ok"
                : "ok";
              return (
                <PlatformResendCard
                  key={`p2-${card.title}-${card.badge ?? "nobadge"}`}
                  title={card.title}
                  spendBrl={card.spendBrl ?? 0}
                  badge={card.badge}
                  badgeTone={card.badgeTone}
                  dimmed={card.dimmed}
                  href={card.href ?? hrefForPlatformTitle(card.title)}
                  loading={isValidating}
                  budget={
                    budget
                      ? {
                          target_brl: budget.target_brl,
                          progress_pct: budget.progress_pct,
                        }
                      : undefined
                  }
                  status={
                    hasCap && capPctLabel
                      ? { tone: capStatusTone, label: capPctLabel }
                      : undefined
                  }
                  metaLine={
                    card.metaLineOverride ??
                    (hasCap && capPctLabel
                      ? { label: "Cap usado", value: capPctLabel }
                      : undefined)
                  }
                  spec={card.spec}
                />
              );
            })}
          </div>
        </section>
        <section className="gridTwo gridTwoCharts gridTwoChartsHome">
          <div
            className="panel panelChart panelChartResend"
            ref={spendByPlatformChartRef}
          >
            <div className="chartBlockHeading">
              <div className="chartBlockHeadingTop">
                <h2 className="chartBlockTitle">Gasto por plataforma</h2>
                <button
                  type="button"
                  className="chartIconButton"
                  aria-label="Baixar gasto por plataforma como PNG"
                  title="Exportar PNG"
                  data-html2canvas-ignore="true"
                  onClick={() =>
                    exportChartAsPng(
                      spendByPlatformChartRef.current,
                      "Gasto por plataforma",
                      "#0f0f0f",
                    )
                  }
                >
                  <DownloadIcon />
                </button>
              </div>
              <p className="chartBlockSubtitle">Valores absolutos (R$)</p>
            </div>
            {isValidating ? (
              <div
                className="platformSkeleton skeletonChartInline"
                aria-hidden="true"
              />
            ) : !chartData.length ? (
              <p className="alertInfo">
                Nenhum gasto em DSP com os filtros selecionados.
              </p>
            ) : (
              <div
                className="chartWrap chartWrapHbars"
                role="img"
                aria-label={`Gasto por plataforma em valores absolutos (reais), período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
              >
                <ResendHbars
                  data={barChartData}
                  total={periodTotalSpend}
                  highlight={distributionHighlightPlatform}
                  onHighlight={setDistributionHighlightPlatform}
                />
              </div>
            )}
          </div>

          <div
            className="panel panelChart panelChartResend"
            ref={distributionChartRef}
          >
            <div className="chartBlockHeading">
              <div className="chartBlockHeadingTop">
                <h2 className="chartBlockTitle">Distribuição</h2>
                <button
                  type="button"
                  className="chartIconButton"
                  aria-label="Baixar distribuição de investimento como PNG"
                  title="Exportar PNG"
                  data-html2canvas-ignore="true"
                  onClick={() =>
                    exportChartAsPng(
                      distributionChartRef.current,
                      "Distribuição",
                      "#0f0f0f",
                    )
                  }
                >
                  <DownloadIcon />
                </button>
              </div>
              <p className="chartBlockSubtitle">% do total investido</p>
            </div>
            {isValidating ? (
              <div
                className="platformSkeleton skeletonChartInline"
                aria-hidden="true"
              />
            ) : !chartData.length ? (
              <p className="alertInfo">
                Nenhum gasto em DSP com os filtros selecionados.
              </p>
            ) : (
              <div
                className="chartWrap"
                role="img"
                aria-label={`Distribuição percentual do gasto por plataforma em relação ao total investido, período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
              >
                {shouldFallbackPieChart ? (
                  <div className="chartFallback">
                    <p className="chartFallbackTitle">
                      Distribuição muito concentrada para donut.
                    </p>
                    <p className="chartFallbackSubtitle">
                      Mostrando proporções em barras para leitura mais clara.
                    </p>
                    <div className="chartFallbackList">
                      {chartData.map((entry, idx) => {
                        const pct =
                          periodTotalSpend > 0
                            ? (entry.spend_brl / periodTotalSpend) * 100
                            : 0;
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
                            onMouseEnter={() =>
                              setDistributionHighlightPlatform(entry.platform)
                            }
                            onMouseLeave={() =>
                              setDistributionHighlightPlatform(null)
                            }
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
                                  backgroundColor:
                                    entry.color ??
                                    PLATFORM_COLORS[entry.platform] ??
                                    "#64748b",
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <ResendDonut
                    data={chartData}
                    total={periodTotalSpend}
                    highlight={distributionHighlightPlatform}
                    onHighlight={setDistributionHighlightPlatform}
                  />
                )}
              </div>
            )}
          </div>
        </section>

        <section
          className="panel panelChart panelChartResend panelChartResendDaily"
          ref={dailyCostChartRef}
        >
          <div className="chartBlockHeading dailyChartHeading">
            <div className="chartBlockHeadingTop">
              <h2 className="chartBlockTitle">Custo dia a dia</h2>
              <div className="dailyChartHeaderRight">
                <ul className="dailyChartLegendStrip" aria-hidden>
                  {dailyChartPlatforms.map((platform) => (
                    <li key={platform} className="dailyChartLegendStripItem">
                      <span
                        className="dailyChartLegendStripSwatch"
                        style={{
                          background:
                            RESEND_CHART_COLORS[platform] ??
                            PLATFORM_COLORS[platform] ??
                            "#A1A1A1",
                        }}
                      />
                      <span>{platform}</span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="chartIconButton"
                  aria-label="Baixar custo dia a dia como PNG"
                  title="Exportar PNG"
                  data-html2canvas-ignore="true"
                  onClick={() =>
                    exportChartAsPng(
                      dailyCostChartRef.current,
                      "Custo dia a dia",
                      "#0f0f0f",
                    )
                  }
                >
                  <DownloadIcon />
                </button>
              </div>
            </div>
            <div className="dailyChartHeaderBottom">
              <p className="chartBlockSubtitle">Evolução diária por plataforma</p>
              {dailyChartPlatforms.length ? (
                <div
                  className="dailyChartSegmented"
                  role="tablist"
                  aria-label="Filtro de plataformas"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={dailyCostFocus === null}
                    className={`dailyChartSegmentedItem${dailyCostFocus === null ? " is-active" : ""}`}
                    onClick={() => setDailyCostFocus(null)}
                  >
                    Tudo
                  </button>
                  {dailyChartPlatforms.map((platform) => (
                    <button
                      key={platform}
                      type="button"
                      role="tab"
                      aria-selected={dailyCostFocus === platform}
                      className={`dailyChartSegmentedItem${dailyCostFocus === platform ? " is-active" : ""}`}
                      onClick={() => setDailyCostFocus(platform)}
                    >
                      {platform}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          {isValidating ? (
            <div
              className="platformSkeleton skeletonChartInline skeletonChartInlineTall"
              aria-hidden="true"
            />
          ) : !dailyChartRows.length ? (
            <p className="alertInfo">
              Sem série diária disponível neste período.
            </p>
          ) : !hasDailyVariation ? (
            <p className="alertInfo">Sem variação diária neste período.</p>
          ) : (
            <div
              className="dailyChartContainer"
              role="img"
              aria-label={`Gráfico de custo diário por plataforma no período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
            >
              <ResendDailyLine
                rows={dailyChartRows}
                platforms={dailyChartPlatforms}
                focused={dailyCostFocus}
                todayIso={new Date().toISOString().slice(0, 10)}
              />
            </div>
          )}
        </section>

      </>
      )}
      {mode === "journey" && (
      <>
        <div className="filterBar filterToolbar filterToolbarDashboard">
          <MultiSelectFilter
            id="journey-filter-client"
            label="Cliente"
            options={clients}
            value={clientFilter}
            onChange={setClientFilter}
            placeholder="Todos"
            disabledOptions={disabledClientOptions}
            compact
          />
          <MultiSelectFilter
            id="journey-filter-cs"
            label="CS"
            options={csFilterOptions}
            value={csFilter}
            onChange={setCsFilter}
            placeholder="Todos"
            showAvatar
            disabledOptions={disabledCsOptions}
            compact
          />
          <MultiSelectFilter
            id="journey-filter-campaign-type"
            label="Produto"
            options={productFilterOptions}
            value={campaignTypeFilter}
            onChange={setCampaignTypeFilter}
            placeholder="Todos"
            disabledOptions={disabledCampaignTypeOptions}
            compact
          />
          <MultiSelectFilter
            id="journey-filter-feature"
            label="Feature"
            options={[...FEATURE_OPTIONS]}
            value={featureFilter}
            onChange={setFeatureFilter}
            placeholder="Todas"
            disabledOptions={disabledFeatureOptions}
            compact
          />
          <MultiSelectFilter
            id="journey-filter-campaign"
            label="Campanha"
            options={campaignFilterOptions}
            value={campaignFilter}
            onChange={setCampaignFilter}
            placeholder="Todas"
            disabledOptions={disabledCampaignOptions}
            compact
          />
          <MultiSelectFilter
            id="journey-filter-campaign-status"
            label="Status"
            options={campaignStatusOptions}
            value={campaignStatusFilter}
            onChange={setCampaignStatusFilter}
            placeholder="Todos"
            disabledOptions={disabledCampaignStatusOptions}
            compact
          />
          {hasDashboardFilters ? (
            <button
              type="button"
              className="filterClearInline"
              onClick={clearDashboardFilters}
            >
              Limpar filtros
            </button>
          ) : null}
        </div>
        <section id="jornada-campanhas" className="journeyResendCard">
          <header className="journeyResendHeader">
            <div className="journeyResendHeaderTitle">
              <h2>Campaign Journey</h2>
              <p className="journeyResendHeaderSubtitle">
                <span className="num">
                  {campaignJourneySummary.totalCount.toLocaleString("pt-BR")}
                </span>{" "}
                {campaignJourneySummary.totalCount === 1 ? "line" : "lines"}
                <span className="journeyResendSep" aria-hidden="true">
                  ·
                </span>
                <span className="num">
                  {brl(campaignJourneySummary.investedTotal)}
                </span>{" "}
                {campaignJourneySummary.totalCount === 1
                  ? "investido"
                  : "investidos"}
                <span className="journeyResendSep" aria-hidden="true">
                  ·
                </span>
                <span className="journeyResendStatActive">
                  <span className="num">
                    {campaignJourneySummary.activeCount.toLocaleString("pt-BR")}
                  </span>{" "}
                  {campaignJourneySummary.activeCount === 1 ? "ativa" : "ativas"}
                </span>
                <span className="journeyResendSep" aria-hidden="true">
                  ·
                </span>
                <span className="journeyResendStatEnded">
                  <span className="num">
                    {campaignJourneySummary.endedCount.toLocaleString("pt-BR")}
                  </span>{" "}
                  {campaignJourneySummary.endedCount === 1
                    ? "encerrada"
                    : "encerradas"}
                </span>
              </p>
            </div>
            <div className="journeyResendHeaderActions">
              <button
                type="button"
                className="journeyResendHeaderBreakdown"
                onClick={() => setIsJourneyBreakdownExpanded((prev) => !prev)}
                aria-expanded={isJourneyBreakdownExpanded}
                title={
                  isJourneyBreakdownExpanded
                    ? "Ocultar colunas de plataforma"
                    : "Mostrar uma coluna por plataforma"
                }
              >
                <ColumnsIcon />
                {isJourneyBreakdownExpanded
                  ? "Ocultar plataformas"
                  : "Detalhar plataformas"}
                <span className="num journeyResendHeaderBreakdownCount">
                  {data.dashboard.active_platforms.length.toLocaleString(
                    "pt-BR",
                  )}
                </span>
              </button>
              <button
                type="button"
                className="journeyResendHeaderIconBtn"
                onClick={handleExportCampaignJourney}
                title="Exportar CSV"
                aria-label="Exportar CSV"
              >
                <DownloadIcon />
              </button>
            </div>
          </header>
          {data.journey_status === "error" ? (
            <p className="alertError">
              Erro ao ler planilha:{" "}
              {data.journey_message ?? "erro desconhecido"}
            </p>
          ) : !sortedCampaignRows.length ? (
            <p className="alertInfo">
              Nenhum token com gasto no mês corrente encontrado nas plataformas.
            </p>
          ) : (
            <div className="stackDetailTableWrap">
              <div className="tableWrap">
                <table className="campaignJourneyTable">
                  <thead>
                    <tr>
                      <th
                        className={
                          campaignJourneySort.key === "cliente"
                            ? "stackThSorted"
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          className={campaignJourneySortButtonClass("cliente")}
                          onClick={() => toggleCampaignJourneySort("cliente")}
                        >
                          <span>Cliente</span>
                          <span className="stackSortIndicator">
                            {campaignJourneySortIndicator("cliente")}
                          </span>
                        </button>
                      </th>
                      <th
                        className={
                          campaignJourneySort.key === "campanha"
                            ? "stackThSorted"
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          className={campaignJourneySortButtonClass("campanha")}
                          onClick={() => toggleCampaignJourneySort("campanha")}
                        >
                          <span>Campanha</span>
                          <span className="stackSortIndicator">
                            {campaignJourneySortIndicator("campanha")}
                          </span>
                        </button>
                      </th>
                      <th
                        className={
                          campaignJourneySort.key === "token"
                            ? "stackThSorted"
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          className={campaignJourneySortButtonClass("token")}
                          onClick={() => toggleCampaignJourneySort("token")}
                        >
                          <span>Token</span>
                          <span className="stackSortIndicator">
                            {campaignJourneySortIndicator("token")}
                          </span>
                        </button>
                      </th>
                      <th
                        className={
                          campaignJourneySort.key === "account_management"
                            ? "stackThSorted"
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          className={campaignJourneySortButtonClass(
                            "account_management",
                          )}
                          onClick={() =>
                            toggleCampaignJourneySort("account_management")
                          }
                        >
                          <span>Account Manager</span>
                          <span className="stackSortIndicator">
                            {campaignJourneySortIndicator("account_management")}
                          </span>
                        </button>
                      </th>
                      <th
                        className={
                          campaignJourneySort.key === "status"
                            ? "stackThSorted"
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          className={campaignJourneySortButtonClass("status")}
                          onClick={() => toggleCampaignJourneySort("status")}
                        >
                          <span>Status</span>
                          <span className="stackSortIndicator">
                            {campaignJourneySortIndicator("status")}
                          </span>
                        </button>
                      </th>
                      <th
                        className={
                          campaignJourneyInvestidoSortHeaderActive
                            ? "stackThSorted stackThFinancial stackThNumeric"
                            : "stackThFinancial stackThNumeric"
                        }
                      >
                        <div
                          className="journeyInvestidoSortWrap"
                          ref={journeyInvestidoSortWrapRef}
                        >
                          <button
                            type="button"
                            className={`stackSortButton ${campaignJourneyInvestidoSortHeaderActive ? "stackSortButtonActive" : ""}`}
                            aria-expanded={journeyInvestidoSortMenuOpen}
                            aria-haspopup="dialog"
                            aria-controls={
                              journeyInvestidoSortMenuOpen
                                ? "journey-investido-sort-popover"
                                : undefined
                            }
                            onClick={() =>
                              setJourneyInvestidoSortMenuOpen((open) => !open)
                            }
                          >
                            <span>Investido</span>
                            <span className="stackSortIndicator">
                              {campaignJourneyInvestidoSortIndicator()}
                            </span>
                          </button>
                          {journeyInvestidoSortMenuOpen ? (
                            <div
                              id="journey-investido-sort-popover"
                              className="journeyInvestidoSortPopover"
                              role="dialog"
                              aria-label="Ordenar coluna Investido"
                            >
                              <p className="journeyInvestidoSortPopoverTitle">
                                Ordenar por
                              </p>
                              <button
                                type="button"
                                className="journeyInvestidoSortPopoverOption"
                                onClick={() =>
                                  selectJourneyInvestidoSortKey("investido")
                                }
                              >
                                Valor investido
                              </button>
                              <button
                                type="button"
                                className="journeyInvestidoSortPopoverOption"
                                onClick={() =>
                                  selectJourneyInvestidoSortKey("pct_investido")
                                }
                              >
                                % do budget (gasto ÷ investido)
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </th>
                      <th
                        className={
                          campaignJourneySort.key === "total_plataformas"
                            ? "stackThSorted stackThFinancial stackThNumeric"
                            : "stackThFinancial stackThNumeric"
                        }
                      >
                        <button
                          type="button"
                          className={campaignJourneySortButtonClass(
                            "total_plataformas",
                          )}
                          onClick={() =>
                            toggleCampaignJourneySort("total_plataformas")
                          }
                        >
                          <span>Total mídia</span>
                          <span className="stackSortIndicator">
                            {campaignJourneySortIndicator("total_plataformas")}
                          </span>
                        </button>
                      </th>
                      {isJourneyBreakdownExpanded
                        ? data.dashboard.active_platforms.map((platform) => (
                            <th
                              key={platform}
                              className={
                                campaignJourneySort.key ===
                                `platform:${platform}`
                                  ? "stackThSorted stackThNumeric"
                                  : "stackThNumeric"
                              }
                            >
                              <button
                                type="button"
                                className={campaignJourneySortButtonClass(
                                  `platform:${platform}`,
                                )}
                                onClick={() =>
                                  toggleCampaignJourneySort(
                                    `platform:${platform}`,
                                  )
                                }
                              >
                                <span>{platform}</span>
                                <span className="stackSortIndicator">
                                  {campaignJourneySortIndicator(
                                    `platform:${platform}`,
                                  )}
                                </span>
                              </button>
                            </th>
                          ))
                        : null}
                      <th
                        className="journeyRowActionHeader"
                        aria-label="Ação da linha"
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCampaignRows.map((row, index) => (
                      <tr
                        key={`${row.token}-${row.campanha}-${index}`}
                        className="campaignJourneyRow"
                        role="button"
                        tabIndex={0}
                        title="Clique para ver detalhes da campanha"
                        onClick={() => navigateToCampaignFromJourney(row.token)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            navigateToCampaignFromJourney(row.token);
                          }
                        }}
                      >
                        <td>{row.cliente}</td>
                        <td>{row.campanha}</td>
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
                                  const copied = await copyToClipboard(
                                    row.token,
                                    "Token",
                                  );
                                  if (copied)
                                    setCopiedFieldKey(`journey-token-${index}`);
                                })();
                              }}
                            >
                              {copiedFieldKey === `journey-token-${index}`
                                ? "✓"
                                : "⧉"}
                            </button>
                            <span title={row.token}>{row.token}</span>
                          </div>
                        </td>
                        <td>
                          {String(row.account_management ?? "").trim() ? (
                            <span className="accountManagerCell">
                              {getAccountManagerAvatar(
                                String(row.account_management),
                              ) ? (
                                <Image
                                  src={
                                    getAccountManagerAvatar(
                                      String(row.account_management),
                                    )!
                                  }
                                  alt={`Foto de ${String(row.account_management)}`}
                                  width={22}
                                  height={22}
                                  className="accountManagerAvatar"
                                />
                              ) : null}
                              <span>{String(row.account_management)}</span>
                              {hasAccountManagerWhatsApp(
                                String(row.account_management),
                              ) ? (
                                <a
                                  href={getCampaignReferenceWhatsAppUrl(
                                    String(row.account_management),
                                    {
                                      campanha: row.campanha,
                                      token: row.token,
                                    },
                                  )}
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
                        <td>
                          <span
                            className={campaignStatusBadgeClass(
                              String(row.status ?? ""),
                            )}
                          >
                            {row.status}
                          </span>
                        </td>
                        <td className="stackNumericCellRight stackNumericCellFinancial">
                          <div className="journeyInvestmentCell">
                            <span className="journeyInvestmentValue">
                              {brl(row.investido)}
                            </span>
                            <div
                              className="journeyBudgetProgress"
                              aria-hidden="true"
                            >
                              <span
                                className="journeyBudgetProgressFill"
                                style={{
                                  width: `${campaignBudgetProgressFillPct(row).toFixed(1)}%`,
                                }}
                              />
                            </div>
                            <span className="journeyBudgetPct">
                              {campaignBudgetSpentPct(row).toFixed(1)}% budget
                            </span>
                          </div>
                        </td>
                        <td className="stackNumericCellRight stackNumericCellFinancial">
                          {brl(row.total_plataformas)}
                        </td>
                        {isJourneyBreakdownExpanded
                          ? data.dashboard.active_platforms.map((platform) => (
                              <td
                                key={`${row.token}-${platform}`}
                                className="stackNumericCellRight"
                              >
                                {brl(Number(row[platform] ?? 0))}
                              </td>
                            ))
                          : null}
                        <td className="journeyRowActionCell" aria-hidden="true">
                          <span className="journeyRowActionHint">
                            Ver campanha
                          </span>
                          <span className="journeyRowActionIcon">→</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="journeyResendTableFoot">
                <span>
                  {sortedCampaignRows.length === 0
                    ? "0 linhas"
                    : `1–${sortedCampaignRows.length.toLocaleString("pt-BR")} de ${sortedCampaignRows.length.toLocaleString("pt-BR")}`}
                </span>
              </div>
            </div>
          )}
        </section>
      </>
      )}
      </>
    );
  };

  const renderPlatformPage = (
    platformName: Exclude<
      NavKey,
      | "Dashboard"
      | "Jornada de campanhas"
      | "⚠️ Lines sem token"
      | "🚨 Gasto fora do mês vigente"
    >,
  ) => {
    if (!data) return null;
    const page = data.platform_pages[platformName];
    if (!page)
      return (
        <p className="alertInfo">Sem dados desta plataforma no período.</p>
      );
    if (platformName === "Nexd") {
      const cap = page.cap ?? 1;
      const impressions = page.impressions ?? 0;
      const usedPct = Math.max(
        0,
        Math.min(100, cap > 0 ? (impressions / cap) * 100 : 0),
      );
      const remainingImpressions = Math.max(0, cap - impressions);
      const remainingPct = Math.max(0, 100 - usedPct);
      const paceVs = nexdPaceVsExpected(usedPct, periodStart, periodEnd);

      const nexdCapContextLine = `Cap: ${formatNexdCapSizePt(cap)} · ${formatNexdPeriodMonthRangeUltraPt(periodStart, periodEnd)}`;

      const nexdForecast = nexdForecastEndPeriodCapPct(
        periodStart,
        periodEnd,
        usedPct,
      );
      const nexdSignedGapPct =
        paceVs.expectedPct != null ? usedPct - paceVs.expectedPct : null;
      const forecastRounded = nexdForecast
        ? Math.round(nexdForecast.forecastPct)
        : null;
      const nexdSummaryRhythm = nexdNexdSummaryRhythmPresentation(
        usedPct,
        paceVs,
        forecastRounded,
      );
      const forecastHot = forecastRounded != null && forecastRounded > 100;
      const forecastWarm =
        forecastRounded != null && forecastRounded >= 85 && !forecastHot;
      const nexdTrendLine = nexdCapTrendBodyCoherent(
        forecastRounded,
        paceVs.vs,
      );
      const nexdForecastLeftKpi =
        nexdForecast != null && forecastRounded != null && !forecastHot
          ? {
              line: `Previsão: ~${forecastRounded}% do cap`,
              hot: false,
            }
          : null;
      const nexdShowTrendStrip = !forecastHot;
      const nexdTrendLineKpi = forecastHot ? null : nexdTrendLine;

      const pacingCtx = nexdPeriodPacingContext(periodStart, periodEnd);
      const dailyAvgImpressions =
        pacingCtx && pacingCtx.elapsedDays >= 1
          ? impressions / pacingCtx.elapsedDays
          : null;
      const todayMidnight = new Date();
      todayMidnight.setHours(0, 0, 0, 0);
      const daysToExhaustAtCurrentPace =
        dailyAvgImpressions != null &&
        dailyAvgImpressions > 0 &&
        remainingImpressions > 0
          ? Math.ceil(remainingImpressions / dailyAvgImpressions)
          : null;
      const exhaustCal =
        daysToExhaustAtCurrentPace != null
          ? new Date(
              todayMidnight.getFullYear(),
              todayMidnight.getMonth(),
              todayMidnight.getDate() + daysToExhaustAtCurrentPace,
            )
          : null;
      const periodEndD = nexdParseIsoDateLocal(periodEnd);
      const showExhaustDate =
        Boolean(
          exhaustCal &&
          periodEndD &&
          exhaustCal.getTime() <= periodEndD.getTime() &&
          usedPct < 100 &&
          impressions > 0,
        ) && exhaustCal != null;

      const nexdBarFillClassName = nexdCapBarFillClass(
        usedPct,
        forecastRounded,
      );
      const nexdBarTodayPct = Math.min(100, Math.max(0, usedPct));
      const nexdBarExpectedPct =
        paceVs.expectedPct != null
          ? Math.min(100, Math.max(0, paceVs.expectedPct))
          : null;
      const nexdBarVisualTone = nexdCapBarVisualTone(nexdBarFillClassName);

      const layoutsSorted = [...(page.layouts ?? [])].sort(
        (a, b) => b.impressions - a.impressions,
      );

      const campaignsSorted = [...(page.campaigns ?? [])].sort(
        (a, b) => b.impressions - a.impressions,
      );
      const layoutsSortedForTable = [...layoutsSorted].sort((a, b) => {
        const creativesA = Number(a.creatives ?? 0);
        const creativesB = Number(b.creatives ?? 0);
        const perCreativeA = creativesA > 0 ? a.impressions / creativesA : -1;
        const perCreativeB = creativesB > 0 ? b.impressions / creativesB : -1;
        const pctImpA =
          impressions > 0 ? (a.impressions / impressions) * 100 : 0;
        const pctImpB =
          impressions > 0 ? (b.impressions / impressions) * 100 : 0;
        const estimatedCostA = Number(a.estimated_cost_brl ?? 0);
        const estimatedCostB = Number(b.estimated_cost_brl ?? 0);

        let cmp = 0;
        if (nexdFormatSort.key === "layout") {
          cmp = a.layout.localeCompare(b.layout, "pt-BR", {
            sensitivity: "base",
          });
        } else if (nexdFormatSort.key === "pct_imp") {
          cmp = pctImpA - pctImpB;
        } else if (nexdFormatSort.key === "impressions") {
          cmp = a.impressions - b.impressions;
        } else if (nexdFormatSort.key === "creatives") {
          cmp = creativesA - creativesB;
        } else if (nexdFormatSort.key === "per_creative") {
          cmp = perCreativeA - perCreativeB;
        } else {
          cmp = estimatedCostA - estimatedCostB;
        }
        if (cmp === 0) {
          return a.layout.localeCompare(b.layout, "pt-BR", {
            sensitivity: "base",
          });
        }
        return nexdFormatSort.direction === "asc" ? cmp : -cmp;
      });
      const NEXD_CAMPAIGN_TABLE_TOP = 5;
      const tailNexdCampaigns = campaignsSorted.slice(NEXD_CAMPAIGN_TABLE_TOP);
      const othersImpCamp = tailNexdCampaigns.reduce(
        (s, c) => s + c.impressions,
        0,
      );
      const othersPctCamp =
        impressions > 0 ? (othersImpCamp / impressions) * 100 : 0;
      type NexdCampaignTableRow =
        | {
            kind: "campaign";
            row: (typeof campaignsSorted)[number];
            displayIndex: number;
          }
        | { kind: "others"; count: number; impressions: number; pct: number };
      const nexdCampaignTableRows: NexdCampaignTableRow[] = [];
      if (nexdCampaignTableShowAll) {
        campaignsSorted.forEach((row, displayIndex) => {
          nexdCampaignTableRows.push({ kind: "campaign", row, displayIndex });
        });
      } else {
        campaignsSorted
          .slice(0, NEXD_CAMPAIGN_TABLE_TOP)
          .forEach((row, displayIndex) => {
            nexdCampaignTableRows.push({ kind: "campaign", row, displayIndex });
          });
        if (tailNexdCampaigns.length > 0) {
          nexdCampaignTableRows.push({
            kind: "others",
            count: tailNexdCampaigns.length,
            impressions: othersImpCamp,
            pct: othersPctCamp,
          });
        }
      }

      return (
        <div className="nexdPlatformStack">
          <div className="nexdSummaryCapRow">
            <section
              className="dspResendHero nexdResendHero"
              aria-label={`Resumo Nexd: ${usedPct.toFixed(1).replace(".", ",")}% do cap usado, gasto ${brl(Number(page.spend_brl ?? 0))}, ${Math.round(impressions).toLocaleString("pt-BR")} impressões, ${nexdSummaryRhythm.label}`}
            >
              <header className="dspResendHeroHead">
                <div className="dspResendHeroBrand">
                  <span className="platformMono platformMono-nexd">NX</span>
                  <div>
                    <p className="dspResendHeroEyebrow">Plataforma</p>
                    <h2 className="dspResendHeroTitle">Nexd</h2>
                  </div>
                </div>
                <div className="dspResendHeroValue">
                  <span className="num">
                    {usedPct.toFixed(1).replace(".", ",")}
                  </span>
                  <span className="dspResendHeroCurrency">% usado</span>
                </div>
              </header>
              <p className="dspResendHeroBudget">
                <span
                  className={`nexdRhythmDot nexdRhythmDot--${nexdSummaryRhythm.tone}`}
                  aria-hidden="true"
                />
                {nexdSummaryRhythm.label}
                {nexdSummaryRhythm.paceHint ? (
                  <>
                    <span className="dspResendHeroBudgetSep">·</span>
                    <span>{nexdSummaryRhythm.paceHint}</span>
                  </>
                ) : null}
                {nexdForecastLeftKpi ? (
                  <>
                    <span className="dspResendHeroBudgetSep">·</span>
                    <span>{nexdForecastLeftKpi.line}</span>
                  </>
                ) : null}
              </p>
              <div className="dspResendHeroStats">
                <div className="dspResendHeroStat">
                  <span className="dspResendHeroStatLabel">Gasto</span>
                  <span className="dspResendHeroStatValue num">
                    {brl(Number(page.spend_brl ?? 0))}
                  </span>
                  <span className="dspResendHeroStatHint">
                    {page.spend_usd != null &&
                    Number.isFinite(Number(page.spend_usd))
                      ? `USD ${Number(page.spend_usd).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                      : "—"}
                  </span>
                </div>
                <div className="dspResendHeroStat">
                  <span className="dspResendHeroStatLabel">Impressões</span>
                  <span className="dspResendHeroStatValue num">
                    {Math.round(impressions).toLocaleString("pt-BR")}
                  </span>
                  <span className="dspResendHeroStatHint">
                    de {cap.toLocaleString("pt-BR")}
                  </span>
                </div>
                <div className="dspResendHeroStat">
                  <span className="dspResendHeroStatLabel">Previsão</span>
                  <span className="dspResendHeroStatValue num">
                    {forecastRounded != null ? `~${forecastRounded}%` : "—"}
                  </span>
                  <span className="dspResendHeroStatHint">
                    {forecastHot
                      ? "Acima do cap"
                      : forecastWarm
                        ? "Atenção"
                        : "Dentro do cap"}
                  </span>
                </div>
              </div>
            </section>

            <section
              className="panel nexdCapPanel nexdPanelTight"
              ref={nexdUsageChartRef}
            >
              <div className="nexdCapPanelHeading">
                <h3 className="nexdSectionTitle">Uso do pacote</h3>
                <button
                  type="button"
                  className="button buttonGhost buttonSmall chartExportButton"
                  aria-label="Exportar uso do pacote Nexd como PNG"
                  onClick={() =>
                    exportChartAsPng(
                      nexdUsageChartRef.current,
                      "nexd uso do pacote",
                    )
                  }
                >
                  <span className="buttonLabelWithIcon">
                    <DownloadIcon />
                    PNG
                  </span>
                </button>
              </div>
              <p
                className="nexdPeriodLine muted"
                title={`Período: ${formatDateBr(periodStart)} — ${formatDateBr(periodEnd)} · cap ${cap.toLocaleString("pt-BR")} impressões`}
                aria-label={`Cap ${cap.toLocaleString("pt-BR")} impressões, período de ${formatDateBr(periodStart)} a ${formatDateBr(periodEnd)}`}
              >
                {nexdCapContextLine}
              </p>

              <div
                className="nexdCapUsageBarBlock"
                role="group"
                aria-label={
                  paceVs.expectedPct != null
                    ? `Uso do cap: atual ${usedPct.toFixed(1)}%, esperado para hoje ${paceVs.expectedPct.toFixed(0)}%`
                    : `Uso do cap: ${usedPct.toFixed(1)}%`
                }
              >
                <div
                  className={`nexdCapUsageBarVisual nexdCapUsageBarVisual--${nexdBarVisualTone}`}
                >
                  <div className="nexdCapUsageBarLabelLayer" aria-hidden="true">
                    <span
                      className="nexdCapUsageBarFlyLabel nexdCapUsageBarFlyLabel--today"
                      style={nexdCapUsageBarFlyLabelStyle(nexdBarTodayPct)}
                      title={`Consumo hoje: ${usedPct.toFixed(1)}% do cap`}
                    >
                      <span className="nexdCapUsageBarFlyLabelText">Hoje</span>
                      <span className="nexdCapUsageBarFlyLabelPct">
                        {usedPct.toFixed(1).replace(".", ",")}%
                      </span>
                    </span>
                  </div>
                  <div className="nexdCapUsageBarTrack">
                    <div
                      className="nexdCapUsageBarTrackInner"
                      aria-hidden="true"
                    >
                      <div
                        className={`nexdCapUsageBarFill budgetProgressFill ${nexdBarFillClassName}`}
                        style={{
                          width: `${nexdBarTodayPct}%`,
                          transition: "width 0.35s ease",
                        }}
                      />
                    </div>
                    {nexdBarExpectedPct != null &&
                    paceVs.expectedPct != null ? (
                      <span
                        className="nexdCapUsageBarExpectedMarker"
                        style={{ left: `${nexdBarExpectedPct}%` }}
                        title={`Esperado: ${paceVs.expectedPct.toFixed(0)}%`}
                      />
                    ) : null}
                  </div>
                  {nexdBarExpectedPct != null && paceVs.expectedPct != null ? (
                    <div
                      className="nexdCapUsageBarExpectedBelowLayer"
                      aria-hidden="true"
                    >
                      <span
                        className="nexdCapUsageBarFlyLabel nexdCapUsageBarFlyLabel--expected nexdCapUsageBarFlyLabel--expectedBelow"
                        style={nexdCapUsageBarFlyLabelStyle(nexdBarExpectedPct)}
                        title={`Esperado hoje: ${paceVs.expectedPct.toFixed(0)}% do cap (ritmo linear do período)`}
                      >
                        <span className="nexdCapUsageBarFlyLabelText">
                          Esperado
                        </span>
                        <span className="nexdCapUsageBarFlyLabelPct">
                          {paceVs.expectedPct.toFixed(0).replace(".", ",")}%
                        </span>
                      </span>
                    </div>
                  ) : null}
                </div>
                <div className="nexdCapUsageBarLegend muted">
                  {paceVs.expectedPct != null ? (
                    nexdSignedGapPct != null &&
                    Math.abs(nexdSignedGapPct) >= 0.05 ? (
                      <span className="nexdCapUsageBarLegendGap">
                        {paceVs.vs === "above"
                          ? `${Math.abs(nexdSignedGapPct).toFixed(1).replace(".", ",")} pts acima do esperado`
                          : paceVs.vs === "below"
                            ? `${Math.abs(nexdSignedGapPct).toFixed(1).replace(".", ",")} pts abaixo do esperado`
                            : "Próximo do esperado para a data"}
                      </span>
                    ) : (
                      <span className="nexdCapUsageBarLegendHint">
                        Hoje e esperado muito próximos no calendário.
                      </span>
                    )
                  ) : (
                    <span>
                      Uso{" "}
                      <strong>{usedPct.toFixed(1).replace(".", ",")}%</strong>{" "}
                      do cap
                    </span>
                  )}
                </div>
              </div>

              {pacingCtx ? (
                <div
                  className="nexdCapTemporalMetrics"
                  role="group"
                  aria-label={[
                    `${pacingCtx.daysLeftInPeriod} dia${pacingCtx.daysLeftInPeriod === 1 ? "" : "s"} restantes no período`,
                    dailyAvgImpressions != null && pacingCtx.elapsedDays >= 1
                      ? `Média ${formatImpressionsCompactPt(Math.round(dailyAvgImpressions))} impressões por dia`
                      : null,
                    showExhaustDate && exhaustCal
                      ? `Projeção de esgotamento do limite em ${formatDateBr(nexdDateToIsoLocal(exhaustCal))}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <div className="nexdCapTemporalMetric">
                    <p className="nexdCapTemporalMetricLine">
                      <span className="nexdCapTemporalMetricValue">
                        {pacingCtx.daysLeftInPeriod}
                      </span>{" "}
                      <span className="nexdCapTemporalMetricRest">
                        dias restantes
                      </span>
                    </p>
                  </div>
                  {dailyAvgImpressions != null && pacingCtx.elapsedDays >= 1 ? (
                    <div className="nexdCapTemporalMetric">
                      <p className="nexdCapTemporalMetricLine nexdCapTemporalMetricLine--tight">
                        <span className="nexdCapTemporalMetricValue">
                          {formatImpressionsCompactPt(
                            Math.round(dailyAvgImpressions),
                          )}
                        </span>
                        <span className="nexdCapTemporalMetricPer">/dia</span>
                        <span className="nexdCapTemporalMetricInlineMuted">
                          {" "}
                          impressões
                        </span>
                      </p>
                    </div>
                  ) : null}
                  {showExhaustDate && exhaustCal ? (
                    <div className="nexdCapTemporalMetric">
                      <p className="nexdCapTemporalMetricLine nexdCapTemporalMetricLine--tight">
                        <span className="nexdCapTemporalMetricRest">
                          Termina em{" "}
                        </span>
                        <span className="nexdCapTemporalMetricValue">
                          {formatDateBrShort(nexdDateToIsoLocal(exhaustCal))}
                        </span>
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <details className="nexdCapMoreDetails">
                <summary className="nexdCapMoreDetailsSummary">
                  Números do pacote
                </summary>
                <div className="nexdCapMoreDetailsBody muted">
                  <p className="nexdCapMoreDetailsLine">
                    <strong>
                      {remainingPct.toFixed(1).replace(".", ",")}%
                    </strong>{" "}
                    do cap ainda livre (
                    {formatImpressionsCompactPt(remainingImpressions)} ·{" "}
                    {remainingImpressions.toLocaleString("pt-BR")} impressões)
                  </p>
                </div>
              </details>

              {nexdForecast && forecastRounded != null ? (
                <div
                  className={`nexdCapForecastSpotlight ${
                    forecastHot
                      ? "nexdCapForecastSpotlight--hot"
                      : forecastWarm
                        ? "nexdCapForecastSpotlight--warm"
                        : "nexdCapForecastSpotlight--calm"
                  }`}
                  role="status"
                  title="Projeção pelo ritmo de consumo até aqui, estendida ao último dia do período."
                  aria-label={
                    forecastHot
                      ? `Vai estourar o limite. ${nexdForecastDetailLinePt(nexdForecast.forecastPct)}`
                      : `Previsão de aproximadamente ${forecastRounded} por cento do cap consumido até o fim do período`
                  }
                >
                  {!forecastHot ? (
                    <span
                      className="nexdCapForecastSpotlightEmoji"
                      aria-hidden="true"
                    >
                      {forecastWarm ? "🟡" : "🟢"}
                    </span>
                  ) : (
                    <span
                      className="nexdCapForecastSpotlightEmoji"
                      aria-hidden="true"
                    >
                      ⚠️
                    </span>
                  )}
                  <div className="nexdCapForecastSpotlightBody">
                    <p className="nexdCapForecastSpotlightTitle">
                      {forecastHot
                        ? "Vai estourar o limite"
                        : `Previsão: ~${forecastRounded}% do cap`}
                    </p>
                    <p className="nexdCapForecastSpotlightSub muted">
                      {forecastHot
                        ? nexdForecastDetailLinePt(nexdForecast.forecastPct)
                        : "até o fim do período se mantiver o ritmo"}
                    </p>
                  </div>
                </div>
              ) : null}

              {nexdShowTrendStrip ? (
                <p className="nexdPaceTrend nexdPaceTrend--strip">
                  <span className="nexdPaceTrendLead">Tendência:</span>{" "}
                  <span className="nexdPaceTrendBody">{nexdTrendLine}</span>
                </p>
              ) : null}
            </section>
          </div>

          <section className="panel nexdPanelCard nexdPanelTight">
            <h3 className="nexdSectionTitle">Por campanha</h3>
            <div className="tableWrap nexdTableWrap">
              <table className="nexdCampaignTable">
                <colgroup>
                  <col className="nexdCampaignColName" />
                  <col className="nexdCampaignColDist" />
                  <col className="nexdCampaignColImp" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Campanha</th>
                    <th>Distribuição</th>
                    <th className="nexdThNumeric">Impressões</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignsSorted.length ? (
                    nexdCampaignTableRows.map((entry) => {
                      if (entry.kind === "others") {
                        const pct = entry.pct;
                        return (
                          <tr
                            key="__nexd_others_campaigns__"
                            className="nexdCampaignRow nexdCampaignRowOthers"
                          >
                            <td
                              className="nexdCampaignNameCell nexdCampaignOthersName"
                              title="Soma das demais campanhas"
                            >
                              Outras campanhas
                              <span className="nexdCampaignOthersCount muted">
                                {" "}
                                ({entry.count})
                              </span>
                            </td>
                            <td className="nexdInlineBarCell">
                              <div className="nexdInlineBarContent">
                                <div
                                  className="nexdInlineBarTrack nexdInlineBarTrack--muted"
                                  aria-hidden="true"
                                >
                                  <div
                                    className="nexdInlineBarFill nexdInlineBarFill--muted"
                                    style={{ width: `${Math.min(100, pct)}%` }}
                                  />
                                </div>
                                <span className="nexdInlineBarPct nexdInlineBarPct--muted">
                                  {pct.toFixed(1)}%
                                </span>
                              </div>
                            </td>
                            <td className="nexdTdNumeric nexdTdNumericSecondary">
                              {entry.impressions.toLocaleString("pt-BR")}
                            </td>
                          </tr>
                        );
                      }
                      const { row, displayIndex } = entry;
                      const pct =
                        impressions > 0
                          ? (row.impressions / impressions) * 100
                          : 0;
                      const isDominant =
                        displayIndex === 0 && row.impressions > 0;
                      return (
                        <tr
                          key={row.name}
                          className={
                            isDominant
                              ? "nexdCampaignRow nexdCampaignRowDominant"
                              : "nexdCampaignRow"
                          }
                        >
                          <td className="nexdCampaignNameCell" title={row.name}>
                            {isDominant ? (
                              <span
                                className="nexdCampaignDominantBadge"
                                aria-label="Campanha dominante"
                              >
                                Dominante
                              </span>
                            ) : null}
                            <span className="nexdCampaignNameText">
                              {truncateChars(row.name, isDominant ? 36 : 42)}
                            </span>
                          </td>
                          <td className="nexdInlineBarCell">
                            <div className="nexdInlineBarContent">
                              <div
                                className={`nexdInlineBarTrack${isDominant ? " nexdInlineBarTrack--lead" : " nexdInlineBarTrack--muted"}`}
                                aria-hidden="true"
                              >
                                <div
                                  className={`nexdInlineBarFill${isDominant ? "" : " nexdInlineBarFill--muted"}`}
                                  style={{ width: `${Math.min(100, pct)}%` }}
                                />
                              </div>
                              <span
                                className={`nexdInlineBarPct${isDominant ? " nexdInlineBarPct--lead" : " nexdInlineBarPct--muted"}`}
                              >
                                {pct.toFixed(1)}%
                              </span>
                            </div>
                          </td>
                          <td className="nexdTdNumeric nexdTdNumericSecondary">
                            {row.impressions.toLocaleString("pt-BR")}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={3} className="nexdTableEmptyCell">
                        Nenhuma campanha retornada para o período.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {campaignsSorted.length > NEXD_CAMPAIGN_TABLE_TOP ? (
              <div className="nexdCampaignTableActions">
                {nexdCampaignTableShowAll ? (
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall"
                    onClick={() => setNexdCampaignTableShowAll(false)}
                  >
                    Ver só as {NEXD_CAMPAIGN_TABLE_TOP} principais
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall"
                    onClick={() => setNexdCampaignTableShowAll(true)}
                  >
                    Ver todas ({campaignsSorted.length})
                  </button>
                )}
              </div>
            ) : null}
          </section>

          {(page.layouts ?? []).length ? (
            <section className="panel nexdPanelCard nexdPanelTight">
              <h3 className="nexdSectionTitle">Por formato</h3>
              <p className="nexdSectionHint muted">
                Distribuição de impressões e custo por formato no período.
              </p>

              <div className="tableWrap nexdTableWrap nexdFormatTableWrap">
                <table>
                  <thead>
                    <tr>
                      <th
                        className={
                          nexdFormatSort.key === "layout" ? "stackThSorted" : ""
                        }
                      >
                        <button
                          type="button"
                          className={nexdFormatSortButtonClass("layout")}
                          onClick={() => toggleNexdFormatSort("layout")}
                        >
                          <span>Formato</span>
                          <span className="stackSortIndicator">
                            {nexdFormatSortIndicator("layout")}
                          </span>
                        </button>
                      </th>
                      <th
                        className={`nexdThNumeric stackThNumeric ${nexdFormatSort.key === "pct_imp" ? "stackThSorted" : ""}`}
                      >
                        <button
                          type="button"
                          className={nexdFormatSortButtonClass("pct_imp")}
                          onClick={() => toggleNexdFormatSort("pct_imp")}
                        >
                          <span>% impressões</span>
                          <span className="stackSortIndicator">
                            {nexdFormatSortIndicator("pct_imp")}
                          </span>
                        </button>
                      </th>
                      <th
                        className={`nexdThNumeric stackThNumeric ${nexdFormatSort.key === "impressions" ? "stackThSorted" : ""}`}
                      >
                        <button
                          type="button"
                          className={nexdFormatSortButtonClass("impressions")}
                          onClick={() => toggleNexdFormatSort("impressions")}
                        >
                          <span>Impressões</span>
                          <span className="stackSortIndicator">
                            {nexdFormatSortIndicator("impressions")}
                          </span>
                        </button>
                      </th>
                      <th
                        className={`nexdThNumeric stackThNumeric ${nexdFormatSort.key === "creatives" ? "stackThSorted" : ""}`}
                      >
                        <button
                          type="button"
                          className={nexdFormatSortButtonClass("creatives")}
                          onClick={() => toggleNexdFormatSort("creatives")}
                        >
                          <span>Criativos</span>
                          <span className="stackSortIndicator">
                            {nexdFormatSortIndicator("creatives")}
                          </span>
                        </button>
                      </th>
                      <th
                        className={`nexdThNumeric stackThNumeric ${nexdFormatSort.key === "per_creative" ? "stackThSorted" : ""}`}
                      >
                        <button
                          type="button"
                          className={nexdFormatSortButtonClass("per_creative")}
                          onClick={() => toggleNexdFormatSort("per_creative")}
                        >
                          <span>Imp. / criativo</span>
                          <span className="stackSortIndicator">
                            {nexdFormatSortIndicator("per_creative")}
                          </span>
                        </button>
                      </th>
                      <th
                        className={`nexdThNumeric stackThNumeric ${nexdFormatSort.key === "estimated_cost_brl" ? "stackThSorted" : ""}`}
                      >
                        <button
                          type="button"
                          className={nexdFormatSortButtonClass(
                            "estimated_cost_brl",
                          )}
                          onClick={() =>
                            toggleNexdFormatSort("estimated_cost_brl")
                          }
                        >
                          <span>Custo est. (BRL)</span>
                          <span className="stackSortIndicator">
                            {nexdFormatSortIndicator("estimated_cost_brl")}
                          </span>
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {layoutsSortedForTable.map((row) => {
                      const creatives = Number(row.creatives ?? 0);
                      const perCreative =
                        creatives > 0
                          ? Math.round(row.impressions / creatives)
                          : null;
                      const pctImp =
                        impressions > 0
                          ? (row.impressions / impressions) * 100
                          : 0;
                      return (
                        <tr key={row.layout}>
                          <td>{row.layout}</td>
                          <td className="nexdTdNumeric">
                            {pctImp.toFixed(1)}%
                          </td>
                          <td className="nexdTdNumeric">
                            {row.impressions.toLocaleString("pt-BR")}
                          </td>
                          <td className="nexdTdNumeric">
                            {creatives.toLocaleString("pt-BR")}
                          </td>
                          <td className="nexdTdNumeric">
                            {perCreative != null
                              ? perCreative.toLocaleString("pt-BR")
                              : "—"}
                          </td>
                          <td className="nexdTdNumeric">
                            {brl(Number(row.estimated_cost_brl ?? 0))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      );
    }

    const rows = page.rows ?? [];
    const showDv360LineItemId = platformName === "DV360";
    const renderTokenValue = (token: string | null | undefined) => {
      if (hasCampaignToken(token)) return token;
      return (
        <span title="Sem token" aria-label="Sem token">
          —
        </span>
      );
    };
    const isDetailedLinePlatform = ["StackAdapt", "DV360", "Xandr"].includes(
      platformName,
    );
    if (isDetailedLinePlatform) {
      const rowsForPlatform =
        platformName === resolvedActivePage
          ? filteredDetailedPlatformRows
          : rows;
      const {
        rowsWithToken,
        rowsWithoutToken,
        activeCampaignsCount,
        sortedRows,
        filteredTotalGasto,
      } = detailedPlatformDerived;
      const lineDetailFiltersActive =
        hasDashboardScopeFilters ||
        hasDashboardFilters ||
        stackAdaptSearch.trim() !== "" ||
        dspLinesOnlyWithoutToken;
      const budget = getBudgetForPlatform(platformName, page.spend_brl);
      const handleExportDetailedLines = () => {
        const headers = [
          "Line",
          ...(showDv360LineItemId
            ? [
                "Line item ID (DV360)",
                "Anunciante (DV360)",
                "Inserção (IO) ID",
                "Campanha (ID API)",
                "Status (API)",
              ]
            : []),
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
          ...(showDv360LineItemId
            ? [
                row.line_item_id ?? "",
                row.dv360_advertiser_id ?? "",
                row.dv360_insertion_order_id ?? "",
                row.dv360_campaign_id ?? "",
                row.dv360_entity_status ?? "",
              ]
            : []),
          row.token,
          row.cliente,
          row.campanha,
          row.gasto,
          row.investido,
          row.pct_invest,
          filteredTotalGasto > 0 ? (row.gasto / filteredTotalGasto) * 100 : 0,
          row.account_management,
        ]);
        downloadCsv(
          `lines-${platformName.toLowerCase().replace(/\s+/g, "-")}.csv`,
          headers,
          rowsToExport,
        );
      };

      const dv360Scope = page.dv360_context;

      {
        const linesActive = rowsForPlatform.length;
        const totalSpend = lineDetailFiltersActive
          ? filteredTotalGasto
          : page.spend_brl;
        const lineNoun = sortedRows.length === 1 ? "line" : "lines";
        const monoCode =
          platformName === "DV360"
            ? "DV"
            : platformName === "Xandr"
              ? "X"
              : "SA";
        const monoToneClass =
          platformName === "DV360"
            ? "platformMono-dv360"
            : platformName === "Xandr"
              ? "platformMono-xandr"
              : "platformMono-stack";
        const platformIdSlug = platformName.toLowerCase();
        const PAGE_SIZE = 20;
        const totalRows = sortedRows.length;
        const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
        const currentPage = Math.min(Math.max(1, dspLinesPage), totalPages);
        const pageStart = (currentPage - 1) * PAGE_SIZE;
        const pageEnd = Math.min(pageStart + PAGE_SIZE, totalRows);
        const pagedRows = sortedRows.slice(pageStart, pageEnd);
        return (
          <>
            <div className="filterBar filterToolbar filterToolbarDashboard">
              <MultiSelectFilter
                id={`${platformIdSlug}-filter-client`}
                label="Cliente"
                options={clients}
                value={clientFilter}
                onChange={setClientFilter}
                placeholder="Todos"
                disabledOptions={disabledClientOptions}
                compact
              />
              <MultiSelectFilter
                id={`${platformIdSlug}-filter-cs`}
                label="CS"
                options={csFilterOptions}
                value={csFilter}
                onChange={setCsFilter}
                placeholder="Todos"
                showAvatar
                disabledOptions={disabledCsOptions}
                compact
              />
              <MultiSelectFilter
                id={`${platformIdSlug}-filter-campaign-type`}
                label="Produto"
                options={productFilterOptions}
                value={campaignTypeFilter}
                onChange={setCampaignTypeFilter}
                placeholder="Todos"
                disabledOptions={disabledCampaignTypeOptions}
                compact
              />
              <MultiSelectFilter
                id={`${platformIdSlug}-filter-feature`}
                label="Feature"
                options={[...FEATURE_OPTIONS]}
                value={featureFilter}
                onChange={setFeatureFilter}
                placeholder="Todas"
                disabledOptions={disabledFeatureOptions}
                compact
              />
              <MultiSelectFilter
                id={`${platformIdSlug}-filter-campaign`}
                label="Campanha"
                options={campaignFilterOptions}
                value={campaignFilter}
                onChange={setCampaignFilter}
                placeholder="Todas"
                disabledOptions={disabledCampaignOptions}
                compact
              />
              <MultiSelectFilter
                id={`${platformIdSlug}-filter-campaign-status`}
                label="Status"
                options={campaignStatusOptions}
                value={campaignStatusFilter}
                onChange={setCampaignStatusFilter}
                placeholder="Todos"
                disabledOptions={disabledCampaignStatusOptions}
                compact
              />
              {hasDashboardFilters ? (
                <button
                  type="button"
                  className="filterClearInline"
                  onClick={clearDashboardFilters}
                >
                  Limpar filtros
                </button>
              ) : null}
            </div>

            <section className="dspResendHero">
              <header className="dspResendHeroHead">
                <div className="dspResendHeroBrand">
                  <span className={`platformMono ${monoToneClass}`}>
                    {monoCode}
                  </span>
                  <div>
                    <p className="dspResendHeroEyebrow">Plataforma</p>
                    <h2 className="dspResendHeroTitle">{platformName}</h2>
                  </div>
                </div>
                <div className="dspResendHeroValue">
                  <span className="dspResendHeroCurrency">R$</span>
                  <span className="num">
                    {totalSpend.toLocaleString("pt-BR", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
              </header>
              {budget &&
              budget.target_brl != null &&
              budget.progress_pct != null ? (
                <p className="dspResendHeroBudget">
                  Meta do mês{" "}
                  <span className="num">{brl(budget.target_brl)}</span>
                  <span className="dspResendHeroBudgetSep">·</span>
                  <span className="num">
                    {budget.progress_pct.toFixed(1).replace(".", ",")}%
                  </span>{" "}
                  realizado
                </p>
              ) : null}
              <div className="dspResendHeroStats">
                <div className="dspResendHeroStat">
                  <span className="dspResendHeroStatLabel">Lines ativas</span>
                  <span className="dspResendHeroStatValue num">
                    {linesActive.toLocaleString("pt-BR")}
                  </span>
                  <span className="dspResendHeroStatHint">
                    {rowsWithToken.toLocaleString("pt-BR")} com token
                  </span>
                </div>
                <button
                  type="button"
                  className={`dspResendHeroStat dspResendHeroStatToggle${
                    rowsWithoutToken > 0 ? " is-alert" : ""
                  }${dspLinesOnlyWithoutToken ? " is-active" : ""}`}
                  aria-pressed={dspLinesOnlyWithoutToken}
                  onClick={() =>
                    setDspLinesOnlyWithoutToken((prev) => !prev)
                  }
                  title="Filtrar tabela: só lines sem token"
                >
                  <span className="dspResendHeroStatLabel">Sem token</span>
                  <span className="dspResendHeroStatValue num">
                    {rowsWithoutToken.toLocaleString("pt-BR")}
                  </span>
                  <span className="dspResendHeroStatHint">
                    {rowsWithoutToken > 0
                      ? "Clique para filtrar"
                      : "Tudo identificado"}
                  </span>
                </button>
                <div className="dspResendHeroStat">
                  <span className="dspResendHeroStatLabel">
                    Campanhas ativas
                  </span>
                  <span className="dspResendHeroStatValue num">
                    {activeCampaignsCount.toLocaleString("pt-BR")}
                  </span>
                  <span className="dspResendHeroStatHint">
                    Com gasto no período
                  </span>
                </div>
              </div>
            </section>

            {!rows.length ? (
              <DspLinesNoDataEmptyState />
            ) : (
              <section
                id={`${platformIdSlug}-lines`}
                className="journeyResendCard dspResendLinesCard"
              >
                <header className="journeyResendHeader">
                  <div className="journeyResendHeaderTitle">
                    <h2>Lines</h2>
                    <p className="journeyResendHeaderSubtitle">
                      <span className="num">
                        {sortedRows.length.toLocaleString("pt-BR")}
                      </span>{" "}
                      {lineNoun}
                      <span
                        className="journeyResendSep"
                        aria-hidden="true"
                      >
                        ·
                      </span>
                      <span className="num">{brl(filteredTotalGasto)}</span>{" "}
                      no período
                    </p>
                  </div>
                  <div className="journeyResendHeaderActions">
                    <div className="dspResendSearch">
                      <SearchIcon />
                      <input
                        type="search"
                        value={stackAdaptSearch}
                        onChange={(event) =>
                          setStackAdaptSearch(event.target.value)
                        }
                        placeholder="Buscar line, token ou cliente"
                        aria-label={`Buscar lines da ${platformName}`}
                      />
                    </div>
                    <button
                      type="button"
                      className="journeyResendHeaderIconBtn"
                      onClick={handleExportDetailedLines}
                      title="Exportar CSV"
                      aria-label="Exportar CSV"
                    >
                      <DownloadIcon />
                    </button>
                  </div>
                </header>
                {sortedRows.length > 0 ? (
                  <div className="tableWrap">
                    <table className="campaignJourneyTable dspResendLinesTable">
                      <thead>
                        <tr>
                          <th
                            className={
                              stackAdaptSort.key === "line"
                                ? "stackThSorted"
                                : undefined
                            }
                          >
                            <button
                              type="button"
                              className={stackSortButtonClass("line")}
                              onClick={() => toggleStackAdaptSort("line")}
                            >
                              <span>Line</span>
                              <span className="stackSortIndicator">
                                {stackSortIndicator("line")}
                              </span>
                            </button>
                          </th>
                          <th
                            className={
                              stackAdaptSort.key === "token"
                                ? "stackThSorted"
                                : undefined
                            }
                          >
                            <button
                              type="button"
                              className={stackSortButtonClass("token")}
                              onClick={() => toggleStackAdaptSort("token")}
                            >
                              <span>Token</span>
                              <span className="stackSortIndicator">
                                {stackSortIndicator("token")}
                              </span>
                            </button>
                          </th>
                          <th
                            className={
                              stackAdaptSort.key === "cliente"
                                ? "stackThSorted"
                                : undefined
                            }
                          >
                            <button
                              type="button"
                              className={stackSortButtonClass("cliente")}
                              onClick={() => toggleStackAdaptSort("cliente")}
                            >
                              <span>Cliente</span>
                              <span className="stackSortIndicator">
                                {stackSortIndicator("cliente")}
                              </span>
                            </button>
                          </th>
                          <th
                            className={
                              stackAdaptSort.key === "campanha"
                                ? "stackThSorted"
                                : undefined
                            }
                          >
                            <button
                              type="button"
                              className={stackSortButtonClass("campanha")}
                              onClick={() =>
                                toggleStackAdaptSort("campanha")
                              }
                            >
                              <span>Campanha</span>
                              <span className="stackSortIndicator">
                                {stackSortIndicator("campanha")}
                              </span>
                            </button>
                          </th>
                          <th>Account Manager</th>
                          <th
                            className={
                              stackAdaptSort.key === "investido"
                                ? "stackThSorted stackThFinancial stackThNumeric"
                                : "stackThFinancial stackThNumeric"
                            }
                          >
                            <button
                              type="button"
                              className={stackSortButtonClass("investido")}
                              onClick={() =>
                                toggleStackAdaptSort("investido")
                              }
                            >
                              <span>Investido</span>
                              <span className="stackSortIndicator">
                                {stackSortIndicator("investido")}
                              </span>
                            </button>
                          </th>
                          <th
                            className={
                              stackAdaptSort.key === "gasto"
                                ? "stackThSorted stackThFinancial stackThNumeric"
                                : "stackThFinancial stackThNumeric"
                            }
                          >
                            <button
                              type="button"
                              className={stackSortButtonClass("gasto")}
                              onClick={() => toggleStackAdaptSort("gasto")}
                            >
                              <span>Gasto</span>
                              <span className="stackSortIndicator">
                                {stackSortIndicator("gasto")}
                              </span>
                            </button>
                          </th>
                          <th
                            className={
                              stackAdaptSort.key === "pct_invest"
                                ? "stackThSorted stackThNumeric"
                                : "stackThNumeric"
                            }
                          >
                            <button
                              type="button"
                              className={stackSortButtonClass("pct_invest")}
                              onClick={() =>
                                toggleStackAdaptSort("pct_invest")
                              }
                            >
                              <span>% budget</span>
                              <span className="stackSortIndicator">
                                {stackSortIndicator("pct_invest")}
                              </span>
                            </button>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedRows.map((row, idx) => {
                          const index = pageStart + idx;
                          const tokenOk = hasCampaignToken(row.token);
                          const pctFill = Math.max(
                            0,
                            Math.min(100, Number(row.pct_invest ?? 0)),
                          );
                          return (
                            <tr
                              key={`${row.line}-${row.token}-${row.cliente}-${row.campanha}-${index}`}
                              className={
                                tokenOk
                                  ? "campaignJourneyRow"
                                  : "campaignJourneyRow campaignJourneyRowMuted"
                              }
                              role={tokenOk ? "button" : undefined}
                              tabIndex={tokenOk ? 0 : undefined}
                              onClick={() => {
                                if (!tokenOk) return;
                                router.push(
                                  routeForCampaign(
                                    row.token,
                                    resolvedActivePage,
                                  ),
                                );
                              }}
                              onKeyDown={(event) => {
                                if (!tokenOk) return;
                                if (
                                  event.key === "Enter" ||
                                  event.key === " "
                                ) {
                                  event.preventDefault();
                                  router.push(
                                    routeForCampaign(
                                      row.token,
                                      resolvedActivePage,
                                    ),
                                  );
                                }
                              }}
                            >
                              <td className="dspResendLineCell">
                                <div
                                  className="dspResendLineCellInner"
                                  title={row.line}
                                >
                                  <span className="dspResendLineText">
                                    {row.line}
                                  </span>
                                  <button
                                    type="button"
                                    className="copyIconButton dspResendLineCopy"
                                    title="Copiar nome da line"
                                    aria-label={`Copiar line ${row.line}`}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void (async () => {
                                        const copied = await copyToClipboard(
                                          row.line,
                                          "Line",
                                        );
                                        if (copied)
                                          setCopiedFieldKey(
                                            `stack-line-${index}`,
                                          );
                                      })();
                                    }}
                                  >
                                    {copiedFieldKey === `stack-line-${index}`
                                      ? "✓"
                                      : "⧉"}
                                  </button>
                                </div>
                              </td>
                              <td className="stackTokenCell">
                                {tokenOk ? (
                                  <div className="copyCell">
                                    <button
                                      type="button"
                                      className="copyIconButton"
                                      title="Copiar token"
                                      aria-label={`Copiar token ${row.token}`}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void (async () => {
                                          const copied = await copyToClipboard(
                                            row.token,
                                            "Token",
                                          );
                                          if (copied)
                                            setCopiedFieldKey(
                                              `stack-token-${index}`,
                                            );
                                        })();
                                      }}
                                    >
                                      {copiedFieldKey ===
                                      `stack-token-${index}`
                                        ? "✓"
                                        : "⧉"}
                                    </button>
                                    <span title={row.token}>{row.token}</span>
                                  </div>
                                ) : (
                                  <span
                                    className="dspResendNoToken"
                                    title="Sem token identificado"
                                  >
                                    Sem token
                                  </span>
                                )}
                              </td>
                              <td className="dspResendTruncCell">
                                <span title={row.cliente}>
                                  {row.cliente || "—"}
                                </span>
                              </td>
                              <td className="dspResendTruncCell">
                                <span title={row.campanha}>
                                  {row.campanha || "—"}
                                </span>
                              </td>
                              <td>
                                {row.account_management &&
                                row.account_management !== "—" ? (
                                  <span className="accountManagerCell">
                                    {getAccountManagerAvatar(
                                      row.account_management,
                                    ) ? (
                                      <Image
                                        src={
                                          getAccountManagerAvatar(
                                            row.account_management,
                                          )!
                                        }
                                        alt={`Foto de ${row.account_management}`}
                                        width={22}
                                        height={22}
                                        className="accountManagerAvatar"
                                      />
                                    ) : null}
                                    <span>{row.account_management}</span>
                                  </span>
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td className="stackNumericCellRight stackNumericCellFinancial">
                                <div className="journeyInvestmentCell">
                                  <span className="journeyInvestmentValue">
                                    {row.investido ? brl(row.investido) : "—"}
                                  </span>
                                  {row.investido ? (
                                    <>
                                      <div
                                        className="journeyBudgetProgress"
                                        aria-hidden="true"
                                      >
                                        <span
                                          className="journeyBudgetProgressFill"
                                          style={{ width: `${pctFill}%` }}
                                        />
                                      </div>
                                      <span className="journeyBudgetPct">
                                        {row.pct_invest != null
                                          ? `${row.pct_invest.toFixed(1).replace(".", ",")}% budget`
                                          : ""}
                                      </span>
                                    </>
                                  ) : null}
                                </div>
                              </td>
                              <td className="stackNumericCellRight stackNumericCellFinancial">
                                {brl(row.gasto)}
                              </td>
                              <td className="stackNumericCellRight">
                                {filteredTotalGasto > 0
                                  ? `${((row.gasto / filteredTotalGasto) * 100).toFixed(1).replace(".", ",")}%`
                                  : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="tableWrap tableWrapDspEmpty">
                    <DspLinesFilteredEmptyState
                      onClearFilters={clearDspLineTableFilters}
                    />
                  </div>
                )}
                {totalRows > 0 ? (
                  <div className="journeyResendTableFoot">
                    <span>
                      {`${(pageStart + 1).toLocaleString("pt-BR")}–${pageEnd.toLocaleString("pt-BR")} de ${totalRows.toLocaleString("pt-BR")}`}
                    </span>
                    <div className="dspResendPager">
                      <button
                        type="button"
                        className="dspResendPagerBtn"
                        onClick={() =>
                          setDspLinesPage((prev) => Math.max(1, prev - 1))
                        }
                        disabled={currentPage <= 1}
                      >
                        Anterior
                      </button>
                      <span className="dspResendPagerPage num">
                        {currentPage}/{totalPages}
                      </span>
                      <button
                        type="button"
                        className="dspResendPagerBtn dspResendPagerBtnPrimary"
                        onClick={() =>
                          setDspLinesPage((prev) =>
                            Math.min(totalPages, prev + 1),
                          )
                        }
                        disabled={currentPage >= totalPages}
                      >
                        Próxima
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>
            )}
          </>
        );
      }
    }

    const simpleDspTableRows = dspLinesOnlyWithoutToken
      ? rows.filter((row) => !hasCampaignToken(row.token))
      : rows;
    const handleExportSimpleDspRows = () => {
      const headers = [
        "Line",
        "Token",
        "Cliente",
        "Campanha",
        "Gasto",
        "Investido",
        "% do budget investido",
        "Account Management",
      ];
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
      downloadCsv(
        `lines-${platformName.toLowerCase().replace(/\s+/g, "-")}.csv`,
        headers,
        rowsToExport,
      );
    };

    return (
      <section className="panel">
        <h2>{platformName}</h2>
        <p className="muted">
          {brl(page.spend_brl)}
          {page.currency === "USD"
            ? ` • USD ${(page.spend_usd ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
            : ""}
        </p>
        {!rows.length ? (
          <DspLinesNoDataEmptyState />
        ) : (
          <>
            <div className="tableTopActions">
              <button
                type="button"
                className="button buttonGhost buttonSmall"
                onClick={handleExportSimpleDspRows}
              >
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
                  onChange={(event) =>
                    setDspLinesOnlyWithoutToken(event.target.checked)
                  }
                />
                Só lines sem token
              </label>
            </div>
            {!simpleDspTableRows.length ? (
              <div className="tableWrap tableWrapDspEmpty">
                <DspLinesFilteredEmptyState
                  onClearFilters={clearDspLineTableFilters}
                />
              </div>
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
                      <th className="stackThNumeric stackThFinancial">
                        Investido
                      </th>
                      <th className="stackThNumeric">% budget</th>
                      <th>Account Management</th>
                    </tr>
                  </thead>
                  <tbody>
                    {simpleDspTableRows.map((row, index) => (
                      <tr
                        key={`${row.line}-${row.token}-${row.cliente}-${row.campanha}-${index}`}
                        className={
                          hasCampaignToken(row.token)
                            ? "campaignJourneyRow"
                            : "missingTokenRow"
                        }
                        role={
                          hasCampaignToken(row.token) ? "button" : undefined
                        }
                        tabIndex={hasCampaignToken(row.token) ? 0 : undefined}
                        onClick={() => {
                          if (!hasCampaignToken(row.token)) return;
                          router.push(
                            routeForCampaign(row.token, resolvedActivePage),
                          );
                        }}
                        onKeyDown={(event) => {
                          if (!hasCampaignToken(row.token)) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            router.push(
                              routeForCampaign(row.token, resolvedActivePage),
                            );
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
                        <td className="stackNumericCellRight stackNumericCellFinancial">
                          {brl(row.gasto)}
                        </td>
                        <td className="stackNumericCellRight stackNumericCellFinancial">
                          {row.investido ? brl(row.investido) : "—"}
                        </td>
                        <td className="stackNumericCellRight">
                          {row.pct_invest !== null
                            ? `${row.pct_invest.toFixed(1)}%`
                            : "—"}
                        </td>
                        <td className="stackAccountManagerCell">
                          {row.account_management &&
                          row.account_management !== "—" ? (
                            <span className="accountManagerCell">
                              {getAccountManagerAvatar(
                                row.account_management,
                              ) ? (
                                <Image
                                  src={
                                    getAccountManagerAvatar(
                                      row.account_management,
                                    )!
                                  }
                                  alt={`Foto de ${row.account_management}`}
                                  width={22}
                                  height={22}
                                  className="accountManagerAvatar"
                                />
                              ) : null}
                              <span className="accountManagerName">
                                {row.account_management}
                              </span>
                              {hasAccountManagerWhatsApp(
                                row.account_management,
                              ) ? (
                                <a
                                  href={getCampaignReferenceWhatsAppUrl(
                                    row.account_management,
                                    {
                                      campanha: row.campanha,
                                      token: row.token,
                                      platform: platformName,
                                      line: row.line,
                                    },
                                  )}
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
      const headers = [
        "Plataforma",
        "Line",
        "Line item ID (DV360)",
        "Anunciante (DV360)",
        "Inserção (IO) ID",
        "Campanha (ID API)",
        "Status (API)",
        "Partner ID",
        "Gasto (BRL)",
        "Observação",
      ];
      const rowsToExport = sortedNoTokenRows.map((row) => [
        row.platform,
        row.line,
        row.line_item_id ?? "",
        row.dv360_advertiser_id ?? "",
        row.dv360_insertion_order_id ?? "",
        row.dv360_campaign_id ?? "",
        row.dv360_entity_status ?? "",
        row.dv360_partner_id ?? "",
        row.gasto,
        row.observation ?? "",
      ]);
      downloadCsv("lines-sem-token.csv", headers, rowsToExport);
    };

    const NO_TOKEN_PAGE_SIZE = 20;
    const noTokenTotalRows = sortedNoTokenRows.length;
    const noTokenTotalPages = Math.max(
      1,
      Math.ceil(noTokenTotalRows / NO_TOKEN_PAGE_SIZE),
    );
    const noTokenCurrentPage = Math.min(
      Math.max(1, dspLinesPage),
      noTokenTotalPages,
    );
    const noTokenPageStart = (noTokenCurrentPage - 1) * NO_TOKEN_PAGE_SIZE;
    const noTokenPageEnd = Math.min(
      noTokenPageStart + NO_TOKEN_PAGE_SIZE,
      noTokenTotalRows,
    );
    const noTokenPagedRows = sortedNoTokenRows.slice(
      noTokenPageStart,
      noTokenPageEnd,
    );

    return (
      <>
        <section
          className="dspResendHero dspResendHero--warning"
          aria-label="Resumo lines sem token"
        >
          <header className="dspResendHeroHead">
            <div className="dspResendHeroBrand">
              <span className="alertMono alertMono--warning" aria-hidden="true">
                ⚠
              </span>
              <div>
                <p className="dspResendHeroEyebrow">Atenção necessária</p>
                <h2 className="dspResendHeroTitle">Lines sem token</h2>
              </div>
            </div>
            <div className="dspResendHeroValue">
              <span className="dspResendHeroCurrency">R$</span>
              <span className="num">
                {data.attention.no_token_total_brl.toLocaleString("pt-BR", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
          </header>
          <p className="dspResendHeroBudget">
            Gasto sem cruzamento com a planilha — não pode ser auditado por
            campanha
          </p>
          <div className="dspResendHeroStats">
            <div className="dspResendHeroStat">
              <span className="dspResendHeroStatLabel">Total de lines</span>
              <span className="dspResendHeroStatValue num">
                {noTokenRows.length.toLocaleString("pt-BR")}
              </span>
              <span className="dspResendHeroStatHint">
                Sem token identificado
              </span>
            </div>
            <div className="dspResendHeroStat">
              <span className="dspResendHeroStatLabel">DSPs afetadas</span>
              <span className="dspResendHeroStatValue num">
                {noTokenUniquePlatforms.length.toLocaleString("pt-BR")}
              </span>
              <span className="dspResendHeroStatHint">
                Plataformas com lines órfãs
              </span>
            </div>
            <div className="dspResendHeroStat">
              <span className="dspResendHeroStatLabel">Filtrado</span>
              <span className="dspResendHeroStatValue num">
                {brl(filteredNoTokenTotal)}
              </span>
              <span className="dspResendHeroStatHint">
                {sortedNoTokenRows.length.toLocaleString("pt-BR")} linha(s)
              </span>
            </div>
          </div>
        </section>

        <section className="dspResendChartCard">
          <header className="dspResendChartCardHead">
            <div>
              <h3>Gasto por DSP</h3>
              <p>Distribuição do gasto sem token</p>
            </div>
            <button
              type="button"
              className="journeyResendHeaderIconBtn"
              title="Exportar PNG"
              aria-label="Exportar gráfico como PNG"
              onClick={() =>
                exportChartAsPng(
                  noTokenDistributionChartRef.current,
                  "gasto sem token por dsp",
                )
              }
            >
              <DownloadIcon />
            </button>
          </header>
          <div
            className="chartWrap"
            ref={noTokenDistributionChartRef}
            role="img"
            aria-label={`Gráfico de distribuição de gasto sem token no período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
          >
            {noTokenPieChartData.length ? (
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={noTokenPieChartData}
                    dataKey="spend_brl"
                    nameKey="platform"
                    innerRadius={55}
                    outerRadius={92}
                    paddingAngle={2}
                    stroke="rgba(15, 15, 15, 0.9)"
                    strokeWidth={2}
                  >
                    {noTokenPieChartData.map((entry) => (
                      <Cell key={entry.platform} fill={entry.color} />
                    ))}
                  </Pie>
                  <Legend
                    content={<PlatformLegend />}
                    verticalAlign="bottom"
                    align="center"
                  />
                  <Tooltip
                    content={<NumberTooltip totalValue={noTokenPieTotal} />}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="alertInfo attentionNoTokenPieEmpty">
                Nenhum gasto por plataforma para exibir.
              </p>
            )}
          </div>
        </section>

        <section
          id="lines-sem-token"
          className="journeyResendCard dspResendLinesCard"
        >
          <header className="journeyResendHeader">
            <div className="journeyResendHeaderTitle">
              <h2>Lines</h2>
              <p className="journeyResendHeaderSubtitle">
                <span className="num">
                  {sortedNoTokenRows.length.toLocaleString("pt-BR")}
                </span>{" "}
                {sortedNoTokenRows.length === 1 ? "linha" : "linhas"}
                <span className="journeyResendSep" aria-hidden="true">
                  ·
                </span>
                <span className="num">{brl(filteredNoTokenTotal)}</span> no
                filtro
              </p>
            </div>
            <div className="journeyResendHeaderActions">
              <div className="dspResendSearch">
                <SearchIcon />
                <input
                  type="search"
                  value={attentionNoTokenSearch}
                  onChange={(event) =>
                    setAttentionNoTokenSearch(event.target.value)
                  }
                  placeholder="Buscar plataforma, line, ID DV360"
                  aria-label="Buscar lines sem token"
                />
              </div>
              <button
                type="button"
                className="journeyResendHeaderIconBtn"
                onClick={handleExportNoToken}
                title="Exportar CSV"
                aria-label="Exportar CSV"
              >
                <DownloadIcon />
              </button>
            </div>
          </header>
          {noTokenRows.length > 0 && noTokenUniquePlatforms.length > 0 ? (
            <div className="dspResendChipBar" role="group" aria-label="Filtrar por DSP">
              <span className="dspResendChipBarLabel">DSPs</span>
              <button
                type="button"
                className={`dspResendChip${attentionNoTokenDspFilters.length === 0 ? " is-active" : ""}`}
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
                      if (prev.includes(platform))
                        return prev.filter((p) => p !== platform);
                      return [...prev, platform];
                    });
                  }}
                />
              ))}
            </div>
          ) : null}
          {noTokenRows.length ? (
              <>
                <p className="stackDetailCounter">
                  {sortedNoTokenRows.length.toLocaleString("pt-BR")} linha(s)
                  encontrada(s) • Total filtrado: {brl(filteredNoTokenTotal)}
                </p>
                {data.platform_pages?.DV360?.dv360_context ? (
                  <p className="attentionDv360ScopeHint">
                    Linhas DV360: no site, use o Partner{" "}
                    <strong>
                      {data.platform_pages.DV360.dv360_context.partner_id ??
                        "—"}
                    </strong>{" "}
                    e o anunciante da coluna abaixo; a inserção (IO) agrupa a
                    line.
                  </p>
                ) : null}
                <div className="tableWrap">
                  <table className="attentionDetailTable">
                    <thead>
                      <tr>
                        <th
                          className="attentionObsIconTh"
                          aria-label="Indicador de observação"
                        />
                        <th>
                          <button
                            type="button"
                            className="stackSortButton"
                            onClick={() =>
                              toggleAttentionNoTokenSort("platform")
                            }
                          >
                            <span>Plataforma</span>
                            <span>
                              {attentionNoTokenSortIndicator("platform")}
                            </span>
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
                        <th
                          className="attentionThLineItemId"
                          title="Só preenchido no DV360; é o ID numérico do line item, útil se o nome exibido for só o ID"
                        >
                          Line item ID
                        </th>
                        <th className="attentionThDv360Meta">Anunciante</th>
                        <th className="attentionThDv360Meta">Inserção (IO)</th>
                        <th className="attentionThDv360Meta">Campanha (ID)</th>
                        <th className="attentionThDv360Meta">Status</th>
                        <th>
                          <button
                            type="button"
                            className="stackSortButton"
                            onClick={() => toggleAttentionNoTokenSort("gasto")}
                          >
                            <span>Gasto</span>
                            <span>
                              {attentionNoTokenSortIndicator("gasto")}
                            </span>
                          </button>
                        </th>
                        <th
                          className="attentionRowActionsTh"
                          aria-label="Ações"
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {noTokenPagedRows.map((row, idx) => {
                        const index = noTokenPageStart + idx;
                        const obsTrim = (row.observation ?? "").trim();
                        const rowActionKey = `${row.platform}-${row.line}-${row.line_item_id ?? ""}-${index}`;
                        return (
                        <tr
                          key={rowActionKey}
                          className={`attentionNoTokenDataRow${obsTrim ? " attentionNoTokenDataRow--hasObs" : ""}`}
                          onMouseEnter={(event) => {
                            if (!obsTrim) return;
                            showNoTokenRowTooltipFromRect(
                              obsTrim,
                              event.currentTarget.getBoundingClientRect(),
                            );
                          }}
                          onMouseLeave={scheduleHideNoTokenRowTooltip}
                        >
                          <td className="attentionObsIconCell">
                            {obsTrim ? (
                                <span
                                  className="attentionObsIconWrap"
                                  aria-hidden={true}
                                >
                                  <svg
                                    className="attentionObsMiniIcon"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden={true}
                                  >
                                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                                  </svg>
                                </span>
                            ) : null}
                          </td>
                          <td>{row.platform}</td>
                          <td>{row.line}</td>
                          <td className="attentionLineItemIdCell">
                            {row.line_item_id &&
                            String(row.line_item_id).trim() !== ""
                              ? String(row.line_item_id).trim()
                              : "—"}
                          </td>
                          <td className="attentionDv360MetaCell">
                            {row.platform === "DV360" &&
                            row.dv360_advertiser_id &&
                            String(row.dv360_advertiser_id).trim() !== "" ? (
                              <a
                                href={dv360AdvertiserRootUrl(
                                  String(row.dv360_advertiser_id),
                                )}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="dv360ExternalLink"
                              >
                                {row.dv360_advertiser_id}
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="attentionDv360MetaCell">
                            {row.platform === "DV360" &&
                            row.dv360_insertion_order_id &&
                            String(row.dv360_insertion_order_id).trim() !== ""
                              ? String(row.dv360_insertion_order_id).trim()
                              : "—"}
                          </td>
                          <td className="attentionDv360MetaCell">
                            {row.platform === "DV360" &&
                            row.dv360_campaign_id &&
                            String(row.dv360_campaign_id).trim() !== ""
                              ? String(row.dv360_campaign_id).trim()
                              : "—"}
                          </td>
                          <td className="attentionDv360MetaCell">
                            {row.platform === "DV360" &&
                            row.dv360_entity_status &&
                            String(row.dv360_entity_status).trim() !== ""
                              ? String(row.dv360_entity_status).trim()
                              : "—"}
                          </td>
                          <td className="attentionGastoCell">
                            {brl(row.gasto)}
                          </td>
                          <td className="attentionRowActionsCell">
                            <div className="attentionRowActionsMenuWrap">
                              <button
                                type="button"
                                className="attentionRowKebabButton"
                                title="Ações"
                                aria-label="Abrir ações desta line"
                                aria-haspopup="menu"
                                aria-expanded={noTokenActionMenuKey === rowActionKey}
                                onClick={() => {
                                  cancelHideNoTokenRowTooltip();
                                  setNoTokenRowTooltip(null);
                                  setNoTokenActionMenuKey((current) =>
                                    current === rowActionKey ? null : rowActionKey,
                                  );
                                }}
                              >
                                ...
                              </button>
                              {noTokenActionMenuKey === rowActionKey ? (
                                <div
                                  className="attentionRowActionsPopover"
                                  role="menu"
                                  aria-label="Ações da line sem token"
                                >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setNoTokenActionMenuKey(null);
                                      setNoTokenNameModalRow(row);
                                      setNoTokenNameModalText(row.line ?? "");
                                    }}
                                  >
                                    Editar nome da line
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setNoTokenActionMenuKey(null);
                                      setNoTokenObsModalRow(row);
                                      setNoTokenObsModalText(
                                        (row.observation ?? "").trim(),
                                      );
                                    }}
                                  >
                                    {(row.observation ?? "").trim()
                                      ? "Editar observação"
                                      : "Adicionar observação"}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!sortedNoTokenRows.length ? (
                  <p className="alertInfo">
                    Nenhuma line sem token encontrada para a busca informada.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="alertSuccess">
                Todas as lines têm token identificado.
              </p>
            )}
          {noTokenTotalRows > 0 ? (
            <div className="journeyResendTableFoot">
              <span>
                {`${(noTokenPageStart + 1).toLocaleString("pt-BR")}–${noTokenPageEnd.toLocaleString("pt-BR")} de ${noTokenTotalRows.toLocaleString("pt-BR")}`}
              </span>
              <div className="dspResendPager">
                <button
                  type="button"
                  className="dspResendPagerBtn"
                  onClick={() =>
                    setDspLinesPage((prev) => Math.max(1, prev - 1))
                  }
                  disabled={noTokenCurrentPage <= 1}
                >
                  Anterior
                </button>
                <span className="dspResendPagerPage num">
                  {noTokenCurrentPage}/{noTokenTotalPages}
                </span>
                <button
                  type="button"
                  className="dspResendPagerBtn dspResendPagerBtnPrimary"
                  onClick={() =>
                    setDspLinesPage((prev) =>
                      Math.min(noTokenTotalPages, prev + 1),
                    )
                  }
                  disabled={noTokenCurrentPage >= noTokenTotalPages}
                >
                  Próxima
                </button>
              </div>
            </div>
          ) : null}
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

    const OUT_PAGE_SIZE = 20;
    const outTotalRows = sortedOutRows.length;
    const outTotalPages = Math.max(1, Math.ceil(outTotalRows / OUT_PAGE_SIZE));
    const outCurrentPage = Math.min(Math.max(1, dspLinesPage), outTotalPages);
    const outPageStart = (outCurrentPage - 1) * OUT_PAGE_SIZE;
    const outPageEnd = Math.min(outPageStart + OUT_PAGE_SIZE, outTotalRows);
    const outPagedRows = sortedOutRows.slice(outPageStart, outPageEnd);
    const outUniquePlatformCount = outOfPeriodUniquePlatforms.length;

    return (
      <>
        <section
          className="dspResendHero dspResendHero--danger"
          aria-label="Resumo gasto fora do mês vigente"
        >
          <header className="dspResendHeroHead">
            <div className="dspResendHeroBrand">
              <span className="alertMono alertMono--danger" aria-hidden="true">
                ⚠
              </span>
              <div>
                <p className="dspResendHeroEyebrow">Risco de vigência</p>
                <h2 className="dspResendHeroTitle">
                  Gasto fora do mês vigente
                </h2>
              </div>
            </div>
            <div className="dspResendHeroValue">
              <span className="dspResendHeroCurrency">R$</span>
              <span className="num">
                {data.attention.out_of_period_total_brl.toLocaleString(
                  "pt-BR",
                  {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  },
                )}
              </span>
            </div>
          </header>
          <p className="dspResendHeroBudget">
            Campanhas cujas datas não cobrem o período atual — investigar antes
            do fechamento
          </p>
          <div className="dspResendHeroStats">
            <div className="dspResendHeroStat">
              <span className="dspResendHeroStatLabel">Total de campanhas</span>
              <span className="dspResendHeroStatValue num">
                {outOfPeriodRows.length.toLocaleString("pt-BR")}
              </span>
              <span className="dspResendHeroStatHint">
                Fora do período vigente
              </span>
            </div>
            <div className="dspResendHeroStat">
              <span className="dspResendHeroStatLabel">DSPs afetadas</span>
              <span className="dspResendHeroStatValue num">
                {outUniquePlatformCount.toLocaleString("pt-BR")}
              </span>
              <span className="dspResendHeroStatHint">
                Plataformas com vigência fora
              </span>
            </div>
            <div className="dspResendHeroStat">
              <span className="dspResendHeroStatLabel">Filtrado</span>
              <span className="dspResendHeroStatValue num">
                {brl(filteredOutRowsTotal)}
              </span>
              <span className="dspResendHeroStatHint">
                {sortedOutRows.length.toLocaleString("pt-BR")} campanha(s)
              </span>
            </div>
          </div>
        </section>

        <section className="dspResendChartCard">
          <header className="dspResendChartCardHead">
            <div>
              <h3>Gasto por DSP</h3>
              <p>Distribuição do gasto fora do mês vigente</p>
            </div>
            <div className="dspResendChartCardActions">
              <button
                type="button"
                className="journeyResendHeaderIconBtn"
                title="Copiar como CSV"
                aria-label="Copiar gasto por DSP como CSV"
                onClick={() =>
                  copyObjectsAsCsv(
                    "gasto fora do mês por dsp",
                    outOfPeriodPieChartData.map((entry) => ({
                      plataforma: entry.platform,
                      gasto_brl: entry.spend_brl.toFixed(2),
                      pct_total:
                        outOfPeriodPieTotal > 0
                          ? (
                              (entry.spend_brl / outOfPeriodPieTotal) *
                              100
                            ).toFixed(2)
                          : "0.00",
                    })),
                  )
                }
              >
                <DownloadIcon />
              </button>
            </div>
          </header>
            <div
              className="chartWrap"
              ref={outOfPeriodDistributionChartRef}
              role="img"
              aria-label={`Gráfico de distribuição de gasto fora do mês vigente no período ${formatDateBr(data.period.start)} a ${formatDateBr(data.period.end)}`}
            >
              {outOfPeriodPieChartData.length ? (
                shouldFallbackOutOfPeriodPieChart ? (
                  <div className="chartFallback">
                    <div className="chartFallbackList">
                      {outOfPeriodPieChartData.map((entry, idx) => {
                        const pct =
                          outOfPeriodPieTotal > 0
                            ? (entry.spend_brl / outOfPeriodPieTotal) * 100
                            : 0;
                        const isDominant = idx === 0;
                        const isHi =
                          outOfPeriodDistributionHighlightPlatform !== null &&
                          outOfPeriodDistributionHighlightPlatform ===
                            entry.platform;
                        const dim =
                          outOfPeriodDistributionHighlightPlatform !== null &&
                          outOfPeriodDistributionHighlightPlatform !==
                            entry.platform;
                        return (
                          <div
                            key={entry.platform}
                            className={`chartFallbackItem${isDominant ? " chartFallbackItemDominant" : ""}${isHi ? " chartFallbackItemHighlight" : ""}`}
                            onMouseEnter={() =>
                              setOutOfPeriodDistributionHighlightPlatform(
                                entry.platform,
                              )
                            }
                            onMouseLeave={() =>
                              setOutOfPeriodDistributionHighlightPlatform(null)
                            }
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
                                  backgroundColor:
                                    entry.color ??
                                    PLATFORM_COLORS[entry.platform] ??
                                    "#64748b",
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
                            data={outOfPeriodPieChartData}
                            dataKey="spend_brl"
                            nameKey="platform"
                            innerRadius={66}
                            outerRadius={102}
                            paddingAngle={2}
                            stroke="rgba(28, 38, 47, 0.9)"
                            strokeWidth={2}
                            label={false}
                            onMouseEnter={(_entry, index) => {
                              const row = outOfPeriodPieChartData[index];
                              if (row?.platform)
                                setOutOfPeriodDistributionHighlightPlatform(
                                  row.platform,
                                );
                            }}
                            onMouseLeave={() =>
                              setOutOfPeriodDistributionHighlightPlatform(null)
                            }
                          >
                            {outOfPeriodPieChartData.map((entry) => {
                              const fill =
                                entry.color ??
                                PLATFORM_COLORS[entry.platform] ??
                                "#64748b";
                              const dim =
                                outOfPeriodDistributionHighlightPlatform !==
                                  null &&
                                outOfPeriodDistributionHighlightPlatform !==
                                  entry.platform;
                              return (
                                <Cell
                                  key={entry.platform}
                                  fill={fill}
                                  fillOpacity={dim ? 0.3 : 1}
                                  stroke={
                                    dim
                                      ? "rgba(28, 38, 47, 0.35)"
                                      : "rgba(28, 38, 47, 0.9)"
                                  }
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
                            {formatDonutCenterValue(outOfPeriodPieTotal)}
                          </text>
                          <Tooltip
                            content={
                              <NumberTooltip totalValue={outOfPeriodPieTotal} />
                            }
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <aside
                      className="chartDistributionPctList"
                      aria-label="Percentual por plataforma"
                    >
                      {outOfPeriodPieChartData.map((entry, idx) => {
                        const pct =
                          outOfPeriodPieTotal > 0
                            ? (entry.spend_brl / outOfPeriodPieTotal) * 100
                            : 0;
                        const isDominant = idx === 0;
                        const isHi =
                          outOfPeriodDistributionHighlightPlatform !== null &&
                          outOfPeriodDistributionHighlightPlatform ===
                            entry.platform;
                        const dim =
                          outOfPeriodDistributionHighlightPlatform !== null &&
                          outOfPeriodDistributionHighlightPlatform !==
                            entry.platform;
                        const fill =
                          entry.color ??
                          PLATFORM_COLORS[entry.platform] ??
                          "#64748b";
                        return (
                          <div
                            key={entry.platform}
                            className={`chartDistributionPctRow${isDominant ? " chartDistributionPctRowDominant" : ""}${isHi ? " chartDistributionPctRowHighlight" : ""}`}
                            onMouseEnter={() =>
                              setOutOfPeriodDistributionHighlightPlatform(
                                entry.platform,
                              )
                            }
                            onMouseLeave={() =>
                              setOutOfPeriodDistributionHighlightPlatform(null)
                            }
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
                            <span className="chartDistributionPctValue">
                              {pct.toFixed(1)}%
                            </span>
                          </div>
                        );
                      })}
                    </aside>
                  </div>
                )
              ) : (
                <p className="alertInfo attentionNoTokenPieEmpty">
                  Nenhum gasto por plataforma para exibir.
                </p>
              )}
            </div>
        </section>

        <div className="filterBar filterToolbar filterToolbarDashboard">
          <MultiSelectFilter
            id="out-filter-client"
            label="Cliente"
            options={clients}
            value={clientFilter}
            onChange={setClientFilter}
            placeholder="Todos"
            disabledOptions={disabledClientOptions}
            compact
          />
          <MultiSelectFilter
            id="out-filter-cs"
            label="CS"
            options={csFilterOptions}
            value={csFilter}
            onChange={setCsFilter}
            placeholder="Todos"
            showAvatar
            disabledOptions={disabledCsOptions}
            compact
          />
          <MultiSelectFilter
            id="out-filter-campaign-type"
            label="Produto"
            options={productFilterOptions}
            value={campaignTypeFilter}
            onChange={setCampaignTypeFilter}
            placeholder="Todos"
            disabledOptions={disabledCampaignTypeOptions}
            compact
          />
          <MultiSelectFilter
            id="out-filter-feature"
            label="Feature"
            options={[...FEATURE_OPTIONS]}
            value={featureFilter}
            onChange={setFeatureFilter}
            placeholder="Todas"
            disabledOptions={disabledFeatureOptions}
            compact
          />
          <MultiSelectFilter
            id="out-filter-campaign"
            label="Campanha"
            options={campaignFilterOptions}
            value={campaignFilter}
            onChange={setCampaignFilter}
            placeholder="Todas"
            disabledOptions={disabledCampaignOptions}
            compact
          />
          <MultiSelectFilter
            id="out-filter-campaign-status"
            label="Status"
            options={campaignStatusOptions}
            value={campaignStatusFilter}
            onChange={setCampaignStatusFilter}
            placeholder="Todos"
            disabledOptions={disabledCampaignStatusOptions}
            compact
          />
          {hasDashboardFilters ? (
            <button
              type="button"
              className="filterClearInline"
              onClick={clearDashboardFilters}
            >
              Limpar filtros
            </button>
          ) : null}
        </div>

        <section
          id="gasto-fora-mes"
          className="journeyResendCard dspResendLinesCard"
        >
          <header className="journeyResendHeader">
            <div className="journeyResendHeaderTitle">
              <h2>Campanhas</h2>
              <p className="journeyResendHeaderSubtitle">
                <span className="num">
                  {sortedOutRows.length.toLocaleString("pt-BR")}
                </span>{" "}
                {sortedOutRows.length === 1 ? "campanha" : "campanhas"}
                <span className="journeyResendSep" aria-hidden="true">
                  ·
                </span>
                <span className="num">{brl(filteredOutRowsTotal)}</span> no
                filtro
              </p>
            </div>
            <div className="journeyResendHeaderActions">
              <div className="dspResendSearch">
                <SearchIcon />
                <input
                  type="search"
                  value={attentionOutOfPeriodSearch}
                  onChange={(event) =>
                    setAttentionOutOfPeriodSearch(event.target.value)
                  }
                  placeholder="Buscar token, cliente, campanha"
                  aria-label="Buscar gastos fora do mês vigente"
                />
              </div>
              <button
                type="button"
                className="journeyResendHeaderIconBtn"
                onClick={handleExportOutOfPeriod}
                title="Exportar CSV"
                aria-label="Exportar CSV"
              >
                <DownloadIcon />
              </button>
            </div>
          </header>
          {outRows.length > 0 && outOfPeriodUniquePlatforms.length > 0 ? (
            <div
              className="dspResendChipBar"
              role="group"
              aria-label="Filtrar por DSP"
            >
              <span className="dspResendChipBarLabel">DSPs</span>
              <button
                type="button"
                className={`dspResendChip${attentionOutOfPeriodDspFilters.length === 0 ? " is-active" : ""}`}
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
                      if (prev.includes(platform))
                        return prev.filter((p) => p !== platform);
                      return [...prev, platform];
                    });
                  }}
                />
              ))}
            </div>
          ) : null}
            {outRows.length ? (
              <>
                <p className="stackDetailCounter">
                  {sortedOutRows.length.toLocaleString("pt-BR")} campanha(s)
                  encontrada(s) • Total filtrado: {brl(filteredOutRowsTotal)}
                </p>
                <div className="tableWrap">
                  <table className="attentionDetailTable">
                    <thead>
                      <tr>
                        <th>
                          <button
                            type="button"
                            className="stackSortButton"
                            onClick={() =>
                              toggleAttentionOutOfPeriodSort("platform")
                            }
                          >
                            <span>Plataforma</span>
                            <span>
                              {attentionOutOfPeriodSortIndicator("platform")}
                            </span>
                          </button>
                        </th>
                        <th>
                          <button
                            type="button"
                            className="stackSortButton"
                            onClick={() =>
                              toggleAttentionOutOfPeriodSort("token")
                            }
                          >
                            <span>Token</span>
                            <span>
                              {attentionOutOfPeriodSortIndicator("token")}
                            </span>
                          </button>
                        </th>
                        <th>
                          <button
                            type="button"
                            className="stackSortButton"
                            onClick={() =>
                              toggleAttentionOutOfPeriodSort("cliente")
                            }
                          >
                            <span>Cliente</span>
                            <span>
                              {attentionOutOfPeriodSortIndicator("cliente")}
                            </span>
                          </button>
                        </th>
                        <th>
                          <button
                            type="button"
                            className="stackSortButton"
                            onClick={() =>
                              toggleAttentionOutOfPeriodSort("campanha")
                            }
                          >
                            <span>Campanha</span>
                            <span>
                              {attentionOutOfPeriodSortIndicator("campanha")}
                            </span>
                          </button>
                        </th>
                        <th>
                          <button
                            type="button"
                            className="stackSortButton"
                            onClick={() =>
                              toggleAttentionOutOfPeriodSort(
                                "account_management",
                              )
                            }
                          >
                            <span>Account Management</span>
                            <span>
                              {attentionOutOfPeriodSortIndicator(
                                "account_management",
                              )}
                            </span>
                          </button>
                        </th>
                        <th>
                          <button
                            type="button"
                            className="stackSortButton"
                            onClick={() =>
                              toggleAttentionOutOfPeriodSort("vigencia")
                            }
                          >
                            <span>Vigência</span>
                            <span>
                              {attentionOutOfPeriodSortIndicator("vigencia")}
                            </span>
                          </button>
                        </th>
                        <th>
                          <button
                            type="button"
                            className="stackSortButton"
                            onClick={() =>
                              toggleAttentionOutOfPeriodSort("gasto")
                            }
                          >
                            <span>Gasto</span>
                            <span>
                              {attentionOutOfPeriodSortIndicator("gasto")}
                            </span>
                          </button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {outPagedRows.map((row, idx) => {
                        const index = outPageStart + idx;
                        return (
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
                                {getAccountManagerAvatar(
                                  row.account_management,
                                ) ? (
                                  <Image
                                    src={
                                      getAccountManagerAvatar(
                                        row.account_management,
                                      )!
                                    }
                                    alt={`Foto de ${row.account_management}`}
                                    width={22}
                                    height={22}
                                    className="accountManagerAvatar"
                                  />
                                ) : null}
                                <span>{row.account_management}</span>
                                {hasAccountManagerWhatsApp(
                                  row.account_management,
                                ) ? (
                                  <a
                                    href={getAccountManagerWhatsAppUrl(
                                      row.account_management,
                                      {
                                        campanha: row.campanha,
                                        token: row.token,
                                        platform: row.platform,
                                        vigencia_start: row.vigencia_start,
                                        vigencia_end: row.vigencia_end,
                                      },
                                    )}
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
                            {formatDateBr(row.vigencia_start)} {"→"}{" "}
                            {formatDateBr(row.vigencia_end)}
                          </td>
                          <td>{brl(row.gasto)}</td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!sortedOutRows.length ? (
                  <p className="alertInfo">
                    Nenhuma campanha fora do mês vigente encontrada para a busca
                    informada.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="alertSuccess">
                Nenhum gasto em campanhas fora do mês vigente.
              </p>
            )}
          {outTotalRows > 0 ? (
            <div className="journeyResendTableFoot">
              <span>
                {`${(outPageStart + 1).toLocaleString("pt-BR")}–${outPageEnd.toLocaleString("pt-BR")} de ${outTotalRows.toLocaleString("pt-BR")}`}
              </span>
              <div className="dspResendPager">
                <button
                  type="button"
                  className="dspResendPagerBtn"
                  onClick={() =>
                    setDspLinesPage((prev) => Math.max(1, prev - 1))
                  }
                  disabled={outCurrentPage <= 1}
                >
                  Anterior
                </button>
                <span className="dspResendPagerPage num">
                  {outCurrentPage}/{outTotalPages}
                </span>
                <button
                  type="button"
                  className="dspResendPagerBtn dspResendPagerBtnPrimary"
                  onClick={() =>
                    setDspLinesPage((prev) =>
                      Math.min(outTotalPages, prev + 1),
                    )
                  }
                  disabled={outCurrentPage >= outTotalPages}
                >
                  Próxima
                </button>
              </div>
            </div>
          ) : null}
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
          <section className="sidebarGroup" aria-label="Campanhas">
            <p className="sidebarGroupTitle">Campanhas</p>
            <div id="sidebar-dsps-items" className="sidebarGroupItems">
              {navOptions
                .filter(
                  (option) =>
                    option !== "⚠️ Lines sem token" &&
                    option !== "🚨 Gasto fora do mês vigente",
                )
                .map((option) => {
                  const letter = NAV_LETTERS[option];
                  return (
                    <button
                      key={option}
                      className={`navButton ${resolvedActivePage === option ? "navButtonActive" : ""}`}
                      onClick={() =>
                        router.push(appendQueryToRoute(routeForPage(option)))
                      }
                    >
                      <span className="brandIcon" aria-hidden="true">
                        {option === "Dashboard" ? (
                          <StackedIcon />
                        ) : option === "Jornada de campanhas" ? (
                          <svg
                            className="brandIconSvg"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <line x1="5" y1="4" x2="13" y2="4" />
                            <line x1="5" y1="8" x2="13" y2="8" />
                            <line x1="5" y1="12" x2="13" y2="12" />
                            <circle cx="3" cy="4" r="0.6" fill="currentColor" />
                            <circle cx="3" cy="8" r="0.6" fill="currentColor" />
                            <circle cx="3" cy="12" r="0.6" fill="currentColor" />
                          </svg>
                        ) : letter ? (
                          letter
                        ) : null}
                      </span>
                      <span>{NAV_LABELS[option]}</span>
                    </button>
                  );
                })}
            </div>
          </section>
          <section className="sidebarGroup" aria-label="Atenção">
            <p className="sidebarGroupTitle">Atenção</p>
            <div className="sidebarGroupItems">
              <button
                type="button"
                className={`navButton ${resolvedActivePage === "⚠️ Lines sem token" ? "navButtonActive" : ""}`}
                onClick={() => router.push("/lines-sem-token")}
              >
                <svg
                  className="ico ico-warn"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
                  <path className="icoShape" d="M7 1.4 13.4 12.6H.6L7 1.4Z" />
                  <path className="icoMark" d="M7 5.6v3" />
                  <circle className="icoMarkDot" cx="7" cy="10.6" r="0.7" />
                </svg>
                <span>Lines sem token</span>
                <span className="navBadge">
                  {homeNoTokenAlertCount.toLocaleString("pt-BR")}
                </span>
              </button>
              <button
                type="button"
                className={`navButton ${resolvedActivePage === "🚨 Gasto fora do mês vigente" ? "navButtonActive" : ""}`}
                onClick={() => router.push("/gasto-fora-mes-vigente")}
              >
                <svg
                  className="ico ico-danger"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
                  <circle className="icoShape" cx="7" cy="7" r="5.8" />
                  <path className="icoMark" d="M7 4v3.2" />
                  <circle className="icoMarkDot" cx="7" cy="9.6" r="0.7" />
                </svg>
                <span>Gasto fora do mês</span>
                <span className="navBadge">
                  {homeOutOfPeriodAlertCount.toLocaleString("pt-BR")}
                </span>
              </button>
            </div>
          </section>
          {VISIBLE_TOOL_TABS.length > 0 ? (
            <section className="sidebarGroup" aria-label="Ferramentas">
              <p className="sidebarGroupTitle">Ferramentas</p>
              <div className="sidebarGroupItems">
                {VISIBLE_TOOL_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`navButton ${resolvedActivePage === tab.key ? "navButtonActive" : ""}`}
                    onClick={() => router.push(`/${tab.slug}`)}
                  >
                    <tab.Icon />
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </nav>
        <div className="sidebarSyncFooter" data-tooltip="Sincronizado de hora em hora">
          <span className="sidebarSyncDot sidebarSyncDotok" aria-hidden="true" />
          <span className="sidebarSyncText">Sincronizado de hora em hora</span>
        </div>
      </aside>

      <section className={`content ${isPeriodStale ? "contentLoading" : ""}`}>
        <div className="topbar">
          <div className="topbarLeft">
            <h1 className="topbarTitle">{periodHeroLabel}</h1>
            <div className="topbarSubtitle">
              <span className="num">{formatDateBrShort(periodStart)}</span>
              <span aria-hidden="true">→</span>
              <span className="num">{formatDateBrShort(periodEnd)}</span>
              {data?.exchange_rate_usd_brl ? (
                <>
                  <span className="topbarSep" aria-hidden="true">
                    ·
                  </span>
                  <span className="statusPill statusInfo">
                    <span className="statusDot" aria-hidden="true" />
                    <span>
                      Câmbio 1 USD = R${" "}
                      <span className="num">
                        {data.exchange_rate_usd_brl.toLocaleString("pt-BR", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </span>
                  </span>
                </>
              ) : null}
            </div>
          </div>
          <div className="topbarControls">
            <div className="seg" role="tablist" aria-label="Visualização">
              {ANALYSIS_VIEW_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={selectedViewMode === option.value}
                  className={`segBtn ${selectedViewMode === option.value ? "segBtnActive" : ""}`}
                  disabled={isUserRefreshRunning || option.disabled}
                  onClick={() => {
                    setSelectedViewMode(option.value);
                    setSelectedMonthKey((prev) => {
                      if (option.value === "day") {
                        return isValidDayKey(prev) ? prev : getCurrentDayKey();
                      }
                      if (option.value === "week") {
                        return isValidWeekKey(prev)
                          ? prev
                          : getCurrentWeekKey();
                      }
                      if (option.value === "year") {
                        return isValidYearKey(prev) ? prev : currentYearKey;
                      }
                      return isValidMonthKey(prev) ? prev : currentMonthKey;
                    });
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <label className="topbarPeriodBtn">
              <svg
                className="ico"
                viewBox="0 0 13 13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="1.5" y="2.5" width="10" height="9" rx="1.5" />
                <path d="M1.5 5.5h10" />
                <path d="M4 1v2.5" />
                <path d="M9 1v2.5" />
              </svg>
              <span className="topbarPeriodLabel">
                {formatPeriodKeyLabel(selectedViewMode, selectedMonthKey)}
              </span>
              <svg
                className="ico icoChevron"
                viewBox="0 0 13 13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m3.5 5 3 3 3-3" />
              </svg>
              <select
                className="topbarPeriodSelect"
                value={selectedMonthKey}
                disabled={isUserRefreshRunning}
                onChange={(event) => {
                  setSelectedMonthKey(event.target.value);
                  const el = event.currentTarget;
                  requestAnimationFrame(() => el.blur());
                }}
                aria-label={
                  selectedViewMode === "year"
                    ? "Selecionar ano de análise"
                    : "Selecionar mês de análise"
                }
              >
                {periodOptions.map((periodKey) => (
                  <option key={periodKey} value={periodKey}>
                    {formatPeriodKeyLabel(selectedViewMode, periodKey)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {dashboardLoadFailed ? (
          <div className="contentErrorWrap">
            <section className="errorStateCard">
              <span className="errorStateIcon" aria-hidden="true">
                <svg
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M7 4v3.5" />
                  <circle cx="7" cy="10" r="0.6" fill="currentColor" />
                </svg>
              </span>
              <h1 className="errorStateTitle">
                Não conseguimos carregar o dashboard
              </h1>
              <p className="errorStateMessage">{dashboardErrorMessage}</p>
              <p className="errorStateHint">
                {dashboardErrorIsTimeout
                  ? "A atualização pode levar até 2 minutos ao buscar dados novos."
                  : "Instabilidade temporária. Tente novamente em instantes."}
              </p>
              <div className="errorStateActions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => mutate()}
                  disabled={isValidating}
                >
                  <ReloadIcon spinning={isValidating} />
                  <span>
                    {isValidating ? "Tentando…" : "Tentar novamente"}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={handleRefresh}
                  disabled={isValidating || isRefreshRunning}
                >
                  Recarregar tudo
                </button>
              </div>
            </section>
          </div>
        ) : (
          <>
            {resolvedActivePage === "Dashboard"
              ? renderDashboardPage("home")
              : null}
            {resolvedActivePage === "Jornada de campanhas"
              ? renderDashboardPage("journey")
              : null}
            {resolvedActivePage === "\u26A0\uFE0F Lines sem token"
              ? renderNoTokenAttentionPage()
              : null}
            {resolvedActivePage === "\u{1F6A8} Gasto fora do m\u{EA}s vigente"
              ? renderOutOfPeriodAttentionPage()
              : null}
            {EXTERNAL_PAGES.has(resolvedActivePage)
              ? (() => {
                  const tab = TOOL_TAB_BY_KEY[resolvedActivePage as ToolTabKey];
                  return tab?.enabled ? <tab.Component /> : null;
                })()
              : null}
            {resolvedActivePage !== "Dashboard" &&
            resolvedActivePage !== "Jornada de campanhas" &&
            resolvedActivePage !== "\u26A0\uFE0F Lines sem token" &&
            resolvedActivePage !== "\u{1F6A8} Gasto fora do m\u{EA}s vigente" &&
            !EXTERNAL_PAGES.has(resolvedActivePage)
              ? renderPlatformPage(resolvedActivePage)
              : null}
          </>
        )}
      </section>

      {noTokenRowTooltip ? (
        <div
          className="attentionObsTooltipLayer"
          style={{
            position: "fixed",
            left: noTokenRowTooltip.anchorCenterX,
            top: noTokenRowTooltip.anchorBottom + 2,
            paddingTop: 6,
            transform: "translateX(-50%) translateZ(0)",
            zIndex: 96,
          }}
          onMouseEnter={cancelHideNoTokenRowTooltip}
          onMouseLeave={scheduleHideNoTokenRowTooltip}
        >
          <div className="attentionObsTooltipCard" role="tooltip">
            <p className="attentionObsTooltipEyebrow">Observação</p>
            <p className="attentionObsTooltipBody">{noTokenRowTooltip.text}</p>
          </div>
        </div>
      ) : null}

      {noTokenObsModalRow ? (
        <div
          className="modalOverlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeNoTokenObservationModal();
          }}
        >
          <div
            className="modalCard modalCardObservation"
            role="dialog"
            aria-modal="true"
            aria-labelledby="no-token-obs-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modalHeading">
              <h2 id="no-token-obs-modal-title">Observação na line</h2>
            </div>
            <p className="modalSubtitle">
              {noTokenObsModalRow.platform}
              {" · "}
              {noTokenObsModalRow.line.length > 96
                ? `${noTokenObsModalRow.line.slice(0, 96)}…`
                : noTokenObsModalRow.line}
            </p>
            <div className="modalField">
              <label htmlFor="no-token-obs-modal-text">Texto</label>
              <textarea
                ref={noTokenObsTextareaRef}
                id="no-token-obs-modal-text"
                className="modalTextarea"
                value={noTokenObsModalText}
                onChange={(event) => setNoTokenObsModalText(event.target.value)}
                placeholder="Observação interna (passe o mouse na linha na tabela para ver o preview)…"
                rows={6}
              />
            </div>
            <div className="modalActions">
              <button
                type="button"
                className="button modalButtonGhost"
                disabled={noTokenObsModalSaving}
                onClick={closeNoTokenObservationModal}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="button modalButtonPrimary"
                disabled={noTokenObsModalSaving}
                onClick={() => void saveNoTokenObservationFromModal()}
              >
                {noTokenObsModalSaving ? "Salvando…" : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {noTokenNameModalRow ? (
        <div
          className="modalOverlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeNoTokenNameModal();
          }}
        >
          <div
            className="modalCard modalCardObservation"
            role="dialog"
            aria-modal="true"
            aria-labelledby="no-token-name-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modalHeading">
              <h2 id="no-token-name-modal-title">Editar nome da line</h2>
            </div>
            <p className="modalSubtitle">
              {noTokenNameModalRow.platform}
              {" · ID "}
              {noTokenNameModalRow.line_item_id
                ? String(noTokenNameModalRow.line_item_id)
                : "—"}
            </p>
            <div className="modalField">
              <label htmlFor="no-token-name-modal-text">Nome correto</label>
              <input
                ref={noTokenNameInputRef}
                id="no-token-name-modal-text"
                className="modalInput modalInputStandalone"
                value={noTokenNameModalText}
                onChange={(event) => setNoTokenNameModalText(event.target.value)}
                placeholder="Ex.: ID-ABC123_HYPR_Campanha..."
              />
              <p className="modalFieldHint">
                Informe o nome com token no padrão ID-XXXXXX ou apenas o short
                token de 6 caracteres.
              </p>
            </div>
            <div className="modalActions">
              <button
                type="button"
                className="button modalButtonGhost"
                disabled={noTokenNameModalSaving}
                onClick={closeNoTokenNameModal}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="button modalButtonPrimary"
                disabled={noTokenNameModalSaving}
                onClick={() => void saveNoTokenNameFromModal()}
              >
                {noTokenNameModalSaving ? "Salvando…" : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div
          className={`toast ${toast.kind === "success" ? "toastSuccess" : "toastError"}`}
          role="status"
          aria-live="polite"
        >
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
