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
};

type CampaignResponse = {
  token: string;
  period: { start: string; end: string };
  campaign: JourneyRow | null;
  line_rows: CampaignLineRow[];
  daily: Array<{ date: string; total: number; [platform: string]: string | number }>;
  active_platforms: string[];
};

type CampaignLineRow = {
  platform: string;
  line: string;
  cliente: string;
  campanha: string;
  account_management?: string;
  gasto: number;
  investido: number | null;
  pct_invest: number | null;
};

const PLATFORM_COLORS: Record<string, string> = {
  StackAdapt: "#2563eb",
  DV360: "#22c55e",
  Xandr: "#dc2626",
  "Amazon DSP": "#f97316",
  Amazon: "#f97316",
  Nexd: "#7dd3fc",
  NEXD: "#7dd3fc",
  Hivestack: "#ec4899",
};

const PLATFORM_LOGOS: Record<string, string> = {
  "StackAdapt": "/stackadapt-logo.png",
  DV360: "/dv360-logo.png",
  Xandr: "/xandr-logo-transparent.png",
  Amazon: "/amazon-logo.png",
  "Amazon DSP": "/amazon-logo.png",
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

const SOURCE_SLUG_TO_PATH: Record<string, string> = {
  "lines-sem-token": "/lines-sem-token",
  "gasto-fora-mes-vigente": "/gasto-fora-mes-vigente",
  nexd: "/nexd",
  "stack-adapt": "/stack-adapt",
  dv360: "/dv360",
  xandr: "/xandr",
  "amazon-dsp": "/amazon-dsp",
};
const BRL_FORMATTER = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2,
});

const fetcher = async (url: string) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error("Falha ao carregar dados do backend.");
    }
    return response.json();
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

function getAccountManagerAvatar(name: string | null | undefined): string | undefined {
  const key = (name ?? "").trim();
  if (!key) return undefined;
  return ACCOUNT_MANAGER_AVATARS[key];
}

function getCampaignReferenceWhatsAppUrl(
  name: string | null | undefined,
  context: { campanha: string; token: string }
): string {
  const managerName = (name ?? "").trim() || "time";
  const rawPhone = ACCOUNT_MANAGER_WHATSAPP_NUMBERS[managerName] ?? FALLBACK_WHATSAPP_NUMBER;
  const digitsOnly = rawPhone.replace(/\D/g, "");
  const text = encodeURIComponent(
    `Oi ${managerName}, tudo bem? Esta mensagem é referente à campanha ${context.campanha}, token ${context.token}. Pode revisar por favor?`
  );
  return `https://wa.me/${digitsOnly}?text=${text}`;
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

function NumberTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      {label ? <p>{label}</p> : null}
      {payload.map((entry) => (
        <p key={`${entry.name}-${entry.value}`} style={{ color: entry.color ?? "#d1d5db" }}>
          {entry.name}: {brl(entry.value)}
        </p>
      ))}
    </div>
  );
}

type PlatformLegendEntry = {
  value?: string | number;
  color?: string;
  payload?: {
    platform?: string;
  };
};

