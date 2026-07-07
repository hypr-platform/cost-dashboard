"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  fetchVercelCostDashboard,
  type VercelCostResponse,
  type VercelProjectRow,
  type VercelRegionRow,
  type VercelServiceRow,
  type VercelChargeCategoryRow,
} from "@/services/api/vercel-cost";
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
import VercelCostTimeline from "@/features/dashboard/components/VercelCostTimeline";

function buildUrl(apiBase: string, from: string, to: string): string {
  const base = apiBase.replace(/\/$/, "");
  const params = new URLSearchParams({ from, to });
  return `${base}/api/vercel-cost/dashboard?${params.toString()}`;
}

function SharePct({ value }: { value: string }) {
  const pct = Number(value);
  return (
    <span className="vercelSharePct">
      <span className="vercelShareTrack" aria-hidden>
        <span
          className="vercelShareBar"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </span>
      <span className="vercelShareLabel">
        {pct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
      </span>
    </span>
  );
}

function formatQuantity(qty: number | null, unit: string | null): string {
  if (qty == null || !Number.isFinite(qty)) return "—";
  const value = qty.toLocaleString("pt-BR", {
    maximumFractionDigits: qty >= 100 ? 0 : 2,
  });
  return unit ? `${value} ${unit}` : value;
}

export default function VercelTab() {
  const apiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  const [from, setFrom] = useState<string>(daysAgoKey(29));
  const [to, setTo] = useState<string>(todayKey());
  const [committedFrom, setCommittedFrom] = useState<string>(daysAgoKey(29));
  const [committedTo, setCommittedTo] = useState<string>(todayKey());

  const url = buildUrl(apiBase, committedFrom, committedTo);
  const { data, error, isValidating, mutate } = useSWR<VercelCostResponse>(
    url,
    fetchVercelCostDashboard,
    {
      shouldRetryOnError: false,
      dedupingInterval: 60_000,
      revalidateOnFocus: false,
    },
  );

  function handleRefresh() {
    setCommittedFrom(from);
    setCommittedTo(to);
    mutate();
  }

  const totalBrl = Number(data?.total_billed_brl ?? 0);
  const totalUsd = Number(data?.total_billed_usd ?? 0);
  const effectiveBrl = Number(data?.total_effective_brl ?? 0);
  const effectiveUsd = Number(data?.total_effective_usd ?? 0);
  const creditsBrl = Number(data?.credits_billed_brl ?? 0);
  const fetchedAt = data?.fetched_at;
  const isCached = Boolean(data?.cached);

  const serviceColumns = useMemo<CostColumn<VercelServiceRow>[]>(
    () => [
      {
        key: "service",
        header: "Serviço",
        render: (s) => (
          <>
            <span className="claudeTableUserName">{s.service_name}</span>
            <span className="claudeTableUserEmail">{s.service_category}</span>
          </>
        ),
      },
      {
        key: "quantity",
        header: "Uso",
        align: "right",
        render: (s) => formatQuantity(s.consumed_quantity, s.consumed_unit),
      },
      {
        key: "share",
        header: "Share",
        align: "right",
        render: (s) => <SharePct value={s.share_pct} />,
      },
      {
        key: "cost",
        header: "Custo",
        align: "right",
        render: (s) => <CostMoneyCell brl={s.billed_brl} usd={s.billed_usd} />,
      },
    ],
    [],
  );

  const projectColumns = useMemo<CostColumn<VercelProjectRow>[]>(
    () => [
      {
        key: "project",
        header: "Projeto",
        render: (p) => (
          <>
            <span className="claudeTableUserName">{p.project_name}</span>
            {p.project_id ? (
              <span className="claudeTableUserEmail">{p.project_id}</span>
            ) : null}
          </>
        ),
      },
      {
        key: "share",
        header: "Share",
        align: "right",
        render: (p) => <SharePct value={p.share_pct} />,
      },
      {
        key: "effective",
        header: "Efetivo",
        align: "right",
        render: (p) => (
          <CostMoneyCell brl={p.effective_brl} usd={p.effective_usd} />
        ),
      },
      {
        key: "cost",
        header: "Faturado",
        align: "right",
        render: (p) => <CostMoneyCell brl={p.billed_brl} usd={p.billed_usd} />,
      },
    ],
    [],
  );

  const regionColumns = useMemo<CostColumn<VercelRegionRow>[]>(
    () => [
      {
        key: "region",
        header: "Região",
        render: (r) => <span className="claudeTableUserName">{r.region}</span>,
      },
      {
        key: "share",
        header: "Share",
        align: "right",
        render: (r) => <SharePct value={r.share_pct} />,
      },
      {
        key: "cost",
        header: "Custo",
        align: "right",
        render: (r) => <CostMoneyCell brl={r.billed_brl} usd={r.billed_usd} />,
      },
    ],
    [],
  );

  const categoryColumns = useMemo<CostColumn<VercelChargeCategoryRow>[]>(
    () => [
      {
        key: "category",
        header: "Categoria",
        render: (c) => (
          <span className="claudeTableUserName">{c.category}</span>
        ),
      },
      {
        key: "share",
        header: "Share",
        align: "right",
        render: (c) => <SharePct value={c.share_pct} />,
      },
      {
        key: "cost",
        header: "Custo",
        align: "right",
        render: (c) => <CostMoneyCell brl={c.billed_brl} usd={c.billed_usd} />,
      },
    ],
    [],
  );

  return (
    <div className="claudeTab bqCostTab vercelCostTab">
      <header className="claudeHeader">
        <div className="claudeHeaderTitle">
          <h1 className="claudeHeaderHeading">Custos Vercel</h1>
          <p className="claudeHeaderSubtitle">
            Faturamento da Vercel entre {dayLabel(from)} e {dayLabel(to)} · dados
            FOCUS v1.3 da Billing API
            {data ? ` · câmbio ${Number(data.exchange_rate).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} BRL/USD` : ""}
            .
          </p>
          <p className="claudeHeaderMeta">
            {data
              ? `${isCached ? "cache" : "live"}${
                  fetchedAt
                    ? ` · atualizado ${new Date(fetchedAt).toLocaleString("pt-BR")}`
                    : ""
                } · ${INT.format(data.projects_count)} projetos · ${INT.format(data.services_count)} serviços`
              : "Carregando…"}
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
          label="Custo faturado"
          value={data ? BRL.format(totalBrl) : null}
          hint={data ? formatUsd(totalUsd) : null}
          tooltip="Total que compõe a fatura da Vercel no período (FOCUS BilledCost). É o número que a Vercel cobra, antes de créditos amortizados."
        />
        <CostKpi
          label="Custo efetivo"
          value={data ? BRL.format(effectiveBrl) : null}
          hint={data ? formatUsd(effectiveUsd) : null}
          tooltip="Custo amortizado incluindo créditos, descontos e compromissos pré-pagos (FOCUS EffectiveCost). Reflete o custo econômico real."
        />
        <CostKpi
          label="Créditos aplicados"
          value={data ? BRL.format(creditsBrl) : null}
          hint={data ? "abatido da fatura" : null}
          tooltip="Créditos e ajustes (ChargeCategory = Credit). Normalmente negativo — reduz o valor faturado."
        />
        <CostKpi
          label="Projetos"
          value={data ? INT.format(data.projects_count) : null}
          hint={data ? `${INT.format(data.services_count)} serviços` : null}
          tooltip="Projetos distintos com custo no período (via Tags.ProjectName do FOCUS) e número de serviços cobrados."
        />
      </section>

      {data && data.daily_by_category.length > 0 ? (
        <VercelCostTimeline
          daily={data.daily_by_category}
          categories={data.service_categories}
        />
      ) : null}

      <CostBreakdownTable
        title="Por serviço"
        hint={data ? `${data.by_service.length} serviços cobrados` : "—"}
        rows={data?.by_service}
        error={error}
        rowKey={(s) => `${s.service_name}·${s.service_category}`}
        columns={serviceColumns}
        emptyMessage="Nenhum custo no intervalo."
      />

      <CostBreakdownTable
        title="Por projeto"
        hint={data ? `${data.by_project.length} projetos` : "—"}
        rows={data?.by_project}
        error={error}
        rowKey={(p) => p.project_name}
        columns={projectColumns}
        emptyMessage="Nenhum custo atribuído a projeto."
      />

      <CostBreakdownTable
        title="Por região"
        hint="Custo faturado por região de execução."
        rows={data?.by_region}
        error={error}
        rowKey={(r) => r.region}
        columns={regionColumns}
        emptyMessage="Sem custo regionalizado no intervalo."
        defaultCollapsed
      />

      <CostBreakdownTable
        title="Por tipo de cobrança"
        hint="Uso, compras, créditos, impostos e ajustes (FOCUS ChargeCategory)."
        rows={data?.by_charge_category}
        error={error}
        rowKey={(c) => c.category}
        columns={categoryColumns}
        emptyMessage="Sem cobranças no intervalo."
        defaultCollapsed
      />
    </div>
  );
}
