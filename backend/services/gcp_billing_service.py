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
from zoneinfo import ZoneInfo

from google.cloud import bigquery
from google.oauth2 import service_account
from googleapiclient.discovery import build as gapi_build

from backend import bigquery_store
from backend.models.gcp_billing import (
    GcpBillingComparisonResponse,
    GcpBillingDailyPoint,
    GcpBillingDashboardResponse,
    GcpBillingDayDetailResponse,
    GcpBillingDaySkusResponse,
    GcpBillingProjectRow,
    GcpBillingServiceRow,
    GcpBillingSkuRow,
    GcpServiceDeltaRow,
    GcpCloudRunByLabelRow,
)
from backend.services.exchange_rate import get_exchange_rate

logger = logging.getLogger(__name__)

DEFAULT_CACHE_TTL = 1800
DEFAULT_MAX_RANGE_DAYS = 92
DEFAULT_TOP_SKUS = 50
TABLE_FQN_PATTERN = re.compile(r"^[A-Za-z0-9_\-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")

# Fuso de billing — alinhado ao GCP Cloud Billing Reports (horário do Pacífico).
BILLING_TZ = os.getenv("BILLING_TZ") or "America/Los_Angeles"
_TZ = ZoneInfo(BILLING_TZ)


def _tz_bounds(from_d: date, to_d: date) -> tuple[datetime, datetime]:
    """Instantes UTC da meia-noite do fuso de billing (início de from_d, fim de to_d)."""
    start = datetime(from_d.year, from_d.month, from_d.day, tzinfo=_TZ).astimezone(timezone.utc)
    end = (datetime(to_d.year, to_d.month, to_d.day, tzinfo=_TZ) + timedelta(days=1)).astimezone(timezone.utc)
    return start, end


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
_day_cache: dict[str, tuple[float, GcpBillingDayDetailResponse]] = {}
_day_skus_cache: dict[str, tuple[float, GcpBillingDaySkusResponse]] = {}
_cmp_cache: dict[str, tuple[float, GcpBillingComparisonResponse]] = {}


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


def _day_cache_get(key: str) -> GcpBillingDayDetailResponse | None:
    ttl = _cache_ttl()
    if ttl <= 0:
        return None
    with _cache_lock:
        entry = _day_cache.get(key)
        if entry is None:
            return None
        ts, payload = entry
        if time.time() - ts > ttl:
            _day_cache.pop(key, None)
            return None
        return payload


def _day_cache_put(key: str, payload: GcpBillingDayDetailResponse) -> None:
    if _cache_ttl() <= 0:
        return
    with _cache_lock:
        _day_cache[key] = (time.time(), payload)


def _day_skus_cache_get(key: str) -> GcpBillingDaySkusResponse | None:
    ttl = _cache_ttl()
    if ttl <= 0:
        return None
    with _cache_lock:
        entry = _day_skus_cache.get(key)
        if entry is None:
            return None
        ts, payload = entry
        if time.time() - ts > ttl:
            _day_skus_cache.pop(key, None)
            return None
        return payload


def _day_skus_cache_put(key: str, payload: GcpBillingDaySkusResponse) -> None:
    if _cache_ttl() <= 0:
        return
    with _cache_lock:
        _day_skus_cache[key] = (time.time(), payload)


def _cmp_cache_get(key: str) -> GcpBillingComparisonResponse | None:
    ttl = _cache_ttl()
    if ttl <= 0:
        return None
    with _cache_lock:
        entry = _cmp_cache.get(key)
        if entry is None:
            return None
        ts, payload = entry
        if time.time() - ts > ttl:
            _cmp_cache.pop(key, None)
            return None
        return payload


def _cmp_cache_put(key: str, payload: GcpBillingComparisonResponse) -> None:
    if _cache_ttl() <= 0:
        return
    with _cache_lock:
        _cmp_cache[key] = (time.time(), payload)


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()
        _day_cache.clear()
        _day_skus_cache.clear()
        _cmp_cache.clear()


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


