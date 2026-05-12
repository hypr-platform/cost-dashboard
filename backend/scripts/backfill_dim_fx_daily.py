"""Backfill `dim_fx_daily` pra 2026 inteiro via PTAX (BCB).

Volume: ~130 chamadas BCB (uma por dia desde Jan/01 até ontem). Idempotente.
"""

from __future__ import annotations

import argparse
import logging
from datetime import date, timedelta

from dotenv import load_dotenv

load_dotenv(".env")

from backend import bigquery_store  # noqa: E402
from backend.dashboard_service import _fetch_fx_with_source  # noqa: E402

logger = logging.getLogger("backfill_dim_fx")


def run(start: date, end: date) -> dict:
    summary = {"ok": [], "errors": []}
    cur = start
    while cur <= end:
        try:
            rate, source = _fetch_fx_with_source(cur)
            bigquery_store.upsert_dim_fx_for_date(cur, rate, source)
            summary["ok"].append({"date": cur.isoformat(), "rate": rate, "source": source})
            logger.info("WROTE %s rate=%.4f source=%s", cur.isoformat(), rate, source)
        except Exception as exc:
            summary["errors"].append({"date": cur.isoformat(), "reason": str(exc)})
            logger.exception("FAILED %s", cur.isoformat())
        cur += timedelta(days=1)
    return summary


def main() -> None:
    today = date.today()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=date.fromisoformat, default=date(2026, 1, 1))
    parser.add_argument("--end", type=date.fromisoformat, default=today)
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[
            logging.FileHandler("/tmp/backfill-dim-fx-daily.log", mode="a"),
            logging.StreamHandler(),
        ],
    )

    logger.info("Backfill range: %s..%s", args.start, args.end)
    out = run(args.start, args.end)

    print()
    print("=== Resumo ===")
    print(f"Days ok:    {len(out['ok'])}")
    print(f"Errors:     {len(out['errors'])}")

    # Distribution de sources
    from collections import Counter
    sources = Counter(d["source"] for d in out["ok"])
    print("\nSources:")
    for s, c in sources.most_common():
        print(f"  {s:<30} {c}")


if __name__ == "__main__":
    main()
