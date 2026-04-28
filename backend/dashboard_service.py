import calendar as _cal
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError, wait
from datetime import date, datetime, timezone
from typing import Any

from backend import bigquery_store, discord_notify, line_observations_pg
from backend.budget_store import dynamic_platform_targets_brl, get_platform_budget_share_percent
from src.apis import dv360, hivestack, nexd, stackadapt, xandr
from src.apis.sheets import extract_token_from_line, fetch_campaign_journey
from src.utils.currency import get_usd_to_brl, to_brl
from src.utils.date_utils import fmt, get_mtd_dates

NEXD_CPM_BRL = 0.0014
DEFAULT_USD_BRL_RATE = 5.15
DEFAULT_INTEGRATION_TIMEOUT_SECONDS = 45.0
DEFAULT_DV360_TIMEOUT_SECONDS = 240.0
DEFAULT_CACHE_TTL_SECONDS = 300.0
DEFAULT_WORKER_FAST_INTERVAL_SECONDS = 600.0
DEFAULT_WORKER_DV360_INTERVAL_SECONDS = 1800.0
# Amazon DSP desligado no worker: sem credenciais de API por ora; não incluir evita alertas no Discord.
PLATFORMS = {
    "StackAdapt": stackadapt,
    "DV360": dv360,
    "Xandr": xandr,
    "Hivestack": hivestack,
}
FAST_WORKER_SKIP_PLATFORMS = {"DV360"}
DV360_WORKER_ONLY_PLATFORMS = {"DV360"}


_cache: dict[str, Any] = {
    "start": None,
    "end": None,
    "data": None,
    "cached_at": None,
    "snapshot_at": None,
    "source": "live",
}
_cache_lock = threading.RLock()
_refresh_lock = threading.Lock()
_worker_state_lock = threading.RLock()
_worker_started = False
_worker_stop_event = threading.Event()
_refresh_status: dict[str, Any] = {
    "running": False,
    "run_id": None,
    "trigger": None,
    "started_at": None,
    "finished_at": None,
    "status": "idle",
    "error": None,
}

logger = logging.getLogger(__name__)


def _to_brl_smart(spend: float, currency: str, rate: float) -> float:
    return spend if currency == "BRL" else spend * rate


def _resolved_token_for_line(line: dict[str, Any]) -> str | None:
    token = str(line.get("resolved_token") or "").strip().upper()
    if token:
        return token
    return extract_token_from_line(line.get("name", ""))


def _line_display_name(line: dict[str, Any]) -> str:
    return str(line.get("resolved_line_name") or line.get("name") or "")


def _line_identity_for_resolution(platform_name: str, line: dict[str, Any]) -> dict[str, Any]:
    return {
        "platform": platform_name,
        "line": str(line.get("name") or ""),
        "line_item_id": line.get("line_item_id"),
    }


def _apply_line_token_resolutions(results: dict[str, dict[str, Any]]) -> None:
    """
    Resolve tokens antes de cruzar com as planilhas.

    Prioridade: override manual SQL > token no nome atual > histórico SQL.
    """
    rows: list[dict[str, Any]] = []
    history_rows: list[dict[str, Any]] = []
    line_refs: list[tuple[str, dict[str, Any], dict[str, Any], str | None]] = []
    for platform_name, platform_data in results.items():
        if platform_data.get("status") != "ok":
            continue
        for line in platform_data.get("lines", []):
            if not isinstance(line, dict):
                continue
            identity = _line_identity_for_resolution(platform_name, line)
            current_token = extract_token_from_line(line.get("name", ""))
            rows.append(identity)
            line_refs.append((platform_name, line, identity, current_token))
            if current_token:
                history_rows.append({**identity, "token": current_token})

    if history_rows:
        try:
            line_observations_pg.upsert_line_token_history(history_rows)
        except Exception:
            logger.exception("Falha ao atualizar histórico de token por line.")

    try:
        resolution_map = line_observations_pg.fetch_resolution_map(rows)
    except Exception:
        logger.exception("Falha ao buscar resoluções de token por line.")
        resolution_map = {}

    for platform_name, line, identity, current_token in line_refs:
        key = line_observations_pg.row_resolution_key(identity)
        resolution = resolution_map.get(key) if key else None
        manual_token = str((resolution or {}).get("manual_token") or "").strip().upper()
        historical_token = str((resolution or {}).get("historical_token") or "").strip().upper()
        manual_name = str((resolution or {}).get("manual_line_name") or "").strip()
        historical_name = str((resolution or {}).get("historical_line_name") or "").strip()

        if manual_token:
            line["resolved_token"] = manual_token
            line["token_resolution_source"] = "manual"
            if manual_name:
                line["resolved_line_name"] = manual_name
                line["name"] = manual_name
        elif current_token:
            line["resolved_token"] = current_token
            line["token_resolution_source"] = "name"
            if "resolved_line_name" not in line:
                line["resolved_line_name"] = str(line.get("name") or "")
        elif historical_token:
            line["resolved_token"] = historical_token
            line["token_resolution_source"] = "historical"
            if historical_name:
                line["resolved_line_name"] = historical_name
                line["name"] = historical_name


def _is_campaign_active(campaign: dict[str, Any], today: date) -> bool:
    s_c = campaign.get("start")
    e_c = campaign.get("end")
    return (s_c is None or s_c <= today) and (e_c is None or e_c >= today)


def _iso(d: date | None) -> str | None:
    return d.isoformat() if d else None


