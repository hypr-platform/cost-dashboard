"use client";

import { useMemo, useState } from "react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
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
  dayLabel,
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

type SkuRow = GcpBillingDashboardResponse["by_sku"][number];

function SkuBarChart({ rows }: { rows: SkuRow[] }) {
  const top15 = rows.slice(0, 15);
  const data = top15.map((r) => ({
    name: r.sku_description.length > 30
      ? r.sku_description.slice(0, 28) + "…"
      : r.sku_description,
    fullName: r.sku_description,
    service: r.service_description,
    usd: Number(r.cost_usd),
  })).reverse();

  return (
    <ResponsiveContainer width="100%" height={Math.max(260, data.length * 28)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={(v) =>
            v >= 1000
              ? `US$ ${(v / 1000).toFixed(0)}k`
              : `US$ ${v.toFixed(0)}`
          }
          tick={{ fontSize: 10, fill: "#666" }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={180}
          tick={{ fontSize: 10, fill: "#aaa" }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          formatter={(value) =>
            `US$ ${Number(value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          }
          labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName ?? ""}
          labelStyle={{ color: "#aaa", fontSize: 11, marginBottom: 4 }}
          contentStyle={{
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: 8,
            fontSize: 12,
            color: "#ededed",
          }}
          cursor={{ fill: "rgba(255,255,255,0.03)" }}
        />
        <Bar dataKey="usd" fill="#4f9cf9" radius={[0, 3, 3, 0]} maxBarSize={18} />
      </BarChart>
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

  const [serviceView, setServiceView] = useState<"table" | "chart">("table");
  const [serviceCollapsed, setServiceCollapsed] = useState(false);
  const [skuCollapsed, setSkuCollapsed] = useState(false);
  const [skuView, setSkuView] = useState<"table" | "chart">("table");

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

  const projectColumns = useMemo<CostColumn<GcpBillingDashboardResponse["by_project"][number]>[]>(
    () => [
      {
        key: "project",
        header: "Projeto",
        render: (p) => (
          <>
            <span className="claudeTableUserName">
              {p.project_name || p.project_id}
            </span>
            <span className="claudeTableUserEmail">{p.project_id}</span>
          </>
        ),
      },
      {
        key: "credits",
        header: "Créditos",
        align: "right",
        render: (p) => (
          <span className="claudeTableMoneySecondary">
            {formatUsd(p.credits_usd)}
          </span>
        ),
      },
      {
        key: "cost",
        header: "Custo",
        align: "right",
        render: (p) => <CostMoneyCell brl={p.cost_brl} usd={p.cost_usd} />,
      },
    ],
    [],
  );

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

  const skuColumns = useMemo<CostColumn<GcpBillingDashboardResponse["by_sku"][number]>[]>(
    () => [
      {
        key: "sku",
        header: "SKU",
        render: (s) => (
          <>
            <span className="claudeTableUserName">{s.sku_description}</span>
            <span className="claudeTableUserEmail">
              {s.service_description} · {s.sku_id}
            </span>
          </>
        ),
      },
      {
        key: "usage",
        header: "Uso",
        align: "right",
        render: (s) => (
          <span className="claudeTableMoneySecondary">
            {Number(s.usage_amount).toLocaleString("pt-BR", {
              maximumFractionDigits: 2,
            })}
            {s.usage_unit ? ` ${s.usage_unit}` : ""}
          </span>
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
          hint={data ? `${INT.format(data.by_project.length)} projetos` : null}
          tooltip="Total de créditos que o GCP descontou no período: sustained use discounts, free tier, créditos de suporte, etc. O valor é negativo pois reduz o custo bruto."
        />
      </section>

      {data?.daily.length ? (
        <GcpCostTimeline daily={data.daily} />
      ) : null}

      <CostBreakdownTable
        title="Cloud Run · por service"
        hint={
          data ? (
            data.cloud_run_by_label.length
              ? `${data.cloud_run_by_label.length} services`
              : "aguardando dados (labels adicionados hoje)"
          ) : (
            <span className="claudeTableHintSkeleton" aria-hidden />
          )
        }
        rows={data?.cloud_run_by_label}
        error={error}
        rowKey={(r) => r.service_name}
        columns={cloudRunLabelColumns}
        emptyMessage="Nenhum custo de Cloud Run com label 'service' no período. Os labels foram adicionados hoje — dados aparecerão a partir de amanhã."
      />

      <CostBreakdownTable
        title="Por projeto"
        hint={
          data ? (
            `${data.by_project.filter((p) => Number(p.cost_usd) > 0).length} projetos`
          ) : (
            <span className="claudeTableHintSkeleton" aria-hidden />
          )
        }
        rows={data?.by_project.filter((p) => Number(p.cost_usd) > 0)}
        error={error}
        rowKey={(p) => p.project_id}
        columns={projectColumns}
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


      <section className="claudeTableCard">
        <div className="gcpServiceHeader">
          <button
            type="button"
            className="claudeTableHeaderBtn"
            style={{ width: "auto", flex: 1 }}
            onClick={() => setSkuCollapsed((c) => !c)}
            aria-expanded={!skuCollapsed}
          >
            <span className="claudeTableHeaderBtnLeft">
              <svg
                className={`claudeTableChevron${skuCollapsed ? " claudeTableChevronCollapsed" : ""}`}
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
              <h2 className="claudeTableTitle">Top SKUs</h2>
            </span>
            <span className="claudeTableHint">Top 50 por custo líquido.</span>
          </button>
          {!skuCollapsed ? (
            <div className="gcpServiceTabs">
              <button
                type="button"
                className={`gcpServiceTab${skuView === "table" ? " gcpServiceTabActive" : ""}`}
                onClick={() => setSkuView("table")}
              >
                Tabela
              </button>
              <button
                type="button"
                className={`gcpServiceTab${skuView === "chart" ? " gcpServiceTabActive" : ""}`}
                onClick={() => setSkuView("chart")}
              >
                Gráfico
              </button>
            </div>
          ) : null}
        </div>
        {!skuCollapsed ? (
          skuView === "table" ? (() => {
            if (!data?.by_sku && !error) return (
              <table className="claudeTable claudeTableLoading" aria-hidden>
                <thead><tr>{skuColumns.map((c) => <th key={c.key} className={c.align === "right" ? "claudeTableColNum" : "claudeTableColUser"}>{c.header}</th>)}</tr></thead>
                <tbody>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i}>
                      <td className="claudeTableColUser"><span className="claudeTableCellSkeleton claudeTableCellSkeletonText" /><span className="claudeTableCellSkeleton claudeTableCellSkeletonSub" /></td>
                      {[1,2].map((j) => <td key={j} className="claudeTableColNum"><span className="claudeTableCellSkeleton claudeTableCellSkeletonNum" /></td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
            if (!data?.by_sku?.length) return <p className="claudeAlert">Sem dados no intervalo.</p>;
            return (
              <table className="claudeTable">
                <thead><tr>{skuColumns.map((c) => <th key={c.key} className={c.align === "right" ? "claudeTableColNum" : "claudeTableColUser"}>{c.header}</th>)}</tr></thead>
                <tbody>
                  {data.by_sku.map((row) => (
                    <tr key={row.sku_id || row.sku_description}>
                      {skuColumns.map((c) => (
                        <td key={c.key} className={c.align === "right" ? "claudeTableColNum" : "claudeTableColUser"}>{c.render(row)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })() : (
            data?.by_sku.length ? (
              <SkuBarChart rows={data.by_sku} />
            ) : (
              <p className="claudeAlert">Sem dados no intervalo.</p>
            )
          )
        ) : null}
      </section>
    </div>
  );
}
