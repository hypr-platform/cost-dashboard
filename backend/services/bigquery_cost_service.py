"""BigQuery cost dashboard service.

Lê `INFORMATION_SCHEMA.JOBS_BY_PROJECT` em uma ou mais regiões para o intervalo
solicitado e agrega: por usuário, por statement_type, por tabela referenciada e
top N queries mais caras. Custo estimado on-demand:
`cost_usd = total_bytes_billed / 2**40 * BQ_ON_DEMAND_USD_PER_TIB` (default 6.25).

Storage e outros SKUs **não** são contabilizados — só queries (`job_type='QUERY'`).
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from collections import defaultdict
from datetime import date, datetime, time as dtime, timezone
from decimal import Decimal
from typing import Any

from google.cloud import bigquery

from backend import bigquery_store
from backend.models.bigquery_cost import (
    BqCostDashboardResponse,
    BqCostQueryRow,
    BqCostStatementRow,
    BqCostTableRow,
    BqCostUserRow,
)
from backend.services.exchange_rate import get_exchange_rate

logger = logging.getLogger(__name__)

DEFAULT_CACHE_TTL = 1800
DEFAULT_PRICE_USD_PER_TIB = Decimal("6.25")
DEFAULT_REGIONS = ("us",)
DEFAULT_MAX_RANGE_DAYS = 92
DEFAULT_TOP_QUERIES = 10
DEFAULT_TOP_TABLES = 25
QUERY_PREVIEW_CHARS = 500
BYTES_PER_TIB = Decimal(2**40)


def is_enabled() -> bool:
    return bigquery_store.is_enabled()


def _cache_ttl() -> int:
    raw = (os.getenv("BQ_COST_CACHE_TTL_SECONDS") or "").strip()
    if not raw:
        return DEFAULT_CACHE_TTL
    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_CACHE_TTL


def _price_per_tib() -> Decimal:
    raw = (os.getenv("BQ_ON_DEMAND_USD_PER_TIB") or "").strip()
    if not raw:
        return DEFAULT_PRICE_USD_PER_TIB
    try:
        return Decimal(raw)
    except Exception:
        return DEFAULT_PRICE_USD_PER_TIB


def _max_range_days() -> int:
    raw = (os.getenv("BQ_COST_MAX_RANGE_DAYS") or "").strip()
    if not raw:
        return DEFAULT_MAX_RANGE_DAYS
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_MAX_RANGE_DAYS


def _strip_region_prefix(token: str) -> str:
    t = token.strip().lower()
    if t.startswith("region-"):
        t = t[len("region-"):]
    return t


def _configured_regions() -> tuple[str, ...]:
    raw = (os.getenv("BQ_COST_REGIONS") or "").strip()
    if not raw:
        return DEFAULT_REGIONS
    items = tuple(
        _strip_region_prefix(token)
        for token in raw.split(",")
        if token.strip()
    )
    return items or DEFAULT_REGIONS


_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, BqCostDashboardResponse]] = {}


def _cache_get(key: str) -> BqCostDashboardResponse | None:
    ttl = _cache_ttl()
    if ttl <= 0:
        return None
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        ts, payload = entry
        if time.time() - ts > ttl:
            _cache.pop(key, None)
            return None
        return payload


def _cache_put(key: str, payload: BqCostDashboardResponse) -> None:
    if _cache_ttl() <= 0:
        return
    with _cache_lock:
        _cache[key] = (time.time(), payload)


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _parse_date(value: str | None, *, field: str) -> date:
    if not value:
        raise ValueError(f"`{field}` é obrigatório (YYYY-MM-DD).")
    try:
        return date.fromisoformat(value.strip())
    except ValueError as exc:
        raise ValueError(f"`{field}` deve estar no formato YYYY-MM-DD.") from exc


def _normalize_regions(raw: str | None) -> tuple[str, ...]:
    if not raw:
        return _configured_regions()
    items = tuple(
        _strip_region_prefix(token)
        for token in raw.split(",")
        if token.strip()
    )
    return items or _configured_regions()


def _resolve_window(
    from_str: str | None,
    to_str: str | None,
    regions_str: str | None,
) -> tuple[date, date, tuple[str, ...]]:
    from_d = _parse_date(from_str, field="from")
    to_d = _parse_date(to_str, field="to")
    if from_d > to_d:
        raise ValueError("`from` deve ser anterior ou igual a `to`.")
    span = (to_d - from_d).days + 1
    if span > _max_range_days():
        raise ValueError(
            f"Intervalo máximo é {_max_range_days()} dias (recebido: {span})."
        )
    regions = _normalize_regions(regions_str)
    return from_d, to_d, regions


def _bytes_to_usd(bytes_billed: int, price_per_tib: Decimal) -> Decimal:
    if bytes_billed <= 0:
        return Decimal("0")
    return (Decimal(bytes_billed) / BYTES_PER_TIB * price_per_tib).quantize(
        Decimal("0.000001")
    )


_JOBS_QUERY_TEMPLATE = """
SELECT
  job_id,
  user_email,
  statement_type,
  creation_time,
  total_bytes_billed,
  total_slot_ms,
  query,
  referenced_tables