def _invested_for_selected_period(
    invested_total: float | int | None,
    campaign_start: date | None,
    campaign_end: date | None,
    period_start: date,
    period_end: date,
) -> float:
    """
    Prorrateia o investido total da campanha para o período selecionado
    usando distribuição linear por dias de vigência.

    Regras:
    - Sem investido válido => 0.
    - Sem vigência completa (start/end) => mantém investido total (fallback).
    - Sem interseção com período => 0.
    """
    try:
        invested = float(invested_total or 0.0)
    except Exception:
        return 0.0
    if invested <= 0:
        return 0.0

    if campaign_start is None or campaign_end is None:
        return invested
    if campaign_start > campaign_end:
        return invested

    campaign_days = (campaign_end - campaign_start).days + 1
    if campaign_days <= 0:
        return invested

    overlap_start = max(campaign_start, period_start)
    overlap_end = min(campaign_end, period_end)
    if overlap_start > overlap_end:
        return 0.0

    overlap_days = (overlap_end - overlap_start).days + 1
    prorated = invested * (overlap_days / campaign_days)
    return max(0.0, min(invested, prorated))


def _month_key_from_date(value: date) -> str:
    return value.strftime("%Y-%m")


def _integration_timeout_seconds() -> float:
    raw_value = os.getenv("DASHBOARD_INTEGRATION_TIMEOUT_SECONDS", "").strip()
    if not raw_value:
        return DEFAULT_INTEGRATION_TIMEOUT_SECONDS
    try:
        parsed = float(raw_value)
        if parsed > 0:
            return parsed
    except ValueError:
        pass
    return DEFAULT_INTEGRATION_TIMEOUT_SECONDS


def _cache_ttl_seconds() -> float:
    raw_value = os.getenv("DASHBOARD_CACHE_TTL_SECONDS", "").strip()
    if not raw_value:
        return DEFAULT_CACHE_TTL_SECONDS
    try:
        parsed = float(raw_value)
        if parsed > 0:
            return parsed
    except ValueError:
        pass
    return DEFAULT_CACHE_TTL_SECONDS


def _cache_is_fresh(cached_at: Any) -> bool:
    if not isinstance(cached_at, (int, float)):
        return False
    return (time.time() - float(cached_at)) <= _cache_ttl_seconds()


def _fast_worker_interval_seconds() -> float:
    raw_value = os.getenv("DASHBOARD_FAST_WORKER_INTERVAL_SECONDS", "").strip()
    if not raw_value:
        return DEFAULT_WORKER_FAST_INTERVAL_SECONDS
    try:
        parsed = float(raw_value)
        if parsed >= 60:
            return parsed
    except ValueError:
        pass
    return DEFAULT_WORKER_FAST_INTERVAL_SECONDS


def _dv360_worker_interval_seconds() -> float:
    raw_value = os.getenv("DASHBOARD_DV360_WORKER_INTERVAL_SECONDS", "").strip()
    if not raw_value:
        return DEFAULT_WORKER_DV360_INTERVAL_SECONDS
    try:
        parsed = float(raw_value)
        if parsed >= 120:
            return parsed
    except ValueError:
        pass
    return DEFAULT_WORKER_DV360_INTERVAL_SECONDS


def _dv360_timeout_seconds() -> float:
    raw_value = os.getenv("DASHBOARD_DV360_TIMEOUT_SECONDS", "").strip()
    if not raw_value:
        return DEFAULT_DV360_TIMEOUT_SECONDS
    try:
        parsed = float(raw_value)
        if parsed > 0:
            return parsed
    except ValueError:
        pass
    return DEFAULT_DV360_TIMEOUT_SECONDS


def _platform_timeout_seconds(platform_name: str) -> float:
    if platform_name == "DV360":
        return _dv360_timeout_seconds()
    return _integration_timeout_seconds()


def _platform_names_for_trigger(trigger: str) -> set[str] | None:
    if trigger == "scheduled_fast":
        return set(PLATFORMS) - FAST_WORKER_SKIP_PLATFORMS
    if trigger == "scheduled_dv360":
        return set(DV360_WORKER_ONLY_PLATFORMS)
    return None


def _reuse_previous_ok_platforms(
    results: dict[str, dict[str, Any]],
    previous_payload: dict[str, Any] | None,
    platform_names: set[str],
) -> None:
    if not platform_names or not isinstance(previous_payload, dict):
        return
    previous_results = previous_payload.get("platform_results", {})
    if not isinstance(previous_results, dict):
        return
    for platform_name in sorted(platform_names):
        previous_platform = previous_results.get(platform_name)
        if isinstance(previous_platform, dict) and previous_platform.get("status") == "ok":
            fallback = dict(previous_platform)
            fallback["reused_from_previous_snapshot"] = True
            fallback["message"] = (
                f"{platform_name} não foi consultado neste ciclo; exibindo último snapshot válido."
            )
            results[platform_name] = fallback


def _period_range(start: date | None, end: date | None) -> tuple[date, date]:
    default_start, default_end = get_mtd_dates()
    resolved_start = start or default_start
    resolved_end = end or default_end
    if resolved_start > resolved_end:
        raise ValueError("`start` deve ser menor ou igual a `end`.")
    return resolved_start, resolved_end


def _refresh_metadata(payload: dict[str, Any], snapshot_at: str, source: str) -> dict[str, Any]:
    out = dict(payload)
    meta = out.get("_meta")
    if not isinstance(meta, dict):
        meta = {}
    meta["snapshot_at"] = snapshot_at
    meta["source"] = source
    meta["cache_ttl_seconds"] = _cache_ttl_seconds()
    out["_meta"] = meta
    return out


