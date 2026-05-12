"""Backfill one-shot de `line_costs` pra 2026 via `line_daily` (Fase 2).

Approach (validado na Fase 0):
- Pra cada (plataforma, mês ∈ [Jan..hoje-1]):
    1 chamada `fetch_mtd_cost(month_start, min(month_end, today-1))`.
- Parsing do `line_daily` retornado (granularidade per-line per-day pra DV360,
  Xandr, StackAdapt; monthly_imputed pra Hivestack e Nexd).
- `_apply_line_token_resolutions` aplicado em cima dos `lines` retornados,
  pra herdar overrides manuais do PG.
- PTAX por dia (`_fetch_ptax(d)` com fallback de 5 dias úteis pra trás).
- `_line_costs_rows_for_backfill` constrói rows com delta diário + MTD
  cumulativo dentro do mês.
- `upsert_line_costs_for_platform_and_date(platform, day, rows)` substitui
  atomicamente por (platform, cost_date). Idempotente — pode re-rodar.

Volume: 5 meses × 5 plataformas = ~25 chamadas de API. ~15min total.
Logs em `/tmp/backfill-line-costs-2026.log`. Zero Discord.

Pré-requisito: PG de produção acessível pra `_apply_line_token_resolutions`.

Uso:
    DV360_USE_DATE_GROUPBY=1 STACKADAPT_USE_DAILY_GRANULARITY=1 \
    HIVESTACK_EMIT_LINE_DAILY=1 NEXD_SYNTHESIZE_LINE_DAILY=1 \
        .venv/bin/python -m backend.scripts.backfill_line_costs_2026
"""

from __future__ import annotations

import argparse
import calendar
import logging
from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

load_dotenv(".env")

from backend import bigquery_store  # noqa: E402
from backend.dashboard_service import (  # noqa: E402
    DEFAULT_USD_BRL_RATE,
    NEXD_CPM_BRL,
    PLATFORMS,
    _apply_line_token_resolutions,
    _line_costs_rows_for_backfill,
)
from src.apis import nexd  # noqa: E402
from src.utils.currency import _fetch_ptax  # noqa: E402

logger = logging.getLogger("backfill_2026")


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _last_day_of_month(d: date) -> date:
    return date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


def _iter_months(start: date, end: date):
    """Itera 1ºs dia de cada mês em [start, end]."""
    cur = _month_start(start)
    end_anchor = _month_start(end)
    while cur <= end_anchor:
        yield cur
        if cur.month == 12:
            cur = date(cur.year + 1, 1, 1)
        else:
            cur = date(cur.year, cur.month + 1, 1)


def _build_fx_cache() -> dict[date, float]:
    """Retorna dict[d] -> rate. Lazy-loaded: cache enche conforme uso via wrapper."""
    return {}


def make_fx_for_day(cache: dict[date, float]):
    """Closure: retorna rate USD/BRL pro dia `d` (PTAX com fallback de 5 dias)."""
    def fx_for(d: date) -> float:
        if d in cache:
            return cache[d]
        for delta in range(6):
            ref = d - timedelta(days=delta)
            rate = _fetch_ptax(ref)
            if rate:
                cache[d] = float(rate)
                return cache[d]
        logger.warning("PTAX indisponível em %s; usando fallback %.4f", d.isoformat(), DEFAULT_USD_BRL_RATE)
        cache[d] = DEFAULT_USD_BRL_RATE
        return cache[d]
    return fx_for


def _fetch_platform_for_month(platform_name: str, module, month_start: date, window_end: date) -> dict | None:
    """Chama fetch_mtd_cost(month_start, window_end). Retorna platform_data ou None."""
    if not hasattr(module, "fetch_mtd_cost"):
        logger.warning("%s: sem fetch_mtd_cost; pulando.", platform_name)
        return None
    try:
        data = module.fetch_mtd_cost(month_start, window_end)
    except Exception as exc:
        logger.warning("%s/[%s..%s] fetch_mtd_cost raised: %s",
                       platform_name, month_start.isoformat(), window_end.isoformat(), exc)
        return None
    if not isinstance(data, dict) or data.get("status") != "ok":
        logger.warning("%s/[%s..%s] status=%s msg=%r",
                       platform_name, month_start.isoformat(), window_end.isoformat(),
                       (data or {}).get("status"), (data or {}).get("message"))
        return None
    return data


def _fetch_nexd_for_month(month_start: date, window_end: date) -> dict | None:
    """Chama nexd.fetch_mtd_impressions e converte pra shape parecido com DSP."""
    try:
        data = nexd.fetch_mtd_impressions(month_start, window_end)
    except Exception as exc:
        logger.warning("Nexd/[%s..%s] raised: %s",
                       month_start.isoformat(), window_end.isoformat(), exc)
        return None
    if not isinstance(data, dict) or data.get("status") != "ok":
        logger.warning("Nexd/[%s..%s] status=%s msg=%r",
                       month_start.isoformat(), window_end.isoformat(),
                       (data or {}).get("status"), (data or {}).get("message"))
        return None
    # Nexd não tem `lines` no shape de DSP. Sintetiza `lines` a partir de `campaigns`
    # × CPM pra `_apply_line_token_resolutions` ter algo pra resolver.
    nexd_payload = {
        "status": "ok",
        "currency": "BRL",
        "spend": float(data.get("impressions") or 0) * NEXD_CPM_BRL,
        "lines": [
            {
                "name": c.get("name", ""),
                "line_item_id": None,
                "spend": float(c.get("impressions") or 0) * NEXD_CPM_BRL,
            }
            for c in data.get("campaigns") or []
            if float(c.get("impressions") or 0) > 0
        ],
        "line_daily": data.get("line_daily") or [],
    }
    return nexd_payload


