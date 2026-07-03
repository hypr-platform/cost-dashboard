"""Backfill line_costs (2026) apenas para StackAdapt.

Wrapper de `backend.scripts.backfill_line_costs_2026` — aceita os mesmos
`--start`/`--end`/`--dry-run`/`--log` do script-base. Define o env var
de granularidade diária se ainda não estiver setado.

Uso:
    .venv/bin/python -m backend.scripts.backfill_stackadapt \
        --start 2026-05-25 --end 2026-06-07
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("STACKADAPT_USE_DAILY_GRANULARITY", "1")

if "--platform" not in sys.argv:
    sys.argv += ["--platform", "StackAdapt"]

from backend.scripts.backfill_line_costs_2026 import main  # noqa: E402

if __name__ == "__main__":
    main()