def _features_from_line_name(line_name: str) -> set[str]:
    normalized = (
        str(line_name or "")
        .upper()
        .strip()
        .replace("Á", "A")
        .replace("À", "A")
        .replace("Ã", "A")
        .replace("Â", "A")
        .replace("É", "E")
        .replace("Ê", "E")
        .replace("Í", "I")
        .replace("Ó", "O")
        .replace("Õ", "O")
        .replace("Ô", "O")
        .replace("Ú", "U")
        .replace("Ç", "C")
    )
    features: set[str] = set()
    if "RMNFISICO" in normalized:
        features.add("RMN Físico")
    if "SURVEY" in normalized:
        features.add("Survey")
    if "TOPICS" in normalized:
        features.add("Topics")
    if "PDOOH" in normalized:
        features.add("P-DOOH")
    if "DOWNLOADED_APPS" in normalized:
        features.add("Downloaded Apps")
    return features


def _has_campaign_token(token: Any) -> bool:
    value = str(token or "").strip()
    return value not in {"", "—"}


def _row_cs_label(row: dict[str, Any]) -> str:
    value = str(row.get("account_management", "") or "").strip()
    return value or "Sem CS"


def _row_matches_campaign_products(produto_vendido: Any, selected_products: set[str]) -> bool:
    if not selected_products:
        return True
    normalized = str(produto_vendido or "").strip()
    return normalized in selected_products


def _sum_platform_totals(rows: list[dict[str, Any]], active_platforms: list[str]) -> dict[str, float]:
    sums: dict[str, float] = {platform: 0.0 for platform in active_platforms}
    for row in rows:
        for platform in active_platforms:
            sums[platform] += float(row.get(platform, 0.0) or 0.0)
    return sums


def build_filtered_daily_series(
    payload: dict[str, Any],
    *,
    clients: list[str] | None = None,
    cs: list[str] | None = None,
    campaigns: list[str] | None = None,
    campaign_status: list[str] | None = None,
    features: list[str] | None = None,
    campaign_types: list[str] | None = None,
    include_out_of_period: bool = False,
) -> list[dict[str, Any]]:
    dashboard = payload.get("dashboard") or {}
    campaign_rows = list(dashboard.get("campaign_journey_rows") or [])
    daily_rows = list(dashboard.get("daily") or [])
    active_platforms = [str(p) for p in (dashboard.get("active_platforms") or [])]
    if not campaign_rows or not daily_rows or not active_platforms:
        return daily_rows

    clients_set = {str(value).strip() for value in (clients or []) if str(value).strip()}
    cs_set = {str(value).strip() for value in (cs or []) if str(value).strip()}
    campaigns_set = {str(value).strip() for value in (campaigns or []) if str(value).strip()}
    status_set = {str(value).strip() for value in (campaign_status or []) if str(value).strip()}
    feature_set = {str(value).strip() for value in (features or []) if str(value).strip()}
    campaign_type_set = {str(value).strip() for value in (campaign_types or []) if str(value).strip()}
    has_dashboard_filters = bool(clients_set or cs_set or campaigns_set or status_set or feature_set or campaign_type_set)
    has_scope_filters = has_dashboard_filters or (not include_out_of_period)
    if not has_scope_filters:
        return daily_rows

    token_features_by_token: dict[str, set[str]] = {}
    platform_pages = payload.get("platform_pages") or {}
    for page in platform_pages.values():
        if not isinstance(page, dict):
            continue
        rows = page.get("rows") or []
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            token = str(row.get("token") or "").strip()
            if not _has_campaign_token(token):
                continue
            row_features = _features_from_line_name(str(row.get("line") or ""))
            if not row_features:
                continue
            existing = token_features_by_token.setdefault(token, set())
            existing.update(row_features)

    out_of_period_spend_by_token_platform: dict[str, dict[str, float]] = {}
    attention = payload.get("attention") or {}
    for row in attention.get("out_of_period_rows") or []:
        if not isinstance(row, dict):
            continue
        token = str(row.get("token") or "").strip()
        platform = str(row.get("platform") or "").strip()
        if not _has_campaign_token(token) or not platform:
            continue
        by_platform = out_of_period_spend_by_token_platform.setdefault(token, {})
        by_platform[platform] = by_platform.get(platform, 0.0) + float(row.get("gasto", 0.0) or 0.0)

    adjusted_rows: list[dict[str, Any]] = []
    if include_out_of_period:
        adjusted_rows = [dict(row) for row in campaign_rows if isinstance(row, dict)]
    else:
        for source_row in campaign_rows:
            if not isinstance(source_row, dict):
                continue
            row = dict(source_row)
            token = str(row.get("token") or "").strip()
            if _has_campaign_token(token):
                platform_adjustments = out_of_period_spend_by_token_platform.get(token, {})
                changed = False
                for platform in active_platforms:
                    adjust = float(platform_adjustments.get(platform, 0.0) or 0.0)
                    if adjust <= 0:
                        continue
                    current_spend = float(row.get(platform, 0.0) or 0.0)
                    next_spend = max(0.0, current_spend - adjust)
                    if next_spend != current_spend:
                        row[platform] = next_spend
                        changed = True
                if changed:
                    recomputed_total = sum(float(row.get(platform, 0.0) or 0.0) for platform in active_platforms)
                    row["total_plataformas"] = recomputed_total
                    invested = float(row.get("investido", 0.0) or 0.0)
                    row["pct_investido"] = (recomputed_total / invested * 100.0) if invested > 0 else 0.0
            adjusted_rows.append(row)

    scoped_rows = [row for row in adjusted_rows if float(row.get("total_plataformas", 0.0) or 0.0) > 0.0]
    filtered_rows = scoped_rows
    if has_dashboard_filters:
        next_rows: list[dict[str, Any]] = []
        for row in scoped_rows:
            if clients_set and str(row.get("cliente", "") or "").strip() not in clients_set:
                continue
            if cs_set and _row_cs_label(row) not in cs_set:
                continue
            if campaigns_set and str(row.get("campanha", "") or "").strip() not in campaigns_set:
                continue
            if status_set and str(row.get("status", "") or "").strip() not in status_set:
                continue
            if feature_set:
                token = str(row.get("token", "") or "").strip()
                if not _has_campaign_token(token):
                    continue
                token_features = token_features_by_token.get(token, set())
                if not (token_features & feature_set):
                    continue
            if not _row_matches_campaign_products(row.get("produto_vendido"), campaign_type_set):
                continue
            next_rows.append(row)
        filtered_rows = next_rows

    baseline_totals = _sum_platform_totals(campaign_rows, active_platforms)
    filtered_totals = _sum_platform_totals(filtered_rows, active_platforms)
    scale_by_platform: dict[str, float] = {}
    for platform in active_platforms:
        baseline = float(baseline_totals.get(platform, 0.0) or 0.0)
        filtered = float(filtered_totals.get(platform, 0.0) or 0.0)
        if baseline <= 0:
            scale_by_platform[platform] = 0.0
        else:
            ratio = filtered / baseline
            scale_by_platform[platform] = min(1.0, max(0.0, ratio))

    filtered_daily: list[dict[str, Any]] = []
    for source_row in daily_rows:
        if not isinstance(source_row, dict):
            continue
        day = str(source_row.get("date") or "")
        row: dict[str, Any] = {"date": day, "total": 0.0}
        for platform in active_platforms:
            base_value = float(source_row.get(platform, 0.0) or 0.0)
            value = base_value * scale_by_platform.get(platform, 0.0)
            row[platform] = value
            row["total"] += value
        if float(row["total"]) > 0.0:
            filtered_daily.append(row)
    return filtered_daily