def _query_by_sku_for_service(table: str, top_n: int) -> str:
    """SKUs de um único serviço (drill-down do detalhamento do dia)."""
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
  AND service.id = @service_id
GROUP BY sku_id
ORDER BY net_cost DESC
LIMIT {int(top_n)}
""".strip()


def _query_daily(table: str) -> str:
    return f"""
SELECT
  DATE(usage_start_time, '{BILLING_TZ}') AS day,
  SUM({_NET_COST_EXPR}) AS net_cost
FROM `{table}`
WHERE usage_start_time >= @from_ts AND usage_start_time < @to_ts
GROUP BY day
ORDER BY day
""".strip()


def _query_cloud_run_cost_by_region(table: str) -> str:
    """Custo de Cloud Run por (dia, região) — base do rateio por CPU."""
    return f"""
SELECT
  DATE(usage_start_time, '{BILLING_TZ}') AS dia,
  location.region AS regiao,
  SUM({_NET_COST_EXPR}) AS net_cost
FROM `{table}`
WHERE usage_start_time >= @from_ts AND usage_start_time < @to_ts
  AND service.description = 'Cloud Run'
GROUP BY dia, regiao
""".strip()


def _query_cloud_run_cost_by_label(table: str) -> str:
    """Custo exato de Cloud Run por (dia, service) via label `service`.

    Só retorna linhas que têm o label — disponível a partir do dia em que os
    labels foram aplicados no template das revisões.
    """
    return f"""
SELECT
  DATE(usage_start_time, '{BILLING_TZ}') AS dia,
  (SELECT l.value FROM UNNEST(labels) l WHERE l.key = 'service' LIMIT 1) AS svc,
  SUM({_NET_COST_EXPR}) AS net_cost
FROM `{table}`
WHERE usage_start_time >= @from_ts AND usage_start_time < @to_ts
  AND service.description = 'Cloud Run'
  AND EXISTS(SELECT 1 FROM UNNEST(labels) l WHERE l.key = 'service')
