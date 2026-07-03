"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  deleteBqLimit,
  fetchBqLimitStatus,
  putBqLimit,
  type BqCostLimitStatus,
  type BqEnforcementValue,
  type BqLimitStatusValue,
} from "@/services/api/bigquery-cost";
import { BRL, formatBytes } from "@/features/dashboard/utils/cost-format";

const STATUS_META: Record<
  BqLimitStatusValue,
  { label: string; tone: string }
> = {
  unset: { label: "Sem limite", tone: "neutral" },
  ok: { label: "Dentro do limite", tone: "ok" },
  projected: { label: "Projeção estoura", tone: "warn" },
  warning: { label: "Perto do limite", tone: "warn" },
  exceeded: { label: "Limite estourado", tone: "danger" },
};

const ENFORCE_META: Record<
  BqEnforcementValue,
  { label: string; tone: string; locked: boolean; hint: string }
> = {
  enforced: {
    label: "Bloqueio ativo",
    tone: "ok",
    locked: true,
    hint: "A quota do GCP está aplicada. Ao estourar, toda query on-demand do projeto falha até a meia-noite (PST).",
  },
  off: {
    label: "Bloqueio inativo",
    tone: "warn",
    locked: false,
    hint: "O limite está salvo, mas a quota do GCP não está aplicada. Salve o limite de novo para reaplicar o bloqueio.",
  },
  drift: {
    label: "Ressincronizar",
    tone: "warn",
    locked: false,
    hint: "A quota aplicada no GCP diverge do limite atual. Salve o limite de novo para sincronizar.",
  },
  stray: {
    label: "Override órfão",
    tone: "warn",
    locked: false,
    hint: "Há uma quota aplicada no GCP sem limite salvo aqui. Remova para voltar ao teto padrão.",
  },
  error: {
    label: "Erro no bloqueio",
    tone: "danger",
    locked: false,
    hint: "Falha ao consultar/aplicar a quota do GCP.",
  },
};

function LockIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="6.5" width="9" height="6" rx="1.2" />
      {open ? <path d="M4.5 6.5V4.5a2.5 2.5 0 0 1 4.9-.7" /> : <path d="M4.5 6.5V4.5a2.5 2.5 0 0 1 5 0v2" />}
    </svg>
  );
}

function parseBrlInput(raw: string): number | null {
  const cleaned = raw.trim().replace(/[R$\s]/g, "");
  if (!cleaned) return null;
  // Aceita formato BR (1.234,56) e simples (1234.56 / 1234).
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned;
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return `há ${d} d`;
}