def _build_payload(
    start: date,
    end: date,
    previous_payload: dict[str, Any] | None = None,
    platform_names: set[str] | None = None,
) -> dict[str, Any]:
    timeout_seconds = _integration_timeout_seconds()
    selected_platforms = {
        name: module
        for name, module in PLATFORMS.items()
        if platform_names is None or name in platform_names
    }
    skipped_platform_names = set(PLATFORMS) - set(selected_platforms)
    max_workers = len(selected_platforms) + 3
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        platform_futures = {
            name: executor.submit(module.fetch_mtd_cost, start, end)
            for name, module in selected_platforms.items()
        }
        rate_future = executor.submit(get_usd_to_brl)
        journey_future = executor.submit(fetch_campaign_journey, start, end)
        nexd_future = executor.submit(nexd.fetch_mtd_impressions, start, end)

        results: dict[str, dict[str, Any]] = {}
        future_to_platform = {future: name for name, future in platform_futures.items()}
        platform_timeout_ceiling = max(
            (_platform_timeout_seconds(name) for name in selected_platforms),
            default=timeout_seconds,
        )
        done_platforms, pending_platforms = wait(
            set(platform_futures.values()),
            timeout=platform_timeout_ceiling,
        )
        for future in done_platforms:
            platform_name = future_to_platform[future]
            try:
                platform_data = future.result()
                if not isinstance(platform_data, dict):
                    raise ValueError("payload inválido da integração")
                results[platform_name] = platform_data
            except Exception as exc:
                results[platform_name] = {
                    "status": "error",
                    "message": str(exc),
                    "spend": 0.0,
                    "currency": "USD",
                    "lines": [],
                    "daily": [],
                }
        for future in pending_platforms:
            future.cancel()
            platform_name = future_to_platform[future]
            platform_timeout = _platform_timeout_seconds(platform_name)
            results[platform_name] = {
                "status": "error",
                "message": f"Timeout da integração ({platform_timeout:.0f}s).",
                "spend": 0.0,
                "currency": "USD",
                "lines": [],
                "daily": [],
            }

        _reuse_previous_ok_platforms(results, previous_payload, skipped_platform_names)

        try:
            rate = float(rate_future.result(timeout=timeout_seconds))
        except FutureTimeoutError:
            rate_future.cancel()
            rate = DEFAULT_USD_BRL_RATE
        except Exception:
            rate = DEFAULT_USD_BRL_RATE

        try:
            journey = journey_future.result(timeout=timeout_seconds)
            if not isinstance(journey, dict):
                raise ValueError("payload inválido de campaign journey")
        except FutureTimeoutError:
            journey_future.cancel()
            journey = {
                "data": [],
                "status": "error",
                "message": f"Timeout ao carregar campaign journey ({timeout_seconds:.0f}s).",
            }
        except Exception as exc:
            journey = {"data": [], "status": "error", "message": str(exc)}

        try:
            nexd_data = nexd_future.result(timeout=timeout_seconds)
            if not isinstance(nexd_data, dict):
                raise ValueError("payload inválido da integração Nexd")
        except FutureTimeoutError:
            nexd_future.cancel()
            nexd_data = {
                "impressions": 0,
                "cap": getattr(nexd, "MONTHLY_CAP", 10_000_000),
                "status": "error",
                "message": f"Timeout da integração ({timeout_seconds:.0f}s).",
                "campaigns": [],
                "layouts": [],
            }
        except Exception as exc:
            nexd_data = {
                "impressions": 0,
                "cap": getattr(nexd, "MONTHLY_CAP", 10_000_000),
                "status": "error",
                "message": str(exc),
                "campaigns": [],
                "layouts": [],
            }

    all_campaigns = {c["token"]: c for c in journey.get("data", [])}
    _apply_line_token_resolutions(results)
    platform_spend_by_token: dict[str, dict[str, float]] = {}

    for platform_name, platform_data in results.items():
        if platform_data.get("status") != "ok":
            continue
        platform_spend_by_token[platform_name] = {}
        for line in platform_data.get("lines", []):
            token = _resolved_token_for_line(line)
            if not token:
                continue
            spend_brl = _to_brl_smart(line.get("spend", 0.0), platform_data.get("currency", "USD"), rate)
            platform_spend_by_token[platform_name][token] = platform_spend_by_token[platform_name].get(token, 0.0) + spend_brl

    active_platforms = list(platform_spend_by_token.keys())
    nexd_cost_brl = nexd_data["impressions"] * NEXD_CPM_BRL if nexd_data.get("status") == "ok" else 0.0
    total_brl = sum(
        _to_brl_smart(v.get("spend", 0.0), v.get("currency", "USD"), rate)
        for v in results.values()
        if v.get("status") == "ok"
    ) + nexd_cost_brl

    spend_by_platform: list[dict[str, Any]] = []
    for name, data in results.items():
        if data.get("status") == "ok" and data.get("spend", 0.0) > 0:
            spend_by_platform.append(
                {
                    "platform": name,
                    "spend_brl": _to_brl_smart(data["spend"], data.get("currency", "USD"), rate),
                }
            )
    if nexd_data.get("status") == "ok":
        spend_by_platform.append({"platform": "Nexd", "spend_brl": nexd_cost_brl})

    daily_platforms = {
        k: v.get("daily", [])
        for k, v in results.items()
        if v.get("status") == "ok" and v.get("daily")
    }
    daily_maps = {
        platform_name: {
            str(entry.get("date", "")): _to_brl_smart(
                float(entry.get("spend", 0.0) or 0.0),
                results[platform_name].get("currency", "USD"),
                rate,
            )
            for entry in series
            if entry.get("date")
        }
        for platform_name, series in daily_platforms.items()
    }
    all_dates = sorted({d["date"] for series in daily_platforms.values() for d in series})
    daily_rows: list[dict[str, Any]] = []
    for day in all_dates:
        row = {"date": day, "total": 0.0}
        for platform_name, date_map in daily_maps.items():
            value = date_map.get(day, 0.0)
            row[platform_name] = value
            row["total"] += value
        daily_rows.append(row)

    tokens_with_spend = set()
    for platform_name in active_platforms:
        tokens_with_spend.update(platform_spend_by_token.get(platform_name, {}).keys())

    today = date.today()
    campaign_rows = []
    for token in tokens_with_spend:
        campaign = all_campaigns.get(token)
        if not campaign:
            continue
        campaign_invested_period = _invested_for_selected_period(
            campaign.get("investido", 0.0),
            campaign.get("start"),
            campaign.get("end"),
            start,
            end,
        )
        row = {
            "token": token,
            "cliente": campaign.get("cliente", ""),
            "campanha": campaign.get("campanha", ""),
            "campaign_start": _iso(campaign.get("start")),
            "campaign_end": _iso(campaign.get("end")),
            "produto_vendido": campaign.get("produto_vendido", ""),
            "account_management": campaign.get("account_management", ""),
            "status": "Ativa" if _is_campaign_active(campaign, today) else "Encerrada",
            "investido": campaign_invested_period,
        }
        total_platforms = 0.0
        for platform_name in active_platforms:
            spend = platform_spend_by_token.get(platform_name, {}).get(token, 0.0)
            row[platform_name] = spend
            total_platforms += spend
        if total_platforms == 0:
            continue
        investido = campaign_invested_period
        row["total_plataformas"] = total_platforms
        row["pct_investido"] = (total_platforms / investido * 100) if investido > 0 else 0.0
        campaign_rows.append(row)

    campaign_rows.sort(key=lambda x: x["total_plataformas"], reverse=True)

    platform_pages: dict[str, Any] = {}
    for platform_name, platform_data in results.items():
        if platform_data.get("status") != "ok":
            continue

        rows = []
        for line in platform_data.get("lines", []):
            token = _resolved_token_for_line(line)
            campaign = all_campaigns.get(token) if token else None
            spend_brl = _to_brl_smart(line.get("spend", 0.0), platform_data.get("currency", "USD"), rate)
            investido = (
                _invested_for_selected_period(
                    campaign.get("investido"),
                    campaign.get("start"),
                    campaign.get("end"),
                    start,
                    end,
                )
                if campaign
                else None
            )
            pct_invest = (spend_brl / investido * 100) if investido and investido > 0 else None
            row = {
                "line": _line_display_name(line),
                "line_item_id": line.get("line_item_id"),
                "token": token or "—",
                "token_resolution_source": line.get("token_resolution_source"),
                "cliente": campaign.get("cliente", "—") if campaign else "—",
                "campanha": campaign.get("campanha", "—") if campaign else "—",
                "account_management": campaign.get("account_management", "—") if campaign else "—",
                "gasto": spend_brl,
                "investido": investido,
                "pct_invest": pct_invest,
            }
            for _dk in (
                "dv360_advertiser_id",
                "dv360_insertion_order_id",
                "dv360_campaign_id",
                "dv360_entity_status",
                "dv360_partner_id",
            ):
                _v = line.get(_dk)
                if _v is not None and str(_v).strip() != "":
                    row[_dk] = str(_v).strip()
            rows.append(row)
        rows.sort(key=lambda x: x["gasto"], reverse=True)

        page_block: dict[str, Any] = {
            "spend_brl": _to_brl_smart(platform_data.get("spend", 0.0), platform_data.get("currency", "USD"), rate),
            "spend_usd": platform_data.get("spend", 0.0),
            "currency": platform_data.get("currency", "USD"),
            "rows": rows,
            "daily": daily_platforms.get(platform_name, []),
        }
        if platform_name == "DV360":
            ctx = platform_data.get("dv360_context")
            if isinstance(ctx, dict) and ctx:
                page_block["dv360_context"] = ctx
        platform_pages[platform_name] = page_block

    if nexd_data.get("status") == "ok":
        impressions = nexd_data.get("impressions", 0)
        cap = nexd_data.get("cap", 1) or 1
        layout_rows: list[dict[str, Any]] = []
        for row in nexd_data.get("layouts", []):
            layout_impressions = int(row.get("impressions", 0) or 0)
            estimated_cost_brl = layout_impressions * NEXD_CPM_BRL
            layout_rows.append(
                {
                    "layout": row.get("layout", "—"),
                    "impressions": layout_impressions,
                    "creatives": int(row.get("creatives", 0) or 0),
                    "estimated_cost_brl": estimated_cost_brl,
                    "pct_estimated_cost": (estimated_cost_brl / nexd_cost_brl * 100) if nexd_cost_brl > 0 else 0.0,
                }
            )
        layout_rows.sort(key=lambda x: x["estimated_cost_brl"], reverse=True)
        platform_pages["Nexd"] = {
            "spend_brl": nexd_cost_brl,
            "impressions": impressions,
            "cap": cap,
            "pct_cap": impressions / cap * 100,
            "campaigns": nexd_data.get("campaigns", []),
            "layouts": layout_rows,
        }

    no_token_rows = []
    for platform_name, platform_data in results.items():
        if platform_data.get("status") != "ok":
            continue
        for line in platform_data.get("lines", []):
            if _resolved_token_for_line(line):
                continue
            if float(line.get("spend", 0.0) or 0.0) <= 0.0:
                continue
            nt: dict = {
                "platform": platform_name,
                "line": _line_display_name(line),
                "line_item_id": line.get("line_item_id"),
                "gasto": _to_brl_smart(line.get("spend", 0.0), platform_data.get("currency", "USD"), rate),
            }
            for _dk in (
                "dv360_advertiser_id",
                "dv360_insertion_order_id",
                "dv360_campaign_id",
                "dv360_entity_status",
                "dv360_partner_id",
            ):
                _v = line.get(_dk)
                if _v is not None and str(_v).strip() != "":
                    nt[_dk] = str(_v).strip()
            no_token_rows.append(nt)
    no_token_rows.sort(key=lambda x: x["gasto"], reverse=True)

    _last_day = _cal.monthrange(start.year, start.month)[1]
    month_end = start.replace(day=_last_day)
    out_rows = []
    for platform_name, platform_data in results.items():
        if platform_data.get("status") != "ok":
            continue
        for line in platform_data.get("lines", []):
            token = _resolved_token_for_line(line)
            if not token:
                continue
            campaign = all_campaigns.get(token)
            if not campaign:
                continue
            s_c = campaign.get("start")
            e_c = campaign.get("end")
            if (s_c and s_c > month_end) or (e_c and e_c < start):
                oor: dict = {
                    "platform": platform_name,
                    "token": token,
                    "line": _line_display_name(line),
                    "line_item_id": line.get("line_item_id"),
                    "cliente": campaign.get("cliente", ""),
                    "campanha": campaign.get("campanha", ""),
                    "account_management": campaign.get("account_management", ""),
                    "vigencia_start": _iso(s_c),
                    "vigencia_end": _iso(e_c),
                    "gasto": _to_brl_smart(line.get("spend", 0.0), platform_data.get("currency", "USD"), rate),
                }
                for _dk in (
                    "dv360_advertiser_id",
                    "dv360_insertion_order_id",
                    "dv360_campaign_id",
                    "dv360_entity_status",
                    "dv360_partner_id",
                ):
                    _v = line.get(_dk)
                    if _v is not None and str(_v).strip() != "":
                        oor[_dk] = str(_v).strip()
                out_rows.append(oor)
    out_rows.sort(key=lambda x: x["gasto"], reverse=True)

    for c in journey.get("data", []):
        c["start"] = _iso(c.get("start"))
        c["end"] = _iso(c.get("end"))

    month_key = _month_key_from_date(start)
    share_percent = get_platform_budget_share_percent()
    allocation_base_brl = 0.0
    for _platform_name in share_percent:
        _pdata = results.get(_platform_name, {})
        if not isinstance(_pdata, dict) or _pdata.get("status") != "ok":
            continue
        allocation_base_brl += _to_brl_smart(
            float(_pdata.get("spend", 0.0) or 0.0),
            _pdata.get("currency", "USD"),
            rate,
        )
    budget_targets = dynamic_platform_targets_brl(allocation_base_brl)
    general_target_brl = None
    general_progress_pct = None
    general_remaining_brl = None
    budget_platforms: dict[str, Any] = {}
    for entry in spend_by_platform:
        platform_name = str(entry["platform"])
        spent_brl = float(entry["spend_brl"])
        target_brl = budget_targets.get(platform_name)
        progress_pct = (spent_brl / target_brl * 100) if target_brl and target_brl > 0 else None
        remaining_brl = (target_brl - spent_brl) if target_brl is not None else None
        budget_platforms[platform_name] = {
            "target_brl": target_brl,
            "spent_brl": spent_brl,
            "progress_pct": progress_pct,
            "remaining_brl": remaining_brl,
        }
    for platform_name, target_brl in budget_targets.items():
        if platform_name in budget_platforms:
            continue
        budget_platforms[platform_name] = {
            "target_brl": target_brl,
            "spent_brl": 0.0,
            "progress_pct": 0.0 if target_brl > 0 else None,
            "remaining_brl": target_brl,
        }

    return {
        "period": {"start": fmt(start), "end": fmt(end)},
        "exchange_rate_usd_brl": rate,
        "total_brl": total_brl,
        "journey_status": journey.get("status", "unknown"),
        "journey_message": journey.get("message"),
        "platform_results": results,
        "nexd": nexd_data,
        "dashboard": {
            "spend_by_platform": spend_by_platform,
            "daily": daily_rows,
            "campaign_journey_rows": campaign_rows,
            "active_platforms": active_platforms,
        },
        "platform_pages": platform_pages,
        "attention": {
            "no_token_rows": no_token_rows,
            "no_token_total_brl": sum(r["gasto"] for r in no_token_rows),
            "out_of_period_rows": out_rows,
            "out_of_period_total_brl": sum(r["gasto"] for r in out_rows),
        },
        "budget": {
            "month_key": month_key,
            "share_percent": share_percent,
            "general": {
                "target_brl": general_target_brl,
                "spent_brl": total_brl,
                "progress_pct": general_progress_pct,
                "remaining_brl": general_remaining_brl,
            },
            "platforms": budget_platforms,
        },
    }


