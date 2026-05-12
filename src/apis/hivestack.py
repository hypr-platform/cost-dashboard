"""
Hivestack medacost reader via BigQuery.

Fonte padrão:
  site-hypr.staging.hivestack_mediacost
"""

import base64
import calendar
import json
import os
import threading
from datetime import date
from decimal import Decimal
from typing import Any

from google.cloud import bigquery
from google.oauth2 import service_account

DEFAULT_TABLE = "site-hypr.staging.hivestack_mediacost"

_state_lock = threading.RLock()
_client: bigquery.Client | None = None


def _project_id() -> str:
    return os.getenv("BQ_PROJECT_ID", "").strip()


def _table_name() -> str:
    return os.getenv("HIVESTACK_BQ_TABLE", DEFAULT_TABLE).strip() or DEFAULT_TABLE


def _credentials_info() -> dict[str, Any] | None:
    raw = os.getenv("GCP_CREDS_JSON_CREDS_BASE64", "").strip()
    if not raw:
        raw = os.getenv("GCP_CREDS_JSON_BASE64", "").strip()
    if not raw:
        return None
    compact = "".join(raw.split())
    try:
        decoded = base64.b64decode(compact, validate=True).decode("utf-8")
        parsed = json.loads(decoded)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        return None
    return None


def _get_client() -> bigquery.Client:
    global _client
    with _state_lock:
        if _client is not None:
            return _client
        project_id = _project_id()
        if not project_id:
            raise RuntimeError("BQ_PROJECT_ID não configurado.")
        credentials_info = _credentials_info()
        if not credentials_info:
            raise RuntimeError("GCP_CREDS_JSON_CREDS_BASE64 inválido ou ausente.")
        credentials = service_account.Credentials.from_service_account_info(credentials_info)
        _client = bigquery.Client(project=project_id, credentials=credentials)
        return _client


def _emit_line_daily_enabled() -> bool:
    return os.getenv("HIVESTACK_EMIT_LINE_DAILY", "").strip() in {"1", "true", "True", "yes"}


def _last_day_of_month(any_day: date) -> date:
    last = calendar.monthrange(any_day.year, any_day.month)[1]
    return date(any_day.year, any_day.month, last)


def _to_float(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value)
    except Exception:
        return 0.0


def fetch_mtd_cost(start: date, end: date) -> dict[str, Any]:
    if not _project_id() or not _credentials_info():
        return {
            "spend": 0.0,
            "currency": "BRL",
            "status": "no_credentials",
            "message": "Credenciais BigQuery não configuradas para Hivestack.",
            "lines": [],
            "daily": [],
            "line_daily": [],
        }

    try:
        client = _get_client()
        query = f"""
            WITH base AS (
              SELECT
                DATE(month) AS month,
                CAST(line_item AS STRING) AS line_item,
                SAFE_CAST(spend AS NUMERIC) AS spend_value,
                TIMESTAMP(ingested_at) AS ingested_at
              FROM `{_table_name()}`
              WHERE DATE(month) BETWEEN DATE_TRUNC(@start_date, MONTH) AND DATE_TRUNC(@end_date, MONTH)
            ),
            latest AS (
              SELECT month, line_item, spend_value
              FROM base
              QUALIFY ROW_NUMBER() OVER (
                PARTITION BY month, line_item
                ORDER BY ingested_at DESC
              ) = 1
            )
            SELECT
              month,
              line_item,
              COALESCE(spend_value, 0) AS spend
            FROM latest
            WHERE COALESCE(spend_value, 0) > 0
            ORDER BY spend DESC
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("start_date", "DATE", start.isoformat()),
                bigquery.ScalarQueryParameter("end_date", "DATE", end.isoformat()),
            ]
        )
        rows = list(client.query(query, job_config=job_config).result())

        # `lines` agrega por (line_item) somando todos os meses do range.
        # `line_daily_raw` mantém granularidade (line_item, month) pra emitir line_daily.
        line_daily_raw: list[dict[str, Any]] = []
        spend_by_line: dict[str, float] = {}
        spend_by_month: dict[str, float] = {}
        total = 0.0
        for row in rows:
            line_name = str(row.get("line_item") or "").strip()
            spend = _to_float(row.get("spend"))
            if not line_name or spend <= 0:
                continue
            month_value = row.get("month")
            if hasattr(month_value, "year") and hasattr(month_value, "month"):
                month_date = date(month_value.year, month_value.month, 1)
            else:
                # fallback defensivo: tenta parsear ISO
                try:
                    month_date = date.fromisoformat(str(month_value)[:10]).replace(day=1)
                except Exception:
                    continue
            month_key = month_date.isoformat()
            spend_by_line[line_name] = spend_by_line.get(line_name, 0.0) + spend
            spend_by_month[month_key] = spend_by_month.get(month_key, 0.0) + spend
            total += spend
            line_daily_raw.append({"month": month_date, "name": line_name, "spend": spend})

        lines = [
            {"name": name, "spend": v}
            for name, v in sorted(spend_by_line.items(), key=lambda kv: -kv[1])
        ]
        daily = [{"date": m, "spend": v} for m, v in sorted(spend_by_month.items())]

        # line_daily: 1 row por (line_item, month) com date = last_day_of_month,
        # marcado como granularity=monthly_imputed porque a fonte agrega no mês.
        line_daily: list[dict[str, Any]] = []
        if _emit_line_daily_enabled():
            for entry in line_daily_raw:
                line_daily.append(
                    {
                        "date": _last_day_of_month(entry["month"]).isoformat(),
                        "line_item_id": None,  # Hivestack não tem ID estável
                        "name": entry["name"],
                        "spend": entry["spend"],
                        "granularity": "monthly_imputed",
                        "is_estimated": True,
                    }
                )

        return {
            "spend": total,
            "currency": "BRL",
            "status": "ok",
            "message": "",
            "lines": lines,
            "daily": daily,
            "line_daily": line_daily,
        }
    except Exception as exc:
        return {
            "spend": 0.0,
            "currency": "BRL",
            "status": "error",
            "message": str(exc),
            "lines": [],
            "daily": [],
            "line_daily": [],
        }
