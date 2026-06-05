import { Skeleton, SkeletonRepeat } from "@/shared/skeletons";

/**
 * Body skeleton da aba de custo de notas fiscais. Espelha o InvoiceCostTab:
 * header + controles de data, 3 KPIs, gráfico (notas vs custo), tabela por dia.
 */
export function InvoiceCostSkeleton() {
  return (
    <div className="claudeTab bqCostTab" aria-hidden="true">
      <header className="claudeHeader">
        <div className="claudeHeaderTitle">
          <Skeleton variant="heading" />
          <Skeleton variant="eyebrow" />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Skeleton variant="buttonWide" />
          <Skeleton variant="buttonWide" />
          <Skeleton variant="button" />
        </div>
      </header>

      <section className="bqCostKpis">
        <SkeletonRepeat count={3} variant="card" className="card" keyPrefix="inv-kpi" />
      </section>

      <section className="panel" style={{ marginTop: 12, padding: 16 }}>
        <Skeleton variant="title" />
        <Skeleton variant="chart" />
      </section>

      <section className="claudeTableCard" style={{ marginTop: 12 }}>
        <div className="claudeTableHeader">
          <Skeleton variant="title" />
          <Skeleton variant="eyebrow" />
        </div>
        <Skeleton variant="table" />
      </section>
    </div>
  );
}
