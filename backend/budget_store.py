import threading
from backend import bigquery_store

GLOBAL_BUDGET_SCOPE = "__global__"
_init_lock = threading.Lock()
_initialized = False


def init_budget_store() -> None:
    global _initialized
    with _init_lock:
        if _initialized:
            return
        if not bigquery_store.ensure_infra():
            raise RuntimeError(
                "BigQuery não configurado para budget store. "
                "Configure BQ_PROJECT_ID e GCP_CREDS_JSON_CREDS_BASE64."
            )
        _initialized = True


def _ensure_initialized() -> None:
    if _initialized:
        return
    init_budget_store()


def get_target(month_key: str, platform: str) -> float | None:
    _ensure_initialized()
    return bigquery_store.read_budget_target(month_key, platform)


def get_targets_for_month(month_key: str) -> dict[str, float]:
    _ensure_initialized()
    return bigquery_store.read_budget_targets_for_month(month_key, GLOBAL_BUDGET_SCOPE)


def upsert_target(month_key: str, platform: str, target_brl: float) -> None:
    _ensure_initialized()
    if target_brl < 0:
        raise ValueError("target_brl deve ser maior ou igual a 0.")
    bigquery_store.write_budget_event(
        month_key=month_key,
        platform=platform,
        target_brl=float(target_brl),
        is_deleted=False,
        source="api_put",
    )


def delete_target(month_key: str, platform: str) -> bool:
    _ensure_initialized()
    existing = get_target(month_key, platform)
    if existing is None:
        return False
    bigquery_store.write_budget_event(
        month_key=month_key,
        platform=platform,
        target_brl=None,
        is_deleted=True,
        source="api_delete",
    )
    return True


def get_general_target(month_key: str) -> float | None:
    return get_target(month_key, GLOBAL_BUDGET_SCOPE)


def upsert_general_target(month_key: str, target_brl: float) -> None:
    upsert_target(month_key, GLOBAL_BUDGET_SCOPE, target_brl)


def delete_general_target(month_key: str) -> bool:
    return delete_target(month_key, GLOBAL_BUDGET_SCOPE)