GROUP BY dia, svc
""".strip()


_CPU_METRIC = "run.googleapis.com/container/cpu/allocation_time"


def _fetch_cpu_by_service(
    project_id: str,
    credentials: service_account.Credentials,
    from_d: date,
    to_d: date,
) -> dict[str, dict[str, dict[str, float]]]:
    """cpu[regiao][service][dia] = vCPU-segundos (Cloud Monitoring).

    Granularidade diária para permitir o merge híbrido (label por dia quando
    existe, senão rateio por CPU). Janelas alinhadas ao fuso de billing.
    """
    mon = gapi_build("monitoring", "v3", credentials=credentials, cache_discovery=False)
    start, end = _tz_bounds(from_d, to_d)
    resp = mon.projects().timeSeries().list(
        name=f"projects/{project_id}",
        filter=f'metric.type="{_CPU_METRIC}"',
        interval_startTime=start.isoformat(),
        interval_endTime=end.isoformat(),
        aggregation_alignmentPeriod="86400s",
        aggregation_perSeriesAligner="ALIGN_SUM",
        aggregation_groupByFields=["resource.labels.location", "resource.labels.service_name"],
        aggregation_crossSeriesReducer="REDUCE_SUM",
    ).execute()
    out: dict[str, dict[str, dict[str, float]]] = {}
    for ts in resp.get("timeSeries", []):
        labels = ts.get("resource", {}).get("labels", {})
        region = labels.get("location", "?")
        svc = labels.get("service_name", "?")
        for p in ts.get("points", []):
            day = p["interval"]["startTime"][:10]
            v = p["value"].get("doubleValue")
            if v is None:
                v = float(p["value"].get("int64Value", 0))
            out.setdefault(region, {}).setdefault(svc, {})
            out[region][svc][day] = out[region][svc].get(day, 0.0) + v
    return out


_REQUEST_METRIC = "run.googleapis.com/request_count"
_LATENCY_METRIC = "run.googleapis.com/request_latencies"


def _point_value(p: dict[str, Any]) -> float:
    v = p["value"].get("doubleValue")
    if v is None:
        v = float(p["value"].get("int64Value", 0))
    return float(v)


def _fetch_request_stats_by_service(
    project_id: str,
    credentials: service_account.Credentials,
    from_d: date,
    to_d: date,
) -> dict[str, dict[str, float]]:
    """stats[service] = {total, err_4xx, err_5xx} de requests no período.

    `request_count` é DELTA por revisão. Agregamos com ALIGN_SUM/REDUCE_SUM por
    (service_name, response_code_class) numa única janela, e derivamos daí tanto
    o total (para custo por request) quanto os erros (para a taxa de erro).
    """
    mon = gapi_build("monitoring", "v3", credentials=credentials, cache_discovery=False)
    start, end = _tz_bounds(from_d, to_d)
    window_s = max(60, int((end - start).total_seconds()))
    resp = mon.projects().timeSeries().list(
        name=f"projects/{project_id}",
        filter=f'metric.type="{_REQUEST_METRIC}"',
        interval_startTime=start.isoformat(),
        interval_endTime=end.isoformat(),
        aggregation_alignmentPeriod=f"{window_s}s",
        aggregation_perSeriesAligner="ALIGN_SUM",
        aggregation_groupByFields=[
            "resource.labels.service_name",
            "metric.labels.response_code_class",
        ],
        aggregation_crossSeriesReducer="REDUCE_SUM",
    ).execute()
    out: dict[str, dict[str, float]] = {}
    for ts in resp.get("timeSeries", []):
        svc = ts.get("resource", {}).get("labels", {}).get("service_name", "?")
        code_class = str(ts.get("metric", {}).get("labels", {}).get("response_code_class", ""))
        total = sum(_point_value(p) for p in ts.get("points", []))
        bucket = out.setdefault(svc, {"total": 0.0, "err_4xx": 0.0, "err_5xx": 0.0})
        bucket["total"] += total
        if code_class == "4xx":
            bucket["err_4xx"] += total
        elif code_class == "5xx":
            bucket["err_5xx"] += total
    return out


_LATENCY_PERCENTILES = (("p50", 50), ("p95", 95), ("p99", 99))


def _fetch_latencies_by_service(
    project_id: str,
    credentials: service_account.Credentials,
    from_d: date,
    to_d: date,
) -> dict[str, dict[str, float]]:
    """latency[service] = {p50, p95, p99} em ms (Cloud Monitoring).

    `request_latencies` é uma DISTRIBUTION por revisão. Para cada percentil
    fazemos uma chamada com ALIGN_DELTA + REDUCE_PERCENTILE_N agrupando por
    service_name — o reducer mescla os buckets das revisões e devolve o
    percentil real da distribuição combinada da janela.
    """
    mon = gapi_build("monitoring", "v3", credentials=credentials, cache_discovery=False)
    start, end = _tz_bounds(from_d, to_d)
    window_s = max(60, int((end - start).total_seconds()))
    out: dict[str, dict[str, float]] = {}
    for label, pct in _LATENCY_PERCENTILES:
        resp = mon.projects().timeSeries().list(
            name=f"projects/{project_id}",
            filter=f'metric.type="{_LATENCY_METRIC}"',
            interval_startTime=start.isoformat(),
            interval_endTime=end.isoformat(),
            aggregation_alignmentPeriod=f"{window_s}s",
            aggregation_perSeriesAligner="ALIGN_DELTA",
            aggregation_groupByFields=["resource.labels.service_name"],
            aggregation_crossSeriesReducer=f"REDUCE_PERCENTILE_{pct}",
        ).execute()
        for ts in resp.get("timeSeries", []):
            svc = ts.get("resource", {}).get("labels", {}).get("service_name", "?")
            points = ts.get("points", [])
            if not points:
                continue
            # Janela única → normalmente 1 ponto; pega o mais recente.
            value = _point_value(points[0])
            out.setdefault(svc, {})[label] = value
    return out


def _query_currency(table: str) -> str:
    return f"""
