import base64
import json
import os
import threading
import uuid
from datetime import date, datetime, timezone
from typing import Any

from google.cloud import bigquery
from google.oauth2 import service_account

DEFAULT_DATASET = "cost_dashboard_rt"
DEFAULT_LOCATION = "US"
SNAPSHOT_TABLE = "dashboard_snapshots"
RUNS_TABLE = "dashboard_refresh_runs"
BUDGET_TABLE = "budget_targets_history"

_state_lock = threading.RLock()
_client: bigquery.Client | None = None
_dataset_ensured = False


def _project_id() -> str:
    return os.getenv("BQ_PROJECT_ID", "").strip()


def _dataset_id() -> str:
    return os.getenv("BQ_DATASET_ID", DEFAULT_DATASET).strip() or DEFAULT_DATASET


def _location() -> str:
    return os.getenv("BQ_LOCATION", DEFAULT_LOCATION).strip() or DEFAULT_LOCATION


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


def is_enabled() -> bool:
    return bool(_project_id() and _credentials_info())


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


def _dataset_ref() -> bigquery.DatasetReference:
    return bigquery.DatasetReference(_project_id(), _dataset_id())


def _table_ref(table_name: str) -> bigquery.TableReference:
    return _dataset_ref().table(table_name)


def _ensure_snapshot_table(client: bigquery.Client) -> None:
    table_ref = _table_ref(SNAPSHOT_TABLE)
    schema = [
        bigquery.SchemaField("snapshot_id", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("snapshot_ts", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("period_start", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("period_end", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("source", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("payload_json", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("created_at", "TIMESTAMP", mode="REQUIRED"),
    ]
    table = bigquery.Table(table_ref, schema=schema)
    table.time_partitioning = bigquery.TimePartitioning(field="snapshot_ts")
    table.clustering_fields = ["period_start", "period_end", "source"]
    client.create_table(table, exists_ok=True)


def _ensure_runs_table(client: bigquery.Client) -> None:
    table_ref = _table_ref(RUNS_TABLE)
    schema = [
        bigquery.SchemaField("run_id", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("trigger", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("period_start", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("period_end", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("started_at", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("finished_at", "TIMESTAMP", mode="NULLABLE"),
        bigquery.SchemaField("status", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("error_message", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("created_at", "TIMESTAMP", mode="REQUIRED"),
    ]
    table = bigquery.Table(table_ref, schema=schema)
    table.time_partitioning = bigquery.TimePartitioning(field="started_at")
    table.clustering_fields = ["status", "trigger"]
    client.create_table(table, exists_ok=True)


def _ensure_budget_table(client: bigquery.Client) -> None:
    table_ref = _table_ref(BUDGET_TABLE)
    schema = [
        bigquery.SchemaField("event_id", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("month_key", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("platform", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("target_brl", "NUMERIC", mode="NULLABLE"),
        bigquery.SchemaField("is_deleted", "BOOL", mode="REQUIRED"),
        bigquery.SchemaField("updated_at", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("updated_by", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("source", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("created_at", "TIMESTAMP", mode="REQUIRED"),
    ]
    table = bigquery.Table(table_ref, schema=schema)
    table.time_partitioning = bigquery.TimePartitioning(field="updated_at")
    table.clustering_fields = ["month_key", "platform", "is_deleted"]
    client.create_table(table, exists_ok=True)


def ensure_infra() -> bool:
    global _dataset_ensured
    if not is_enabled():
        return False
    with _state_lock:
        if _dataset_ensured:
            return True
        client = _get_client()
        dataset = bigquery.Dataset(_dataset_ref())
        dataset.location = _location()
        client.create_dataset(dataset, exists_ok=True)
        _ensure_snapshot_table(client)
        _ensure_runs_table(client)
        _ensure_budget_table(client)
        _dataset_ensured = True
        return True


def write_refresh_run(
    run_id: str,
    trigger: str,
    period_start: date,
    period_end: date,
    started_at: datetime,
    status: str,
    finished_at: datetime | None = None,
    error_message: str | None = None,
) -> None:
    if not ensure_infra():
        return
    client = _get_client()
    table_ref = _table_ref(RUNS_TABLE)
    now = datetime.now(timezone.utc)
    row = {
        "run_id": run_id,
        "trigger": trigger,
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat() if finished_at else None,
        "status": status,
        "error_message": error_message,
        "created_at": now.isoformat(),
    }
    errors = client.insert_rows_json(table_ref, [row])
    if errors:
        raise RuntimeError(f"Falha ao gravar run no BigQuery: {errors}")


def write_snapshot(period_start: date, period_end: date, payload: dict[str, Any], source: str) -> str:
    if not ensure_infra():
        raise RuntimeError("BigQuery não está habilitado.")
    client = _get_client()
    table_ref = _table_ref(SNAPSHOT_TABLE)
    now = datetime.now(timezone.utc)
    snapshot_id = str(uuid.uuid4())
    row = {
        "snapshot_id": snapshot_id,
        "snapshot_ts": now.isoformat(),
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "source": source,
        "payload_json": json.dumps(payload, ensure_ascii=True, separators=(",", ":")),
        "created_at": now.isoformat(),
    }
    errors = client.insert_rows_json(table_ref, [row])
    if errors:
        raise RuntimeError(f"Falha ao gravar snapshot no BigQuery: {errors}")
    return now.isoformat()


def load_latest_snapshot(period_start: date, period_end: date) -> tuple[dict[str, Any], str] | None:
    if not ensure_infra():
        return None
    client = _get_client()
    query = f"""
        SELECT payload_json, snapshot_ts
        FROM `{_project_id()}.{_dataset_id()}.{SNAPSHOT_TABLE}`
        WHERE period_start = @period_start
          AND period_end = @period_end
        ORDER BY snapshot_ts DESC
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("period_start", "DATE", period_start.isoformat()),
            bigquery.ScalarQueryParameter("period_end", "DATE", period_end.isoformat()),
        ]
    )
    rows = list(client.query(query, job_config=job_config).result())
    if not rows:
        return None
    payload_raw = rows[0].get("payload_json")
    snapshot_ts = rows[0].get("snapshot_ts")
    if not payload_raw:
        return None
    payload = json.loads(payload_raw)
    if not isinstance(payload, dict):
        return None
    snapshot_iso = snapshot_ts.isoformat() if hasattr(snapshot_ts, "isoformat") else str(snapshot_ts)
    return payload, snapshot_iso


def write_budget_event(
    month_key: str,
    platform: str,
    *,
    target_brl: float | None,
    is_deleted: bool,
    updated_by: str | None = None,
    source: str = "api",
) -> str:
    if not ensure_infra():
        raise RuntimeError("BigQuery não está habilitado.")
    client = _get_client()
    table_ref = _table_ref(BUDGET_TABLE)
    now = datetime.now(timezone.utc)
    row = {
        "event_id": str(uuid.uuid4()),
        "month_key": month_key,
        "platform": platform,
        "target_brl": None if target_brl is None else float(target_brl),
        "is_deleted": bool(is_deleted),
        "updated_at": now.isoformat(),
        "updated_by": updated_by,
        "source": source,
        "created_at": now.isoformat(),
    }
    errors = client.insert_rows_json(table_ref, [row])
    if errors:
        raise RuntimeError(f"Falha ao gravar budget no BigQuery: {errors}")
    return now.isoformat()


def read_budget_target(month_key: str, platform: str) -> float | None:
    if not ensure_infra():
        raise RuntimeError("BigQuery não está habilitado.")
    client = _get_client()
    query = f"""
        SELECT target_brl, is_deleted
        FROM `{_project_id()}.{_dataset_id()}.{BUDGET_TABLE}`
        WHERE month_key = @month_key
          AND platform = @platform
        ORDER BY updated_at DESC
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("month_key", "STRING", month_key),
            bigquery.ScalarQueryParameter("platform", "STRING", platform),
        ]
    )
    rows = list(client.query(query, job_config=job_config).result())
    if not rows:
        return None
    row = rows[0]
    if row.get("is_deleted"):
        return None
    value = row.get("target_brl")
    return float(value) if value is not None else None


def read_budget_targets_for_month(month_key: str, global_scope: str) -> dict[str, float]:
    if not ensure_infra():
        raise RuntimeError("BigQuery não está habilitado.")
    client = _get_client()
    query = f"""
        WITH ranked AS (
          SELECT
            platform,
            target_brl,
            is_deleted,
            ROW_NUMBER() OVER (PARTITION BY platform ORDER BY updated_at DESC) AS rn
          FROM `{_project_id()}.{_dataset_id()}.{BUDGET_TABLE}`
          WHERE month_key = @month_key
            AND platform != @global_scope
        )
        SELECT platform, target_brl
        FROM ranked
        WHERE rn = 1
          AND is_deleted = FALSE
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("month_key", "STRING", month_key),
            bigquery.ScalarQueryParameter("global_scope", "STRING", global_scope),
        ]
    )
    out: dict[str, float] = {}
    for row in client.query(query, job_config=job_config).result():
        platform = row.get("platform")
        target = row.get("target_brl")
        if platform and target is not None:
            out[str(platform)] = float(target)
    return out


def read_refresh_metrics(window_hours: int = 24, trigger: str = "manual_api") -> dict[str, Any] | None:
    if not ensure_infra():
        return None
    client = _get_client()
    query = f"""
        WITH base AS (
          SELECT
            TIMESTAMP_DIFF(finished_at, started_at, SECOND) AS duration_seconds
          FROM `{_project_id()}.{_dataset_id()}.{RUNS_TABLE}`
          WHERE trigger = @trigger
            AND status = 'success'
            AND finished_at IS NOT NULL
            AND started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @window_hours HOUR)
        )
        SELECT
          COUNT(*) AS sample_size,
          AVG(duration_seconds) AS avg_duration_seconds,
          APPROX_QUANTILES(duration_seconds, 100)[OFFSET(50)] AS p50_duration_seconds,
          APPROX_QUANTILES(duration_seconds, 100)[OFFSET(95)] AS p95_duration_seconds
        FROM base
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("trigger", "STRING", trigger),
            bigquery.ScalarQueryParameter("window_hours", "INT64", int(window_hours)),
        ]
    )
    rows = list(client.query(query, job_config=job_config).result())
    if not rows:
        return None
    row = rows[0]
    sample_size = int(row.get("sample_size") or 0)
    if sample_size <= 0:
        return {
            "window_hours": int(window_hours),
            "trigger": trigger,
            "sample_size": 0,
            "avg_duration_seconds": None,
            "p50_duration_seconds": None,
            "p95_duration_seconds": None,
        }
    return {
        "window_hours": int(window_hours),
        "trigger": trigger,
        "sample_size": sample_size,
        "avg_duration_seconds": float(row.get("avg_duration_seconds")) if row.get("avg_duration_seconds") is not None else None,
        "p50_duration_seconds": float(row.get("p50_duration_seconds")) if row.get("p50_duration_seconds") is not None else None,
        "p95_duration_seconds": float(row.get("p95_duration_seconds")) if row.get("p95_duration_seconds") is not None else None,
    }
