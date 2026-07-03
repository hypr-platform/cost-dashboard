"use client";

import { useMemo, useState } from "react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import useSWR from "swr";
import {
  fetchGcpBillingDashboard,
  type GcpBillingDashboardResponse,
  type GcpCloudRunByLabelRow,
} from "@/services/api/gcp-billing";
import {
  BRL,
  INT,
  daysAgoKey,
  formatUsd,
  todayKey,
} from "@/features/dashboard/utils/cost-format";
import {
  CostBreakdownTable,
  CostDateRangeControls,
  CostKpi,
  CostMoneyCell,
  type CostColumn,
} from "@/features/dashboard/components/cost";
import GcpCostTimeline from "@/features/dashboard/components/GcpCostTimeline";
import GcpDayDetailModal from "@/features/dashboard/components/GcpDayDetailModal";
import GcpComparisonCard from "@/features/dashboard/components/GcpComparisonCard";

const PIE_COLORS = [
  "#7c6af7", "#4f9cf9", "#34c78a", "#f59e42", "#f06292",
  "#a78bfa", "#38bdf8", "#fb923c", "#4ade80", "#f472b6",
];

type ServiceRow = GcpBillingDashboardResponse["by_service"][number];

function ServicePieChart({ rows }: { rows: ServiceRow[] }) {
  const top = rows.slice(0, 9);
  const others = rows.slice(9);
  const othersTotal = others.reduce((s, r) => s + Number(r.cost_usd), 0);
  const data = [
    ...top.map((r) => ({
      name: r.service_description,
      value: Number(r.cost_usd),
    })),
    ...(othersTotal > 0 ? [{ name: "Outros", value: othersTotal }] : []),
  ];

  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={70}
          outerRadius={110}
          paddingAngle={2}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value) =>
            `US$ ${Number(value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          }
          contentStyle={{
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: 8,
            fontSize: 12,
            color: "#ededed",
          }}
        />
        <Legend
          iconType="circle"
          iconSize={8}
          formatter={(value) => (
            <span style={{ fontSize: 11, color: "#aaa" }}>{value}</span>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

function buildUrl(apiBase: string, from: string, to: string): string {
  const base = apiBase.replace(/\/$/, "");
  const params = new URLSearchParams({ from, to });
  return `${base}/api/gcp-billing/dashboard?${params.toString()}`;
}

export default function GoogleCloudTab() {
  const apiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

  // Estados do input — mudam livremente enquanto o usuário digita
  const [from, setFrom] = useState<string>(daysAgoKey(29));
  const [to, setTo] = useState<string>(todayKey());

  // Estados commitados — só atualizam quando o usuário clica em "Atualizar"
  const [committedFrom, setCommittedFrom] = useState<string>(daysAgoKey(29));
  const [committedTo, setCommittedTo] = useState<string>(todayKey());

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [serviceView, setServiceView] = useState<"table" | "chart">("table");
  const [serviceCollapsed, setServiceCollapsed] = useState(false);

  const url = buildUrl(apiBase, committedFrom, committedTo);
  const { data, error, isValidating, mutate } =
    useSWR<GcpBillingDashboardResponse>(url, fetchGcpBillingDashboard, {
      shouldRetryOnError: false,
      dedupingInterval: 60_000,
      revalidateOnFocus: false,
    });

  function handleRefresh() {
    setCommittedFrom(from);
    setCommittedTo(to);
    mutate();
  }

  const fetchedAt = data?.fetched_at;
  const isCached = Boolean(data?.cached);
  const totalBrl = Number(data?.total_cost_brl ?? 0);
  const totalUsd = Number(data?.total_cost_usd ?? 0);
  const creditsUsd = Number(data?.total_credits_usd ?? 0);
  const grossUsd = Number(data?.total_gross_usd ?? 0);

  const cloudRunLabelColumns = useMemo<CostColumn<GcpCloudRunByLabelRow>[]>(
    () => [
      {
        key: "service",
        header: "Service",
        render: (r) => (
          <span className="claudeTableUserName">{r.service_name}</span>
        ),
      },
      {
        key: "requests",
        header: "Requests",
        align: "right",
        render: (r) => (
          <span className="claudeTableMoneySecondary">
            {r.requests > 0 ? INT.format(r.requests) : "—"}
          </span>
        ),
      },
      {
        key: "latency",
        header: "Latência p50/95/99",
        align: "right",
        render: (r) => {
          const parts = [r.latency_p50_ms, r.latency_p95_ms, r.latency_p99_ms];
          if (parts.every((p) => p == null)) {
            return <span className="claudeTableMoneySecondary">—</span>;
          }
          return (
            <span className="claudeTableMoneySecondary">
              {parts
                .map((p) =>
                  p != null
                    ? Number(p).toLocaleString("pt-BR", {
                        maximumFractionDigits: 0,
                      })
                    : "—",
                )
                .join(" / ")}{" "}
              ms
            </span>
          );
        },
      },
      {
        key: "error_rate",
        header: "% erro",
        align: "right",
        render: (r) => {
          if (r.error_rate == null) {
            return <span className="claudeTableMoneySecondary">—</span>;
          }
          const pct = Number(r.error_rate) * 100;
          const high = pct >= 1;
          return (
            <span
              className={
                high ? "claudeTableMoney" : "claudeTableMoneySecondary"
              }
              style={high ? { color: "#f06292" } : undefined}
            >
              {pct.toLocaleString("pt-BR", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
              %
            </span>
          );
        },
      },
      {
        key: "per_million",
        header: "Custo / 1M req",
        align: "right",
        render: (r) =>
          r.cost_per_million_brl != null && r.cost_per_million_usd != null ? (
            <CostMoneyCell
              brl={r.cost_per_million_brl}
              usd={r.cost_per_million_usd}
            />
          ) : (
            <span className="claudeTableMoneySecondary">—</span>
          ),
      },
      {
        key: "cost",
        header: "Custo",
        align: "right",
        render: (r) => <CostMoneyCell brl={r.cost_brl} usd={r.cost_usd} />,
      },
    ],
    [],
  );

  const serviceColumns = useMemo<CostColumn<GcpBillingDashboardResponse["by_service"][number]>[]>(
    () => [
      {
        key: "service",
        header: "Serviço",
        render: (s) => (
          <>
            <span className="claudeTableUserName">{s.service_description}</span>
            <span className="claudeTableUserEmail">{s.service_id}</span>
          </>
        ),
      },
      {
        key: "cost",
        header: "Custo",
        align: "right",
        render: (s) => <CostMoneyCell brl={s.cost_brl} usd={s.cost_usd} />,
      },
    ],
    [],
  );

  return (
    <div className="claudeTab bqCostTab">
      <header className="claudeHeader">
        <div className="claudeHeaderTitle">
          <h1 className="claudeHeaderHeading">Google Cloud · Billing</h1>
          <p className="claudeHeaderMeta">
            {data ? (
              `${isCached ? "cache" : "live"}${
                fetchedAt
                  ? ` · atualizado ${new Date(fetchedAt).toLocaleString("pt-BR")}`
                  : ""
              } · câmbio ${Number(data.exchange_rate).toLocaleString("pt-BR", {
                maximumFractionDigits: 4,
              })}`
            ) : (
              <span className="claudeHeaderMetaSkeleton" aria-hidden />
            )}
          </p>
        </div>
        <CostDateRangeControls
          from={from}
          to={to}
          onChangeFrom={setFrom}
          onChangeTo={setTo}
          onRefresh={handleRefresh}
          isValidating={isValidating}
        />
      </header>

      {error ? (
        <p className="claudeAlert claudeAlertError">
          {error instanceof Error ? error.message : "Falha ao carregar dados."}
        </p>
      ) : null}

      <section className="bqCostKpis">
        <CostKpi
          label="Custo total (líquido)"
          value={data ? BRL.format(totalBrl) : null}
          hint={data ? formatUsd(totalUsd) : null}
          tooltip={
            data?.currency === "BRL"
              ? "Soma de todos os serviços GCP no período, já com créditos descontados. Valores nativos em BRL — sem conversão de câmbio."
              : `Soma de todos os serviços GCP no período, já com créditos descontados. Conversão USD→BRL pela cotação PTAX do último dia do intervalo (${data ? Number(data.exchange_rate).toLocaleString("pt-BR", { maximumFractionDigits: 4 }) : "—"} R$/USD).`
          }
        />
        <CostKpi
          label="Custo bruto"
          value={data ? formatUsd(grossUsd) : null}
          hint={data ? "antes de créditos" : null}
          tooltip="Custo puro de consumo, sem descontar nenhum crédito. É o valor que seria cobrado se não houvesse sustained use discounts, free tier ou créditos de suporte."
        />
        <CostKpi
          label="Créditos aplicados"
          value={data ? formatUsd(creditsUsd) : null}
          hint={data ? "descontados do bruto" : null}
          tooltip="Total de créditos que o GCP descontou no período: sustained use discounts, free tier, créditos de suporte, etc. O valor é negativo pois reduz o custo bruto."
        />
      </section>

      {data?.daily.length ? (
        <GcpCostTimeline daily={data.daily} onDaySelect={setSelectedDay} />
      ) : null}

      {selectedDay ? (
        <GcpDayDetailModal
          date={selectedDay}
          apiBase={apiBase}
          onClose={() => setSelectedDay(null)}
        />
      ) : null}

      <GcpComparisonCard
        apiBase={apiBase}
        from={committedFrom}
        to={committedTo}
      />

      <CostBreakdownTable
        title="Cloud Run · por service"
        hint={
          data ? (
            data.cloud_run_by_label.length
              ? `${data.cloud_run_by_label.length} services`
              : "sem dados de Cloud Run no período"
          ) : (
            <span className="claudeTableHintSkeleton" aria-hidden />
          )
        }
        rows={data?.cloud_run_by_label}
        error={error}
        rowKey={(r) => r.service_name}
        columns={cloudRunLabelColumns}
        emptyMessage="Sem dados de Cloud Run no período."
      />

      <section className="claudeTableCard">
        <div className="gcpServiceHeader">
          <button
            type="button"
            className="claudeTableHeaderBtn"
            style={{ width: "auto", flex: 1 }}
            onClick={() => setServiceCollapsed((c) => !c)}
            aria-expanded={!serviceCollapsed}
          >
            <span className="claudeTableHeaderBtnLeft">
              <svg
                className={`claudeTableChevron${serviceCollapsed ? " claudeTableChevronCollapsed" : ""}`}
                viewBox="0 0 12 12"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
              </svg>
              <h2 className="claudeTableTitle">Por serviço</h2>
            </span>
            <span className="claudeTableHint">
              {data ? (
                `${data.by_service.filter((s) => Number(s.cost_usd) > 0).length} serviços`
              ) : (
                <span className="claudeTableHintSkeleton" aria-hidden />
              )}
            </span>
          </button>
          {!serviceCollapsed ? (
            <div className="gcpServiceTabs">
              <button
                type="button"
                className={`gcpServiceTab${serviceView === "table" ? " gcpServiceTabActive" : ""}`}
                onClick={() => setServiceView("table")}
              >
                Tabela
              </button>
              <button
                type="button"
                className={`gcpServiceTab${serviceView === "chart" ? " gcpServiceTabActive" : ""}`}
                onClick={() => setServiceView("chart")}
              >
                Gráfico
              </button>
            </div>
          ) : null}
        </div>
        {!serviceCollapsed && serviceView === "table" ? (
          (() => {
            const visibleRows = data?.by_service.filter((s) => Number(s.cost_usd) > 0);
            if (!visibleRows && !error) return (
              <table className="claudeTable claudeTableLoading" aria-hidden>
                <thead><tr>{serviceColumns.map((c) => <th key={c.key} className="claudeTableColUser">{c.header}</th>)}</tr></thead>
                <tbody>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      <td className="claudeTableColUser"><span className="claudeTableCellSkeleton claudeTableCellSkeletonText" /><span className="claudeTableCellSkeleton claudeTableCellSkeletonSub" /></td>
                      <td className="claudeTableColNum"><span className="claudeTableCellSkeleton claudeTableCellSkeletonNum" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
            if (!visibleRows?.length) return <p className="claudeAlert">Sem dados no intervalo.</p>;
            return (
              <table className="claudeTable">
                <thead><tr>{serviceColumns.map((c) => <th key={c.key} className={c.align === "right" ? "claudeTableColNum" : "claudeTableColUser"}>{c.header}</th>)}</tr></thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={row.service_id || row.service_description}>
                      {serviceColumns.map((c) => (
                        <td key={c.key} className={c.align === "right" ? "claudeTableColNum" : "claudeTableColUser"}>{c.render(row)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()
        ) : !serviceCollapsed ? (
          data?.by_service.filter((s) => Number(s.cost_usd) > 0).length ? (
            <ServicePieChart
              rows={data.by_service.filter((s) => Number(s.cost_usd) > 0)}
            />
          ) : (
            <p className="claudeAlert">Sem dados no intervalo.</p>
          )
        ) : null}
      </section>
    </div>
  );
}