function PlatformLegend({ payload }: { payload?: PlatformLegendEntry[] }) {
  if (!payload?.length) return null;
  return (
    <div className="chartLegend">
      {payload.map((entry) => {
        const name = String(entry.payload?.platform ?? entry.value ?? "");
        const displayName = name === "Amazon" ? "Amazon DSP" : name;
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
                }`}
              />
            ) : null}
            <span className="chartLegendDot" style={{ backgroundColor: entry.color ?? "#64748b" }} />
            <span>{displayName}</span>
          </div>
        );
      })}
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

function CampaignDetailLoadingSkeleton() {
  return (
    <>
      <section className="gridCards campaignKpisGrid">
        {Array.from({ length: 4 }).map((_, index) => (
          <article className="card" key={`campaign-kpi-skeleton-${index}`}>
            <div className="skeleton skeletonText campaignSkeletonCardTitle" />
            <div className="skeleton skeletonTitle campaignSkeletonCardValue" />
            <div className="skeleton skeletonSubtitle campaignSkeletonCardSubtitle" />
          </article>
        ))}
      </section>

      <section className="gridTwo campaignChartsGrid">
        {Array.from({ length: 2 }).map((_, index) => (
          <article className="panel panelChart" key={`campaign-chart-skeleton-${index}`}>
            <div className="panelHeading">
              <div className="skeleton skeletonTitle campaignSkeletonPanelHeading" />
              <div className="skeleton skeletonText campaignSkeletonPanelSubheading" />
            </div>
            <div className="skeleton skeletonChart" />
          </article>
        ))}
      </section>

      <section className="panel panelChart campaignLinesPanel">
        <div className="panelHeading">
          <div className="skeleton skeletonTitle campaignSkeletonPanelHeading" />
          <div className="skeleton skeletonText campaignSkeletonPanelSubheading" />
        </div>
        <div className="skeleton skeletonChart campaignSkeletonLinesChart" />
      </section>

      <section className="panel panelChart">
        <div className="panelHeading">
          <div className="skeleton skeletonTitle campaignSkeletonPanelHeading" />
          <div className="skeleton skeletonText campaignSkeletonPanelSubheading" />
        </div>
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
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  const tokenParam = Array.isArray(params?.token) ? params.token[0] : params?.token;
  const token = safeDecodeURIComponent(tokenParam ?? "").trim().toUpperCase();
  const sourceParam = searchParams.get("source")?.trim().toLowerCase() ?? "";
  const backPath = SOURCE_SLUG_TO_PATH[sourceParam] ?? "/";
  const userEmail = user?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "";
  const isAllowedDomain = userEmail.endsWith("@hypr.mobi");
  const shouldFetchData = isUserLoaded && isSignedIn && isAllowedDomain && Boolean(token);
  const swrKey = shouldFetchData ? `${apiBase}/api/campaign/${encodeURIComponent(token)}` : null;
  const { data, error, isLoading, isValidating } = useSWR<CampaignResponse>(swrKey, fetcher, {
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
  const accountManagerName = (campaign?.account_management || "").trim();

  const lineRows = useMemo(() => {
    return data?.line_rows ?? [];
  }, [data?.line_rows]);

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
        <section className="panel">
          <p className="alertInfo">Validando sessão...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="content campaignDetailPage">
      <div className="campaignTopBar">
        <button type="button" className="button buttonSmall campaignBackButton" onClick={() => router.push(backPath)}>
          <span aria-hidden="true">←</span> Voltar
        </button>
        <div className="campaignTopBarUserButton">
          <UserButton />
        </div>
      </div>
      <section className="panel panelChart campaignHeroPanel">
        <div className="campaignDetailHeader">
          <div>
            <p className="eyebrow">Campaign Journey</p>
            <h1>Detalhamento da campanha</h1>
            <div className="campaignTokenRow">
              <span className="muted">Token</span>
              {showLoadingSkeleton ? (
                <>
                  <span className="skeleton campaignSkeletonTokenValue" />
                  <span className="skeleton campaignSkeletonTokenCopy" />
                </>
              ) : (
                <>
                  <strong>{token || "—"}</strong>
                  <button
                    type="button"
                    className="copyIconButton"
                    aria-label={`Copiar token ${token}`}
                    onClick={() => void copyToClipboard(token, "Token")}
                    disabled={!token}
                  >
                    ⧉
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
        {copyStatus ? <p className="campaignCopyStatus">{copyStatus}</p> : null}
      </section>

      {error ? (
        <section className="panel">
          <p className="alertError">{error.message}</p>
        </section>
      ) : null}

      {showLoadingSkeleton ? <CampaignDetailLoadingSkeleton /> : null}

      {!showLoadingSkeleton && !isLoading && !error && !lineRows.length ? (
        <section className="panel">
          <p className="alertInfo">Nenhuma line encontrada para este token no período atual.</p>
        </section>
      ) : null}

      {lineRows.length ? (
        <>
          <section className="gridCards campaignKpisGrid">
            <article className="card">
              <p className="cardTitle">Cliente</p>
              <p className="cardValue campaignKpiValue">{campaign?.cliente || lineRows[0]?.cliente || "—"}</p>
              <p className="cardSubtitle">
                {campaign?.campanha || lineRows[0]?.campanha || "Campanha não encontrada na planilha"}
              </p>
              {accountManagerName ? (
                <p className="cardSubtitle">
                  <span className="accountManagerCell">
                    {getAccountManagerAvatar(accountManagerName) ? (
                      <Image
                        src={getAccountManagerAvatar(accountManagerName)!}
                        alt={`Foto de ${accountManagerName}`}
                        width={22}
                        height={22}
                        className="accountManagerAvatar"
                      />
                    ) : null}
                    <span>{accountManagerName}</span>
                    <a
                      href={getCampaignReferenceWhatsAppUrl(accountManagerName, {
                        campanha: campaign?.campanha || lineRows[0]?.campanha || "campanha sem nome",
                        token,
                      })}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="accountManagerWhatsappLink"
                      aria-label={`Conversar com ${accountManagerName} no WhatsApp`}
                      title="Abrir conversa no WhatsApp"
                    >
                      <WhatsAppIcon />
                    </a>
                  </span>
                </p>
              ) : null}
            </article>
            <article className="card">
              <p className="cardTitle">Total das lines</p>
              <p className="cardValue campaignKpiValue">{brl(totalLinesCost)}</p>
              <p className="cardSubtitle">{lineRows.length.toLocaleString("pt-BR")} line(s) com gasto no período</p>
            </article>
            <article className="card">
              <p className="cardTitle">Investido (planilha)</p>
              <p className="cardValue campaignKpiValue">{brl(campaign?.investido ?? 0)}</p>
              <p className="cardSubtitle">
                {campaign ? `${campaign.pct_investido.toFixed(1)}% consumido` : "Token sem campanha vinculada na planilha"}
              </p>
            </article>
            <article className="card">
              <p className="cardTitle">DSPs ativas</p>
              <p className="cardValue campaignKpiValue">{spendByDsp.length.toLocaleString("pt-BR")}</p>
              <p className="cardSubtitle">
                {spendByDsp[0] ? `Maior gasto: ${spendByDsp[0].platform} (${brl(spendByDsp[0].gasto)})` : "Sem DSP ativa"}
              </p>
            </article>
          </section>

          <section className="gridTwo campaignChartsGrid">
            <article className="panel panelChart">
              <div className="panelHeading">
                <div>
                  <h2>Gasto por DSP</h2>
                  <p>Resumo por plataforma para o token {token}</p>
                </div>
                <div className="panelHeadingActions">
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall"
                    onClick={() =>
                      void copyObjectsAsCsv(
                        "gasto por DSP",
                        spendByDsp.map((row) => ({
                          DSP: row.platform,
                          Gasto: row.gasto,
                          Lines: row.lines,
                          Percentual: totalLinesCost > 0 ? Number(((row.gasto / totalLinesCost) * 100).toFixed(2)) : 0,
                        }))
                      )
                    }
                  >
                    Copiar dados CSV
                  </button>
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall"
                    onClick={() => void exportChartAsPng(spendByDspBarChartRef.current, "gasto por DSP")}
                  >
                    Exportar PNG
                  </button>
                </div>
              </div>
              <div ref={spendByDspBarChartRef}>
                <div className="chartWrap chartWrapSmall">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={spendByDsp} layout="vertical" margin={{ top: 8, right: 12, left: 8, bottom: 8 }}>
                      <CartesianGrid stroke="rgba(83, 104, 114, 0.55)" strokeDasharray="3 4" opacity={0.45} />
                      <XAxis
                        type="number"
                        stroke="#94a3b8"
                        tickFormatter={(value) => brl(Number(value)).replace(",00", "")}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="platform"
                        stroke="#cbd5e1"
                        width={120}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip content={<NumberTooltip />} />
                      <Bar dataKey="gasto" name="Gasto" radius={[0, 10, 10, 0]} barSize={22}>
                        {spendByDsp.map((entry) => (
                          <Cell key={`dsp-bar-${entry.platform}`} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <PlatformLegend
                  payload={spendByDsp.map((entry) => ({
                    value: entry.platform,
                    color: entry.color,
                    payload: { platform: entry.platform },
                  }))}
                />
              </div>
            </article>

            <article className="panel panelChart">
              <div className="panelHeading">
                <div>
                  <h2>Pizza por DSP</h2>
                  <p>Participação do gasto por plataforma</p>
                </div>
                <div className="panelHeadingActions">
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall"
                    onClick={() =>
                      void copyObjectsAsCsv(
                        "pizza por DSP",
                        spendByDsp.map((row) => ({
                          DSP: row.platform,
                          Gasto: row.gasto,
                          Percentual: totalLinesCost > 0 ? Number(((row.gasto / totalLinesCost) * 100).toFixed(2)) : 0,
                        }))
                      )
                    }
                  >
                    Copiar dados CSV
                  </button>
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall"
                    onClick={() => void exportChartAsPng(spendByDspPieChartRef.current, "pizza por DSP")}
                  >
                    Exportar PNG
                  </button>
                </div>
              </div>
              <div ref={spendByDspPieChartRef}>
                <div className="chartWrap chartWrapSmall">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={spendByDsp}
                        dataKey="gasto"
                        nameKey="platform"
                        innerRadius={52}
                        outerRadius={92}
                        paddingAngle={2}
                        stroke="rgba(28, 38, 47, 0.92)"
                        strokeWidth={2}
                      >
                        {spendByDsp.map((entry) => (
                          <Cell key={`dsp-pie-${entry.platform}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Legend content={<PlatformLegend />} verticalAlign="bottom" />
                      <Tooltip content={<NumberTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </article>
          </section>

          <section className="panel panelChart campaignLinesPanel">
            <div className="panelHeading">
              <div>
                <h2>Top lines por gasto</h2>
                <p>
                  {chartData.length.toLocaleString("pt-BR")} maiores lines
                  {lineRows.length > chartData.length ? ` de ${lineRows.length.toLocaleString("pt-BR")}` : ""}
                </p>
              </div>
              <div className="panelHeadingActions">
                <button
                  type="button"
                  className="button buttonGhost buttonSmall"
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
                  Copiar dados CSV
                </button>
                <button
                  type="button"
                  className="button buttonGhost buttonSmall"
                  onClick={() => void exportChartAsPng(topLinesChartRef.current, "top lines por gasto")}
                >
                  Exportar PNG
                </button>
              </div>
            </div>
            <div ref={topLinesChartRef}>
              <div className="campaignLinesLegend">
                <PlatformLegend
                  payload={spendByDsp.map((entry) => ({
                    value: entry.platform,
                    color: entry.color,
                    payload: { platform: entry.platform },
                  }))}
                />
              </div>
              <div className="chartWrap" style={{ height: Math.max(280, chartData.length * 36) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 18, left: 8, bottom: 8 }}>
                    <CartesianGrid stroke="rgba(83, 104, 114, 0.55)" strokeDasharray="3 4" opacity={0.42} />
                    <XAxis
                      type="number"
                      stroke="#94a3b8"
                      tickFormatter={(value) => brl(Number(value)).replace(",00", "")}
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
                      content={<NumberTooltip />}
                      labelFormatter={(_, payload) => {
                        const target = payload?.[0]?.payload as { fullLabel?: string; platform?: string } | undefined;
                        if (!target) return "";
                        return `${target.platform ?? ""} • ${target.fullLabel ?? ""}`;
                      }}
                    />
                    <Bar dataKey="gasto" name="Gasto" radius={[0, 8, 8, 0]} barSize={20}>
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
            <section className="panel panelChart">
              <div className="panelHeading">
                <div>
                  <h2>Tempo de investimento por DSP</h2>
                  <p>Evolução diária agregada no período disponível</p>
                </div>
                <div className="panelHeadingActions">
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall"
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
                    Copiar dados CSV
                  </button>
                  <button
                    type="button"
                    className="button buttonGhost buttonSmall"
                    onClick={() => void exportChartAsPng(timelineChartRef.current, "tempo de investimento por DSP")}
                  >
                    Exportar PNG
                  </button>
                </div>
              </div>
              <div ref={timelineChartRef}>
                <div className="chartWrap chartWrapTall">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={timelineData}>
                      <CartesianGrid stroke="rgba(83, 104, 114, 0.55)" strokeDasharray="3 4" opacity={0.45} />
                      <XAxis
                        dataKey="date"
                        stroke="#94a3b8"
                        tickFormatter={(value) => formatDateBr(String(value))}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        stroke="#94a3b8"
                        tickFormatter={(value) => brl(Number(value)).replace(",00", "")}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip content={<NumberTooltip />} labelFormatter={(label) => formatDateBr(String(label))} />
                      <Legend content={<PlatformLegend />} />
                      {spendByDsp.map((platformItem) => (
                        <Line
                          key={`line-${platformItem.platform}`}
                          type="monotone"
                          dataKey={platformItem.platform}
                          stroke={platformItem.color}
                          strokeWidth={2.4}
                          dot={false}
                          activeDot={{ r: 5, strokeWidth: 2, stroke: "#1c262f" }}
                        />
                      ))}
                      <Line
                        type="monotone"
                        dataKey="total"
                        stroke="#e2e8f0"
                        strokeWidth={2.2}
                        strokeDasharray="4 4"
                        dot={false}
                        activeDot={{ r: 5, strokeWidth: 2, stroke: "#1c262f" }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </section>
          ) : null}

          <section className="panel panelChart">
            <div className="panelHeading">
              <h2>Gastos por DSP</h2>
              <p>Tabela consolidada por plataforma</p>
            </div>
            <div className="tableWrap">
              <table className="campaignDataTable">
                <thead>
                  <tr>
                    <th>DSP</th>
                    <th>Gasto</th>
                    <th>Lines</th>
                    <th>% do total</th>
                  </tr>
                </thead>
                <tbody>
                  {spendByDsp.map((row) => (
                    <tr key={`dsp-row-${row.platform}`}>
                      <td>{row.platform}</td>
                      <td>{brl(row.gasto)}</td>
                      <td>{row.lines.toLocaleString("pt-BR")}</td>
                      <td>{totalLinesCost > 0 ? `${((row.gasto / totalLinesCost) * 100).toFixed(1)}%` : "0.0%"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel panelChart">
            <div className="panelHeading">
              <h2>Todas as lines</h2>
              <p>Padrão de leitura alinhado com a tabela de DSP</p>
            </div>
            <div className="tableWrap">
              <table className="campaignDataTable">
                <thead>
                  <tr>
                    <th>DSP</th>
                    <th>Line</th>
                    <th>Gasto</th>
                    <th>% do total</th>
                  </tr>
                </thead>
                <tbody>
                  {lineRows.map((row, index) => (
                    <tr key={`${row.platform}-${row.line}-${row.cliente}-${row.campanha}-${index}`}>
                      <td>{row.platform}</td>
                      <td className="campaignLineCell">
                        <div className="copyCell">
                          <button
                            type="button"
                            className="copyIconButton"
                            aria-label={`Copiar line ${row.line}`}
                            onClick={() => void copyToClipboard(row.line, "Line")}
                          >
                            ⧉
                          </button>
                          <span>{row.line}</span>
                        </div>
                      </td>
                      <td>{brl(row.gasto)}</td>
                      <td>{totalLinesCost > 0 ? `${((row.gasto / totalLinesCost) * 100).toFixed(1)}%` : "0.0%"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