FROM `{project}`.`region-{region}`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE job_type = 'QUERY'
  AND state = 'DONE'
  AND error_result IS NULL
  AND creation_time BETWEEN @from_ts AND @to_ts
  AND total_bytes_billed > 0
"""


def _run_region_query(
    client: bigquery.Client,
    project: str,
    region: str,
    from_ts: datetime,
    to_ts: datetime,
) -> list[dict[str, Any]]:
    sql = _JOBS_QUERY_TEMPLATE.format(project=project, region=region)
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("from_ts", "TIMESTAMP", from_ts),
            bigquery.ScalarQueryParameter("to_ts", "TIMESTAMP", to_ts),
        ]
    )
    rows: list[dict[str, Any]] = []
    for row in client.query(sql, job_config=job_config).result():
        rows.append(
            {
                "job_id": row["job_id"],
                "user_email": row["user_email"],
                "statement_type": row["statement_type"],
                "creation_time": row["creation_time"],
                "total_bytes_billed": int(row["total_bytes_billed"] or 0),
                "total_slot_ms": int(row["total_slot_ms"] or 0),
                "query": row["query"] or "",
                "referenced_tables": [
                    {
                        "project_id": t.get("project_id"),
                        "dataset_id": t.get("dataset_id"),
                        "table_id": t.get("table_id"),
                    }
                    for t in (row["referenced_tables"] or [])
                ],
                "region": region,
            }
        )
    return rows


async def build_dashboard(
    from_str: str | None,
    to_str: str | None,
    regions_str: str | None = None,
    use_cache: bool = True,
) -> BqCostDashboardResponse:
    if not is_enabled():
        raise RuntimeError(
            "Integração BigQuery desabilitada: configure BQ_PROJECT_ID e GCP_CREDS_JSON_CREDS_BASE64."
        )

    from_d, to_d, regions = _resolve_window(from_str, to_str, regions_str)
    cache_key = f"{from_d.isoformat()}|{to_d.isoformat()}|{','.join(regions)}"
    if use_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached.model_copy(update={"cached": True})

    client = bigquery_store._get_client()
    project = bigquery_store._project_id()
    from_ts = datetime.combine(from_d, dtime.min, tzinfo=timezone.utc)
    to_ts = datetime.combine(to_d, dtime.max, tzinfo=timezone.utc)

    loop = asyncio.get_running_loop()
    tasks = [
        loop.run_in_executor(
            None, _run_region_query, client, project, region, from_ts, to_ts
        )
        for region in regions
    ]
    try:
        results = await asyncio.gather(*tasks)
    except Exception as exc:
        logger.exception("Falha ao consultar INFORMATION_SCHEMA.JOBS_BY_PROJECT.")
        raise RuntimeError(f"BigQuery falhou: {exc}") from exc

    all_rows: list[dict[str, Any]] = []
    for region_rows in results:
        all_rows.extend(region_rows)

    price_per_tib = _price_per_tib()
    rate = get_exchange_rate(to_d)

    by_user_acc: dict[str, dict[str, int]] = defaultdict(
        lambda: {"jobs": 0, "bytes": 0, "slot": 0}
    )
    by_stmt_acc: dict[str, dict[str, int]] = defaultdict(
        lambda: {"jobs": 0, "bytes": 0, "slot": 0}
    )
    by_table_acc: dict[str, dict[str, int | float]] = defaultdict(
        lambda: {"jobs": 0, "bytes": 0.0}
    )
    query_costs: list[tuple[int, dict[str, Any]]] = []

    total_jobs = len(all_rows)
    total_bytes = 0
    total_slot = 0

    for row in all_rows:
        bytes_billed = row["total_bytes_billed"]
        slot_ms = row["total_slot_ms"]
        total_bytes += bytes_billed
        total_slot += slot_ms

        user_key = (row["user_email"] or "").strip().lower() or "(sem usuário)"
        bu = by_user_acc[user_key]
        bu["jobs"] += 1
        bu["bytes"] += bytes_billed
        bu["slot"] += slot_ms

        stmt_key = row["statement_type"] or "UNKNOWN"
        bs = by_stmt_acc[stmt_key]
        bs["jobs"] += 1
        bs["bytes"] += bytes_billed
        bs["slot"] += slot_ms

        refs = [
            t
            for t in row["referenced_tables"]
            if t["project_id"] and t["dataset_id"] and t["table_id"]
        ]
        if refs and bytes_billed > 0:
            share = bytes_billed / len(refs)
            for t in refs:
                fqn = f"{t['project_id']}.{t['dataset_id']}.{t['table_id']}"
                bt = by_table_acc[fqn]
                bt["jobs"] += 1
                bt["bytes"] = float(bt["bytes"]) + share

        query_costs.append((bytes_billed, row))

    def _row_user(acc_key: str, acc: dict[str, int]) -> BqCostUserRow:
        usd = _bytes_to_usd(acc["bytes"], price_per_tib)
        brl = (usd * rate).quantize(Decimal("0.01"))
        return BqCostUserRow(
            user_email=acc_key,
            jobs=acc["jobs"],
            bytes_billed=acc["bytes"],
            slot_ms=acc["slot"],
            cost_usd=usd.quantize(Decimal("0.01")),
            cost_brl=brl,
        )

    by_user = sorted(
        (_row_user(k, v) for k, v in by_user_acc.items()),
        key=lambda r: r.cost_brl,
        reverse=True,
    )

    def _row_stmt(acc_key: str, acc: dict[str, int]) -> BqCostStatementRow:
        usd = _bytes_to_usd(acc["bytes"], price_per_tib)
        brl = (usd * rate).quantize(Decimal("0.01"))
        return BqCostStatementRow(
            statement_type=acc_key,
            jobs=acc["jobs"],
            bytes_billed=acc["bytes"],
            slot_ms=acc["slot"],
            cost_usd=usd.quantize(Decimal("0.01")),
            cost_brl=brl,
        )

    by_statement_type = sorted(
        (_row_stmt(k, v) for k, v in by_stmt_acc.items()),
        key=lambda r: r.cost_brl,
        reverse=True,
    )

    def _row_table(fqn: str, acc: dict[str, int | float]) -> BqCostTableRow:
        bytes_int = int(round(float(acc["bytes"])))
        usd = _bytes_to_usd(bytes_int, price_per_tib)
        brl = (usd * rate).quantize(Decimal("0.01"))
        return BqCostTableRow(
            table_fqn=fqn,
            jobs=int(acc["jobs"]),
            bytes_billed=bytes_int,
            cost_usd=usd.quantize(Decimal("0.01")),
            cost_brl=brl,
        )

    by_table = sorted(
        (_row_table(k, v) for k, v in by_table_acc.items()),
        key=lambda r: r.cost_brl,
        reverse=True,
    )[:DEFAULT_TOP_TABLES]

    query_costs.sort(key=lambda x: x[0], reverse=True)
    top_queries: list[BqCostQueryRow] = []
    for bytes_billed, row in query_costs[:DEFAULT_TOP_QUERIES]:
        usd = _bytes_to_usd(bytes_billed, price_per_tib)
        brl = (usd * rate).quantize(Decimal("0.01"))
        creation_time = row["creation_time"]
        if hasattr(creation_time, "isoformat"):
            creation_iso = creation_time.isoformat()
        else:
            creation_iso = str(creation_time)
        preview = (row["query"] or "").strip()
        if len(preview) > QUERY_PREVIEW_CHARS:
            preview = preview[:QUERY_PREVIEW_CHARS] + "…"
        top_queries.append(
            BqCostQueryRow(
                job_id=row["job_id"],
                user_email=(row["user_email"] or None),
                statement_type=row["statement_type"],
                creation_time=creation_iso,
                bytes_billed=bytes_billed,
                slot_ms=row["total_slot_ms"],
                cost_usd=usd.quantize(Decimal("0.01")),
                cost_brl=brl,
                query_preview=preview,
                region=row["region"],
            )
        )

    total_usd = _bytes_to_usd(total_bytes, price_per_tib)
    total_brl = (total_usd * rate).quantize(Decimal("0.01"))

    response = BqCostDashboardResponse(
        from_date=from_d,
        to_date=to_d,
        regions=list(regions),
        exchange_rate=rate.quantize(Decimal("0.0001")),
        price_usd_per_tib=price_per_tib,
        total_jobs=total_jobs,
        total_bytes_billed=total_bytes,
        total_slot_ms=total_slot,
        total_cost_usd=total_usd.quantize(Decimal("0.01")),
        total_cost_brl=total_brl,
        by_user=by_user,
        by_statement_type=by_statement_type,
        by_table=by_table,
        top_queries=top_queries,
        cached=False,
        fetched_at=datetime.now(timezone.utc).isoformat(),
    )

    _cache_put(cache_key, response)
    return response
