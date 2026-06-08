"""Serviço do dashboard de custo de notas fiscais.

Cruza volume de notas processadas (`invoices-processed`) com o custo de infra
que as gera: Cloud Run `invoice-reader` (southamerica-east1) + `hypr-captcha-solver`
(europe-west1).

Atribuição de custo (retroativa, sem depender de labels):
  Para cada service, rateia o custo REAL de Cloud Run da sua região (billing
  export) proporcionalmente ao seu uso de CPU (Cloud Monitoring
  `container/cpu/allocation_time`, por service, retroativo ~6 semanas).

    custo_service(dia) = custo_regiao(dia) × cpu_service(dia) / cpu_total_regiao(dia)

  O Monitoring guarda métricas por service muito antes dos labels existirem, e o
  numerador é o custo real do billing — então a soma bate com a fatura e cada
  service recebe sua fatia proporcional ao consumo de CPU.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from google.cloud import bigquery
from google.oauth2 import service_account
from googleapiclient.discovery import build as gapi_build

from backend import bigquery_store
from backend.models.invoice_cost import InvoiceCostResponse, InvoiceDailyRow

logger = logging.getLogger(__name__)

DEFAULT_CACHE_TTL = 1800
DEFAULT_MAX_RANGE_DAYS = 92
DEFAULT_INVOICES_TABLE = "site-hypr.hypr_invoice_data.invoices-processed"

# Services que processam notas: (service_name no Cloud Run, região, chave de saída).
INVOICE_SERVICES = [
    ("invoice-reader", "southamerica-east1", "invoice_reader"),
    ("hypr-captcha-solver", "europe-west1", "captcha"),
]
_CPU_METRIC = "run.googleapis.com/container/cpu/allocation_time"


def _invoices_table() -> str:
    return (os.getenv("INVOICES_TABLE") or DEFAULT_INVOICES_TABLE).strip()


def _billing_table() -> str | None:
    raw = (os.getenv("GCP_BILLING_TABLE") or "").strip()
    return raw or None


def is_enabled() -> bool:
    return bigquery_store.is_enabled() and _billing_table() is not None


def _cache_ttl() -> int:
    raw = (os.getenv("INVOICE_COST_CACHE_TTL_SECONDS") or "").strip()
    try:
        return max(0, int(raw)) if raw else DEFAULT_CACHE_TTL
    except ValueError:
        return DEFAULT_CACHE_TTL


def _max_range_days() -> int:
    raw = (os.getenv("INVOICE_COST_MAX_RANGE_DAYS") or "").strip()
    try:
        return max(1, int(raw)) if raw else DEFAULT_MAX_RANGE_DAYS
    except ValueError:
        return DEFAULT_MAX_RANGE_DAYS


_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, InvoiceCostResponse]] = {}


def _cache_get(key: str) -> InvoiceCostResponse | None:
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


def _cache_put(key: str, payload: InvoiceCostResponse) -> None:
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
        raise ValueError(f"Intervalo máximo é {_max_range_days()} dias (recebido: {span}).")
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


def _q2(v: Decimal) -> Decimal:
    return v.quantize(Decimal("0.01"))


def _q4(v: Decimal) -> Decimal:
    return v.quantize(Decimal("0.0001"))


def _q8(v: Decimal) -> Decimal:
    # custo por nota pode ser fração de centavo — preserva precisão para o
    # frontend formatar com casas adaptativas (evita arredondar para zero).
    return v.quantize(Decimal("0.00000001"))


def _query_invoices(table: str) -> str:
    return f"""
SELECT DATE(processed_at) AS dia, COUNT(*) AS total
FROM `{table}`
WHERE DATE(processed_at) BETWEEN @from_d AND @to_d
GROUP BY dia
""".strip()


_NET = "cost + COALESCE((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)"


def _query_cost_by_region(billing_table: str) -> str:
    return f"""
SELECT
  DATE(usage_start_time) AS dia,
  location.region AS regiao,
  SUM({_NET}) AS net
FROM `{billing_table}`
WHERE service.description = 'Cloud Run'
  AND DATE(usage_start_time) BETWEEN @from_d AND @to_d