def _update_cache(
    start: date,
    end: date,
    payload: dict[str, Any],
    *,
    source: str,
    snapshot_at: str,
) -> None:
    with _cache_lock:
        _cache["start"] = start
        _cache["end"] = end
        _cache["data"] = payload
        _cache["cached_at"] = time.time()
        _cache["source"] = source
        _cache["snapshot_at"] = snapshot_at


def _refresh_status_update(**updates: Any) -> None:
    with _worker_state_lock:
        _refresh_status.update(updates)


def get_refresh_status() -> dict[str, Any]:
    with _worker_state_lock:
        return dict(_refresh_status)


def get_refresh_metrics() -> dict[str, Any]:
    if bigquery_store.is_enabled():
        try:
            metrics = bigquery_store.read_refresh_metrics(window_hours=24, trigger="manual_api")
            if metrics is not None:
                return metrics
        except Exception:
            logger.exception("Falha ao buscar métricas de refresh no BigQuery.")
    return {
        "window_hours": 24,
        "trigger": "manual_api",
        "sample_size": 0,
        "avg_duration_seconds": None,
        "p50_duration_seconds": None,
        "p95_duration_seconds": None,
    }


def _load_from_bigquery(start: date, end: date) -> dict[str, Any] | None:
    if not bigquery_store.is_enabled():
        return None
    try:
        latest = bigquery_store.load_latest_snapshot(start, end)
    except Exception:
        logger.exception("Falha ao consultar snapshot no BigQuery.")
        return None
    if not latest:
        return None
    payload, snapshot_at = latest
    payload_with_meta = _refresh_metadata(payload, snapshot_at=snapshot_at, source="bigquery")
    _update_cache(start, end, payload_with_meta, source="bigquery", snapshot_at=snapshot_at)
    return payload_with_meta


