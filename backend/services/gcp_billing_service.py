"""GCP Billing dashboard service.

Consulta o billing export padrão do GCP (`gcp_billing_export_v1_*`) em BigQuery
e agrega: por projeto, serviço, SKU (top N) e total diário. Custo líquido =
`cost + SUM(credits.amount)` (créditos chegam negativos).

A tabela de export é configurada via `GCP_BILLING_TABLE` (FQN completa, ex.
`projeto.dataset.gcp_billing_export_v1_AAAA_BBBB_CCCC`). Sem essa variável a
integração fica desabilitada e o endpoint retorna 503.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from decimal import Decimal
from typing import Any

from google.cloud import bigquery

from backend import bigquery_store
from backend.models.gcp_billing import (
    GcpBillingDailyPoint,
    GcpBillingDashboardResponse,
    GcpBillingProjectRow,
    GcpBillingServiceRow,
    GcpBillingSkuRow,
    GcpCloudRunByLabelRow,
)
from backend.services.exchange_rate import get_exchange_rate

logger = logging.getLogger(__name__)

DEFAULT_CACHE_TTL = 1800
DEFAULT_MAX_RANGE_DAYS = 92
DEFAULT_TOP_SKUS = 50
TABLE_FQN_PATTERN = re.compile(r"^[A-Za-z0-9_\-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")


def _native_currency_override() -> str | None:
    """Permite forçar a moeda nativa via GCP_BILLING_NATIVE_CURRENCY (ex: BRL ou USD).
    Evita dependência de detecção automática via ANY_VALUE(currency) que pode ser
    não-determinístico em billing accounts com linhas em múltiplas moedas.
    """
    raw = (os.getenv("GCP_BILLING_NATIVE_CURRENCY") or "").strip().upper()
    return raw if raw in ("BRL", "USD") else None


def _table_fqn() -> str | None:
    raw = (os.getenv("GCP_BILLING_TABLE") or "").strip()
    if not raw:
        return None
    if not TABLE_FQN_PATTERN.match(raw):
        logger.warning("GCP_BILLING_TABLE inválido (esperado project.dataset.table): %s", raw)
        return None
    return raw


def is_enabled() -> bool:
    return bigquery_store.is_enabled() and _table_fqn() is not None


def _cache_ttl() -> int:
    raw = (os.getenv("GCP_BILLING_CACHE_TTL_SECONDS") or "").strip()
    if not raw:
        return DEFAULT_CACHE_TTL
    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_CACHE_TTL


def _max_range_days() -> int:
    raw = (os.getenv("GCP_BILLING_MAX_RANGE_DAYS") or "").strip()
    if not raw:
        return DEFAULT_MAX_RANGE_DAYS
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_MAX_RANGE_DAYS


_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, GcpBillingDashboardResponse]] = {}


def _cache_get(key: str) -> GcpBillingDashboardResponse | None:
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


def _cache_put(key: str, payload: GcpBillingDashboardResponse) -> None:
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


def _resolve_window(from_str: str | None, to_str: str | None) -> tuple[date, date]:
    from_d = _parse_date(from_str, field="from")
    to_d = _parse_date(to_str, field="to")
    if from_d > to_d:
        raise ValueError("`from` deve ser anterior ou igual a `to`.")
    span = (to_d - from_d).days + 1
    if span > _max_range_days():
        raise ValueError(
            f"Intervalo máximo é {_max_range_days()} dias (recebido: {span})."
        )
    return from_d, to_d


def _to_decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal("0")


def _q2(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"))


def _q6(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.000001"))


_NET_COST_EXPR = (
    "cost + COALESCE((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)"
)
_CREDITS_EXPR = (
    "COALESCE((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)"
)


def _query_by_project(table: str) -> str:
    return f"""
SELECT
  project.id AS project_id,
  ANY_VALUE(project.name) AS project_name,
  SUM({_NET_COST_EXPR}) AS net_cost,
  SUM({_CREDITS_EXPR}) AS credits_amount
FROM `{table}`
WHERE usage_start_time >= @from_ts AND usage_start_time < @to_ts
GROUP BY project_id
""".strip()


def _query_by_service(table: str) -> str:
    return f"""
SELECT
  service.id AS service_id,
  ANY_VALUE(service.description) AS service_description,
  SUM({_NET_COST_EXPR}) AS net_cost
FROM `{table}`
WHERE usage_start_time >= @from_ts AND usage_start_time < @to_ts
GROUP BY service_id
""".strip()


def _query_by_sku(table: str, top_n: int) -> str:
    return f"""
