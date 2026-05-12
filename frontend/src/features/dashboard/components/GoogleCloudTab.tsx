"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  fetchGcpBillingDashboard,
  type GcpBillingDashboardResponse,
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

function buildUrl(apiBase: string, from: string, to: string): string {
  const base = apiBase.replace(/\/$/, "");
  const params = new URLSearchParams({ from, to });
  return `${base}/api/gcp-billing/dashboard?${params.toString()}`;
}

export default function GoogleCloudTab() {
  const apiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  const [from, setFrom] = useState<string>(daysAgoKey(29));
  const [to, setTo] = useState<string>(todayKey());

  const url = buildUrl(apiBase, from, to);
  const { data, error, isValidating, mutate } =
    useSWR<GcpBillingDashboardResponse>(url, fetchGcpBillingDashboard, {
      shouldRetryOnError: false,
      dedupingInterval: 60_000,
      revalidateOnFocus: false,
    });

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
          <p className="claudeHeaderSubtitle">
            Consumo do GCP entre {dayLabel(from)} e {dayLabel(to)} · custo
            líquido (depois de créditos).
          </p>
          <p className="claudeHeaderMeta">
            {data
              ? `${isCached ? "cache" : "live"}${
                  fetchedAt
                    ? ` · atualizado ${new Date(fetchedAt).toLocaleString("pt-BR")}`
                    : ""
                } · câmbio ${Number(data.exchange_rate).toLocaleString("pt-BR", {
                  maximumFractionDigits: 4,
                })}`
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
        />
        <CostKpi
          label="Custo bruto"
          value={data ? formatUsd(grossUsd) : null}
          hint={data ? "antes de créditos" : null}
        />
        <CostKpi
          label="Créditos aplicados"
          value={data ? formatUsd(creditsUsd) : null}
          hint={data ? `${INT.format(data.by_project.length)} projetos` : null}
        />
      </section>

      <CostBreakdownTable
        title="Por projeto"
        hint={data ? `${data.by_project.length} projetos` : "—"}
        rows={data?.by_project}
        error={error}
        rowKey={(p) => p.project_id}
        columns={projectColumns}
      />

      <CostBreakdownTable
        title="Por serviço"
        hint={data ? `${data.by_service.length} serviços` : "—"}
        rows={data?.by_service}
        error={error}
        rowKey={(s) => s.service_id || s.service_description}
        columns={serviceColumns}
      />

      <CostBreakdownTable
        title="Top SKUs"
        hint="Top 50 por custo líquido."
        rows={data?.by_sku}
        error={error}
        rowKey={(s) => s.sku_id || s.sku_description}
        columns={skuColumns}
      />
    </div>
  );
}