GROUP BY dia, regiao
""".strip()


def _query_cost_by_label(billing_table: str) -> str:
    # Custo exato por service via o label `service` (disponível a partir do dia
    # em que os labels foram aplicados nos serviços).
    names = ", ".join(f"'{name}'" for name, _, _ in INVOICE_SERVICES)
    return f"""
SELECT
  DATE(usage_start_time) AS dia,
  (SELECT l.value FROM UNNEST(labels) l WHERE l.key = 'service' LIMIT 1) AS svc,
  SUM({_NET}) AS net
FROM `{billing_table}`
WHERE service.description = 'Cloud Run'
  AND DATE(usage_start_time) BETWEEN @from_d AND @to_d
  AND (SELECT l.value FROM UNNEST(labels) l WHERE l.key = 'service' LIMIT 1) IN ({names})
GROUP BY dia, svc
""".strip()


def _run_bq(client: bigquery.Client, sql: str, from_d: date, to_d: date) -> list[dict[str, Any]]:
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("from_d", "DATE", from_d),
            bigquery.ScalarQueryParameter("to_d", "DATE", to_d),
        ]
    )
    return [dict(r) for r in client.query(sql, job_config=job_config).result(timeout=45)]


def _fetch_cpu_allocation(
    project_id: str,
    credentials: service_account.Credentials,
    from_d: date,
    to_d: date,
    regions: list[str],
) -> dict[str, dict[str, dict[str, float]]]:
    """Retorna cpu[regiao][service][dia] = vCPU-segundos, via Cloud Monitoring.

    Janelas diárias alinhadas a meia-noite UTC (batem com DATE() do billing).
    """
    mon = gapi_build("monitoring", "v3", credentials=credentials, cache_discovery=False)
    start = datetime(from_d.year, from_d.month, from_d.day, tzinfo=timezone.utc)
    end = datetime(to_d.year, to_d.month, to_d.day, tzinfo=timezone.utc) + timedelta(days=1)

    region_filter = " OR ".join(f'resource.labels.location="{r}"' for r in regions)
    resp = mon.projects().timeSeries().list(
        name=f"projects/{project_id}",
        filter=f'metric.type="{_CPU_METRIC}" AND ({region_filter})',
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
            # Janela diária [start, end): o consumo pertence ao dia do startTime
            # (alinha com DATE(usage_start_time) do billing). Usar endTime
            # desalinharia 1 dia.
            day = p["interval"]["startTime"][:10]
            v = p["value"].get("doubleValue")
            if v is None:
                v = float(p["value"].get("int64Value", 0))
            out.setdefault(region, {}).setdefault(svc, {})
            out[region][svc][day] = out[region][svc].get(day, 0.0) + v
    return out


async def build_dashboard(
    from_str: str | None,
    to_str: str | None,
    use_cache: bool = True,
) -> InvoiceCostResponse:
    if not is_enabled():
        raise RuntimeError(
            "Integração de custo de notas desabilitada: configure BQ_PROJECT_ID, credenciais e GCP_BILLING_TABLE."
        )

    billing_table = _billing_table()
    assert billing_table is not None

    from_d, to_d = _resolve_window(from_str, to_str)
    cache_key = f"{from_d.isoformat()}|{to_d.isoformat()}"
    if use_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached.model_copy(update={"cached": True})

    client = bigquery_store._get_client()
    project_id = bigquery_store._project_id()
    creds_info = bigquery_store._credentials_info()
    credentials = service_account.Credentials.from_service_account_info(
        creds_info,
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )
    regions = sorted({region for _, region, _ in INVOICE_SERVICES})

    loop = asyncio.get_running_loop()
    try:
        invoice_rows, cost_rows, label_rows, cpu = await asyncio.gather(
            loop.run_in_executor(None, _run_bq, client, _query_invoices(_invoices_table()), from_d, to_d),
            loop.run_in_executor(None, _run_bq, client, _query_cost_by_region(billing_table), from_d, to_d),
            loop.run_in_executor(None, _run_bq, client, _query_cost_by_label(billing_table), from_d, to_d),
            loop.run_in_executor(None, _fetch_cpu_allocation, project_id, credentials, from_d, to_d, regions),
        )
    except Exception as exc:
        logger.exception("Falha ao montar dashboard de custo de notas.")
        raise RuntimeError(f"BigQuery/Monitoring falhou: {exc}") from exc

    invoices_by_day: dict[str, int] = {r["dia"].isoformat(): int(r.get("total") or 0) for r in invoice_rows}

    # custo[regiao][dia] = custo real de Cloud Run
    cost_by_region: dict[str, dict[str, Decimal]] = {}
    for r in cost_rows:
        d = r["dia"].isoformat()
        region = str(r.get("regiao") or "")
        cost_by_region.setdefault(region, {})[d] = _to_decimal(r.get("net"))

    # Custo exato por label: label_cost[service_name][dia] = Decimal
    label_cost: dict[str, dict[str, Decimal]] = {}
    for r in label_rows:
        svc = str(r.get("svc") or "")
        d = r["dia"].isoformat()
        label_cost.setdefault(svc, {})[d] = _to_decimal(r.get("net"))

    # Rateio por CPU (fallback retroativo): custo da região × fração de CPU.
    ratio_cost: dict[str, dict[str, Decimal]] = {key: {} for _, _, key in INVOICE_SERVICES}
    for service_name, region, key in INVOICE_SERVICES:
        region_cpu = cpu.get(region, {})
        total_cpu_by_day: dict[str, float] = {}
        for _svc, days in region_cpu.items():
            for day, v in days.items():
                total_cpu_by_day[day] = total_cpu_by_day.get(day, 0.0) + v
        svc_cpu_by_day = region_cpu.get(service_name, {})
        region_cost = cost_by_region.get(region, {})
        for day, region_total_cost in region_cost.items():
            total_cpu = total_cpu_by_day.get(day, 0.0)
            svc_cpu = svc_cpu_by_day.get(day, 0.0)
            if total_cpu > 0:
                frac = Decimal(str(svc_cpu / total_cpu))
                ratio_cost[key][day] = region_total_cost * frac

    # Estratégia híbrida por (service, dia): prefere label exato; senão rateio.
    # Retorna (custo, usou_label).
    def cost_for(service_name: str, key: str, day: str) -> tuple[Decimal, bool]:
        lbl = label_cost.get(service_name, {}).get(day)
        if lbl is not None and lbl > 0:
            return lbl, True
        return ratio_cost.get(key, {}).get(day, Decimal("0")), False

    name_by_key = {key: name for name, _, key in INVOICE_SERVICES}

    all_days = sorted(
        set(invoices_by_day)
        | {d for days in ratio_cost.values() for d in days}
        | {d for days in label_cost.values() for d in days},
        reverse=True,
    )

    daily: list[InvoiceDailyRow] = []
    total_invoices = 0
    total_captcha = Decimal("0")
    total_reader = Decimal("0")
    for d in all_days:
        n = invoices_by_day.get(d, 0)
        captcha, cap_lbl = cost_for(name_by_key["captcha"], "captcha", d)
        reader, rd_lbl = cost_for(name_by_key["invoice_reader"], "invoice_reader", d)
        total = captcha + reader
        total_invoices += n
        total_captcha += captcha
        total_reader += reader
        per_invoice = (total / Decimal(n)) if n > 0 else Decimal("0")
        # source do dia: "label" só se todos os custos não-zero vieram de label.
        used_ratio = (captcha > 0 and not cap_lbl) or (reader > 0 and not rd_lbl)
        source = "estimated" if used_ratio else "label"
        daily.append(
            InvoiceDailyRow(
                day=date.fromisoformat(d),
                invoices=n,
                captcha_brl=_q2(captcha),
                invoice_reader_brl=_q2(reader),
                total_brl=_q2(total),
                cost_per_invoice_brl=_q8(per_invoice),
                source=source,
            )
        )

    total_cost = total_captcha + total_reader
    avg_per_invoice = (total_cost / Decimal(total_invoices)) if total_invoices > 0 else Decimal("0")

    response = InvoiceCostResponse(
        from_date=from_d,
        to_date=to_d,
        total_invoices=total_invoices,
        total_captcha_brl=_q2(total_captcha),
        total_invoice_reader_brl=_q2(total_reader),
        total_cost_brl=_q2(total_cost),
        avg_cost_per_invoice_brl=_q8(avg_per_invoice),
        daily=daily,
        cached=False,
        fetched_at=datetime.now(timezone.utc).isoformat(),
    )
    _cache_put(cache_key, response)
    return response
