"use client";

import { Fragment, useMemo, useState } from "react";
import useSWR from "swr";
import {
  fetchBigQueryCostDashboard,
  type BqCostDashboardResponse,
} from "@/services/api/bigquery-cost";
import {
  BRL,
  INT,
  dayLabel,
  daysAgoKey,
  emailLabel,
  formatBytes,
  formatSlotHours,
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

function buildUrl(
  apiBase: string,
  from: string,
  to: string,
  regions: string,
): string {
  const base = apiBase.replace(/\/$/, "");
  const params = new URLSearchParams({ from, to });
  const trimmed = regions.trim();
  if (trimmed) params.set("regions", trimmed);
  return `${base}/api/bigquery-cost/dashboard?${params.toString()}`;
}

export default function BigQueryTab() {
  const apiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  const [from, setFrom] = useState<string>(daysAgoKey(29));
  const [to, setTo] = useState<string>(todayKey());
  const [regions, setRegions] = useState<string>("");
  const [expandedQuery, setExpandedQuery] = useState<string | null>(null);

  const url = buildUrl(apiBase, from, to, regions);
  const { data, error, isValidating, mutate } =
    useSWR<BqCostDashboardResponse>(url, fetchBigQueryCostDashboard, {
      shouldRetryOnError: false,
      dedupingInterval: 60_000,
      revalidateOnFocus: false,
    });

  const totalBrl = Number(data?.total_cost_brl ?? 0);
  const totalUsd = Number(data?.total_cost_usd ?? 0);
  const fetchedAt = data?.fetched_at;
  const isCached = Boolean(data?.cached);

  const userColumns = useMemo<CostColumn<BqCostDashboardResponse["by_user"][number]>[]>(
    () => [
      {
        key: "user",
        header: "Usuário",
        render: (u) => (
          <>
            <span className="claudeTableUserName">
              {emailLabel(u.user_email)}
            </span>
            <span className="claudeTableUserEmail">{u.user_email}</span>
          </>
        ),
      },
      {
        key: "jobs",
        header: "Jobs",
        align: "right",
        render: (u) => INT.format(u.jobs),
      },
      {
        key: "bytes",
        header: "Bytes",
        align: "right",
        render: (u) => formatBytes(u.bytes_billed),
      },
      {
        key: "slot",
        header: "Slot",
        align: "right",
        render: (u) => formatSlotHours(u.slot_ms),
      },
      {
        key: "cost",
        header: "Custo",
        align: "right",
        render: (u) => <CostMoneyCell brl={u.cost_brl} usd={u.cost_usd} />,
      },
    ],
    [],
  );

  const stmtColumns = useMemo<CostColumn<BqCostDashboardResponse["by_statement_type"][number]>[]>(
    () => [
      {
        key: "stmt",
        header: "Tipo",
        render: (s) => (
          <span className="claudeTableUserName">{s.statement_type}</span>
        ),
      },
      {
        key: "jobs",
        header: "Jobs",
        align: "right",
        render: (s) => INT.format(s.jobs),
      },
      {
        key: "bytes",
        header: "Bytes",
        align: "right",
        render: (s) => formatBytes(s.bytes_billed),
      },
      {
        key: "slot",
        header: "Slot",
        align: "right",
        render: (s) => formatSlotHours(s.slot_ms),
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

  const tableColumns = useMemo<CostColumn<BqCostDashboardResponse["by_table"][number]>[]>(
    () => [
      {
        key: "table",
        header: "Tabela",
        render: (t) => (
          <span className="claudeTableUserEmail">{t.table_fqn}</span>
        ),
      },
      {
        key: "jobs",
        header: "Jobs",
        align: "right",
        render: (t) => INT.format(t.jobs),
      },
      {
        key: "bytes",
        header: "Bytes",
        align: "right",
        render: (t) => formatBytes(t.bytes_billed),
      },
      {
        key: "cost",
        header: "Custo",
        align: "right",
        render: (t) => <CostMoneyCell brl={t.cost_brl} usd={t.cost_usd} />,
      },
    ],
    [],
  );

  return (
    <div className="claudeTab bqCostTab">
      <header className="claudeHeader">
        <div className="claudeHeaderTitle">
          <h1 className="claudeHeaderHeading">Custos BigQuery</h1>
          <p className="claudeHeaderSubtitle">
            Queries cobradas entre {dayLabel(from)} e {dayLabel(to)} ·
            estimativa on-demand a {data?.price_usd_per_tib ?? "—"} USD/TiB.
          </p>
          <p className="claudeHeaderMeta">
            {data
              ? `${isCached ? "cache" : "live"}${
                  fetchedAt
                    ? ` · atualizado ${new Date(fetchedAt).toLocaleString("pt-BR")}`
                    : ""
                } · regiões: ${data.regions.join(", ") || "—"}`
              : "Carregando…"}
          </p>
        </div>
        <CostDateRangeControls
          from={from}
          to={to}
          onChangeFrom={setFrom}
          onChangeTo={setTo}
          onRefresh={() => mutate()}
          isValidating={isValidating}
          extraFields={
            <label className="bqCostField">
              <span className="bqCostFieldLabel">Regiões</span>
              <input
                type="text"
                className="claudeDayInput bqCostRegionsInput"
                placeholder="ex: us,southamerica-east1"
                value={regions}
                onChange={(e) => setRegions(e.target.value)}
              />
            </label>
          }
        />
      </header>

      {error ? (
        <p className="claudeAlert claudeAlertError">
          {error instanceof Error ? error.message : "Falha ao carregar dados."}
        </p>
      ) : null}

      <section className="bqCostKpis">
        <CostKpi
          label="Custo total"
          value={data ? BRL.format(totalBrl) : null}
          hint={data ? formatUsd(totalUsd) : null}
        />
        <CostKpi
          label="Bytes faturados"
          value={data ? formatBytes(data.total_bytes_billed) : null}
          hint={data ? `${INT.format(data.total_bytes_billed)} bytes` : null}
        />
        <CostKpi
          label="Jobs"
          value={data ? INT.format(data.total_jobs) : null}
          hint={data ? formatSlotHours(data.total_slot_ms) : null}
        />
      </section>

      <CostBreakdownTable
        title="Por usuário"
        hint={data ? `${data.by_user.length} usuários` : "—"}
        rows={data?.by_user}
        error={error}
        rowKey={(u) => u.user_email}
        columns={userColumns}
        emptyMessage="Nenhum job no intervalo."
      />

      <CostBreakdownTable
        title="Por statement type"
        hint={data ? `${data.by_statement_type.length} tipos` : "—"}
        rows={data?.by_statement_type}
        error={error}
        rowKey={(s) => s.statement_type}
        columns={stmtColumns}
      />

      <CostBreakdownTable
        title="Top tabelas referenciadas"
        hint="Custo rateado entre as tabelas referenciadas em cada job."
        rows={data?.by_table}
        error={error}
        rowKey={(t) => t.table_fqn}
        columns={tableColumns}
      />

      <section className="claudeTableCard">
        <div className="claudeTableHeader">
          <h2 className="claudeTableTitle">Top 10 queries mais caras</h2>
          <span className="claudeTableHint">Clique para ver o SQL.</span>
        </div>
        {data && data.top_queries.length > 0 ? (
          <table className="claudeTable">
            <thead>
              <tr>
                <th className="claudeTableColUser">Job / usuário</th>
                <th className="claudeTableColNum">Bytes</th>
                <th className="claudeTableColNum">Slot</th>
                <th className="claudeTableColNum">Custo</th>
              </tr>
            </thead>
            <tbody>
              {data.top_queries.map((q) => {
                const isOpen = expandedQuery === q.job_id;
                return (
                  <Fragment key={q.job_id}>
                    <tr
                      onClick={() =>
                        setExpandedQuery(isOpen ? null : q.job_id)
                      }
                      style={{ cursor: "pointer" }}
                    >
                      <td className="claudeTableColUser">
                        <span className="claudeTableUserName">
                          {q.user_email
                            ? emailLabel(q.user_email)
                            : "(sem usuário)"}
                        </span>
                        <span className="claudeTableUserEmail">
                          {q.statement_type ?? "—"} · {q.region} ·{" "}
                          {new Date(q.creation_time).toLocaleString("pt-BR")}
                        </span>
                      </td>
                      <td className="claudeTableColNum">
                        {formatBytes(q.bytes_billed)}
                      </td>
                      <td className="claudeTableColNum">
                        {formatSlotHours(q.slot_ms)}
                      </td>
                      <td className="claudeTableColNum">
                        <CostMoneyCell brl={q.cost_brl} usd={q.cost_usd} />
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr>
                        <td colSpan={4} className="bqCostQueryCell">
                          <pre className="bqCostQuerySql">
                            {q.query_preview}
                          </pre>
                          <span className="claudeTableUserEmail">
                            job_id: {q.job_id}
                          </span>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </section>
    </div>
  );
}
