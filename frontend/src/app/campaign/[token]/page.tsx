"use client";

import html2canvas from "html2canvas";
import { UserButton, useClerk, useUser } from "@clerk/nextjs";
import Image from "next/image";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchCampaign } from "@/services/api/campaign";
import type { CampaignLineRow, CampaignResponse } from "@/services/api/types";
import {
  brl,
  formatCurrencyAxisTick,
  NumberTooltip,
  PlatformLegend,
} from "@/shared/charts/homeRecharts";
import {
  RESEND_CHART_COLORS,
  ResendDailyLine,
  ResendDonut,
  ResendHbars,
} from "@/features/dashboard/components/DeepDiveCharts";
import { PLATFORM_COLORS } from "@/shared/constants/platform";
import {
  getAccountManagerAvatar,
  getFallbackAccountManagerWhatsAppNumber,
} from "@/shared/utils/accountManagers";

type CampaignAllLinesSortKey = "platform" | "line" | "gasto" | "pct";

const SOURCE_SLUG_TO_PATH: Record<string, string> = {
  "jornada-campanhas": "/jornada-campanhas",
  "lines-sem-token": "/lines-sem-token",
  "gasto-fora-mes-vigente": "/gasto-fora-mes-vigente",
  nexd: "/nexd",
  "stack-adapt": "/stack-adapt",
  dv360: "/dv360",
  xandr: "/xandr",
  hivestack: "/hivestack",
  "amazon-dsp": "/amazon-dsp",
};

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function compactLabel(value: string, max = 50) {
  const normalized = value.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

function formatDateBr(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function formatBrlAmount(value: number) {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function getCampaignReferenceWhatsAppUrl(
  name: string | null | undefined,
  context: { campanha: string; token: string }
): string {
  const managerName = (name ?? "").trim() || "time";
  const rawPhone = getFallbackAccountManagerWhatsAppNumber(managerName);
  const digitsOnly = rawPhone.replace(/\D/g, "");
  const text = encodeURIComponent(
    `Oi ${managerName}, tudo bem? Esta mensagem é referente à campanha ${context.campanha}, token ${context.token}. Pode revisar por favor?`
  );
  return `https://wa.me/${digitsOnly}?text=${text}`;
}

async function downloadElementPng(element: HTMLElement, filename: string) {
  const canvas = await html2canvas(element, {
    scale: 2,
    backgroundColor: "#0a0a0a",
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

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" className="buttonIcon">
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.7" />
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

function CampaignDetailLoadingSkeleton() {
  return (
    <>
      <section className="dspResendHero campaignResendHero">
        <header className="dspResendHeroHead">
          <div className="dspResendHeroBrand">
            <div>
              <div className="skeleton skeletonText campaignSkeletonEyebrow" />
              <div className="skeleton skeletonTitle campaignSkeletonHeroTitle" />
            </div>
          </div>
          <div className="skeleton campaignSkeletonHeroValue" />
        </header>
        <div className="skeleton skeletonText campaignSkeletonHeroBudget" />
        <div className="dspResendHeroStats">
          {Array.from({ length: 3 }).map((_, index) => (
            <div className="dspResendHeroStat" key={`hero-stat-skeleton-${index}`}>
              <div className="skeleton skeletonText campaignSkeletonStatLabel" />
              <div className="skeleton skeletonTitle campaignSkeletonStatValue" />
              <div className="skeleton skeletonText campaignSkeletonStatHint" />
            </div>
          ))}
        </div>
      </section>

      <section className="gridTwo gridTwoCharts gridTwoChartsHome">
        {Array.from({ length: 2 }).map((_, index) => (
          <div className="panel panelChart panelChartResend" key={`chart-skeleton-${index}`}>
            <div className="chartBlockHeading">
              <div className="chartBlockHeadingTop">
                <div className="skeleton skeletonTitle campaignSkeletonPanelHeading" />
                <div className="skeleton skeletonText campaignSkeletonChartExport" />
              </div>
              <div className="skeleton skeletonText campaignSkeletonPanelSubheading" />
            </div>
            <div className="skeleton skeletonChart" />
          </div>
        ))}
      </section>

      <section className="panel panelChart panelChartResend">
        <div className="chartBlockHeading">
          <div className="chartBlockHeadingTop">
            <div className="skeleton skeletonTitle campaignSkeletonPanelHeading" />
          </div>
          <div className="skeleton skeletonText campaignSkeletonPanelSubheading" />
        </div>
        <div className="skeleton skeletonChart campaignSkeletonLinesChart" />
      </section>

      <section className="journeyResendCard dspResendLinesCard">
        <header className="journeyResendHeader">
          <div className="journeyResendHeaderTitle">
            <div className="skeleton skeletonTitle campaignSkeletonPanelHeading" />
            <div className="skeleton skeletonText campaignSkeletonPanelSubheading" />
          </div>
        </header>
        <div className="skeleton skeletonTable campaignSkeletonTable" />
      </section>
    </>
  );
}

export default function CampaignDetailPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useParams<{ token: string }>();
  const copyStatusTimeoutRef = useRef<number | null>(null);
  const spendByDspBarChartRef = useRef<HTMLDivElement | null>(null);
  const spendByDspPieChartRef = useRef<HTMLDivElement | null>(null);
  const topLinesChartRef = useRef<HTMLDivElement | null>(null);
  const timelineChartRef = useRef<HTMLDivElement | null>(null);
  const { signOut } = useClerk();
  const { isLoaded: isUserLoaded, isSignedIn, user } = useUser();
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [distributionHighlightPlatform, setDistributionHighlightPlatform] = useState<string | null>(null);
  const [allLinesSearch, setAllLinesSearch] = useState("");
  const [allLinesSort, setAllLinesSort] = useState<{
    key: CampaignAllLinesSortKey;
    direction: "asc" | "desc";
  }>({ key: "gasto", direction: "desc" });
  const [campaignTimelineFocus, setCampaignTimelineFocus] = useState<string | null>(null);
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  const tokenParam = Array.isArray(params?.token) ? params.token[0] : params?.token;
  const token = safeDecodeURIComponent(tokenParam ?? "").trim().toUpperCase();
  const sourceParam = searchParams.get("source")?.trim().toLowerCase() ?? "";
  const backPath = SOURCE_SLUG_TO_PATH[sourceParam] ?? "/";
  const userEmail = user?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "";
  const isAllowedDomain = userEmail.endsWith("@hypr.mobi");
  const shouldFetchData = isUserLoaded && isSignedIn && isAllowedDomain && Boolean(token);
  const swrKey = shouldFetchData ? `${apiBase}/api/campaign/${encodeURIComponent(token)}` : null;
  const { data, error, isLoading, isValidating } = useSWR<CampaignResponse>(swrKey, fetchCampaign, {
    keepPreviousData: true,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60000,
  });
  const showLoadingSkeleton = !error && !data && (isLoading || isValidating);

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

  const campaign = data?.campaign ?? null;

  const lineRows = useMemo(() => {
    return data?.line_rows ?? [];
  }, [data?.line_rows]);

  const accountManagerName = (
    campaign?.account_management ??
    lineRows[0]?.account_management ??
    ""
  ).trim();
  const displayCliente = (campaign?.cliente ?? lineRows[0]?.cliente ?? "").trim();
  const displayCampanhaNome = (campaign?.campanha ?? lineRows[0]?.campanha ?? "").trim();

  const chartData = useMemo(
    () =>
      lineRows.slice(0, 12).map((row, index) => ({
        id: `${row.platform}-${index}`,
        label: compactLabel(row.line, 42),
        fullLabel: row.line,
        gasto: row.gasto,
        platform: row.platform,
        color: PLATFORM_COLORS[row.platform] ?? "#4e1e9c",
      })),
    [lineRows]
  );

  const totalLinesCost = useMemo(() => lineRows.reduce((sum, row) => sum + row.gasto, 0), [lineRows]);

  const allLinesSearchNormalized = allLinesSearch.trim().toLowerCase();

  const filteredCampaignLineRows = useMemo(() => {
    if (!allLinesSearchNormalized) return lineRows;
    return lineRows.filter((row) => row.line.toLowerCase().includes(allLinesSearchNormalized));
  }, [lineRows, allLinesSearchNormalized]);

  const sortedCampaignLineRows = useMemo(() => {
    const rows: CampaignLineRow[] = [...filteredCampaignLineRows];
    const dir = allLinesSort.direction === "asc" ? 1 : -1;
    const rowPct = (r: CampaignLineRow) => (totalLinesCost > 0 ? r.gasto / totalLinesCost : 0);
    rows.sort((a, b) => {
      switch (allLinesSort.key) {
        case "platform":
          return a.platform.localeCompare(b.platform, "pt-BR") * dir;
        case "line":
          return a.line.localeCompare(b.line, "pt-BR") * dir;
        case "gasto":
          return (a.gasto - b.gasto) * dir;
        case "pct":
          return (rowPct(a) - rowPct(b)) * dir;
        default:
          return 0;
      }
    });
    return rows;
  }, [filteredCampaignLineRows, allLinesSort, totalLinesCost]);

  const filteredLinesTotal = useMemo(
    () => sortedCampaignLineRows.reduce((sum, row) => sum + row.gasto, 0),
    [sortedCampaignLineRows]
  );

  const toggleAllLinesSort = (key: CampaignAllLinesSortKey) => {
    setAllLinesSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return {
        key,
        direction: key === "platform" || key === "line" ? "asc" : "desc",
      };
    });
  };

  const allLinesSortIndicator = (key: CampaignAllLinesSortKey) => {
    if (allLinesSort.key !== key) return "↕";
    return allLinesSort.direction === "asc" ? "↑" : "↓";
  };

  const allLinesSortButtonClass = (key: CampaignAllLinesSortKey) =>
    `stackSortButton ${allLinesSort.key === key ? "stackSortButtonActive" : ""}`;

  const spendByDsp = useMemo(() => {
    const grouped = new Map<string, { platform: string; gasto: number; lines: number }>();
    for (const row of lineRows) {
      const current = grouped.get(row.platform) ?? { platform: row.platform, gasto: 0, lines: 0 };
      current.gasto += row.gasto;
      current.lines += 1;
      grouped.set(row.platform, current);
    }
    return Array.from(grouped.values())
      .sort((a, b) => b.gasto - a.gasto)
      .map((item) => ({
        ...item,
        color: PLATFORM_COLORS[item.platform] ?? "#4e1e9c",
      }));
  }, [lineRows]);

  const campaignPlatformChartData = useMemo(
    () =>
      spendByDsp.map((row) => ({
        platform: row.platform,
        spend_brl: row.gasto,
        color: row.color,
      })),
    [spendByDsp]
  );
  const campaignBarChartData = useMemo(() => [...campaignPlatformChartData], [campaignPlatformChartData]);
  const campaignDominantShare = useMemo(() => {
    if (!campaignPlatformChartData.length || totalLinesCost <= 0) return 0;
    return campaignPlatformChartData[0].spend_brl / totalLinesCost;
  }, [campaignPlatformChartData, totalLinesCost]);
  const shouldFallbackCampaignPie =
    campaignPlatformChartData.length <= 1 || campaignDominantShare >= 0.9;

  const campaignTimelinePlatforms = useMemo(
    () => spendByDsp.map((p) => p.platform),
    [spendByDsp]
  );

  const campaignTimelineEffectiveFocus = useMemo(
    () =>
      campaignTimelineFocus && campaignTimelinePlatforms.includes(campaignTimelineFocus)
        ? campaignTimelineFocus
        : null,
    [campaignTimelineFocus, campaignTimelinePlatforms]
  );

  const timelineData = useMemo(() => {
    if (!data?.daily.length || !spendByDsp.length) return [];
    const platforms = new Set(spendByDsp.map((item) => item.platform));
    return data.daily
      .map((dailyRow) => {
        const row: { date: string; total: number; [platform: string]: string | number } = {
          date: String(dailyRow.date),
          total: 0,
        };
        for (const platform of platforms) {
          const value = Number(dailyRow[platform] ?? 0);
          row[platform] = value;
          row.total += value;
        }
        return row;
      })
      .filter((row) => row.total > 0);
  }, [data, spendByDsp]);

  const hasCampaignTimelineVariation = useMemo(() => {
    const platforms = campaignTimelineEffectiveFocus
      ? [campaignTimelineEffectiveFocus]
      : campaignTimelinePlatforms;
    if (!platforms.length) return false;
    let max = 0;
    for (const row of timelineData) {
      for (const p of platforms) {
        const v = Number(row[p] ?? 0);
        if (v > max) max = v;
      }
    }
    return max > 0;
  }, [timelineData, campaignTimelinePlatforms, campaignTimelineEffectiveFocus]);

  const setTransientStatus = (message: string) => {
    setCopyStatus(message);
    if (copyStatusTimeoutRef.current !== null) {
      window.clearTimeout(copyStatusTimeoutRef.current);
    }
    copyStatusTimeoutRef.current = window.setTimeout(() => setCopyStatus(null), 1800);
  };

  const copyToClipboard = async (value: string, label: string) => {
    const normalized = value.trim();
    if (!normalized || normalized === "—") return;
    try {
      await navigator.clipboard.writeText(normalized);
      setTransientStatus(`${label} copiado.`);
    } catch {
      setTransientStatus(`Nao foi possivel copiar ${label.toLowerCase()}.`);
    }
  };

  const copyObjectsAsCsv = async (label: string, rows: Array<Record<string, string | number>>) => {
    if (!rows.length) {
      setTransientStatus(`Sem dados para copiar em ${label}.`);
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
      setTransientStatus(`Dados de ${label} copiados em CSV.`);
    } catch {
      setTransientStatus("Nao foi possivel copiar os dados. Verifique as permissoes do navegador.");
    }
  };

  const exportChartAsPng = async (element: HTMLDivElement | null, chartName: string) => {
    if (!element) {
      setTransientStatus("Nao foi possivel capturar o grafico.");
      return;
    }
    try {
      const safeName = chartName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadElementPng(element, `${safeName}-${stamp}.png`);
      setTransientStatus(`Imagem exportada: ${chartName}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "erro desconhecido";
      setTransientStatus(`Falha ao exportar imagem (${message}).`);
    }
  };

  useEffect(() => {
    return () => {
      if (copyStatusTimeoutRef.current !== null) {
        window.clearTimeout(copyStatusTimeoutRef.current);
      }
    };
  }, []);

  if (!isUserLoaded || !isSignedIn || !isAllowedDomain) {
    return (
      <main className="content">
        <section className="panel panelChart panelChartResend">
          <p className="alertInfo">Validando sessão...</p>
        </section>
      </main>
    );
  }

  const heroBudgetPct = campaign
    ? Math.min(100, Math.max(0, campaign.pct_investido))
    : null;
  const leadPlatform = spendByDsp[0];

  return (
    <main className="content campaignDetailPage">
      <div className="campaignTopBar">
        <button type="button" className="dspResendPagerBtn campaignBackButton" onClick={() => router.push(backPath)}>
          <span aria-hidden="true">←</span> Voltar
        </button>
        <div className="campaignTopBarUserButton">
          <UserButton />
        </div>
      </div>

      <section className="dspResendHero campaignResendHero" aria-label="Resumo da campanha">
        <header className="dspResendHeroHead">
          <div className="dspResendHeroBrand">
            <div>
              <p className="dspResendHeroEyebrow">Campaign Journey</p>
              {showLoadingSkeleton ? (
                <div className="skeleton skeletonTitle campaignSkeletonHeroTitle" />
              ) : (
                <h2 className="dspResendHeroTitle">
                  {displayCliente || "Detalhamento da campanha"}
                </h2>
              )}
              {!showLoadingSkeleton && displayCampanhaNome ? (
                <p className="campaignResendSubtitle">{displayCampanhaNome}</p>
              ) : null}
            </div>
          </div>
          {showLoadingSkeleton ? (
            <div className="skeleton campaignSkeletonHeroValue" />
          ) : (
            <div className="dspResendHeroValue">
              <span className="dspResendHeroCurrency">R$</span>
              <span className="num">{formatBrlAmount(totalLinesCost)}</span>
            </div>
          )}
        </header>

        {!showLoadingSkeleton ? (
          <div className="campaignResendMeta">
            <div className="campaignResendMetaItem">
              <span className="campaignResendMetaLabel">Token</span>
              <span className="campaignResendMetaValue num">{token || "—"}</span>
              <button
                type="button"
                className="copyIconButton"
                aria-label={`Copiar token ${token}`}
                onClick={() => void copyToClipboard(token, "Token")}
                disabled={!token}
              >
                ⧉
              </button>
            </div>
            {accountManagerName ? (
              <div className="campaignResendMetaItem">
                <span className="campaignResendMetaLabel">Account</span>
                {getAccountManagerAvatar(accountManagerName) ? (
                  <Image
                    src={getAccountManagerAvatar(accountManagerName)!}
                    alt=""
                    width={20}
                    height={20}
                    className="accountManagerAvatar"
                  />
                ) : null}
                <span className="campaignResendMetaValue">{accountManagerName}</span>
                <a
                  href={getCampaignReferenceWhatsAppUrl(accountManagerName, {
                    campanha: displayCampanhaNome || "campanha sem nome",
                    token,
                  })}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="campaignHeaderWhatsappLink"
                  aria-label={`Conversar com ${accountManagerName} no WhatsApp`}
                >
                  <WhatsAppIcon />
                  <span>WhatsApp</span>
                </a>
              </div>
            ) : null}
          </div>
        ) : null}

        {!showLoadingSkeleton && campaign && heroBudgetPct !== null ? (
          <div className="campaignResendBudgetBlock">
            <p className="dspResendHeroBudget">
              Orçamento <span className="num">{brl(campaign.investido)}</span>
              <span className="dspResendHeroBudgetSep">·</span>
              <span className="num">
                {campaign.pct_investido.toLocaleString("pt-BR", {
                  maximumFractionDigits: 1,
                  minimumFractionDigits: 0,
                })}
                %
              </span>{" "}
              utilizado
            </p>
            <div
              className="campaignResendProgressTrack"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(heroBudgetPct)}
              aria-label="Percentual do orçamento utilizado"
            >
              <div
                className="campaignResendProgressFill"
                style={{ width: `${heroBudgetPct}%` }}
              />
            </div>
          </div>
        ) : null}

        {showLoadingSkeleton ? (
          <div className="dspResendHeroStats">
            {Array.from({ length: 3 }).map((_, index) => (
              <div className="dspResendHeroStat" key={`hero-stat-inline-skeleton-${index}`}>
                <div className="skeleton skeletonText campaignSkeletonStatLabel" />
                <div className="skeleton skeletonTitle campaignSkeletonStatValue" />
                <div className="skeleton skeletonText campaignSkeletonStatHint" />
              </div>
            ))}
          </div>
        ) : (
          <div className="dspResendHeroStats">
            <div className="dspResendHeroStat">
              <span className="dspResendHeroStatLabel">Investido (planilha)</span>
              <span className="dspResendHeroStatValue num">
                {campaign ? brl(campaign.investido) : "—"}
              </span>
              <span className="dspResendHeroStatHint">
                {campaign
                  ? `${campaign.pct_investido.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 0 })}% do orçamento`
                  : "Sem campanha vinculada"}
              </span>
            </div>
            <div className="dspResendHeroStat">
              <span className="dspResendHeroStatLabel">Lines com gasto</span>
              <span className="dspResendHeroStatValue num">
                {lineRows.length.toLocaleString("pt-BR")}
              </span>
              <span className="dspResendHeroStatHint">
                {lineRows.length === 0
                  ? "Sem linhas no período"
                  : `${brl(totalLinesCost)} consumidos`}
              </span>
            </div>
            <div className="dspResendHeroStat">
              <span className="dspResendHeroStatLabel">Plataformas</span>
              <span className="dspResendHeroStatValue num">
                {spendByDsp.length.toLocaleString("pt-BR")}
              </span>
              <span className="dspResendHeroStatHint">
                {leadPlatform
                  ? `Maior: ${leadPlatform.platform} · ${brl(leadPlatform.gasto)}`
                  : "Nenhuma com gasto"}
              </span>
            </div>
          </div>
        )}

        {copyStatus ? <p className="campaignCopyStatus">{copyStatus}</p> : null}
      </section>

      {error ? (
        <section className="panel panelChart panelChartResend">
          <p className="alertError">{error.message}</p>
        </section>
      ) : null}

      {showLoadingSkeleton ? <CampaignDetailLoadingSkeleton /> : null}

      {!showLoadingSkeleton && !isLoading && !error && !lineRows.length ? (
        <section className="panel panelChart panelChartResend">
          <p className="alertInfo">Nenhuma line encontrada para este token no período atual.</p>
        </section>
      ) : null}

      {lineRows.length ? (
        <>
          <section className="gridTwo gridTwoCharts gridTwoChartsHome">
            <div className="panel panelChart panelChartResend" ref={spendByDspBarChartRef}>
              <div className="chartBlockHeading">
                <div className="chartBlockHeadingTop">
                  <h2 className="chartBlockTitle">Gasto por plataforma</h2>
                  <div className="chartBlockHeadingActions">
                    <button
                      type="button"
                      className="chartIconButton"
                      aria-label="Copiar gasto por plataforma como CSV"
                      title="Exportar CSV"
                      data-html2canvas-ignore="true"
                      onClick={() =>
                        void copyObjectsAsCsv(
                          "gasto por plataforma",
                          campaignPlatformChartData.map((row) => ({
                            plataforma: row.platform,
                            gasto_brl: row.spend_brl.toFixed(2),
                            pct_total:
                              totalLinesCost > 0
                                ? ((row.spend_brl / totalLinesCost) * 100).toFixed(2)
                                : "0.00",
                          }))
                        )
                      }
                    >
                      <DownloadIcon />
                    </button>
                    <button
                      type="button"
                      className="chartIconButton"
                      aria-label="Baixar gasto por plataforma como PNG"
                      title="Exportar PNG"
                      data-html2canvas-ignore="true"
                      onClick={() => void exportChartAsPng(spendByDspBarChartRef.current, "gasto por plataforma")}
                    >
                      <DownloadIcon />
                    </button>
                  </div>
                </div>
                <p className="chartBlockSubtitle">Valores absolutos (R$)</p>
              </div>
              {!campaignPlatformChartData.length ? (
                <p className="alertInfo">Sem dados de plataforma neste token.</p>
              ) : (
                <div
                  className="chartWrap chartWrapHbars"
                  role="img"
                  aria-label={`Gasto por plataforma em valores absolutos (reais), token ${token}`}
                >
                  <ResendHbars
                    data={campaignBarChartData}
                    total={totalLinesCost}
                    highlight={distributionHighlightPlatform}
                    onHighlight={setDistributionHighlightPlatform}
                  />
                </div>
              )}
            </div>

            <div className="panel panelChart panelChartResend" ref={spendByDspPieChartRef}>
              <div className="chartBlockHeading">
                <div className="chartBlockHeadingTop">
                  <h2 className="chartBlockTitle">Distribuição</h2>
                  <div className="chartBlockHeadingActions">
                    <button
                      type="button"
                      className="chartIconButton"
                      aria-label="Copiar distribuição de investimento como CSV"
                      title="Exportar CSV"
                      data-html2canvas-ignore="true"
                      onClick={() =>
                        void copyObjectsAsCsv(
                          "distribuição de investimento",
                          campaignPlatformChartData.map((row) => ({
                            plataforma: row.platform,
                            gasto_brl: row.spend_brl.toFixed(2),
                            pct_total:
                              totalLinesCost > 0
                                ? ((row.spend_brl / totalLinesCost) * 100).toFixed(2)
                                : "0.00",
                          }))
                        )
                      }
                    >
                      <DownloadIcon />
                    </button>
                    <button
                      type="button"
                      className="chartIconButton"
                      aria-label="Baixar distribuição como PNG"
                      title="Exportar PNG"
                      data-html2canvas-ignore="true"
                      onClick={() => void exportChartAsPng(spendByDspPieChartRef.current, "distribuição de investimento")}
                    >
                      <DownloadIcon />
                    </button>
                  </div>
                </div>
                <p className="chartBlockSubtitle">% do total investido</p>
              </div>
              {!campaignPlatformChartData.length ? (
                <p className="alertInfo">Sem dados de plataforma neste token.</p>
              ) : (
                <div
                  className="chartWrap"
                  role="img"
                  aria-label={`Distribuição percentual do gasto por plataforma, token ${token}`}
                >
                  {shouldFallbackCampaignPie ? (
                    <div className="chartFallback">
                      <p className="chartFallbackTitle">Distribuição muito concentrada para donut.</p>
                      <p className="chartFallbackSubtitle">Mostrando proporções em barras para leitura mais clara.</p>
                      <div className="chartFallbackList">
                        {campaignPlatformChartData.map((entry, idx) => {
                          const pct = totalLinesCost > 0 ? (entry.spend_brl / totalLinesCost) * 100 : 0;
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
                    <ResendDonut
                      data={campaignPlatformChartData}
                      total={totalLinesCost}
                      highlight={distributionHighlightPlatform}
                      onHighlight={setDistributionHighlightPlatform}
                    />
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="panel panelChart panelChartResend" ref={topLinesChartRef}>
            <div className="chartBlockHeading">
              <div className="chartBlockHeadingTop">
                <h2 className="chartBlockTitle">Top lines por gasto</h2>
                <div className="chartBlockHeadingActions">
                  <button
                    type="button"
                    className="chartIconButton"
                    aria-label="Copiar top lines por gasto como CSV"
                    title="Exportar CSV"
                    data-html2canvas-ignore="true"
                    onClick={() =>
                      void copyObjectsAsCsv(
                        "top lines por gasto",
                        chartData.map((row) => ({
                          DSP: row.platform,
                          Line: row.fullLabel,
                          Gasto: row.gasto,
                        }))
                      )
                    }
                  >
                    <DownloadIcon />
                  </button>
                  <button
                    type="button"
                    className="chartIconButton"
                    aria-label="Baixar top lines por gasto como PNG"
                    title="Exportar PNG"
                    data-html2canvas-ignore="true"
                    onClick={() => void exportChartAsPng(topLinesChartRef.current, "top lines por gasto")}
                  >
                    <DownloadIcon />
                  </button>
                </div>
              </div>
              <p className="chartBlockSubtitle">
                {chartData.length.toLocaleString("pt-BR")} maiores lines
                {lineRows.length > chartData.length ? ` de ${lineRows.length.toLocaleString("pt-BR")}` : ""}
              </p>
            </div>
            <div>
              <div className="campaignLinesLegend">
                <PlatformLegend
                  payload={spendByDsp.map((entry) => ({
                    value: entry.platform,
                    color: entry.color,
                  }))}
                />
              </div>
              <div className="chartWrap" style={{ height: Math.max(280, chartData.length * 36) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ top: 6, right: 58, bottom: 6, left: 2 }}>
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
                      dataKey="label"
                      stroke="#cbd5e1"
                      width={250}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      shared
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const target = payload[0]?.payload as
                          | { fullLabel?: string; platform?: string }
                          | undefined;
                        const displayLabel = target
                          ? `${target.platform ?? ""} • ${target.fullLabel ?? ""}`
                          : String(label ?? "");
                        return (
                          <NumberTooltip
                            active={active}
                            payload={payload as unknown as NonNullable<Parameters<typeof NumberTooltip>[0]["payload"]>}
                            label={displayLabel}
                            totalValue={totalLinesCost}
                          />
                        );
                      }}
                      cursor={{ fill: "rgba(15, 23, 42, 0.28)", stroke: "none" }}
                      offset={{ x: 18, y: 4 }}
                      allowEscapeViewBox={{ x: false, y: true }}
                      animationDuration={120}
                    />
                    <Bar
                      dataKey="gasto"
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
                      {chartData.map((entry) => (
                        <Cell key={`bar-${entry.id}`} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            {lineRows.length > chartData.length ? (
              <p className="campaignPanelHint">
                O gráfico mostra as lines mais relevantes para manter legibilidade; a tabela abaixo traz o detalhamento completo.
              </p>
            ) : null}
          </section>

          {timelineData.length ? (
            <section
              className="panel panelChart panelChartResend panelChartResendDaily"
              ref={timelineChartRef}
            >
              <div className="chartBlockHeading dailyChartHeading">
                <div className="chartBlockHeadingTop">
                  <h2 className="chartBlockTitle">Tempo de investimento por DSP</h2>
                  <div className="dailyChartHeaderRight">
                    <ul className="dailyChartLegendStrip" aria-hidden>
                      {campaignTimelinePlatforms.map((platform) => (
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
                      aria-label="Copiar tempo de investimento por DSP como CSV"
                      title="Exportar CSV"
                      data-html2canvas-ignore="true"
                      onClick={() =>
                        void copyObjectsAsCsv(
                          "tempo de investimento por DSP",
                          timelineData.map((row) => {
                            const csvRow: Record<string, string | number> = {
                              Data: formatDateBr(String(row.date)),
                              Total: Number(row.total ?? 0),
                            };
                            for (const platformItem of spendByDsp) {
                              csvRow[platformItem.platform] = Number(row[platformItem.platform] ?? 0);
                            }
                            return csvRow;
                          })
                        )
                      }
                    >
                      <DownloadIcon />
                    </button>
                    <button
                      type="button"
                      className="chartIconButton"
                      aria-label="Baixar tempo de investimento por DSP como PNG"
                      title="Exportar PNG"
                      data-html2canvas-ignore="true"
                      onClick={() => void exportChartAsPng(timelineChartRef.current, "tempo de investimento por DSP")}
                    >
                      <DownloadIcon />
                    </button>
                  </div>
                </div>
                <div className="dailyChartHeaderBottom">
                  <p className="chartBlockSubtitle">Evolução diária agregada no período disponível</p>
                  {campaignTimelinePlatforms.length ? (
                    <div
                      className="dailyChartSegmented"
                      role="tablist"
                      aria-label="Filtro de plataformas"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={campaignTimelineEffectiveFocus === null}
                        className={`dailyChartSegmentedItem${campaignTimelineEffectiveFocus === null ? " is-active" : ""}`}
                        onClick={() => setCampaignTimelineFocus(null)}
                      >
                        Tudo
                      </button>
                      {campaignTimelinePlatforms.map((platform) => (
                        <button
                          key={platform}
                          type="button"
                          role="tab"
                          aria-selected={campaignTimelineEffectiveFocus === platform}
                          className={`dailyChartSegmentedItem${campaignTimelineEffectiveFocus === platform ? " is-active" : ""}`}
                          onClick={() => setCampaignTimelineFocus(platform)}
                        >
                          {platform}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
              {!hasCampaignTimelineVariation ? (
                <p className="alertInfo">Sem variação diária neste período.</p>
              ) : (
                <div
                  className="dailyChartContainer"
                  role="img"
                  aria-label={`Evolução diária do gasto por plataforma, token ${token}`}
                >
                  <ResendDailyLine
                    rows={timelineData}
                    platforms={campaignTimelinePlatforms}
                    focused={campaignTimelineEffectiveFocus}
                    todayIso={new Date().toISOString().slice(0, 10)}
                  />
                </div>
              )}
            </section>
          ) : null}

          <section className="journeyResendCard dspResendLinesCard">
            <header className="journeyResendHeader">
              <div className="journeyResendHeaderTitle">
                <h2>Gastos por DSP</h2>
                <p className="journeyResendHeaderSubtitle">
                  <span className="num">{spendByDsp.length.toLocaleString("pt-BR")}</span>{" "}
                  {spendByDsp.length === 1 ? "plataforma" : "plataformas"}
                  <span className="journeyResendSep" aria-hidden="true">·</span>
                  <span className="num">{brl(totalLinesCost)}</span> consolidado
                </p>
              </div>
            </header>
            <div className="tableWrap">
              <table className="campaignJourneyTable dspResendLinesTable campaignDspTable">
                <thead>
                  <tr>
                    <th>DSP</th>
                    <th className="stackThFinancial stackThNumeric">Gasto</th>
                    <th className="stackThNumeric">Lines</th>
                    <th className="stackThNumeric">% do total</th>
                  </tr>
                </thead>
                <tbody>
                  {spendByDsp.map((row) => (
                    <tr key={`dsp-row-${row.platform}`} className="campaignJourneyRow">
                      <td>{row.platform}</td>
                      <td className="stackNumericCellRight stackNumericCellFinancial">{brl(row.gasto)}</td>
                      <td className="stackNumericCellRight">{row.lines.toLocaleString("pt-BR")}</td>
                      <td className="stackNumericCellRight">
                        {totalLinesCost > 0 ? `${((row.gasto / totalLinesCost) * 100).toFixed(1)}%` : "0.0%"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="journeyResendCard dspResendLinesCard">
            <header className="journeyResendHeader">
              <div className="journeyResendHeaderTitle">
                <h2>Todas as lines</h2>
                <p className="journeyResendHeaderSubtitle">
                  <span className="num">{sortedCampaignLineRows.length.toLocaleString("pt-BR")}</span>{" "}
                  {sortedCampaignLineRows.length === 1 ? "linha" : "linhas"}
                  {allLinesSearchNormalized ? (
                    <>
                      <span className="journeyResendSep" aria-hidden="true">·</span>
                      filtradas de {lineRows.length.toLocaleString("pt-BR")}
                    </>
                  ) : null}
                  <span className="journeyResendSep" aria-hidden="true">·</span>
                  <span className="num">{brl(filteredLinesTotal)}</span>{" "}
                  no filtro
                </p>
              </div>
              <div className="journeyResendHeaderActions">
                <div className="dspResendSearch">
                  <SearchIcon />
                  <input
                    type="search"
                    value={allLinesSearch}
                    onChange={(event) => setAllLinesSearch(event.target.value)}
                    placeholder="Buscar por line"
                    aria-label="Buscar lines por nome"
                  />
                </div>
                <button
                  type="button"
                  className="journeyResendHeaderIconBtn"
                  onClick={() =>
                    void copyObjectsAsCsv(
                      "todas as lines",
                      sortedCampaignLineRows.map((row) => ({
                        DSP: row.platform,
                        Line: row.line,
                        Gasto: row.gasto,
                        "Pct do total":
                          totalLinesCost > 0 ? Number(((row.gasto / totalLinesCost) * 100).toFixed(2)) : 0,
                      }))
                    )
                  }
                  title="Exportar CSV"
                  aria-label="Exportar CSV"
                >
                  <DownloadIcon />
                </button>
              </div>
            </header>
            {!sortedCampaignLineRows.length ? (
              <p className="alertInfo campaignLinesEmpty">
                {allLinesSearchNormalized
                  ? "Nenhuma line corresponde à busca."
                  : "Nenhuma line neste período."}
              </p>
            ) : (
              <div className="tableWrap">
                <table className="campaignJourneyTable dspResendLinesTable campaignAllLinesTable">
                  <thead>
                    <tr>
                      <th className={allLinesSort.key === "platform" ? "stackThSorted" : undefined}>
                        <button
                          type="button"
                          className={allLinesSortButtonClass("platform")}
                          onClick={() => toggleAllLinesSort("platform")}
                        >
                          <span>DSP</span>
                          <span className="stackSortIndicator">{allLinesSortIndicator("platform")}</span>
                        </button>
                      </th>
                      <th className={allLinesSort.key === "line" ? "stackThSorted" : undefined}>
                        <button
                          type="button"
                          className={allLinesSortButtonClass("line")}
                          onClick={() => toggleAllLinesSort("line")}
                        >
                          <span>Line</span>
                          <span className="stackSortIndicator">{allLinesSortIndicator("line")}</span>
                        </button>
                      </th>
                      <th
                        className={
                          allLinesSort.key === "gasto"
                            ? "stackThSorted stackThFinancial stackThNumeric"
                            : "stackThFinancial stackThNumeric"
                        }
                      >
                        <button
                          type="button"
                          className={allLinesSortButtonClass("gasto")}
                          onClick={() => toggleAllLinesSort("gasto")}
                        >
                          <span>Gasto</span>
                          <span className="stackSortIndicator">{allLinesSortIndicator("gasto")}</span>
                        </button>
                      </th>
                      <th
                        className={
                          allLinesSort.key === "pct" ? "stackThSorted stackThNumeric" : "stackThNumeric"
                        }
                      >
                        <button
                          type="button"
                          className={allLinesSortButtonClass("pct")}
                          onClick={() => toggleAllLinesSort("pct")}
                        >
                          <span>% do total</span>
                          <span className="stackSortIndicator">{allLinesSortIndicator("pct")}</span>
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCampaignLineRows.map((row, index) => (
                      <tr
                        key={`${row.platform}-${row.line}-${row.cliente}-${row.campanha}-${index}`}
                        className="campaignJourneyRow"
                      >
                        <td>{row.platform}</td>
                        <td className="campaignLineCell dspResendLineCell">
                          <div className="copyCell dspResendLineCellInner">
                            <span className="dspResendLineText">{row.line}</span>
                            <button
                              type="button"
                              className="copyIconButton dspResendLineCopy"
                              aria-label={`Copiar line ${row.line}`}
                              onClick={() => void copyToClipboard(row.line, "Line")}
                            >
                              {"⧉"}
                            </button>
                          </div>
                        </td>
                        <td className="stackNumericCellRight stackNumericCellFinancial">{brl(row.gasto)}</td>
                        <td className="stackNumericCellRight">
                          {totalLinesCost > 0 ? `${((row.gasto / totalLinesCost) * 100).toFixed(1)}%` : "0.0%"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}
