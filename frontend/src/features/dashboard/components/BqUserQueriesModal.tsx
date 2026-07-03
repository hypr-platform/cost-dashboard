"use client";

import { Fragment, useEffect, useState } from "react";
import useSWR from "swr";
import {
  fetchBqUserQueries,
  type BqUserQueriesResponse,
} from "@/services/api/bigquery-cost";
import {
  BRL,
  INT,
  emailLabel,
  formatBytes,
  formatUsd,
} from "@/features/dashboard/utils/cost-format";
import { CostMoneyCell } from "@/features/dashboard/components/cost";

type Props = {
  apiBase: string;
  from: string;
  to: string;
  regions: string;
  user: { email: string; costBrl: string; costUsd: string };
  onClose: () => void;
};

function buildUrl(
  apiBase: string,
  from: string,
  to: string,
  regions: string,
  user: string,
): string {
  const base = apiBase.replace(/\/$/, "");
  const params = new URLSearchParams({ from, to, user_email: user });
  if (regions.trim()) params.set("regions", regions.trim());
  return `${base}/api/bigquery-cost/user-queries?${params.toString()}`;
}

export default function BqUserQueriesModal({
  apiBase,
  from,
  to,
  regions,
  user,
  onClose,
}: Props) {
  const url = buildUrl(apiBase, from, to, regions, user.email);
  const { data, error } = useSWR<BqUserQueriesResponse>(
    url,
    fetchBqUserQueries,
    { shouldRetryOnError: false, dedupingInterval: 60_000, revalidateOnFocus: false },
  );
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="gcpDayModalOverlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Queries de ${user.email}`}
      onClick={onClose}
    >
      <div className="gcpDayModal" onClick={(e) => e.stopPropagation()}>
        <header className="gcpDayModalHeader">
          <div className="gcpDayModalTitle">
            <h2 className="claudeHeaderHeading">
              Queries · {emailLabel(user.email)}
            </h2>
            <p className="claudeHeaderMeta">
              {user.email} · {BRL.format(Number(user.costBrl))} ·{" "}
              {formatUsd(user.costUsd)}
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
              {error instanceof Error ? error.message : "Falha ao carregar."}
            </p>
          ) : null}

          <p className="claudeTableHint">
            Queries agrupadas por padrão (valores normalizados). Clique para ver
            o SQL de exemplo.
          </p>

          {!data && !error ? (
            <p className="claudeAlert">Carregando…</p>
          ) : data && data.groups.length === 0 ? (
            <p className="claudeAlert">Nenhuma query no intervalo.</p>
          ) : data ? (
            <table className="claudeTable">
              <thead>
                <tr>
                  <th className="claudeTableColUser">Padrão de query</th>
                  <th className="claudeTableColNum">Execuções</th>
                  <th className="claudeTableColNum">Bytes</th>
                  <th className="claudeTableColNum">Custo</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g, i) => {
                  const isOpen = expanded === i;
                  return (
                    <Fragment key={i}>
                      <tr
                        onClick={() => setExpanded(isOpen ? null : i)}
                        className="claudeTableRowClickable"
                      >
                        <td className="claudeTableColUser">
                          <span className="bqCostQueryPattern">
                            {g.pattern_preview}
                          </span>
                          <span className="claudeTableUserEmail">
                            {g.statement_type ?? "—"}
                          </span>
                        </td>
                        <td className="claudeTableColNum">
                          {INT.format(g.jobs)}
                        </td>
                        <td className="claudeTableColNum">
                          {formatBytes(g.bytes_billed)}
                        </td>
                        <td className="claudeTableColNum">
                          <CostMoneyCell brl={g.cost_brl} usd={g.cost_usd} />
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr>
                          <td colSpan={4} className="bqCostQueryCell">
                            <pre className="bqCostQuerySql">{g.sample_query}</pre>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
    </div>
  );
}