SELECT
  sku.id AS sku_id,
  ANY_VALUE(sku.description) AS sku_description,
  ANY_VALUE(service.description) AS service_description,
  SUM({_NET_COST_EXPR}) AS net_cost,
  SUM(usage.amount) AS usage_amount,
  ANY_VALUE(usage.unit) AS usage_unit
FROM `{table}`
WHERE usage_start_time >= @from_ts AND usage_start_time < @to_ts
GROUP BY sku_id
ORDER BY net_cost DESC
LIMIT {int(top_n)}
""".strip()


def _query_daily(table: str) -> str:
    return f"""
SELECT
  DATE(usage_start_time) AS day,
  SUM({_NET_COST_EXPR}) AS net_cost
FROM `{table}`
WHERE usage_start_time >= @from_ts AND usage_start_time < @to_ts
GROUP BY day
ORDER BY day
""".strip()


def _query_cloud_run_by_label(table: str) -> str:
    """Agrega custo do Cloud Run pelo label 'service' adicionado nos services/functions.

    Linhas sem o label 'service' são agrupadas como '(sem label)'.
    """
    return f"""
SELECT
  COALESCE(
    (SELECT l.value FROM UNNEST(labels) l WHERE l.key = 'service' LIMIT 1),
    '(sem label)'
  ) AS service_name,
  SUM({_NET_COST_EXPR}) AS net_cost
FROM `{table}`
WHERE usage_start_time >= @from_ts AND usage_start_time < @to_ts
  AND service.description = 'Cloud Run'
GROUP BY service_name
ORDER BY net_cost DESC
""".strip()


def _query_currency(table: str) -> str:
    return f"""
