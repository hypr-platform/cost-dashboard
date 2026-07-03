"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  fetchGcpBillingDayDetail,
  fetchGcpBillingDaySkus,
  type GcpBillingDayDetailResponse,
  type GcpBillingDaySkusResponse,
} from "@/services/api/gcp-billing";
import {
  BRL,
  INT,
  dayLabel,
  formatUsd,
} from "@/features/dashboard/utils/cost-format";
import {
  CostBreakdownTable,
  CostKpi,
  CostMoneyCell,
  type CostColumn,
} from "@/features/dashboard/components/cost";

type Props = {
  /** Dia a detalhar no formato YYYY-MM-DD. */
  date: string;
  apiBase: string;
  onClose: () => void;
};

function buildUrl(apiBase: string, date: string): string {
  const base = apiBase.replace(/\/$/, "");
  const params = new URLSearchParams({ date });
  return `${base}/api/gcp-billing/day-detail?${params.toString()}`;
}

function buildSkusUrl(
  apiBase: string,
  date: string,
  serviceId: string,
): string {
  const base = apiBase.replace(/\/$/, "");
  const params = new URLSearchParams({ date, service_id: serviceId });
  return `${base}/api/gcp-billing/day-detail/skus?${params.toString()}`;
}

export default function GcpDayDetailModal({ date, apiBase, onClose }: Props) {
  const url = buildUrl(apiBase, date);
  const { data, error } = useSWR<GcpBillingDayDetailResponse>(
    url,
    fetchGcpBillingDayDetail,
    {
      shouldRetryOnError: false,
      dedupingInterval: 60_000,
      revalidateOnFocus: false,
    },
  );

  // Drill-down encadeado: serviço selecionado → SKUs daquele serviço no dia.
  const [selectedService, setSelectedService] = useState<{
    id: string;
    description: string;
  } | null>(null);

  const skusUrl = selectedService
    ? buildSkusUrl(apiBase, date, selectedService.id)
    : null;
  const { data: skusData, error: skusError } =
    useSWR<GcpBillingDaySkusResponse>(skusUrl, fetchGcpBillingDaySkus, {
      shouldRetryOnError: false,
      dedupingInterval: 60_000,
      revalidateOnFocus: false,
    });

  // Escape: no drill-down volta; senão fecha. Trava o scroll do body.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (selectedService) setSelectedService(null);
      else onClose();
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, selectedService]);

  const totalBrl = Number(data?.total_cost_brl ?? 0);
  const totalUsd = Number(data?.total_cost_usd ?? 0);
  const creditsUsd = Number(data?.total_credits_usd ?? 0);
  const grossUsd = Number(data?.total_gross_usd ?? 0);

  const serviceColumns = useMemo<
    CostColumn<GcpBillingDayDetailResponse["by_service"][number]>[]
  >(
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

  const skuColumns = useMemo<
    CostColumn<GcpBillingDaySkusResponse["by_sku"][number]>[]
  >(
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

  const serviceRows = data?.by_service.filter((s) => Number(s.cost_usd) !== 0);

  return (
    <div
      className="gcpDayModalOverlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Detalhamento de custo · ${dayLabel(date)}`}
      onClick={onClose}
    >
      <div
        className="gcpDayModal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="gcpDayModalHeader">
          <div className="gcpDayModalTitle">
            <h2 className="claudeHeaderHeading">Detalhamento · {dayLabel(date)}</h2>
            <p className="claudeHeaderMeta">
              {data ? (
                `${data.cached ? "cache" : "live"} · câmbio ${Number(
                  data.exchange_rate,
                ).toLocaleString("pt-BR", { maximumFractionDigits: 4 })}`
              ) : (
                <span className="claudeHeaderMetaSkeleton" aria-hidden />
              )}
            </p>
          </div>
          <button
            type="button"
            className="gcpDayModalClose"
            onClick={onClose}
            aria-label="Fechar"
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="gcpDayModalBody">
          {error ? (
            <p className="claudeAlert claudeAlertError">
              {error instanceof Error
                ? error.message
                : "Falha ao carregar detalhamento."}
            </p>
          ) : null}

          <section className="bqCostKpis">
            <CostKpi
              label="Custo do dia (líquido)"
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

          {selectedService ? (
            <div className="gcpDrillView">
              <button
                type="button"
                className="gcpDrillBack"
                onClick={() => setSelectedService(null)}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m10 3-5 5 5 5" />
                </svg>
                Voltar aos serviços
              </button>
              <CostBreakdownTable
                title={`SKUs · ${selectedService.description}`}
                hint={
                  skusData
                    ? `${skusData.by_sku.length} SKUs`
                    : undefined
                }
                rows={skusData?.by_sku}
                error={skusError}
                rowKey={(s) => s.sku_id || s.sku_description}
                columns={skuColumns}
                emptyMessage="Sem SKUs para este serviço no dia."
              />
            </div>
          ) : (
            <>
              <CostBreakdownTable
                title="Por serviço"
                hint={
                  data
                    ? `${serviceRows?.length ?? 0} serviços · clique para ver SKUs`
                    : undefined
                }
                rows={serviceRows}
                error={error}
                rowKey={(s) => s.service_id || s.service_description}
                columns={serviceColumns}
                onRowClick={(s) =>
                  setSelectedService({
                    id: s.service_id,
                    description: s.service_description,
                  })
                }
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