export default function BqLimitCard({
  apiBase,
  userEmail,
}: {
  apiBase: string;
  userEmail?: string;
}) {
  const url = `${apiBase.replace(/\/$/, "")}/api/bigquery-cost/limit`;
  const { data, error, mutate, isLoading } = useSWR<BqCostLimitStatus>(
    url,
    fetchBqLimitStatus,
    {
      shouldRetryOnError: false,
      refreshInterval: 60_000,
      revalidateOnFocus: true,
    },
  );

  const [editing, setEditing] = useState(false);
  const [limitInput, setLimitInput] = useState("");
  const [warnInput, setWarnInput] = useState("80");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const hasLimit = data ? data.status !== "unset" && data.limit_brl != null : false;

  useEffect(() => {
    if (!editing && data) {
      setLimitInput(data.limit_brl ? String(Math.round(Number(data.limit_brl))) : "");
      setWarnInput(data.warn_pct ? String(Math.round(Number(data.warn_pct))) : "80");
    }
  }, [data, editing]);

  const meta = data ? STATUS_META[data.status] : STATUS_META.unset;
  const enforce = data ? ENFORCE_META[data.enforcement] ?? ENFORCE_META.off : null;
  const spent = Number(data?.spent_brl ?? 0);
  const limit = Number(data?.limit_brl ?? 0);
  const projected = Number(data?.projected_brl ?? 0);
  const pctUsed = data?.pct_used != null ? Number(data.pct_used) : null;
  const capTib = data?.enforced_limit_tib ? Number(data.enforced_limit_tib) : null;
  const editValue = parseBrlInput(limitInput);
  const blocksImmediately = editValue != null && editValue < spent;

  const meterPct = useMemo(() => {
    if (!hasLimit || limit <= 0) return 0;
    return Math.min(100, (spent / limit) * 100);
  }, [hasLimit, spent, limit]);

  const projectedPct = useMemo(() => {
    if (!hasLimit || limit <= 0) return null;
    return Math.min(100, (projected / limit) * 100);
  }, [hasLimit, projected, limit]);

  async function handleSave() {
    const value = parseBrlInput(limitInput);
    if (value == null) {
      setActionError("Informe um valor em reais maior que zero.");
      return;
    }
    const warn = Number(warnInput);
    setBusy(true);
    setActionError(null);
    try {
      const next = await putBqLimit(
        apiBase,
        { limit_brl: value, warn_pct: Number.isFinite(warn) ? warn : undefined },
        userEmail,
      );
      await mutate(next, { revalidate: false });
      setEditing(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Falha ao salvar.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true);
    setActionError(null);
    try {
      const next = await deleteBqLimit(apiBase, userEmail);
      await mutate(next, { revalidate: false });
      setEditing(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Falha ao remover.");
    } finally {
      setBusy(false);
    }
  }

  // ---- Loading skeleton --------------------------------------------------
  if (isLoading && !data) {
    return (
      <section className="bqLimitCard">
        <div className="bqLimitTopRow">
          <span className="bqLimitEyebrow">Limite diário de gasto</span>
        </div>
        <div className="bqLimitValueSkeleton" aria-hidden />
        <div className="bqLimitMeter">
          <div className="bqLimitMeterFill" style={{ width: "40%", opacity: 0.3 }} />
        </div>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="bqLimitCard">
        <div className="bqLimitTopRow">
          <span className="bqLimitEyebrow">Limite diário de gasto</span>
        </div>
        <p className="bqLimitError">
          {error instanceof Error ? error.message : "Falha ao carregar o limite."}
        </p>
      </section>
    );
  }

  const editForm = (
    <div className="bqLimitEditForm">
      <div className="bqLimitFields">
        <label className="bqLimitField">
          <span className="bqLimitFieldLabel">Limite por dia (R$)</span>
          <div className="bqLimitInputWrap">
            <span className="bqLimitInputPrefix">R$</span>
            <input
              className="bqLimitInput"
              inputMode="decimal"
              autoFocus
              placeholder="2.000"
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          </div>
        </label>
        <label className="bqLimitField bqLimitFieldNarrow">
          <span className="bqLimitFieldLabel">Alerta em (%)</span>
          <input
            className="bqLimitInput bqLimitInputNarrow"
            inputMode="numeric"
            placeholder="80"
            value={warnInput}
            onChange={(e) => setWarnInput(e.target.value)}
          />
        </label>
      </div>
      {editValue != null ? (
        <p className="bqLimitEditHint">
          Bloqueia em ≈{" "}
          {(editValue / (Number(data?.price_usd_per_tib ?? 8.44) * Number(data?.exchange_rate ?? 1))).toLocaleString(
            "pt-BR",
            { maximumFractionDigits: 1 },
          )}{" "}
          TiB/dia · aplica a quota no projeto inteiro.
        </p>
      ) : null}
      {blocksImmediately ? (
        <p className="bqLimitWarn">
          ⚠ Esse valor é menor que o gasto de hoje ({BRL.format(spent)}). O
          projeto será bloqueado imediatamente até a meia-noite.
        </p>
      ) : null}
      {actionError ? <p className="bqLimitError">{actionError}</p> : null}
      <div className="bqLimitActions">
        <button
          type="button"
          className="bqLimitBtn bqLimitBtnPrimary"
          onClick={handleSave}
          disabled={busy}
        >
          {busy ? "Salvando…" : "Salvar limite"}
        </button>
        <button
          type="button"
          className="bqLimitBtn bqLimitBtnGhost"
          onClick={() => {
            setEditing(false);
            setActionError(null);
          }}
          disabled={busy}
        >
          Cancelar
        </button>
        {hasLimit ? (
          <button
            type="button"
            className="bqLimitBtn bqLimitBtnDanger"
            onClick={handleRemove}
            disabled={busy}
          >
            Remover
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <section className={`bqLimitCard bqLimitTone-${meta.tone}`}>
      <div className="bqLimitTopRow">
        <div className="bqLimitEyebrowWrap">
          <span className="bqLimitEyebrow">Limite diário de gasto</span>
          <span className="bqLimitPill" data-tone={meta.tone}>
            <span className="bqLimitPillDot" />
            {meta.label}
          </span>
        </div>
        {!editing ? (
          <div className="bqLimitTopActions">
            {enforce && (hasLimit || data?.enforcement === "stray") ? (
              <span
                className="bqLimitEnforceChip"
                data-tone={enforce.tone}
                title={data?.enforce_error ? `${enforce.hint}\n\n${data.enforce_error}` : enforce.hint}
              >
                <LockIcon open={!enforce.locked} />
                {enforce.label}
              </span>
            ) : null}
            <button
              type="button"
              className="bqLimitBtn bqLimitBtnGhost bqLimitBtnSm"
              onClick={() => setEditing(true)}
            >
              {hasLimit ? "Editar" : "Definir limite"}
            </button>
          </div>
        ) : null}
      </div>

      {editing ? (
        editForm
      ) : hasLimit ? (
        <>
          <div className="bqLimitValueRow">
            <span className="bqLimitSpent">{BRL.format(spent)}</span>
            <span className="bqLimitOfLimit">de {BRL.format(limit)}</span>
            {pctUsed != null ? (
              <span className="bqLimitPct">{pctUsed.toFixed(0)}%</span>
            ) : null}
          </div>

          <div className="bqLimitMeter" role="progressbar" aria-valuenow={meterPct} aria-valuemin={0} aria-valuemax={100}>
            <div className="bqLimitMeterFill" style={{ width: `${meterPct}%` }} />
            {projectedPct != null && projectedPct > meterPct + 0.5 ? (
              <div
                className="bqLimitMeterProjected"
                style={{ left: `${projectedPct}%` }}
                title={`Projeção de fim de dia: ${BRL.format(projected)}`}
              />
            ) : null}
          </div>

          <div className="bqLimitStats">
            <div className="bqLimitStat">
              <span className="bqLimitStatLabel">Projeção fim do dia</span>
              <span className="bqLimitStatValue">{BRL.format(projected)}</span>
            </div>
            <div className="bqLimitStat">
              <span className="bqLimitStatLabel">Restante hoje</span>
              <span className="bqLimitStatValue">
                {BRL.format(Math.max(0, limit - spent))}
              </span>
            </div>
            <div className="bqLimitStat">
              <span className="bqLimitStatLabel">Bytes faturados hoje</span>
              <span className="bqLimitStatValue">
                {data ? formatBytes(data.spent_bytes) : "—"}
              </span>
            </div>
          </div>

          <div className="bqLimitBlockNote" data-tone={enforce?.tone ?? "warn"}>
            <LockIcon open={!enforce?.locked} />
            <span>
              {enforce?.locked ? (
                <>
                  Bloqueia em <strong>≈ {capTib != null ? capTib.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : "—"} TiB/dia</strong>.
                  Ao estourar, todas as queries on-demand do projeto param até a
                  meia-noite ({data?.timezone}).
                </>
              ) : (
                <>{enforce?.hint}</>
              )}
            </span>
          </div>

          <p className="bqLimitFootnote">
            Dia {data?.day} ({data?.timezone}) · regiões {data?.regions.join(", ") || "—"} ·
            preço {data?.price_usd_per_tib} USD/TiB
            {data?.updated_at ? ` · limite alterado ${timeAgo(data.updated_at)}` : ""}
          </p>
        </>
      ) : (
        <div className="bqLimitEmpty">
          <p className="bqLimitEmptyText">
            Nenhum limite definido. Hoje já foram gastos{" "}
            <strong>{BRL.format(spent)}</strong> em queries. Defina um teto diário
            para acompanhar o gasto e ser avisado antes de estourar.
          </p>
          <button
            type="button"
            className="bqLimitBtn bqLimitBtnPrimary"
            onClick={() => setEditing(true)}
          >
            Definir limite diário
          </button>
        </div>
      )}
    </section>
  );
}