SELECT currency, COUNT(*) AS cnt
FROM `{table}`
WHERE usage_start_time >= @from_ts AND usage_start_time < @to_ts
GROUP BY currency
ORDER BY cnt DESC
""".strip()


def _run_query(client: bigquery.Client, sql: str, from_ts: datetime, to_ts: datetime) -> list[dict[str, Any]]:
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("from_ts", "TIMESTAMP", from_ts),
            bigquery.ScalarQueryParameter("to_ts", "TIMESTAMP", to_ts),
        ]
    )
    return [dict(row) for row in client.query(sql, job_config=job_config).result()]


async def build_dashboard(
    from_str: str | None,
    to_str: str | None,
    use_cache: bool = True,
) -> GcpBillingDashboardResponse:
    if not is_enabled():
        raise RuntimeError(
            "Integração GCP Billing desabilitada: configure BQ_PROJECT_ID, GCP_CREDS_JSON_CREDS_BASE64 e GCP_BILLING_TABLE."
        )

    table = _table_fqn()
    assert table is not None  # guarded by is_enabled()

    from_d, to_d = _resolve_window(from_str, to_str)
    cache_key = f"{from_d.isoformat()}|{to_d.isoformat()}|{table}"
    if use_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached.model_copy(update={"cached": True})

    client = bigquery_store._get_client()
    from_ts = datetime.combine(from_d, dtime.min, tzinfo=timezone.utc)
    to_ts = datetime.combine(to_d + timedelta(days=1), dtime.min, tzinfo=timezone.utc)

    sql_project = _query_by_project(table)
    sql_service = _query_by_service(table)
    sql_sku = _query_by_sku(table, DEFAULT_TOP_SKUS)
    sql_daily = _query_daily(table)
    sql_currency = _query_currency(table)
    sql_cloud_run_label = _query_cloud_run_by_label(table)

    # Todas as queries em paralelo (inclui cloud_run_by_label, antes sequencial).
    loop = asyncio.get_running_loop()
    try:
        (
            project_rows,
            service_rows,
            sku_rows,
            daily_rows,
            currency_rows,
            cloud_run_label_rows,
        ) = await asyncio.gather(
            loop.run_in_executor(None, _run_query, client, sql_project, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_service, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_sku, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_daily, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_currency, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_cloud_run_label, from_ts, to_ts),
        )
    except Exception as exc:
        logger.exception("Falha ao consultar GCP billing export.")
        raise RuntimeError(f"BigQuery falhou: {exc}") from exc

    # Detecta a moeda nativa do billing export.
    # Prioridade: 1) env var GCP_BILLING_NATIVE_CURRENCY (override explícito)
    #             2) coluna `currency` da tabela (auto-detecção)
    #             3) fallback "USD"
    # ANY_VALUE(currency) pode ser não-determinístico em contas com linhas multi-moeda,
    # por isso o override via env var é preferível quando a moeda é conhecida.
    override = _native_currency_override()
    if override:
        native_currency = override
        logger.info("GCP billing currency: %s (via GCP_BILLING_NATIVE_CURRENCY override)", native_currency)
    else:
        native_currency = "USD"
        if currency_rows:
            # currency_rows: [{currency: "BRL", cnt: 1234}, {currency: "USD", cnt: 5}, ...]
            # Já ordenado por cnt DESC — pega a moeda mais frequente.
            logger.warning("GCP billing currency distribution: %s", currency_rows)
            dominant = str(currency_rows[0].get("currency") or "").strip().upper()
            if dominant in ("BRL", "USD"):
                native_currency = dominant
        logger.warning("GCP billing native_currency resolved: %s", native_currency)

    if native_currency == "BRL":
        rate = Decimal("1")
        usd_rate = get_exchange_rate(to_d)
    else:
        rate = get_exchange_rate(to_d)
        usd_rate = rate

    def to_brl(native: Decimal) -> Decimal:
        return native if native_currency == "BRL" else _q2(native * rate)

    def to_usd(native: Decimal) -> Decimal:
        return _q2(native / usd_rate) if native_currency == "BRL" else native

    by_project: list[GcpBillingProjectRow] = []
    total_net_native = Decimal("0")
    total_credits_native = Decimal("0")
    for r in project_rows:
        net = _to_decimal(r.get("net_cost"))
        credits_amount = _to_decimal(r.get("credits_amount"))
        total_net_native += net
        total_credits_native += credits_amount
        by_project.append(
            GcpBillingProjectRow(
                project_id=str(r.get("project_id") or "(sem projeto)"),
                project_name=(r.get("project_name") or None),
                cost_usd=to_usd(net),
                cost_brl=to_brl(net),
                credits_usd=to_usd(credits_amount),
            )
        )
    by_project.sort(key=lambda r: r.cost_brl, reverse=True)

    by_service: list[GcpBillingServiceRow] = [
        GcpBillingServiceRow(
            service_id=str(r.get("service_id") or ""),
            service_description=str(r.get("service_description") or r.get("service_id") or "—"),
            cost_usd=to_usd(_to_decimal(r.get("net_cost"))),
            cost_brl=to_brl(_to_decimal(r.get("net_cost"))),
        )
        for r in service_rows
    ]
    by_service.sort(key=lambda r: r.cost_brl, reverse=True)

    by_sku: list[GcpBillingSkuRow] = [
        GcpBillingSkuRow(
            sku_id=str(r.get("sku_id") or ""),
            sku_description=str(r.get("sku_description") or r.get("sku_id") or "—"),
            service_description=str(r.get("service_description") or "—"),
            cost_usd=to_usd(_to_decimal(r.get("net_cost"))),
            cost_brl=to_brl(_to_decimal(r.get("net_cost"))),
            usage_amount=_q6(_to_decimal(r.get("usage_amount"))),
            usage_unit=(r.get("usage_unit") or None),
        )
        for r in sku_rows
    ]

    daily: list[GcpBillingDailyPoint] = [
        GcpBillingDailyPoint(
            day=r["day"],
            cost_usd=to_usd(_to_decimal(r.get("net_cost"))),
            cost_brl=to_brl(_to_decimal(r.get("net_cost"))),
        )
        for r in daily_rows
    ]

    cloud_run_by_label: list[GcpCloudRunByLabelRow] = [
        GcpCloudRunByLabelRow(
            service_name=str(r.get("service_name") or "(sem label)"),
            cost_usd=to_usd(_to_decimal(r.get("net_cost"))),
            cost_brl=to_brl(_to_decimal(r.get("net_cost"))),
        )
        for r in cloud_run_label_rows
        if _to_decimal(r.get("net_cost")) > 0
    ]

    total_gross_native = total_net_native - total_credits_native

    response = GcpBillingDashboardResponse(
        from_date=from_d,
        to_date=to_d,
        currency=native_currency,
        exchange_rate=usd_rate.quantize(Decimal("0.0001")),
        total_cost_usd=to_usd(total_net_native),
        total_cost_brl=to_brl(total_net_native),
        total_credits_usd=to_usd(total_credits_native),
        total_gross_usd=to_usd(total_gross_native),
        by_project=by_project,
        by_service=by_service,
        by_sku=by_sku,
        daily=daily,
        cloud_run_by_label=cloud_run_by_label,
        cached=False,
        fetched_at=datetime.now(timezone.utc).isoformat(),
    )

    _cache_put(cache_key, response)
    return response