def run_backfill(start: date, end: date, *, dry_run: bool = False) -> dict:
    """Executa backfill mês a mês, plataforma a plataforma."""
    assert start <= end, "start <= end"

    fx_cache = _build_fx_cache()
    fx_for_day = make_fx_for_day(fx_cache)

    summary: dict[str, list[dict]] = {"ok": [], "skipped": [], "errors": []}
    # source_snapshot_at é TIMESTAMP no schema BQ; usa ISO puro.
    # O marker "backfill-2026" vai pra coluna `observation`.
    snapshot_marker = datetime.now(timezone.utc).isoformat()
    observation_tag = "backfill-2026"

    months = list(_iter_months(start, end))
    logger.info("Range: %s..%s (%d meses)", start.isoformat(), end.isoformat(), len(months))

    for month_start in months:
        month_end_calendar = _last_day_of_month(month_start)
        window_end = min(month_end_calendar, end)
        logger.info("=== Mês %s..%s ===", month_start.isoformat(), window_end.isoformat())

        # 1. Fetch all DSPs in PLATFORMS
        results: dict[str, dict] = {}
        for platform_name, module in PLATFORMS.items():
            data = _fetch_platform_for_month(platform_name, module, month_start, window_end)
            if data is None:
                summary["skipped"].append({"platform": platform_name, "month": month_start.isoformat(),
                                            "reason": "fetch failed or status != ok"})
                continue
            results[platform_name] = data
            logger.info("  %s: status=ok lines=%d line_daily=%d spend=%.2f %s",
                        platform_name, len(data.get("lines") or []), len(data.get("line_daily") or []),
                        float(data.get("spend") or 0), data.get("currency", "?"))

        # 2. Apply token resolution (mutates lines in place)
        if results:
            try:
                _apply_line_token_resolutions(results)
            except Exception:
                logger.exception("apply_line_token_resolutions falhou no mês %s; seguindo sem tokens.",
                                 month_start.isoformat())

        # 3. Fetch Nexd separately (not in PLATFORMS, different shape)
        nexd_payload = _fetch_nexd_for_month(month_start, window_end)
        if nexd_payload is not None:
            logger.info("  Nexd: line_daily=%d spend≈%.2f BRL",
                        len(nexd_payload.get("line_daily") or []),
                        float(nexd_payload.get("spend") or 0))
            # Aplica resolução pro Nexd separado
            try:
                _apply_line_token_resolutions({"Nexd": nexd_payload})
            except Exception:
                logger.exception("apply_line_token_resolutions(Nexd) falhou no mês %s.",
                                 month_start.isoformat())
        else:
            summary["skipped"].append({"platform": "Nexd", "month": month_start.isoformat(),
                                        "reason": "fetch failed or status != ok"})

        # 4. Build + upsert por (platform, day)
        all_sources = list(results.items())
        if nexd_payload is not None:
            all_sources.append(("Nexd", nexd_payload))

        for platform_name, pdata in all_sources:
            grouped = _line_costs_rows_for_backfill(
                platform_name=platform_name,
                platform_data=pdata,
                fx_for_day=fx_for_day,
                period_end_window=window_end,
                snapshot_marker=snapshot_marker,
                observation_tag=observation_tag,
            )
            if not grouped:
                logger.info("  %s/%s: 0 days c/ rows", platform_name, month_start.strftime("%Y-%m"))
                continue
            for cd in sorted(grouped.keys()):
                rows = grouped[cd]
                if dry_run:
                    logger.info("  DRY %s/%s: %d rows", platform_name, cd.isoformat(), len(rows))
                    continue
                try:
                    n = bigquery_store.upsert_line_costs_for_platform_and_date(platform_name, cd, rows)
                    summary["ok"].append({"platform": platform_name, "cost_date": cd.isoformat(), "rows": n})
                    logger.info("  WROTE %s/%s: %d rows", platform_name, cd.isoformat(), n)
                except Exception as exc:
                    summary["errors"].append({"platform": platform_name, "cost_date": cd.isoformat(),
                                              "reason": str(exc)})
                    logger.exception("UPSERT FAILED %s/%s", platform_name, cd.isoformat())

    return summary


def main() -> None:
    today = date.today()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=date.fromisoformat, default=date(2026, 1, 1),
                        help="YYYY-MM-DD (default 2026-01-01)")
    parser.add_argument("--end", type=date.fromisoformat, default=today - timedelta(days=1),
                        help="YYYY-MM-DD (default ontem)")
    parser.add_argument("--dry-run", action="store_true", help="Não grava em BQ.")
    parser.add_argument("--log", default="/tmp/backfill-line-costs-2026.log")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[logging.FileHandler(args.log, mode="a"), logging.StreamHandler()],
    )

    logger.info("Backfill range: %s..%s (dry_run=%s)", args.start, args.end, args.dry_run)
    out = run_backfill(args.start, args.end, dry_run=args.dry_run)

    print()
    print("=== Resumo ===")
    print(f"Upserts ok: {len(out['ok'])}")
    print(f"Skipped:    {len(out['skipped'])}")
    print(f"Errors:     {len(out['errors'])}")
    if out["skipped"]:
        print("\nSkipped (top 10):")
        for s in out["skipped"][:10]:
            print(f"  {s['platform']:12s} {s['month']:10s}  {s['reason']}")
    if out["errors"]:
        print("\nErrors (top 10):")
        for e in out["errors"][:10]:
            print(f"  {e['platform']:12s} {e['cost_date']:10s}  {e['reason']}")


if __name__ == "__main__":
    main()