def _refresh_dashboard(start: date, end: date, trigger: str) -> dict[str, Any]:
    run_id = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc)
    _refresh_status_update(
        running=True,
        run_id=run_id,
        trigger=trigger,
        started_at=started_at.isoformat(),
        finished_at=None,
        status="running",
        error=None,
    )

    if bigquery_store.is_enabled():
        try:
            bigquery_store.write_refresh_run(
                run_id=run_id,
                trigger=trigger,
                period_start=start,
                period_end=end,
                started_at=started_at,
                status="running",
            )
        except Exception:
            logger.exception("Falha ao registrar início do run no BigQuery.")

    with _refresh_lock:
        try:
            previous_payload = None
            with _cache_lock:
                if _cache["start"] == start and _cache["end"] == end and isinstance(_cache.get("data"), dict):
                    previous_payload = dict(_cache["data"])
            if previous_payload is None:
                bq_snapshot = _load_from_bigquery(start, end)
                if isinstance(bq_snapshot, dict):
                    previous_payload = dict(bq_snapshot)

            payload = _build_payload(
                start,
                end,
                previous_payload=previous_payload,
                platform_names=_platform_names_for_trigger(trigger),
            )
            snapshot_at = datetime.now(timezone.utc).isoformat()
            payload = _refresh_metadata(payload, snapshot_at=snapshot_at, source="live")
            try:
                discord_notify.maybe_notify_partial_after_refresh(
                    trigger=trigger, run_id=run_id, payload=payload
                )
            except Exception:
                logger.exception("Falha ao avaliar/enviar alerta Discord (integrações parciais).")
            _update_cache(start, end, payload, source="live", snapshot_at=snapshot_at)

            if bigquery_store.is_enabled():
                try:
                    written_snapshot_at = bigquery_store.write_snapshot(start, end, payload, source=trigger)
                    payload = _refresh_metadata(payload, snapshot_at=written_snapshot_at, source="bigquery")
                    _update_cache(start, end, payload, source="bigquery", snapshot_at=written_snapshot_at)
                except Exception:
                    logger.exception("Falha ao gravar snapshot no BigQuery.")

            finished_at = datetime.now(timezone.utc)
            _refresh_status_update(
                running=False,
                finished_at=finished_at.isoformat(),
                status="success",
                error=None,
            )
            if bigquery_store.is_enabled():
                try:
                    bigquery_store.write_refresh_run(
                        run_id=run_id,
                        trigger=trigger,
                        period_start=start,
                        period_end=end,
                        started_at=started_at,
                        finished_at=finished_at,
                        status="success",
                    )
                except Exception:
                    logger.exception("Falha ao registrar sucesso do run no BigQuery.")
            return payload
        except Exception as exc:
            finished_at = datetime.now(timezone.utc)
            _refresh_status_update(
                running=False,
                finished_at=finished_at.isoformat(),
                status="error",
                error=str(exc),
            )
            if bigquery_store.is_enabled():
                try:
                    bigquery_store.write_refresh_run(
                        run_id=run_id,
                        trigger=trigger,
                        period_start=start,
                        period_end=end,
                        started_at=started_at,
                        finished_at=finished_at,
                        status="error",
                        error_message=str(exc),
                    )
                except Exception:
                    logger.exception("Falha ao registrar erro do run no BigQuery.")
            try:
                discord_notify.notify_dashboard_refresh_failed(
                    trigger=trigger,
                    run_id=run_id,
                    exc=exc,
                    period_start=start,
                    period_end=end,
                )
            except Exception:
                logger.exception("Falha ao enviar alerta Discord (refresh falhou).")
            raise


