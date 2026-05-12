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
RUNS_TABLE = "dashboard_refresh_runs"
BUDGET_TABLE = "budget_targets_history"
LINE_DAILY_COST_TABLE = "dsp_line_daily_cost"
LINE_COSTS_TABLE = "line_costs"
DIM_CAMPAIGN_TABLE = "dim_campaign"
DIM_FX_DAILY_TABLE = "dim_fx_daily"
DIM_NEXD_SNAPSHOT_TABLE = "dim_nexd_snapshot"
DIM_DV360_LINE_META_TABLE = "dim_dv360_line_meta"

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


def _ensure_line_daily_cost_table(client: bigquery.Client) -> None:
    table_ref = _table_ref(LINE_DAILY_COST_TABLE)
    schema = [
        bigquery.SchemaField("run_id", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("trigger", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("snapshot_ts", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("period_start", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("period_end", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("platform", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("cost_date", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("line_item_id", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("line_name", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("spend_original", "FLOAT64", mode="REQUIRED"),
        bigquery.SchemaField("currency", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("spend_brl", "FLOAT64", mode="REQUIRED"),
        bigquery.SchemaField("exchange_rate_usd_brl", "FLOAT64", mode="NULLABLE"),
        bigquery.SchemaField("ingested_at", "TIMESTAMP", mode="REQUIRED"),
    ]
    table = bigquery.Table(table_ref, schema=schema)
    table.time_partitioning = bigquery.TimePartitioning(field="cost_date")
    table.clustering_fields = ["platform", "line_item_id", "run_id"]
    client.create_table(table, exists_ok=True)


def _ensure_line_costs_table(client: bigquery.Client) -> None:
    table_ref = _table_ref(LINE_COSTS_TABLE)
    schema = [
        bigquery.SchemaField("cost_date", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("platform", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("line_item_id", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("line_name", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("resolved_token", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("token_resolution_source", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("spend_native_delta", "FLOAT64", mode="NULLABLE"),
        bigquery.SchemaField("currency_native", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("spend_brl_delta", "FLOAT64", mode="REQUIRED"),
        bigquery.SchemaField("spend_native_mtd", "FLOAT64", mode="REQUIRED"),
        bigquery.SchemaField("spend_brl_mtd", "FLOAT64", mode="REQUIRED"),
        bigquery.SchemaField("exchange_rate_usd_brl", "FLOAT64", mode="NULLABLE"),
        bigquery.SchemaField("had_negative_delta", "BOOL", mode="REQUIRED"),
        bigquery.SchemaField("observation", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("source_snapshot_at", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("baseline_snapshot_at", "TIMESTAMP", mode="NULLABLE"),
        bigquery.SchemaField("ingested_at", "TIMESTAMP", mode="REQUIRED"),
        # Fase 1: granularidade e flag de estimativa.
        # NULLABLE pra compatibilidade com rows escritas antes da Fase 1.
        bigquery.SchemaField("is_estimated", "BOOL", mode="NULLABLE"),
        bigquery.SchemaField("granularity", "STRING", mode="NULLABLE"),
    ]
    table = bigquery.Table(table_ref, schema=schema)
    table.time_partitioning = bigquery.TimePartitioning(field="cost_date")
    table.clustering_fields = ["platform", "resolved_token", "line_item_id"]
    client.create_table(table, exists_ok=True)


def _ensure_dim_campaign_table(client: bigquery.Client) -> None:
    """Dim sem versionamento — 1 row por token. Estado atual da planilha do Checklist
    + Journey. `first_seen_at` preservado em upserts; `last_seen_at` atualizado a cada refresh."""
    table_ref = _table_ref(DIM_CAMPAIGN_TABLE)
    schema = [
        bigquery.SchemaField("token", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("cliente", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("campanha", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("account_management", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("status", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("produto", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("investido_brl", "FLOAT64", mode="NULLABLE"),
        bigquery.SchemaField("total_plataformas", "FLOAT64", mode="NULLABLE"),
        bigquery.SchemaField("pct_investido", "FLOAT64", mode="NULLABLE"),
        bigquery.SchemaField("campaign_start", "DATE", mode="NULLABLE"),
        bigquery.SchemaField("campaign_end", "DATE", mode="NULLABLE"),
        bigquery.SchemaField("raw_row", "JSON", mode="NULLABLE"),
        bigquery.SchemaField("first_seen_at", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("last_seen_at", "TIMESTAMP", mode="REQUIRED"),
    ]
    table = bigquery.Table(table_ref, schema=schema)
    table.clustering_fields = ["token"]
    client.create_table(table, exists_ok=True)


def _ensure_dim_fx_daily_table(client: bigquery.Client) -> None:
    """Dim com 1 row por dia: taxa USD/BRL (PTAX BCB) usada pra converter spend."""
    table_ref = _table_ref(DIM_FX_DAILY_TABLE)
    schema = [
        bigquery.SchemaField("cost_date", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("fx_usd_brl", "FLOAT64", mode="REQUIRED"),
        bigquery.SchemaField("source", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("captured_at", "TIMESTAMP", mode="REQUIRED"),
    ]
    table = bigquery.Table(table_ref, schema=schema)
    table.time_partitioning = bigquery.TimePartitioning(field="cost_date")
    client.create_table(table, exists_ok=True)


def _ensure_dim_nexd_snapshot_table(client: bigquery.Client) -> None:
    """1 row apenas — snapshot mais recente do estado Nexd (impressões + breakdown).
    Sem partição, sem cluster — tabela trivial."""
    table_ref = _table_ref(DIM_NEXD_SNAPSHOT_TABLE)
    schema = [
        bigquery.SchemaField("snapshot_at", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("impressions", "INT64", mode="REQUIRED"),
        bigquery.SchemaField("cap", "INT64", mode="REQUIRED"),
        bigquery.SchemaField("campaigns_json", "JSON", mode="NULLABLE"),
        bigquery.SchemaField("layouts_json", "JSON", mode="NULLABLE"),
    ]
    table = bigquery.Table(table_ref, schema=schema)
    client.create_table(table, exists_ok=True)


def _ensure_dim_dv360_line_meta_table(client: bigquery.Client) -> None:
    """1 row por DV360 line_item_id com metadados (advertiser, IO, etc.).
    Cluster em line_item_id pra JOIN rápido com line_costs."""
    table_ref = _table_ref(DIM_DV360_LINE_META_TABLE)
    schema = [
        bigquery.SchemaField("line_item_id", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("advertiser_id", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("insertion_order_id", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("campaign_id", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("entity_status", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("partner_id", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("last_seen_at", "TIMESTAMP", mode="REQUIRED"),
    ]
    table = bigquery.Table(table_ref, schema=schema)
    table.clustering_fields = ["line_item_id"]
    client.create_table(table, exists_ok=True)


def _migrate_line_costs_columns(client: bigquery.Client) -> None:
    """Adiciona colunas novas em `line_costs` se não existirem. Idempotente."""
    sql = f"""
        ALTER TABLE `{_project_id()}.{_dataset_id()}.{LINE_COSTS_TABLE}`
          ADD COLUMN IF NOT EXISTS is_estimated BOOL,
          ADD COLUMN IF NOT EXISTS granularity STRING
    """
    client.query(sql).result()


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
        _ensure_runs_table(client)
        _ensure_budget_table(client)
        _ensure_line_daily_cost_table(client)
        _ensure_line_costs_table(client)
        _migrate_line_costs_columns(client)
        _ensure_dim_campaign_table(client)
        _ensure_dim_fx_daily_table(client)
        _ensure_dim_nexd_snapshot_table(client)
        _ensure_dim_dv360_line_meta_table(client)
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


def write_dsp_line_daily_cost_rows(rows: list[dict[str, Any]]) -> None:
    """Append-only: custo por line e dia (hoje preenchido a partir de Xandr `line_daily`)."""
    if not rows:
        return
    if not ensure_infra():
        return
    client = _get_client()
    _ensure_line_daily_cost_table(client)
    table_ref = _table_ref(LINE_DAILY_COST_TABLE)
    chunk_size = 400
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i : i + chunk_size]
        errors = client.insert_rows_json(table_ref, chunk)
        if errors:
            raise RuntimeError(f"Falha ao gravar dsp_line_daily_cost no BigQuery: {errors}")


def replace_line_costs_for_date(cost_date: date, rows: list[dict[str, Any]]) -> int:
    """Idempotente: substitui *toda* a partição daquele `cost_date` por `rows`.

    Usa load job com partition decorator (`$YYYYMMDD`) + `WRITE_TRUNCATE`,
    que é atômico e não esbarra no streaming buffer. Quando `rows` está vazio,
    apenas trunca a partição.

    Retorna a quantidade de linhas inseridas.
    """
    if not ensure_infra():
        raise RuntimeError("BigQuery não está habilitado.")
    client = _get_client()
    table_ref = _table_ref(LINE_COSTS_TABLE)
    partition_decorator = cost_date.strftime("%Y%m%d")
    destination = f"{table_ref.project}.{table_ref.dataset_id}.{table_ref.table_id}${partition_decorator}"
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        schema=client.get_table(table_ref).schema,
    )
    # Load job exige pelo menos um registro; pra "truncar pra vazio" usamos
    # um DML DELETE (que funciona porque load jobs não populam streaming buffer).
    if not rows:
        delete_sql = (
            f"DELETE FROM `{table_ref.project}.{table_ref.dataset_id}.{table_ref.table_id}` "
            "WHERE cost_date = @cost_date"
        )
        delete_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("cost_date", "DATE", cost_date.isoformat()),
            ]
        )
        client.query(delete_sql, job_config=delete_config).result()
        return 0
    load_job = client.load_table_from_json(rows, destination, job_config=job_config)
    load_job.result()
    if load_job.errors:
        raise RuntimeError(f"Falha ao gravar line_costs no BigQuery: {load_job.errors}")
    return len(rows)


def upsert_line_costs_for_platform_and_date(
    platform: str,
    cost_date: date,
    rows: list[dict[str, Any]],
) -> int:
    """Substitui as rows de `line_costs` para `(platform, cost_date)`.

    Diferente de `replace_line_costs_for_date` (que trunca a partição inteira),
    aqui isolamos por `(platform, cost_date)` — uma DSP que falha no refresh
    não regride o que outras escreveram.

    Estratégia:
      1. DELETE FROM line_costs WHERE cost_date=@D AND platform=@P
      2. Load JSON com WRITE_APPEND no partition decorator `$YYYYMMDD`.

    Window curta entre DELETE e INSERT é aceitável pro caso de uso (cron interno).
    Idempotente — pode re-rodar com os mesmos `rows`.
    """
    if not ensure_infra():
        raise RuntimeError("BigQuery não está habilitado.")
    client = _get_client()
    table_ref = _table_ref(LINE_COSTS_TABLE)
    table_fqn = f"{table_ref.project}.{table_ref.dataset_id}.{table_ref.table_id}"

    # 1. DELETE existing rows for (platform, cost_date)
    delete_sql = (
        f"DELETE FROM `{table_fqn}` "
        "WHERE cost_date = @cost_date AND platform = @platform"
    )
    delete_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("cost_date", "DATE", cost_date.isoformat()),
            bigquery.ScalarQueryParameter("platform", "STRING", platform),
        ]
    )
    client.query(delete_sql, job_config=delete_config).result()

    if not rows:
        return 0

    # 2. Append new rows via load job (não usa streaming buffer)
    partition_decorator = cost_date.strftime("%Y%m%d")
    destination = f"{table_fqn}${partition_decorator}"
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        schema=client.get_table(table_ref).schema,
    )
    load_job = client.load_table_from_json(rows, destination, job_config=job_config)
    load_job.result()
    if load_job.errors:
        raise RuntimeError(
            f"Falha ao gravar line_costs ({platform}/{cost_date.isoformat()}): {load_job.errors}"
        )
    return len(rows)


def upsert_dim_campaign(rows: list[dict[str, Any]]) -> int:
    """Substitui a tabela inteira por `rows`, preservando `first_seen_at` por token.

    Estratégia: lê `first_seen_at` existente, popula nos rows novos (ou usa now()
    pra tokens inéditos), e faz `WRITE_TRUNCATE` da tabela inteira. Atomic dentro
    do load job. Race-condition-safe (1 só worker em produção).
    """
    if not ensure_infra():
        raise RuntimeError("BigQuery não está habilitado.")
    if not rows:
        return 0
    client = _get_client()
    table_ref = _table_ref(DIM_CAMPAIGN_TABLE)
    table_fqn = f"{table_ref.project}.{table_ref.dataset_id}.{table_ref.table_id}"

    # 1. Lê first_seen_at existente
    sql = f"SELECT token, first_seen_at FROM `{table_fqn}`"
    try:
        existing: dict[str, str] = {}
        for r in client.query(sql).result():
            ts = r.get("first_seen_at")
            existing[str(r.get("token"))] = (
                ts.isoformat() if hasattr(ts, "isoformat") else str(ts)
            )
    except Exception:
        # Tabela vazia ou recém-criada
        existing = {}

    now_iso = datetime.now(timezone.utc).isoformat()

    # 2. Popula first/last seen
    for row in rows:
        token = str(row.get("token") or "")
        row["first_seen_at"] = existing.get(token, now_iso)
        row["last_seen_at"] = now_iso

    # 3. WRITE_TRUNCATE atomic
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        schema=client.get_table(table_ref).schema,
    )
    load_job = client.load_table_from_json(rows, table_ref, job_config=job_config)
    load_job.result()
    if load_job.errors:
        raise RuntimeError(f"Falha ao gravar dim_campaign: {load_job.errors}")
    return len(rows)


def upsert_dim_fx_for_date(cost_date: date, fx_usd_brl: float, source: str) -> int:
    """Substitui a row de `dim_fx_daily` para `cost_date`.

    DELETE + load APPEND no partition decorator. Idempotente.
    """
    if not ensure_infra():
        raise RuntimeError("BigQuery não está habilitado.")
    client = _get_client()
    table_ref = _table_ref(DIM_FX_DAILY_TABLE)
    table_fqn = f"{table_ref.project}.{table_ref.dataset_id}.{table_ref.table_id}"

    delete_sql = f"DELETE FROM `{table_fqn}` WHERE cost_date = @cost_date"
    delete_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("cost_date", "DATE", cost_date.isoformat()),
        ]
    )
    client.query(delete_sql, job_config=delete_config).result()

    row = {
        "cost_date": cost_date.isoformat(),
        "fx_usd_brl": float(fx_usd_brl),
        "source": source,
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }
    partition_decorator = cost_date.strftime("%Y%m%d")
    destination = f"{table_fqn}${partition_decorator}"
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        schema=client.get_table(table_ref).schema,
    )
    load_job = client.load_table_from_json([row], destination, job_config=job_config)
    load_job.result()
    if load_job.errors:
        raise RuntimeError(f"Falha ao gravar dim_fx_daily: {load_job.errors}")
    return 1


def upsert_dim_nexd_snapshot(
    impressions: int, cap: int, campaigns: list[dict[str, Any]], layouts: list[dict[str, Any]]
) -> int:
    """WRITE_TRUNCATE da tabela inteira — 1 row apenas representando o estado atual."""
    if not ensure_infra():
        raise RuntimeError("BigQuery não está habilitado.")
    client = _get_client()
    table_ref = _table_ref(DIM_NEXD_SNAPSHOT_TABLE)
    row = {
        "snapshot_at": datetime.now(timezone.utc).isoformat(),
        "impressions": int(impressions or 0),
        "cap": int(cap or 0),
        "campaigns_json": json.dumps(campaigns or [], ensure_ascii=False),
        "layouts_json": json.dumps(layouts or [], ensure_ascii=False),
    }
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        schema=client.get_table(table_ref).schema,
    )
    load_job = client.load_table_from_json([row], table_ref, job_config=job_config)
    load_job.result()
    if load_job.errors:
        raise RuntimeError(f"Falha ao gravar dim_nexd_snapshot: {load_job.errors}")
    return 1


def upsert_dim_dv360_line_meta(rows: list[dict[str, Any]]) -> int:
    """WRITE_TRUNCATE da tabela inteira com os metadados DV360 de todos os line_item_ids
    presentes no payload atual. `last_seen_at` preenchido aqui."""
    if not ensure_infra():
        raise RuntimeError("BigQuery não está habilitado.")
    if not rows:
        return 0
    client = _get_client()
    table_ref = _table_ref(DIM_DV360_LINE_META_TABLE)
    now_iso = datetime.now(timezone.utc).isoformat()
    enriched = []
    for r in rows:
        lid = str(r.get("line_item_id") or "").strip()
        if not lid:
            continue
        enriched.append({
            "line_item_id": lid,
            "advertiser_id": r.get("advertiser_id"),
            "insertion_order_id": r.get("insertion_order_id"),
            "campaign_id": r.get("campaign_id"),
            "entity_status": r.get("entity_status"),
            "partner_id": r.get("partner_id"),
            "last_seen_at": now_iso,
        })
    if not enriched:
        return 0
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        schema=client.get_table(table_ref).schema,
    )
    load_job = client.load_table_from_json(enriched, table_ref, job_config=job_config)
    load_job.result()
    if load_job.errors:
        raise RuntimeError(f"Falha ao gravar dim_dv360_line_meta: {load_job.errors}")
    return len(enriched)


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
