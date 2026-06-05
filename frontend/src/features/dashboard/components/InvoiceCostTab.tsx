"use client";

import { useState } from "react";
import {
  Line, Bar, ComposedChart, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import useSWR from "swr";
import {
  fetchInvoiceCostDashboard,
  type InvoiceCostResponse,
} from "@/services/api/invoice-cost";
import {
  BRL, INT, daysAgoKey, todayKey,
} from "@/features/dashboard/utils/cost-format";
import {
  CostDateRangeControls,
  CostKpi,
} from "@/features/dashboard/components/cost";

function buildUrl(apiBase: string, from: string, to: string): string {
  const base = apiBase.replace(/\/$/, "");
  const params = new URLSearchParams({ from, to });
  return `${base}/api/invoice-cost/dashboard?${params.toString()}`;
}

function fmtBrl4(v: string | number): string {
  const n = Number(v);
  return `R$ ${(Number.isFinite(n) ? n : 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })}`;
}

type ChartPoint = {
  label: string;
  notas: number;
  custo: number;
  captcha: number;
  invoiceReader: number;
  porNota: number;
};

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { payload: ChartPoint }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div
      style={{
        background: "#1a1a1a",
        border: "1px solid #333",
        borderRadius: 8,
        fontSize: 12,
        color: "#ededed",
        padding: "8px 10px",
        lineHeight: 1.6,
      }}
    >
      <div style={{ color: "#aaa", fontSize: 11, marginBottom: 4 }}>{label}</div>
      <div style={{ color: "#4f9cf9" }}>
        Notas: {p.notas.toLocaleString("pt-BR")}
      </div>
      <div style={{ color: "#f59e42" }}>
        invoice-reader: R${" "}
        {p.invoiceReader.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
      <div style={{ color: "#a78bfa" }}>
        captcha: R${" "}
        {p.captcha.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
      <div style={{ color: "#ededed" }}>
        Total: R${" "}
        {p.custo.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
      <div style={{ color: "#34c78a" }}>Custo/nota: {fmtBrl4(p.porNota)}</div>
    </div>
  );
}

export default function InvoiceCostTab() {
  const apiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  const [from, setFrom] = useState<string>(daysAgoKey(29));
  const [to, setTo] = useState<string>(todayKey());
  const [committedFrom, setCommittedFrom] = useState<string>(daysAgoKey(29));
  const [committedTo, setCommittedTo] = useState<string>(todayKey());
  const [tableCollapsed, setTableCollapsed] = useState(false);
  // séries escondidas via clique na legenda
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  function toggleSeries(key: string) {
    setHidden((h) => ({ ...h, [key]: !h[key] }));
  }

  const url = buildUrl(apiBase, committedFrom, committedTo);
  const { data, error, isValidating, mutate } = useSWR<InvoiceCostResponse>(
    url,
    fetchInvoiceCostDashboard,
    { shouldRetryOnError: false, dedupingInterval: 60_000, revalidateOnFocus: false },
  );

  function handleRefresh() {
    setCommittedFrom(from);
    setCommittedTo(to);
    mutate();
  }

  const fetchedAt = data?.fetched_at;
  const isCached = Boolean(data?.cached);
  const totalInvoices = Number(data?.total_invoices ?? 0);
  const totalCost = Number(data?.total_cost_brl ?? 0);
  const avgPerInvoice = Number(data?.avg_cost_per_invoice_brl ?? 0);

  // Série cronológica (asc) para o gráfico
  const chartData = (data?.daily ?? [])
    .slice()
    .reverse()
    .map((d) => {
      const [, m, dd] = d.day.split("-");
      return {
        label: `${dd}/${m}`,
        notas: d.invoices,
        custo: Number(d.total_brl),
        captcha: Number(d.captcha_brl),
        invoiceReader: Number(d.invoice_reader_brl),
        porNota: Number(d.cost_per_invoice_brl),
      };
    });

  return (
    <div className="claudeTab bqCostTab">
      <header className="claudeHeader">
        <div className="claudeHeaderTitle">
          <h1 className="claudeHeaderHeading">Notas Fiscais · Custo</h1>
          <p className="claudeHeaderMeta">
            {data ? (
              `${isCached ? "cache" : "live"}${
                fetchedAt
                  ? ` · atualizado ${new Date(fetchedAt).toLocaleString("pt-BR")}`
                  : ""
              }`
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

      <p className="claudeAlert" style={{ fontSize: 11, color: "#888" }}>
        Custo = Cloud Run <strong>invoice-reader</strong> +{" "}
        <strong>hypr-captcha-solver</strong>. O custo real de cada região
        (billing) é rateado pelo uso de CPU de cada serviço (Cloud Monitoring) —
        estimativa retroativa que soma ao total faturado. O dia corrente pode
        aparecer zerado por latência do billing export.
      </p>

      <section className="bqCostKpis">
        <CostKpi
          label="Notas processadas"
          value={data ? INT.format(totalInvoices) : null}
          hint={data ? "no período" : null}
          tooltip="Total de notas com processed_at no intervalo (tabela invoices-processed)."
        />
        <CostKpi
          label="Custo total"
          value={data ? BRL.format(totalCost) : null}
          hint={data ? "captcha + invoice-reader" : null}
          tooltip="Soma do custo de Cloud Run dos dois serviços que processam as notas, no período."
        />
        <CostKpi
          label="Custo por nota"
          value={data ? fmtBrl4(avgPerInvoice) : null}
          hint={data ? "custo total ÷ notas" : null}
          tooltip="Custo médio de infra por nota processada no período."
        />
      </section>

      <section className="claudeTableCard gcpTimeline">
        <div className="gcpTimelineHeader">
          <h2 className="claudeTableTitle">Notas vs. custo por dia</h2>
        </div>
        {chartData.length ? (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#666" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis yAxisId="notas" tick={{ fontSize: 10, fill: "#666" }} tickLine={false} axisLine={false}
                tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)} width={42} />
              <YAxis yAxisId="custo" orientation="right" tick={{ fontSize: 10, fill: "#666" }} tickLine={false} axisLine={false}
                tickFormatter={(v) => `R$${v >= 1000 ? (v / 1000).toFixed(0) + "k" : v.toFixed(0)}`} width={56} />
              <YAxis yAxisId="porNota" hide domain={[0, "dataMax"]} />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                onClick={(o) => toggleSeries(String(o.dataKey))}
                formatter={(value, entry) => {
                  const key = String((entry as { dataKey?: string })?.dataKey ?? "");
                  return (
                    <span
                      style={{
                        fontSize: 11,
                        color: hidden[key] ? "#555" : "#aaa",
                        cursor: "pointer",
                        textDecoration: hidden[key] ? "line-through" : "none",
                      }}
                    >
                      {value}
                    </span>
                  );
                }}
              />
              <Bar yAxisId="notas" dataKey="notas" name="Notas" fill="#4f9cf9" radius={[3, 3, 0, 0]} maxBarSize={28} hide={hidden["notas"]} />
              <Line yAxisId="custo" type="monotone" dataKey="custo" name="Total (R$)" stroke="#ededed" strokeWidth={1.5} dot={false} hide={hidden["custo"]} />
              <Line yAxisId="custo" type="monotone" dataKey="invoiceReader" name="invoice-reader (R$)" stroke="#f59e42" strokeWidth={1.5} dot={false} hide={hidden["invoiceReader"]} />
              <Line yAxisId="custo" type="monotone" dataKey="captcha" name="captcha (R$)" stroke="#a78bfa" strokeWidth={1.5} dot={false} hide={hidden["captcha"]} />
              <Line yAxisId="porNota" type="monotone" dataKey="porNota" name="Custo/nota (R$)" stroke="#34c78a" strokeWidth={1.5} strokeDasharray="4 3" dot={false} hide={hidden["porNota"]} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : !data && !error ? (
          <div className="claudeTableSkeleton" aria-hidden />
        ) : (
          <p className="claudeAlert">Sem dados no intervalo.</p>
        )}
      </section>

      <section className="claudeTableCard">
        <button
          type="button"
          className="claudeTableHeaderBtn"
          onClick={() => setTableCollapsed((c) => !c)}
          aria-expanded={!tableCollapsed}
        >
          <span className="claudeTableHeaderBtnLeft">
            <svg
              className={`claudeTableChevron${tableCollapsed ? " claudeTableChevronCollapsed" : ""}`}
              viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            >
              <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
            </svg>
            <h2 className="claudeTableTitle">Detalhe por dia</h2>
          </span>
          <span className="claudeTableHint">
            {data ? `${data.daily.length} dias` : <span className="claudeTableHintSkeleton" aria-hidden />}
          </span>
        </button>
        {!tableCollapsed ? (
          !data && !error ? (
            <div className="claudeTableSkeleton" aria-hidden />
          ) : data && data.daily.length ? (
            <table className="claudeTable">
              <thead>
                <tr>
                  <th className="claudeTableColUser">Dia</th>
                  <th className="claudeTableColNum">Notas</th>
                  <th className="claudeTableColNum">Captcha</th>
                  <th className="claudeTableColNum">Invoice-reader</th>
                  <th className="claudeTableColNum">Total</th>
                  <th className="claudeTableColNum" style={{ whiteSpace: "nowrap" }}>Custo/nota</th>
                </tr>
              </thead>
              <tbody>
                {data.daily.map((d) => {
                  const [y, m, dd] = d.day.split("-");
                  return (
                    <tr key={d.day}>
                      <td className="claudeTableColUser">
                        <span className="claudeTableUserName">
                          {`${dd}/${m}/${y}`}
                          {d.source === "estimated" ? (
                            <span
                              title="Custo estimado por rateio de CPU (dia anterior aos labels). A partir do label, vira exato."
                              style={{ color: "#888", marginLeft: 6, cursor: "help" }}
                            >
                              ≈
                            </span>
                          ) : (
                            <span
                              title="Custo exato via label de billing."
                              style={{ color: "#34c78a", marginLeft: 6, cursor: "help" }}
                            >
                              ✓
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="claudeTableColNum">{INT.format(d.invoices)}</td>
                      <td className="claudeTableColNum">{BRL.format(Number(d.captcha_brl))}</td>
                      <td className="claudeTableColNum">{BRL.format(Number(d.invoice_reader_brl))}</td>
                      <td className="claudeTableColNum">{BRL.format(Number(d.total_brl))}</td>
                      <td className="claudeTableColNum" style={{ whiteSpace: "nowrap" }}>{fmtBrl4(d.cost_per_invoice_brl)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="claudeAlert">Sem dados no intervalo.</p>
          )
        ) : null}
      </section>
    </div>
  );
}