def get_dashboard_data(
    start: date | None = None,
    end: date | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    resolved_start, resolved_end = _period_range(start, end)
    if force_refresh:
        return line_observations_pg.merge_observations_into_payload(
            _refresh_dashboard(resolved_start, resolved_end, trigger="force_refresh")
        )

    with _cache_lock:
        if (
            _cache["start"] == resolved_start
            and _cache["end"] == resolved_end
            and _cache["data"] is not None
            and _cache_is_fresh(_cache.get("cached_at"))
        ):
            return line_observations_pg.merge_observations_into_payload(dict(_cache["data"]))

    bq_payload = _load_from_bigquery(resolved_start, resolved_end)
    if bq_payload is not None:
        return line_observations_pg.merge_observations_into_payload(bq_payload)

    return line_observations_pg.merge_observations_into_payload(
        _refresh_dashboard(resolved_start, resolved_end, trigger="cache_miss")
    )


def trigger_refresh_async(start: date | None = None, end: date | None = None, trigger: str = "manual") -> dict[str, Any]:
    resolved_start, resolved_end = _period_range(start, end)
    status = get_refresh_status()
    if status.get("running"):
        return {
            "queued": False,
            "running": True,
            "message": "Refresh já em execução.",
            "status": status,
        }

    def _run() -> None:
        try:
            _refresh_dashboard(resolved_start, resolved_end, trigger=trigger)
        except Exception:
            logger.exception("Falha no refresh assíncrono.")

    thread = threading.Thread(target=_run, daemon=True, name=f"dashboard-refresh-{trigger}")
    thread.start()
    return {
        "queued": True,
        "running": True,
        "message": "Refresh disparado.",
        "period": {"start": resolved_start.isoformat(), "end": resolved_end.isoformat()},
    }


def _worker_loop(trigger_name: str, interval_seconds: float) -> None:
    while not _worker_stop_event.wait(timeout=2):
        now = time.time()
        with _worker_state_lock:
            last_key = f"last_run_{trigger_name}"
            last_run = _refresh_status.get(last_key)
        if isinstance(last_run, (int, float)) and now - float(last_run) < interval_seconds:
            continue
        try:
            start, end = get_mtd_dates()
            _refresh_dashboard(start, end, trigger=trigger_name)
        except Exception:
            logger.exception("Falha no worker `%s`.", trigger_name)
        finally:
            with _worker_state_lock:
                _refresh_status[last_key] = time.time()


def start_background_workers() -> None:
    global _worker_started
    with _worker_state_lock:
        if _worker_started:
            return
        _worker_started = True
    if bigquery_store.is_enabled():
        try:
            bigquery_store.ensure_infra()
        except Exception:
            logger.exception("Falha ao preparar infraestrutura no BigQuery.")
    _worker_stop_event.clear()
    fast_thread = threading.Thread(
        target=_worker_loop,
        args=("scheduled_fast", _fast_worker_interval_seconds()),
        daemon=True,
        name="dashboard-worker-fast",
    )
    dv360_thread = threading.Thread(
        target=_worker_loop,
        args=("scheduled_dv360", _dv360_worker_interval_seconds()),
        daemon=True,
        name="dashboard-worker-dv360",
    )
    fast_thread.start()
    dv360_thread.start()


def stop_background_workers() -> None:
    _worker_stop_event.set()
    with _worker_state_lock:
        _refresh_status["running"] = False


def get_cached_dashboard_data() -> dict[str, Any] | None:
    with _cache_lock:
        cached = _cache.get("data")
    if isinstance(cached, dict):
        return dict(cached)
    return None


def invalidate_dashboard_cache() -> None:
    with _cache_lock:
        _cache["start"] = None
        _cache["end"] = None
        _cache["data"] = None
        _cache["cached_at"] = None
        _cache["snapshot_at"] = None
        _cache["source"] = "live"
