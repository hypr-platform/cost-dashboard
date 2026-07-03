"""Backfill line_costs (2026) apenas para DV360.

Wrapper de `backend.scripts.backfill_line_costs_2026` — aceita os mesmos
`--start`/`--end`/`--dry-run`/`--log` do script-base. Define o env var
de groupby por data se ainda não estiver setado.

Uso:
    .venv/bin/python -m backend.scripts.backfill_dv360 \
        --start 2026-05-25 --end 2026-06-07
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("DV360_USE_DATE_GROUPBY", "1")

if "--platform" not in sys.argv:
    sys.argv += ["--platform", "DV360"]

from backend.scripts.backfill_line_costs_2026 import main  # noqa: E402

if __name__ == "__main__":
    main()
