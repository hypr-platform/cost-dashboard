"use client";

import { useMemo } from "react";
import useSWR from "swr";
import {
  fetchGcpBillingComparison,
  type GcpBillingComparisonResponse,
  type GcpServiceDeltaRow,
} from "@/services/api/gcp-billing";
import { formatBrl } from "@/features/dashboard/utils/cost-format";
import {
  CostBreakdownTable,
  type CostColumn,
} from "@/features/dashboard/components/cost";

type Props = {
  apiBase: string;
  from: string;
  to: string;
};

// Custo subindo é ruim (rosa); descendo é bom (verde).
const UP_COLOR = "#f06292";
const DOWN_COLOR = "#34c78a";

function buildUrl(apiBase: string, from: string, to: string): string {
  const base = apiBase.replace(/\/$/, "");
  const params = new URLSearchParams({ from, to });
  return `${base}/api/gcp-billing/compare?${params.toString()}`;
}

/** Valor compacto e legível de relance: R$ 13,1k / R$ 1,2M. */
function compactBrl(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `R$ ${(abs / 1_000_000).toFixed(1).replace(".", ",")}M`;
  if (abs >= 1_000) return `R$ ${(abs / 1_000).toFixed(1).replace(".", ",")}k`;
  return `R$ ${abs.toFixed(0)}`;
}

function formatPct(pct: string | null): string {
  if (pct == null) return "novo";
  const v = Number(pct) * 100;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`;
}

function daysInclusive(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z").getTime();
  const b = new Date(to + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Variação como âncora visual: seta + valor colorido + %. */
function DeltaValue({
  deltaBrl,
  pct,
  compact = true,
}: {
  deltaBrl: string;
  pct: string | null;
  compact?: boolean;
}) {
  const d = Number(deltaBrl);
  if (d === 0) return <span className="claudeTableMoneySecondary">—</span>;
  const up = d > 0;
  const color = up ? UP_COLOR : DOWN_COLOR;
  const value = compact ? compactBrl(Math.abs(d)) : formatBrl(Math.abs(d));
  return (
    <span style={{ color, fontWeight: 600, fontFeatureSettings: '"tnum"' }}>
      {up ? "▲" : "▼"} {up ? "+" : "−"}
      {value}
      <span style={{ opacity: 0.7, marginLeft: 6, fontWeight: 400 }}>
        {formatPct(pct)}
      </span>
    </span>
  );
}

export default function GcpComparisonCard({ apiBase, from, to }: Props) {
  const url = buildUrl(apiBase, from, to);
  const { data, error } = useSWR<GcpBillingComparisonResponse>(
    url,
    fetchGcpBillingComparison,
    {
      shouldRetryOnError: false,
      dedupingInterval: 60_000,
      revalidateOnFocus: false,
    },
  );

  const columns = useMemo<CostColumn<GcpServiceDeltaRow>[]>(
    () => [
      {
        key: "service",
        header: "Serviço",
        render: (r) => (
          <span className="claudeTableUserName">{r.service_description}</span>
        ),
      },
      {
        key: "flow",
        header: "Antes → Agora",
        align: "right",
        render: (r) => (
          <span
            className="claudeTableMoneySecondary"
            style={{ fontFeatureSettings: '"tnum"' }}
          >
            {compactBrl(Number(r.previous_brl))}
            <span style={{ opacity: 0.4, margin: "0 6px" }}>→</span>
            {compactBrl(Number(r.current_brl))}
          </span>
        ),
      },
      {
        key: "delta",
        header: "Variação",
        align: "right",
        render: (r) => <DeltaValue deltaBrl={r.delta_brl} pct={r.delta_pct} />,
      },
    ],
    [],
  );

  // Só serviços que de fato mudaram — o resto é ruído.
  const movers = data?.by_service_delta.filter(
    (r) => Number(r.delta_brl) !== 0,
  );

  const nDays = daysInclusive(from, to);
  const title = `O que mudou · últimos ${nDays}d vs. ${nDays}d anteriores`;

  const hint =
    data != null ? (
      <span style={{ fontFeatureSettings: '"tnum"' }}>
        {formatBrl(data.previous_total_brl)}
        <span style={{ opacity: 0.4, margin: "0 6px" }}>→</span>
        <span style={{ color: "#ededed" }}>
          {formatBrl(data.current_total_brl)}
        </span>
        <span style={{ margin: "0 8px", opacity: 0.3 }}>·</span>
        <DeltaValue
          deltaBrl={data.delta_total_brl}
          pct={data.delta_total_pct}
          compact={false}
        />
      </span>
    ) : undefined;

  return (
    <CostBreakdownTable
      title={title}
      hint={hint}
      rows={movers}
      error={error}
      rowKey={(r) => r.service_id || r.service_description}
      columns={columns}
      emptyMessage="Sem variação entre os períodos."
    />
  );
}