SELECT currency, COUNT(*) AS cnt
FROM `{table}`
WHERE usage_start_time >= @from_ts AND usage_start_time < @to_ts
GROUP BY currency
ORDER BY cnt DESC
""".strip()


def _resolve_currency_rates(
    currency_rows: list[dict[str, Any]], to_d: date
) -> tuple[str, Decimal, Any, Any]:
    """Resolve a moeda nativa do billing export e os conversores para BRL/USD.

    Prioridade: 1) env var GCP_BILLING_NATIVE_CURRENCY (override explícito)
                2) coluna `currency` da tabela (auto-detecção pela mais frequente)
                3) fallback "USD"

    Retorna (native_currency, usd_rate, to_brl, to_usd).
    """
    override = _native_currency_override()
    if override:
        native_currency = override
        logger.info(
            "GCP billing currency: %s (via GCP_BILLING_NATIVE_CURRENCY override)",
            native_currency,
        )
    else:
        native_currency = "USD"
        if currency_rows:
            # currency_rows já ordenado por cnt DESC — pega a moeda mais frequente.
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

    return native_currency, usd_rate, to_brl, to_usd


def _run_query(client: bigquery.Client, sql: str, from_ts: datetime, to_ts: datetime) -> list[dict[str, Any]]:
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("from_ts", "TIMESTAMP", from_ts),
            bigquery.ScalarQueryParameter("to_ts", "TIMESTAMP", to_ts),
        ]
    )
    return [dict(row) for row in client.query(sql, job_config=job_config).result()]


def _run_query_service(
    client: bigquery.Client, sql: str, from_ts: datetime, to_ts: datetime, service_id: str
) -> list[dict[str, Any]]:
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("from_ts", "TIMESTAMP", from_ts),
            bigquery.ScalarQueryParameter("to_ts", "TIMESTAMP", to_ts),
            bigquery.ScalarQueryParameter("service_id", "STRING", service_id),
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
    # Janela alinhada ao fuso de billing (meia-noite PST), para os totais
    # baterem com o GCP Console.
    from_ts, to_ts = _tz_bounds(from_d, to_d)

    sql_project = _query_by_project(table)
    sql_service = _query_by_service(table)
    sql_sku = _query_by_sku(table, DEFAULT_TOP_SKUS)
    sql_daily = _query_daily(table)
    sql_currency = _query_currency(table)
    sql_cloud_run_region = _query_cloud_run_cost_by_region(table)
    sql_cloud_run_label = _query_cloud_run_cost_by_label(table)

    # Credenciais para o Cloud Monitoring (rateio de Cloud Run por service).
    creds_info = bigquery_store._credentials_info()
    mon_credentials = service_account.Credentials.from_service_account_info(
        creds_info,
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
    ) if creds_info else None
    project_id_for_mon = bigquery_store._project_id()

    def _fetch_cpu() -> dict[str, dict[str, dict[str, float]]]:
        if mon_credentials is None:
            return {}
        try:
            return _fetch_cpu_by_service(project_id_for_mon, mon_credentials, from_d, to_d)
        except Exception as exc:  # Monitoring indisponível: degrada para vazio
            logger.warning("Cloud Run CPU por service indisponível: %s", exc)
            return {}

    def _fetch_request_stats() -> dict[str, dict[str, float]]:
        if mon_credentials is None:
            return {}
        try:
            return _fetch_request_stats_by_service(project_id_for_mon, mon_credentials, from_d, to_d)
        except Exception as exc:  # Monitoring indisponível: degrada para vazio
            logger.warning("Cloud Run request stats por service indisponível: %s", exc)
            return {}

    def _fetch_latencies() -> dict[str, dict[str, float]]:
        if mon_credentials is None:
            return {}
        try:
            return _fetch_latencies_by_service(project_id_for_mon, mon_credentials, from_d, to_d)
        except Exception as exc:  # Monitoring indisponível: degrada para vazio
            logger.warning("Cloud Run latências por service indisponível: %s", exc)
            return {}

    loop = asyncio.get_running_loop()
    try:
        (
            project_rows,
            service_rows,
            sku_rows,
            daily_rows,
            currency_rows,
            cloud_run_region_rows,
            cloud_run_label_rows,
            cpu_by_service,
            request_stats_by_service,
            latencies_by_service,
        ) = await asyncio.gather(
            loop.run_in_executor(None, _run_query, client, sql_project, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_service, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_sku, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_daily, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_currency, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_cloud_run_region, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_cloud_run_label, from_ts, to_ts),
            loop.run_in_executor(None, _fetch_cpu),
            loop.run_in_executor(None, _fetch_request_stats),
            loop.run_in_executor(None, _fetch_latencies),
        )
    except Exception as exc:
        logger.exception("Falha ao consultar GCP billing export.")
        raise RuntimeError(f"BigQuery falhou: {exc}") from exc

    # Detecta a moeda nativa do billing export e resolve conversores BRL/USD.
    # ANY_VALUE(currency) pode ser não-determinístico em contas com linhas multi-moeda,
    # por isso o override via env var é preferível quando a moeda é conhecida.
    native_currency, usd_rate, to_brl, to_usd = _resolve_currency_rates(currency_rows, to_d)

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

    # Cloud Run por service — híbrido POR DIA:
    #   - se há custo exato via label `service` naquele dia → usa o label
    #   - senão → rateia o custo real da região pelo uso de CPU (Monitoring)
    # Assim o retroativo (dias sem label) continua via rateio e os dias novos
    # (com label) ficam exatos, sem dupla contagem.

    # custo real por (dia, região)
    region_cost_by_day: dict[str, dict[str, Decimal]] = {}
    for r in cloud_run_region_rows:
        d = r["dia"].isoformat()
        region = str(r.get("regiao") or "")
        region_cost_by_day.setdefault(d, {})[region] = _to_decimal(r.get("net_cost"))

    # custo exato por (dia, service) via label
    label_cost_by_day: dict[str, dict[str, Decimal]] = {}
    for r in cloud_run_label_rows:
        d = r["dia"].isoformat()
        svc = str(r.get("svc") or "")
        if svc:
            label_cost_by_day.setdefault(d, {})[svc] = _to_decimal(r.get("net_cost"))

    svc_native: dict[str, Decimal] = {}
    all_days = set(region_cost_by_day) | set(label_cost_by_day)
    for d in all_days:
        day_labels = label_cost_by_day.get(d, {})
        labeled_services = {s for s, v in day_labels.items() if v > 0}
        # 1) services com label nesse dia → valor exato
        for svc, v in day_labels.items():
            if v > 0:
                svc_native[svc] = svc_native.get(svc, Decimal("0")) + v
        # 2) o resto da região (sem label) → rateio por CPU entre os não-rotulados
        for region, region_cost in region_cost_by_day.get(d, {}).items():
            region_cpu_day = {
                svc: days.get(d, 0.0)
                for svc, days in cpu_by_service.get(region, {}).items()
            }
            # remove o que já foi contado via label
            unlabeled_cpu = {s: c for s, c in region_cpu_day.items() if s not in labeled_services}
            labeled_cost_region = sum(
                (day_labels.get(s, Decimal("0")) for s in region_cpu_day if s in labeled_services),
                Decimal("0"),
            )
            remaining = region_cost - labeled_cost_region
            total_unlabeled_cpu = sum(unlabeled_cpu.values())
            if remaining <= 0:
                continue
            if total_unlabeled_cpu <= 0:
                svc_native["(sem detalhe)"] = svc_native.get("(sem detalhe)", Decimal("0")) + remaining
                continue
            for svc, svc_cpu in unlabeled_cpu.items():
                frac = Decimal(str(svc_cpu / total_unlabeled_cpu))
                svc_native[svc] = svc_native.get(svc, Decimal("0")) + remaining * frac

    def _cloud_run_row(svc: str, native: Decimal) -> GcpCloudRunByLabelRow:
        cost_usd = _q2(to_usd(native))
        cost_brl = _q2(to_brl(native))
        stats = request_stats_by_service.get(svc, {})
        reqs = int(round(stats.get("total", 0.0)))
        per_million_usd: Decimal | None = None
        per_million_brl: Decimal | None = None
        error_rate: Decimal | None = None
        if reqs > 0:
            factor = Decimal(1_000_000) / Decimal(reqs)
            per_million_usd = _q2(cost_usd * factor)
            per_million_brl = _q2(cost_brl * factor)
            errors = stats.get("err_4xx", 0.0) + stats.get("err_5xx", 0.0)
            error_rate = (Decimal(str(errors)) / Decimal(reqs)).quantize(Decimal("0.0001"))
        lat = latencies_by_service.get(svc, {})

        def _lat(key: str) -> Decimal | None:
            v = lat.get(key)
            return Decimal(str(v)).quantize(Decimal("0.1")) if v is not None else None

        return GcpCloudRunByLabelRow(
            service_name=svc,
            cost_usd=cost_usd,
            cost_brl=cost_brl,
            requests=reqs,
            cost_per_million_usd=per_million_usd,
            cost_per_million_brl=per_million_brl,
            latency_p50_ms=_lat("p50"),
            latency_p95_ms=_lat("p95"),
            latency_p99_ms=_lat("p99"),
            error_rate=error_rate,
        )

    cloud_run_by_label: list[GcpCloudRunByLabelRow] = sorted(
        (
            _cloud_run_row(svc, native)
            for svc, native in svc_native.items()
            if native > 0
        ),
        key=lambda r: r.cost_brl,
        reverse=True,
    )

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


async def build_day_detail(
    date_str: str | None,
    use_cache: bool = True,
) -> GcpBillingDayDetailResponse:
    """Detalhamento de custo (projeto/serviço/SKU) de um único dia.

    Drill-down do gráfico diário: reutiliza as mesmas queries do dashboard, mas
    com a janela restrita ao dia informado, alinhada ao fuso de billing.
    """
    if not is_enabled():
        raise RuntimeError(
            "Integração GCP Billing desabilitada: configure BQ_PROJECT_ID, GCP_CREDS_JSON_CREDS_BASE64 e GCP_BILLING_TABLE."
        )

    table = _table_fqn()
    assert table is not None  # guarded by is_enabled()

    day = _parse_date(date_str, field="date")
    cache_key = f"{day.isoformat()}|{table}"
    if use_cache:
        cached = _day_cache_get(cache_key)
        if cached is not None:
            return cached.model_copy(update={"cached": True})

    client = bigquery_store._get_client()
    # Janela de um único dia, alinhada à meia-noite do fuso de billing.
    from_ts, to_ts = _tz_bounds(day, day)

    sql_project = _query_by_project(table)
    sql_service = _query_by_service(table)
    sql_sku = _query_by_sku(table, DEFAULT_TOP_SKUS)
    sql_currency = _query_currency(table)

    loop = asyncio.get_running_loop()
    try:
        project_rows, service_rows, sku_rows, currency_rows = await asyncio.gather(
            loop.run_in_executor(None, _run_query, client, sql_project, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_service, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_sku, from_ts, to_ts),
            loop.run_in_executor(None, _run_query, client, sql_currency, from_ts, to_ts),
        )
    except Exception as exc:
        logger.exception("Falha ao consultar detalhamento diário de GCP billing.")
        raise RuntimeError(f"BigQuery falhou: {exc}") from exc

    native_currency, usd_rate, to_brl, to_usd = _resolve_currency_rates(currency_rows, day)

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

    total_gross_native = total_net_native - total_credits_native

    response = GcpBillingDayDetailResponse(
        date=day,
        currency=native_currency,
        exchange_rate=usd_rate.quantize(Decimal("0.0001")),
        total_cost_usd=to_usd(total_net_native),
        total_cost_brl=to_brl(total_net_native),
        total_credits_usd=to_usd(total_credits_native),
        total_gross_usd=to_usd(total_gross_native),
        by_project=by_project,
        by_service=by_service,
        by_sku=by_sku,
        cached=False,
        fetched_at=datetime.now(timezone.utc).isoformat(),
    )

    _day_cache_put(cache_key, response)
    return response


async def build_day_service_skus(
    date_str: str | None,
    service_id: str | None,
    use_cache: bool = True,
) -> GcpBillingDaySkusResponse:
    """SKUs de um serviço específico num único dia (drill-down encadeado)."""
    if not is_enabled():
        raise RuntimeError(
            "Integração GCP Billing desabilitada: configure BQ_PROJECT_ID, GCP_CREDS_JSON_CREDS_BASE64 e GCP_BILLING_TABLE."
        )

    table = _table_fqn()
    assert table is not None  # guarded by is_enabled()

    day = _parse_date(date_str, field="date")
    svc_id = (service_id or "").strip()
    if not svc_id:
        raise ValueError("`service_id` é obrigatório.")

    cache_key = f"{day.isoformat()}|{svc_id}|{table}"
    if use_cache:
        cached = _day_skus_cache_get(cache_key)
        if cached is not None:
            return cached.model_copy(update={"cached": True})

    client = bigquery_store._get_client()
    from_ts, to_ts = _tz_bounds(day, day)

    sql_sku = _query_by_sku_for_service(table, DEFAULT_TOP_SKUS)
    sql_currency = _query_currency(table)

    loop = asyncio.get_running_loop()
    try:
        sku_rows, currency_rows = await asyncio.gather(
            loop.run_in_executor(None, _run_query_service, client, sql_sku, from_ts, to_ts, svc_id),
            loop.run_in_executor(None, _run_query, client, sql_currency, from_ts, to_ts),
        )
    except Exception as exc:
        logger.exception("Falha ao consultar SKUs do serviço no dia.")
        raise RuntimeError(f"BigQuery falhou: {exc}") from exc

    native_currency, usd_rate, to_brl, to_usd = _resolve_currency_rates(currency_rows, day)

    service_description: str | None = None
    by_sku: list[GcpBillingSkuRow] = []
    for r in sku_rows:
        if service_description is None:
            service_description = r.get("service_description") or None
        by_sku.append(
            GcpBillingSkuRow(
                sku_id=str(r.get("sku_id") or ""),
                sku_description=str(r.get("sku_description") or r.get("sku_id") or "—"),
                service_description=str(r.get("service_description") or "—"),
                cost_usd=to_usd(_to_decimal(r.get("net_cost"))),
                cost_brl=to_brl(_to_decimal(r.get("net_cost"))),
                usage_amount=_q6(_to_decimal(r.get("usage_amount"))),
                usage_unit=(r.get("usage_unit") or None),
            )
        )

    response = GcpBillingDaySkusResponse(
        date=day,
        service_id=svc_id,
        service_description=service_description,
        currency=native_currency,
        exchange_rate=usd_rate.quantize(Decimal("0.0001")),
        by_sku=by_sku,
        cached=False,
        fetched_at=datetime.now(timezone.utc).isoformat(),
    )

    _day_skus_cache_put(cache_key, response)
    return response


async def build_comparison(
    from_str: str | None,
    to_str: str | None,
    use_cache: bool = True,
) -> GcpBillingComparisonResponse:
    """Compara o custo por serviço do período atual com o período anterior.

    O período anterior tem a mesma duração e termina no dia imediatamente
    antes de `from`. Retorna o ranking de serviços por maior variação absoluta —
    responde direto ao "subiu, por quê?".
    """
    if not is_enabled():
        raise RuntimeError(
            "Integração GCP Billing desabilitada: configure BQ_PROJECT_ID, GCP_CREDS_JSON_CREDS_BASE64 e GCP_BILLING_TABLE."
        )

    table = _table_fqn()
    assert table is not None  # guarded by is_enabled()

    from_d, to_d = _resolve_window(from_str, to_str)
    span = (to_d - from_d).days + 1
    prev_to = from_d - timedelta(days=1)
    prev_from = prev_to - timedelta(days=span - 1)

    cache_key = f"cmp|{from_d.isoformat()}|{to_d.isoformat()}|{table}"
    if use_cache:
        cached = _cmp_cache_get(cache_key)
        if cached is not None:
            return cached.model_copy(update={"cached": True})

    client = bigquery_store._get_client()
    cur_from_ts, cur_to_ts = _tz_bounds(from_d, to_d)
    prev_from_ts, prev_to_ts = _tz_bounds(prev_from, prev_to)

    sql_service = _query_by_service(table)
    sql_currency = _query_currency(table)

    loop = asyncio.get_running_loop()
    try:
        cur_rows, prev_rows, currency_rows = await asyncio.gather(
            loop.run_in_executor(None, _run_query, client, sql_service, cur_from_ts, cur_to_ts),
            loop.run_in_executor(None, _run_query, client, sql_service, prev_from_ts, prev_to_ts),
            loop.run_in_executor(None, _run_query, client, sql_currency, cur_from_ts, cur_to_ts),
        )
    except Exception as exc:
        logger.exception("Falha ao comparar períodos de GCP billing.")
        raise RuntimeError(f"BigQuery falhou: {exc}") from exc

    native_currency, usd_rate, to_brl, to_usd = _resolve_currency_rates(currency_rows, to_d)

    cur_native: dict[str, Decimal] = {}
    descriptions: dict[str, str] = {}
    for r in cur_rows:
        sid = str(r.get("service_id") or "")
        cur_native[sid] = _to_decimal(r.get("net_cost"))
        descriptions[sid] = str(r.get("service_description") or r.get("service_id") or "—")

    prev_native: dict[str, Decimal] = {}
    for r in prev_rows:
        sid = str(r.get("service_id") or "")
        prev_native[sid] = _to_decimal(r.get("net_cost"))
        descriptions.setdefault(sid, str(r.get("service_description") or r.get("service_id") or "—"))

    rows: list[GcpServiceDeltaRow] = []
    for sid in set(cur_native) | set(prev_native):
        cur_n = cur_native.get(sid, Decimal("0"))
        prev_n = prev_native.get(sid, Decimal("0"))
        delta_n = cur_n - prev_n
        pct = (delta_n / prev_n).quantize(Decimal("0.0001")) if prev_n != 0 else None
        rows.append(
            GcpServiceDeltaRow(
                service_id=sid,
                service_description=descriptions.get(sid, "—"),
                current_usd=to_usd(cur_n),
                current_brl=to_brl(cur_n),
                previous_usd=to_usd(prev_n),
                previous_brl=to_brl(prev_n),
                delta_usd=to_usd(delta_n),
                delta_brl=to_brl(delta_n),
                delta_pct=pct,
            )
        )
    rows.sort(key=lambda r: abs(r.delta_brl), reverse=True)

    cur_total = sum(cur_native.values(), Decimal("0"))
    prev_total = sum(prev_native.values(), Decimal("0"))
    delta_total = cur_total - prev_total
    delta_total_pct = (
        (delta_total / prev_total).quantize(Decimal("0.0001")) if prev_total != 0 else None
    )

    response = GcpBillingComparisonResponse(
        from_date=from_d,
        to_date=to_d,
        prev_from_date=prev_from,
        prev_to_date=prev_to,
        currency=native_currency,
        exchange_rate=usd_rate.quantize(Decimal("0.0001")),
        current_total_usd=to_usd(cur_total),
        current_total_brl=to_brl(cur_total),
        previous_total_usd=to_usd(prev_total),
        previous_total_brl=to_brl(prev_total),
        delta_total_usd=to_usd(delta_total),
        delta_total_brl=to_brl(delta_total),
        delta_total_pct=delta_total_pct,
        by_service_delta=rows,
        cached=False,
        fetched_at=datetime.now(timezone.utc).isoformat(),
    )

    _cmp_cache_put(cache_key, response)
    return response
