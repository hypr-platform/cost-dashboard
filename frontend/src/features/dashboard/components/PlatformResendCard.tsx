"use client";

import { Fragment } from "react";
import { useRouter } from "next/navigation";

const BRL_FORMATTER = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatBrl = (value: number) => BRL_FORMATTER.format(value);

export const MONO_BY_TITLE: Record<string, { code: string; tone: string }> = {
  DV360: { code: "DV", tone: "dv360" },
  Xandr: { code: "X", tone: "xandr" },
  StackAdapt: { code: "SA", tone: "stack" },
  NEXD: { code: "NX", tone: "nexd" },
  Nexd: { code: "NX", tone: "nexd" },
  Hivestack: { code: "HV", tone: "hive" },
  Amazon: { code: "AZ", tone: "amzn" },
  "Amazon DSP": { code: "AZ", tone: "amzn" },
};

export const monoFor = (title: string) => {
  const direct = MONO_BY_TITLE[title];
  if (direct) return direct;
  const upper = title.trim().toUpperCase();
  for (const key of Object.keys(MONO_BY_TITLE)) {
    if (upper.startsWith(key.toUpperCase())) return MONO_BY_TITLE[key];
  }
  return { code: title.slice(0, 2).toUpperCase(), tone: "" };
};

type StatusTone = "ok" | "warn" | "crit" | "idle" | "info";

export type PlatformResendCardProps = {
  title: string;
  spendBrl: number;
  budget?: {
    target_brl: number | null;
    progress_pct: number | null;
  };
  badge?: string;
  badgeTone?: "soon";
  dimmed?: boolean;
  href?: string;
  /**
   * Optional override for the secondary line. When omitted, derived from
   * budget.target_brl ("Meta R$ X") or falls back to "—".
   */
  metaLine?: { label: string; value: string };
  /** Override the status (otherwise derived from progress). */
  status?: { tone: StatusTone; label: string };
  /** When true, renders skeleton placeholders for value/status/meta. */
  loading?: boolean;
  /** Optional spec-sheet rows rendered below the meta line. */
  spec?: Array<{ label: string; value: string; mono?: boolean }>;
};

function deriveStatus(
  spendBrl: number,
  progressPct: number | null | undefined,
  badgeTone: "soon" | undefined,
  dimmed: boolean | undefined,
): { tone: StatusTone; label: string } {
  if (badgeTone === "soon") return { tone: "info", label: "em breve" };
  if (dimmed && spendBrl <= 0) return { tone: "idle", label: "inativo" };
  if (spendBrl <= 0) return { tone: "idle", label: "inativo" };
  if (typeof progressPct !== "number" || !Number.isFinite(progressPct)) {
    return { tone: "ok", label: "ativo" };
  }
  const rounded = Math.round(progressPct * 10) / 10;
  if (rounded > 100) {
    const over = Math.round(rounded - 100);
    return { tone: "crit", label: `+${over}%` };
  }
  const formatted = `${rounded.toFixed(rounded < 10 ? 1 : 0).replace(".", ",")}%`;
  if (rounded >= 80) return { tone: "warn", label: formatted };
  return { tone: "ok", label: formatted };
}

export function PlatformResendCard({
  title,
  spendBrl,
  budget,
  badge,
  badgeTone,
  dimmed,
  href,
  metaLine,
  status,
  loading,
  spec,
}: PlatformResendCardProps) {
  const router = useRouter();
  const mono = monoFor(title);
  const computed =
    status ?? deriveStatus(spendBrl, budget?.progress_pct, badgeTone, dimmed);
  const isZero = spendBrl <= 0;

  const resolvedMeta =
    metaLine ??
    (badgeTone === "soon"
      ? { label: "Status", value: badge ?? "em breve" }
      : budget?.target_brl != null
        ? { label: "Meta", value: `R$ ${formatBrl(budget.target_brl)}` }
        : null);

  const clickable = Boolean(href);
  const go = () => {
    if (href) router.push(href);
  };

  return (
    <article
      className={`platformCard${dimmed || badgeTone === "soon" ? " platformCardDisabled" : ""}${clickable ? " platformCardClickable" : ""}`}
      data-status={computed.tone}
      role={clickable ? "link" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `Abrir ${title}` : undefined}
      onClick={clickable ? go : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                go();
              }
            }
          : undefined
      }
    >
      <div className="platformCardHead">
        <div className="platformCardName">
          <span className={`platformMono platformMono-${mono.tone}`}>
            {mono.code}
          </span>
          <span>{title}</span>
        </div>
        {loading ? (
          <span
            className="platformSkeleton platformSkeletonStatus"
            aria-hidden="true"
          />
        ) : (
          <span className={`platformStatus platformStatus-${computed.tone}`}>
            <span className="platformStatusDot" aria-hidden="true" />
            {computed.label}
          </span>
        )}
      </div>
      {loading ? (
        <span
          className="platformSkeleton platformSkeletonValue"
          aria-hidden="true"
        />
      ) : (
        <div
          className={`platformCardValue${isZero ? " platformCardValueMuted" : ""}`}
        >
          <span className="platformCardCurrency">R$</span>
          <span className="num">{formatBrl(spendBrl)}</span>
        </div>
      )}
      {loading ? (
        <span
          className="platformSkeleton platformSkeletonMeta"
          aria-hidden="true"
        />
      ) : resolvedMeta ? (
        <div className="platformCardMeta">
          {resolvedMeta.label}{" "}
          <span className="num">{resolvedMeta.value}</span>
        </div>
      ) : null}
      {!loading && spec && spec.length > 0 ? (
        <dl className="spec">
          {spec.map((row) => (
            <Fragment key={row.label}>
              <dt>{row.label}</dt>
              <dd className={row.mono ? "num" : undefined}>{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </article>
  );
}
