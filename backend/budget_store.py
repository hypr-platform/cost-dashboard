import os
import threading
from backend import bigquery_store

GLOBAL_BUDGET_SCOPE = "__global__"

# Share de investimento: alvo = (soma gasto SA+DV360+Xandr) × (pct/100). Variáveis 0–100; ver .env.example.
_SHARE_PLATFORM_ORDER: tuple[str, ...] = ("StackAdapt", "DV360", "Xandr")
_DEFAULT_SHARE_PERCENT: dict[str, float] = {
    "StackAdapt": 30.0,
    "DV360": 50.0,
    "Xandr": 13.0,
}
_SHARE_ENV_KEYS: dict[str, str] = {
    "StackAdapt": "DASHBOARD_SHARE_STACKADAPT_PCT",
    "DV360": "DASHBOARD_SHARE_DV360_PCT",
    "Xandr": "DASHBOARD_SHARE_XANDR_PCT",
}


def _parse_share_percent_env(var_name: str, default_pct: float) -> float:
    raw = os.getenv(var_name, "").strip()
    if not raw:
        return default_pct
    try:
        value = float(raw.replace(",", "."))
    except ValueError:
        return default_pct
    if value != value or value < 0 or value > 100:
        return default_pct
    return value


def get_platform_budget_share_percent() -> dict[str, float]:
    """Percentuais 0–100 por plataforma (StackAdapt, DV360, Xandr), a partir do env ou padrão."""
    return {
        platform: _parse_share_percent_env(_SHARE_ENV_KEYS[platform], _DEFAULT_SHARE_PERCENT[platform])
        for platform in _SHARE_PLATFORM_ORDER
    }


def get_platform_budget_share_fraction() -> dict[str, float]:
    """Frações 0–1 para cálculo de alvo em BRL."""
    pct = get_platform_budget_share_percent()
    return {platform: pct[platform] / 100.0 for platform in _SHARE_PLATFORM_ORDER}
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


def dynamic_platform_targets_brl(allocation_base_brl: float) -> dict[str, float]:
    """Alvos em BRL dados a soma do gasto SA+DV360+Xandr no período."""
    if allocation_base_brl <= 0 or allocation_base_brl != allocation_base_brl:
        return {}
    return {
        name: allocation_base_brl * frac for name, frac in get_platform_budget_share_fraction().items()
    }


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
