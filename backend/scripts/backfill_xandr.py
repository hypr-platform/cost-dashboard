"""Backfill line_costs (2026) apenas para Xandr.

Wrapper de `backend.scripts.backfill_line_costs_2026` — aceita os mesmos
`--start`/`--end`/`--dry-run`/`--log` do script-base.

Uso:
    .venv/bin/python -m backend.scripts.backfill_xandr \
        --start 2026-05-25 --end 2026-06-07
"""
from __future__ import annotations

import sys

if "--platform" not in sys.argv:
    sys.argv += ["--platform", "Xandr"]

from backend.scripts.backfill_line_costs_2026 import main  # noqa: E402

if __name__ == "__main__":
    main()
