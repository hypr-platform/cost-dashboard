import calendar as _cal
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError, wait
from datetime import date, datetime, timedelta, timezone
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
DEFAULT_XANDR_TIMEOUT_SECONDS = 150.0
DEFAULT_CACHE_TTL_SECONDS = 300.0
# Amazon DSP desligado no worker: sem credenciais de API por ora; não incluir evita alertas no Discord.
PLATFORMS = {
    "StackAdapt": stackadapt,
    "DV360": dv360,
    "Xandr": xandr,
    "Hivestack": hivestack,
}


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


def _dsp_line_daily_cost_rows_bigquery(
    *,
    run_id: str,
    trigger: str,
    snapshot_ts: str,
    period_start: date,
    period_end: date,
    platform_results: dict[str, Any],
    exchange_rate_usd_brl: float,
    ingested_at: datetime,
) -> list[dict[str, Any]]:
    """Linhas para `dsp_line_daily_cost`: integrações que expõem `line_daily` (hoje: Xandr)."""
    rows: list[dict[str, Any]] = []
    rate = float(exchange_rate_usd_brl)
    for platform_name, pdata in platform_results.items():
        if not isinstance(pdata, dict) or pdata.get("status") != "ok":
            continue
        line_daily = pdata.get("line_daily")
        if not isinstance(line_daily, list) or not line_daily:
            continue
        currency = str(pdata.get("currency") or "USD")
        fx = None if currency == "BRL" else rate
        for entry in line_daily:
            if not isinstance(entry, dict):
                continue
            cost_date = str(entry.get("date") or "").strip()
            if not cost_date:
                continue
            spend_orig = float(entry.get("spend") or 0.0)
            if spend_orig <= 0:
                continue
            spend_brl = _to_brl_smart(spend_orig, currency, rate)
            li = entry.get("line_item_id")
            line_item_id = str(li).strip() if li is not None and str(li).strip() else None
            line_name_raw = str(entry.get("name") or "").strip()
            line_name = line_name_raw or None
            rows.append(
                {
                    "run_id": run_id,
                    "trigger": trigger,
                    "snapshot_ts": snapshot_ts,
                    "period_start": period_start.isoformat(),
                    "period_end": period_end.isoformat(),
                    "platform": platform_name,
                    "cost_date": cost_date,
                    "line_item_id": line_item_id,
                    "line_name": line_name,
                    "spend_original": spend_orig,
                    "currency": currency,
                    "spend_brl": spend_brl,
                    "exchange_rate_usd_brl": fx,
                    "ingested_at": ingested_at.isoformat(),
                }
            )
    return rows


def _last_day_of_month(any_day: date) -> date:
    last = _cal.monthrange(any_day.year, any_day.month)[1]
    return date(any_day.year, any_day.month, last)


def _line_costs_normalize_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _line_costs_line_key(entry: dict[str, Any]) -> str:
    """Identidade da line: id se houver, senão nome (com prefixo pra evitar colisão)."""
    lid = _line_costs_normalize_str(entry.get("line_item_id"))
    if lid:
        return f"id:{lid}"
    name = _line_costs_normalize_str(entry.get("name") or entry.get("resolved_line_name"))
    return f"name:{name or ''}"


def _line_costs_rows_from_payload(
    *,
    platform_results: dict[str, Any],
    nexd_data: dict[str, Any] | None,
    rate: float,
    snapshot_at: str,
    period_end: date,
    accept_dates: set[date],
) -> dict[tuple[str, date], list[dict[str, Any]]]:
    """Constrói rows pra `line_costs` agrupadas por (platform, cost_date).

    Pra cada plataforma que emite `line_daily`, emite **1 row por line ativa
    no mês** apontando pro cost_date alvo:

      - granularity=daily  → target = today (delta = spend de hoje, mtd = total mês)
      - granularity=monthly_imputed → target = last_day_of_month (delta = mtd)

    Lines que apareceram no mês mas não gastaram em `target` ainda recebem row
    com `spend_brl_delta=0` mas `spend_brl_mtd > 0` — garantindo cobertura
    completa do MTD da plataforma.

    Returns: dict[(platform, cost_date)] -> list[row].
    """
    grouped: dict[tuple[str, date], list[dict[str, Any]]] = {}
    ingested_at = datetime.now(timezone.utc).isoformat()

    sources: list[tuple[str, dict[str, Any]]] = []
    for platform_name, pdata in (platform_results or {}).items():
        if isinstance(pdata, dict) and pdata.get("status") == "ok":
            sources.append((str(platform_name), pdata))
    if isinstance(nexd_data, dict) and nexd_data.get("status") == "ok":
        sources.append(("Nexd", nexd_data))

    for platform_name, pdata in sources:
        line_daily = pdata.get("line_daily") or []
        if not isinstance(line_daily, list) or not line_daily:
            continue
        platform_currency = str(pdata.get("currency") or "USD")

        # Token lookup a partir de pdata["lines"] (já com resolved_token aplicado).
        lookup_by_id: dict[str, dict[str, Any]] = {}
        lookup_by_name: dict[str, dict[str, Any]] = {}
        for line in pdata.get("lines") or []:
            if not isinstance(line, dict):
                continue
            info = {
                "resolved_token": _line_costs_normalize_str(line.get("resolved_token")),
                "resolved_line_name": _line_costs_normalize_str(line.get("resolved_line_name")),
                "token_resolution_source": _line_costs_normalize_str(
                    line.get("token_resolution_source")
                ),
            }
            lid = _line_costs_normalize_str(line.get("line_item_id"))
            name = _line_costs_normalize_str(line.get("resolved_line_name") or line.get("name"))
            if lid:
                lookup_by_id[lid] = info
            if name:
                lookup_by_name[name] = info

        # Detecta granularity da plataforma (monthly_imputed vs daily).
        is_monthly_imputed = any(
            isinstance(e, dict)
            and (e.get("granularity") == "monthly_imputed" or e.get("is_estimated"))
            for e in line_daily
        )
        # Pra monthly_imputed o target é a maior `date` em line_daily (geralmente
        # last_day_of_month). Pra daily o target é o último dia do `accept_dates`
        # que NÃO é last_day_of_month — ou seja, today.
        all_entry_dates: list[date] = []
        for e in line_daily:
            if not isinstance(e, dict):
                continue
            try:
                all_entry_dates.append(date.fromisoformat(str(e.get("date") or "")))
            except Exception:
                pass
        if not all_entry_dates:
            continue
        last_day_in_month = _last_day_of_month(period_end)
        if is_monthly_imputed:
            # Mensais imputados (Hivestack/Nexd) só têm um target: a maior data
            # do line_daily (geralmente last_day_of_month).
            target_cds: list[date] = [max(all_entry_dates)]
        else:
            # Daily: reescreve todos os dias dentro do accept_dates (exceto o
            # last_day_of_month, que é exclusivo do monthly_imputed). Isso
            # permite que dias passados sejam revisados conforme as DSPs
            # finalizam relatórios atrasados (ex: DV360 tem 24-48h de lag).
            target_cds = sorted(d for d in accept_dates if d != last_day_in_month)
            if not target_cds:
                target_cds = [last_day_in_month]

        target_cds = [cd for cd in target_cds if cd in accept_dates]
        if not target_cds:
            continue

        # Pré-agrega spend por (line, dia) e guarda metadata por line.
        per_line_daily: dict[str, dict[date, float]] = {}
        per_line_meta: dict[str, dict[str, Any]] = {}
        for entry in line_daily:
            if not isinstance(entry, dict):
                continue
            try:
                cd = date.fromisoformat(str(entry.get("date") or ""))
            except Exception:
                continue
            try:
                spend = float(entry.get("spend") or 0.0)
            except (TypeError, ValueError):
                continue
            if spend <= 0:
                continue
            key = _line_costs_line_key(entry)
            daily_map = per_line_daily.setdefault(key, {})
            daily_map[cd] = daily_map.get(cd, 0.0) + spend
            if key not in per_line_meta:
                per_line_meta[key] = {
                    "sample": entry,
                    "currency": str(entry.get("currency") or platform_currency),
                    "granularity": str(entry.get("granularity") or "daily"),
                    "is_estimated": bool(entry.get("is_estimated", False)),
                }

        # Para cada target_cd, emite 1 row por line com:
        #   - mtd_native = soma cumulativa até target_cd (inclusivo)
        #   - delta_native = spend do dia target_cd
        for target_cd in target_cds:
            for key, daily_map in per_line_daily.items():
                mtd_n = sum(s for d, s in daily_map.items() if d <= target_cd)
                if mtd_n <= 0:
                    continue
                delta_n = daily_map.get(target_cd, 0.0)
                meta = per_line_meta[key]
                entry_currency = meta["currency"]
                if entry_currency == "BRL":
                    mtd_b = mtd_n
                    delta_b = delta_n
                    fx_rate: float | None = None
                else:
                    mtd_b = mtd_n * rate
                    delta_b = delta_n * rate
                    fx_rate = rate

                sample = meta["sample"]
                lid = _line_costs_normalize_str(sample.get("line_item_id"))
                name = _line_costs_normalize_str(sample.get("name"))
                token_info = (
                    (lookup_by_id.get(lid) if lid else None)
                    or (lookup_by_name.get(name) if name else None)
                    or {}
                )

                row: dict[str, Any] = {
                    "cost_date": target_cd.isoformat(),
                    "platform": platform_name,
                    "line_item_id": lid,
                    "line_name": token_info.get("resolved_line_name") or name,
                    "resolved_token": token_info.get("resolved_token"),
                    "token_resolution_source": token_info.get("token_resolution_source"),
                    "spend_native_delta": delta_n,
                    "currency_native": entry_currency,
                    "spend_brl_delta": delta_b,
                    "spend_native_mtd": mtd_n,
                    "spend_brl_mtd": mtd_b,
                    "exchange_rate_usd_brl": fx_rate,
                    "had_negative_delta": False,
                    "observation": None,  # Fase 1 não consulta PG; preencher em fase futura.
                    "source_snapshot_at": snapshot_at,
                    "baseline_snapshot_at": None,
                    "ingested_at": ingested_at,
                    "is_estimated": meta["is_estimated"],
                    "granularity": meta["granularity"],
                }
                grouped.setdefault((platform_name, target_cd), []).append(row)

    return grouped


def _line_costs_rows_for_backfill(
    *,
    platform_name: str,
    platform_data: dict[str, Any],
    fx_for_day,
    period_end_window: date,
    snapshot_marker: str,
    observation_tag: str | None = None,
) -> dict[date, list[dict[str, Any]]]:
    """Constrói rows pra `line_costs` em modo BACKFILL.

    Diferente de `_line_costs_rows_from_payload` (Fase 1, que escreve 1 row/line
    no target_date escolhido), este emite **1 row por (line, day)** preservando
    a granularidade nativa do `line_daily`. MTD é cumulativo dentro do mês.

    `fx_for_day(cd)` é callable: retorna a taxa USD/BRL daquele dia.

    Returns: dict[cost_date] -> list[row].
    """
    line_daily = platform_data.get("line_daily") or []
    if not isinstance(line_daily, list) or not line_daily:
        return {}
    platform_currency = str(platform_data.get("currency") or "USD")

    # Token lookup a partir de platform_data["lines"]
    lookup_by_id: dict[str, dict[str, Any]] = {}
    lookup_by_name: dict[str, dict[str, Any]] = {}
    for line in platform_data.get("lines") or []:
        if not isinstance(line, dict):
            continue
        info = {
            "resolved_token": _line_costs_normalize_str(line.get("resolved_token")),
            "resolved_line_name": _line_costs_normalize_str(line.get("resolved_line_name")),
            "token_resolution_source": _line_costs_normalize_str(
                line.get("token_resolution_source")
            ),
        }
        lid = _line_costs_normalize_str(line.get("line_item_id"))
        name = _line_costs_normalize_str(line.get("resolved_line_name") or line.get("name"))
        if lid:
            lookup_by_id[lid] = info
        if name:
            lookup_by_name[name] = info

    # Agrega (line_key, cost_date) -> spend_native. Pula entries depois do window.
    by_line_day: dict[tuple[str, date], float] = {}
    sample_by_line: dict[str, dict[str, Any]] = {}
    granularity_by_line: dict[str, str] = {}
    estimated_by_line: dict[str, bool] = {}
    for entry in line_daily:
        if not isinstance(entry, dict):
            continue
        try:
            cd = date.fromisoformat(str(entry.get("date") or ""))
        except Exception:
            continue
        if cd > period_end_window:
            continue
        try:
            spend = float(entry.get("spend") or 0.0)
        except (TypeError, ValueError):
            continue
        if spend <= 0:
            continue
        key = _line_costs_line_key(entry)
        by_line_day[(key, cd)] = by_line_day.get((key, cd), 0.0) + spend
        sample_by_line.setdefault(key, entry)
        g = str(entry.get("granularity") or "daily")
        if g == "monthly_imputed" or entry.get("is_estimated"):
            granularity_by_line[key] = "monthly_imputed"
            estimated_by_line[key] = True
        else:
            granularity_by_line.setdefault(key, "daily")
            estimated_by_line.setdefault(key, False)

    # MTD cumulativo por line, ordenado por data.
    by_line_dates: dict[str, list[tuple[date, float]]] = {}
    for (key, cd), spend in by_line_day.items():
        by_line_dates.setdefault(key, []).append((cd, spend))

    grouped: dict[date, list[dict[str, Any]]] = {}
    ingested_at = datetime.now(timezone.utc).isoformat()

    for key, items in by_line_dates.items():
        items.sort(key=lambda t: t[0])
        sample = sample_by_line[key]
        entry_currency = str(sample.get("currency") or platform_currency)
        granul = granularity_by_line[key]
        is_est = estimated_by_line[key]

        lid = _line_costs_normalize_str(sample.get("line_item_id"))
        name = _line_costs_normalize_str(sample.get("name"))
        token_info = (
            (lookup_by_id.get(lid) if lid else None)
            or (lookup_by_name.get(name) if name else None)
            or {}
        )

        acc_native = 0.0
        for cd, delta_n in items:
            acc_native += delta_n
            rate = fx_for_day(cd)
            if entry_currency == "BRL":
                delta_b = delta_n
                mtd_b = acc_native
                fx: float | None = None
            else:
                delta_b = delta_n * rate
                mtd_b = acc_native * rate
                fx = rate
            row: dict[str, Any] = {
                "cost_date": cd.isoformat(),
                "platform": platform_name,
                "line_item_id": lid,
                "line_name": token_info.get("resolved_line_name") or name,
                "resolved_token": token_info.get("resolved_token"),
                "token_resolution_source": token_info.get("token_resolution_source"),
                "spend_native_delta": delta_n,
                "currency_native": entry_currency,
                "spend_brl_delta": delta_b,
                "spend_native_mtd": acc_native,
                "spend_brl_mtd": mtd_b,
                "exchange_rate_usd_brl": fx,
                "had_negative_delta": False,
                "observation": observation_tag,
                "source_snapshot_at": snapshot_marker,
                "baseline_snapshot_at": None,
                "ingested_at": ingested_at,
                "is_estimated": is_est,
                "granularity": granul,
            }
            grouped.setdefault(cd, []).append(row)

    return grouped


def _coerce_date(value: Any) -> date | None:
    """Aceita date object ou ISO string (YYYY-MM-DD ou completo) — retorna date ou None."""
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except Exception:
            return None
    return None


def _dim_campaign_rows_from_journey(journey_data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Constrói rows pra `dim_campaign` a partir do `journey["data"]`.

    Pula tokens vazios ou duplicados (fica com último). Status é derivado de
    start/end vs hoje. `total_plataformas` e `pct_investido` ficam None na dim
    (são métricas derivadas de gasto real, mudam toda hora — não pertencem ao
    dimensional de campanha).

    Aceita entries com `start`/`end` como `date` ou como ISO string.
    """
    import json as _json
    today = date.today()
    by_token: dict[str, dict[str, Any]] = {}
    for entry in journey_data or []:
        if not isinstance(entry, dict):
            continue
        token = str(entry.get("token") or "").strip().upper()
        if not token:
            continue
        start_d = _coerce_date(entry.get("start"))
        end_d = _coerce_date(entry.get("end"))
        # raw_row precisa ser JSON serializável; datas viram ISO
        raw_dict: dict[str, Any] = {}
        for k, v in entry.items():
            if isinstance(v, date):
                raw_dict[k] = v.isoformat()
            else:
                raw_dict[k] = v
        try:
            investido = float(entry.get("investido") or 0.0)
        except (TypeError, ValueError):
            investido = 0.0
        # `_is_campaign_active` precisa de date objects — chama com versão coerced.
        active_check = {"start": start_d, "end": end_d}
        by_token[token] = {
            "token": token,
            "cliente": _line_costs_normalize_str(entry.get("cliente")),
            "campanha": _line_costs_normalize_str(entry.get("campanha")),
            "account_management": _line_costs_normalize_str(entry.get("account_management")),
            "status": "Ativa" if _is_campaign_active(active_check, today) else "Encerrada",
            "produto": _line_costs_normalize_str(entry.get("produto_vendido")),
            "investido_brl": investido,
            "total_plataformas": None,
            "pct_investido": None,
            "campaign_start": _iso(start_d),
            "campaign_end": _iso(end_d),
            "raw_row": _json.dumps(raw_dict, ensure_ascii=False),
        }
    return list(by_token.values())


def _fetch_fx_with_source(target: date) -> tuple[float, str]:
    """Retorna (rate, source) pra `target`. Tenta PTAX(target), depois fallback
    de até 5 dias úteis pra trás. Por fim cai pro `DEFAULT_USD_BRL_RATE`.
    """
    from src.utils.currency import _fetch_ptax
    for delta in range(6):
        ref = target - timedelta(days=delta)
        try:
            rate = _fetch_ptax(ref)
        except Exception:
            rate = None
        if rate:
            source = "ptax" if delta == 0 else f"ptax_fallback_{delta}_days"
            return float(rate), source
    return DEFAULT_USD_BRL_RATE, "default_5_15"


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


def _hourly_worker_interval_seconds() -> float:
    """Worker único de 1h (Fase 5). Pop. `line_costs` + dims + cache home.

    Override via `WORKER_HOURLY_INTERVAL_SECONDS` em segundos (mínimo 300).
    Default: 3600s (1h)."""
    raw_value = os.getenv("WORKER_HOURLY_INTERVAL_SECONDS", "").strip()
    default = 3600.0
    if not raw_value:
        return default
    try:
        parsed = float(raw_value)
        if parsed >= 300:
            return parsed
    except ValueError:
        pass
    return default


def _worker_lookback_days() -> int:
    """Quantos dias de overlap o worker pede pras DSPs ao fechar a janela.

    Default casa com `LINE_COSTS_BACKFILL_DAYS` (3) — assim a janela de FETCH
    bate com a de ESCRITA em `line_costs`. Override via `WORKER_LOOKBACK_DAYS`.

    Importa principalmente na virada do mês: sem overlap, no dia 1º o worker
    pede só `[today, today]` às DSPs e como elas reportam com 1-2 dias de
    delay, o mês corrente fica em R$ 0 até a 2ª/3ª execução do worker.
    """
    raw_value = os.getenv(
        "WORKER_LOOKBACK_DAYS",
        os.getenv("LINE_COSTS_BACKFILL_DAYS", "3"),
    ).strip()
    try:
        parsed = int(raw_value)
        return max(0, parsed)
    except ValueError:
        return 3


def _worker_refresh_window() -> tuple[date, date]:
    """Janela `(start, end)` do worker: `(today - lookback, today)`.

    Difere de `get_mtd_dates()` (que volta `(first_of_month, today)`) porque
    queremos cobrir o lag de relatório das DSPs e suavizar a virada do mês.
    """
    today = date.today()
    lookback = _worker_lookback_days()
    return today - timedelta(days=lookback), today


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


def _xandr_timeout_seconds() -> float:
    raw_value = os.getenv("DASHBOARD_XANDR_TIMEOUT_SECONDS", "").strip()
    if not raw_value:
        return DEFAULT_XANDR_TIMEOUT_SECONDS
    try:
        parsed = float(raw_value)
        if parsed > 0:
            return parsed
    except ValueError:
        pass
    return DEFAULT_XANDR_TIMEOUT_SECONDS


def _platform_timeout_seconds(platform_name: str) -> float:
    if platform_name == "DV360":
        return _dv360_timeout_seconds()
    if platform_name == "Xandr":
        return _xandr_timeout_seconds()
    return _integration_timeout_seconds()


def _platform_names_for_trigger(trigger: str) -> set[str] | None:
    """Sempre None = chama TODAS as DSPs. Single worker `scheduled_hourly`."""
    return None


def _reuse_from_line_costs(
    results: dict[str, dict[str, Any]],
    platform_names: set[str],
    period_start: date,
    period_end: date,
) -> None:
    """Fase 5.2: reconstrói `platform_results[X]` a partir de `line_costs`.

    Substitui o reuse via snapshot blob — pra DSPs puladas pelo worker (ex:
    `scheduled_fast` pula DV360), reconstituímos os dados a partir do que
    foi gravado em `line_costs` pelo último ciclo OK daquela DSP.

    Não toca em DSPs com erro/timeout nesse ciclo — só nas explicitamente
    `skipped`.
    """
    if not platform_names:
        return
    from backend import bigquery_reads

    for platform_name in sorted(platform_names):
        # Não sobrescreve se já tem dado fresco do refresh atual
        existing = results.get(platform_name)
        if isinstance(existing, dict) and existing.get("status") == "ok":
            continue
        try:
            reused = bigquery_reads.platform_data_from_line_costs(
                platform_name, period_start, period_end
            )
        except Exception:
            logger.exception("reuse_from_line_costs falhou pra %s", platform_name)
            continue
        if reused.get("status") in {"ok", "stale"}:
            results[platform_name] = reused


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

        # Fase 5.2: reuse vem de line_costs, não do blob snapshot
        _reuse_from_line_costs(results, skipped_platform_names, start, end)

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

    # Overlay do `investido` por token via checklist_info (BQ). Aplica a regra
    # de atribuição por start_date (sem rateio). Token sem registro pro
    # período fica com 0.
    invested_by_token: dict[str, float] = {}
    invested_total_brl: float = 0.0
    if bigquery_store.is_enabled():
        try:
            from backend import bigquery_reads as _br_invested
            invested_by_token = _br_invested.invested_by_token_in_period(start, end)
            invested_total_brl = float(_br_invested.invested_total_in_period(start, end) or 0.0)
        except Exception:
            logger.exception("checklist_info: falha ao buscar invested overlay.")
    for c in journey.get("data", []):
        token_key = str(c.get("token", "") or "").strip().upper()
        c["investido"] = float(invested_by_token.get(token_key, 0.0))

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
        # `campaign["investido"]` já vem period-scoped do overlay checklist_info.
        # Atribuição integral por start_date — sem rateio linear.
        campaign_invested_period = float(campaign.get("investido", 0.0) or 0.0)
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
            # Já period-scoped via overlay checklist_info — sem rateio.
            investido = (
                float(campaign.get("investido", 0.0) or 0.0) if campaign else None
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

    # journey_data: versão "crua" da planilha (com investido total não-rateado),
    # serializável (datas em ISO). Usado pelo hook da Fase 3 pra popular dim_campaign.
    journey_data_serializable = []
    for entry in journey.get("data") or []:
        if not isinstance(entry, dict):
            continue
        clean: dict[str, Any] = {}
        for k, v in entry.items():
            clean[k] = v.isoformat() if isinstance(v, date) else v
        journey_data_serializable.append(clean)

    return {
        "period": {"start": fmt(start), "end": fmt(end)},
        "exchange_rate_usd_brl": rate,
        "total_brl": total_brl,
        "journey_status": journey.get("status", "unknown"),
        "journey_message": journey.get("message"),
        "journey_data": journey_data_serializable,
        "platform_results": results,
        "nexd": nexd_data,
        "dashboard": {
            "spend_by_platform": spend_by_platform,
            "daily": daily_rows,
            "campaign_journey_rows": campaign_rows,
            "active_platforms": active_platforms,
            "total_invested_brl": invested_total_brl,
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


def _dashboard_data_source() -> str:
    """`bq` = lê métricas de BQ (Fase 4). `blob` = mantém comportamento atual.
    Default: `blob` (sem mudança de comportamento)."""
    return os.getenv("DASHBOARD_DATA_SOURCE", "blob").strip().lower() or "blob"


def _overlay_bq_metrics(payload: dict[str, Any], start: date, end: date) -> dict[str, Any]:
    """Sobrepõe campos derivados de line_costs/dim_fx_daily no `payload`.

    Atualmente sobrescreve:
      - `total_brl`
      - `dashboard.spend_by_platform`
      - `dashboard.daily`
      - `exchange_rate_usd_brl` (se houver dim_fx pra `end`)

    Não toca em: `platform_results`, `nexd`, `platform_pages`, `attention`,
    `campaign_journey_rows`, `budget`. Esses ficam pra etapas 4.2+.

    Retorna o mesmo dict (mutado). Idempotente.
    """
    from backend import bigquery_reads

    try:
        bq_total = bigquery_reads.total_brl(start, end)
        bq_spend = bigquery_reads.spend_by_platform(start, end)
        bq_daily = bigquery_reads.daily_by_platform(start, end)
        bq_fx = bigquery_reads.exchange_rate_for_date(end) or bigquery_reads.latest_exchange_rate()
    except Exception:
        logger.exception("Falha ao ler métricas de BQ; mantendo blob.")
        return payload

    # Antes/depois pra log (audit trail)
    blob_total = float(payload.get("total_brl") or 0.0)
    diff_total = blob_total - bq_total
    diff_pct = (diff_total / blob_total * 100) if blob_total else 0
    logger.info(
        "overlay_bq: blob_total=%.2f bq_total=%.2f diff=%+.2f (%+.2f%%)",
        blob_total, bq_total, diff_total, diff_pct,
    )

    payload["total_brl"] = bq_total
    if bq_fx:
        payload["exchange_rate_usd_brl"] = bq_fx
    dashboard = payload.setdefault("dashboard", {})
    dashboard["spend_by_platform"] = bq_spend
    dashboard["daily"] = bq_daily

    # Etapa 4.2: campaign_journey_rows e attention
    active_plats = list(dashboard.get("active_platforms") or [p["platform"] for p in bq_spend])
    try:
        bq_journey = bigquery_reads.campaign_journey_rows(start, end, active_plats)
        blob_journey = dashboard.get("campaign_journey_rows") or []
        logger.info(
            "overlay_bq journey: blob=%d rows bq=%d rows",
            len(blob_journey), len(bq_journey),
        )
        dashboard["campaign_journey_rows"] = bq_journey
    except Exception:
        logger.exception("overlay_bq: campaign_journey_rows falhou; mantém blob.")

    try:
        bq_no_token = bigquery_reads.no_token_rows(start, end)
        bq_oop = bigquery_reads.out_of_period_rows(start, end)
        attention = payload.setdefault("attention", {})
        attention["no_token_rows"] = bq_no_token
        attention["no_token_total_brl"] = sum(r["gasto"] for r in bq_no_token)
        attention["out_of_period_rows"] = bq_oop
        attention["out_of_period_total_brl"] = sum(r["gasto"] for r in bq_oop)
        logger.info(
            "overlay_bq attention: no_token=%d (R$ %.2f) oop=%d (R$ %.2f)",
            len(bq_no_token), attention["no_token_total_brl"],
            len(bq_oop), attention["out_of_period_total_brl"],
        )
    except Exception:
        logger.exception("overlay_bq: attention falhou; mantém blob.")

    payload["_metrics_source"] = "bq"
    return payload


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


def _build_payload_from_bq(start: date, end: date) -> dict[str, Any] | None:
    """Monta o payload **sempre** a partir de BigQuery — fonte única da verdade.

    Paralelizado com ThreadPoolExecutor (queries BQ simultâneas, ~4-5s total).
    Todas as métricas vêm de:
      - `line_costs` (gastos)
      - `dim_campaign` (campanhas/Investido)
      - `dim_fx_daily` (câmbio)

    O cron `scheduled_hourly` alimenta essas tabelas a cada hora. Esta função é
    chamada em toda request — não há "cache de fan-out". Estado é sempre o que
    a base diz, na cadência do cron.

    Campos NÃO derivados de BQ (preenchidos pelo refresh real quando rodar):
      - `nexd.campaigns` / `nexd.layouts` (detalhe Nexd page)
      - `platform_pages[DV360].rows[].dv360_advertiser_id/io_id/...`

    Esses faltam só na Nexd page e em algumas colunas do DV360 page. Home/Journey/
    Detalhe de campanha vêm completos de BQ.
    """
    if not bigquery_store.is_enabled():
        return None
    try:
        from concurrent.futures import ThreadPoolExecutor

        from backend import bigquery_reads

        with ThreadPoolExecutor(max_workers=12) as ex:
            # Fase 1: dispara todas as queries independentes simultaneamente
            f_fx_target = ex.submit(bigquery_reads.exchange_rate_for_date, end)
            f_fx_latest = ex.submit(bigquery_reads.latest_exchange_rate)
            f_total = ex.submit(bigquery_reads.total_brl, start, end)
            f_spend = ex.submit(bigquery_reads.spend_by_platform, start, end)
            f_daily = ex.submit(bigquery_reads.daily_by_platform, start, end)
            f_no_token = ex.submit(bigquery_reads.no_token_rows, start, end)
            f_oop = ex.submit(bigquery_reads.out_of_period_rows, start, end)
            f_invested_total = ex.submit(
                bigquery_reads.invested_total_in_period, start, end
            )
            platform_futures = {
                name: ex.submit(
                    bigquery_reads.platform_data_from_line_costs, name, start, end
                )
                for name in PLATFORMS
            }
            # rows da DSP page (line × campanha) — usado em platform_pages[name].rows
            page_rows_futures = {
                name: ex.submit(bigquery_reads.platform_page_rows, name, start, end)
                for name in PLATFORMS
            }
            # Nexd snapshot (campaigns/layouts) + DV360 dim
            f_nexd = ex.submit(bigquery_reads.nexd_snapshot)

            # Aguarda spend_by_platform pra extrair active_platforms (input do journey)
            spend_by_platform = f_spend.result()
            active_platforms = [p["platform"] for p in spend_by_platform]

            # Fase 2: dispara journey (depende de active_platforms)
            f_journey = ex.submit(
                bigquery_reads.campaign_journey_rows, start, end, active_platforms
            )

            # Aguarda o resto
            rate = (
                f_fx_target.result()
                or f_fx_latest.result()
                or DEFAULT_USD_BRL_RATE
            )
            total_brl = f_total.result()
            daily = f_daily.result()
            no_token = f_no_token.result()
            out_of_period = f_oop.result()
            journey_rows = f_journey.result()
            try:
                invested_total_brl = float(f_invested_total.result() or 0.0)
            except Exception:
                logger.exception("cold-start: invested_total_in_period falhou.")
                invested_total_brl = 0.0

            platform_results: dict[str, Any] = {}
            for name, fut in platform_futures.items():
                try:
                    platform_results[name] = fut.result()
                except Exception:
                    logger.exception(
                        "cold-start: line_costs reuse falhou pra %s", name
                    )
                    platform_results[name] = {
                        "status": "stale", "currency": "USD", "spend": 0.0,
                        "lines": [], "daily": [], "line_daily": [],
                        "message": "Sem cache disponível.",
                    }
    except Exception:
        logger.exception("Falha no cold-start via bigquery_reads.")
        return None

    # platform_pages — constrói com spend_brl, daily e rows (BQ).
    spend_brl_by_platform = {p["platform"]: p["spend_brl"] for p in spend_by_platform}

    # Enriquecimento DV360: pega dimensions (advertiser/IO/campaign/...) do dim_dv360_line_meta
    dv360_meta_map: dict[str, dict[str, Any]] = {}
    try:
        dv360_page_rows = page_rows_futures.get("DV360")
        if dv360_page_rows is not None:
            # rows já resolvido aqui — pega line_item_ids únicos
            dv_rows = dv360_page_rows.result()
            line_ids = [r.get("line_item_id") for r in dv_rows if r.get("line_item_id")]
            if line_ids:
                from backend import bigquery_reads as _br
                dv360_meta_map = _br.dv360_line_meta_map(line_ids)
    except Exception:
        logger.exception("cold-start: falha ao buscar dv360_line_meta_map.")

    platform_pages: dict[str, Any] = {}
    for name, pdata in platform_results.items():
        try:
            page_rows = page_rows_futures[name].result() if name in page_rows_futures else []
        except Exception:
            logger.exception("cold-start: platform_page_rows falhou pra %s", name)
            page_rows = []

        # Enriquece rows DV360 com dimensions
        if name == "DV360" and dv360_meta_map and page_rows:
            for r in page_rows:
                lid = str(r.get("line_item_id") or "").strip()
                meta = dv360_meta_map.get(lid)
                if not meta:
                    continue
                for k, v in meta.items():
                    if v is not None and str(v).strip():
                        r[f"dv360_{k}"] = str(v).strip()

        platform_pages[name] = {
            "spend_brl": spend_brl_by_platform.get(name, 0.0),
            "spend_usd": float(pdata.get("spend") or 0.0) if pdata.get("currency") == "USD" else 0.0,
            "currency": pdata.get("currency", "USD"),
            "rows": page_rows,
            "daily": pdata.get("daily") or [],
        }

    # DV360 context (partner_id, advertiser_ids) — pega de qualquer meta row
    if dv360_meta_map and "DV360" in platform_pages:
        partners = {m.get("partner_id") for m in dv360_meta_map.values() if m.get("partner_id")}
        advertisers = {m.get("advertiser_id") for m in dv360_meta_map.values() if m.get("advertiser_id")}
        if partners or advertisers:
            platform_pages["DV360"]["dv360_context"] = {
                "partner_id": next(iter(partners), None),
                "advertiser_ids": sorted(filter(None, advertisers)),
            }

    # Nexd payload — vem de dim_nexd_snapshot
    nexd_payload: dict[str, Any]
    try:
        nexd_snap = f_nexd.result()
        if nexd_snap:
            nexd_payload = nexd_snap
        else:
            nexd_payload = {
                "impressions": 0, "cap": 10_000_000, "status": "stale",
                "message": "Nenhum snapshot Nexd disponível (aguardando primeiro refresh).",
                "campaigns": [], "layouts": [],
            }
    except Exception:
        logger.exception("cold-start: falha ao ler nexd_snapshot.")
        nexd_payload = {
            "impressions": 0, "cap": 10_000_000, "status": "error",
            "message": "Erro ao ler snapshot Nexd.",
            "campaigns": [], "layouts": [],
        }

    # platform_pages["Nexd"] — usado pelo card do home e Nexd page
    if nexd_payload.get("status") == "ok":
        imps = int(nexd_payload.get("impressions") or 0)
        cap_v = int(nexd_payload.get("cap") or 10_000_000) or 1
        nexd_cost = imps * NEXD_CPM_BRL
        layout_rows: list[dict[str, Any]] = []
        for r in (nexd_payload.get("layouts") or []):
            l_imps = int(r.get("impressions") or 0)
            est = l_imps * NEXD_CPM_BRL
            layout_rows.append({
                "layout": r.get("layout", "—"),
                "impressions": l_imps,
                "creatives": int(r.get("creatives") or 0),
                "estimated_cost_brl": est,
                "pct_estimated_cost": (est / nexd_cost * 100) if nexd_cost > 0 else 0.0,
            })
        layout_rows.sort(key=lambda x: x["estimated_cost_brl"], reverse=True)
        platform_pages["Nexd"] = {
            "spend_brl": nexd_cost,
            "spend_usd": 0.0,
            "impressions": imps,
            "cap": cap_v,
            "pct_cap": (imps / cap_v * 100) if cap_v > 0 else 0.0,
            "campaigns": nexd_payload.get("campaigns") or [],
            "layouts": layout_rows,
        }

    payload: dict[str, Any] = {
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "exchange_rate_usd_brl": rate,
        "total_brl": total_brl,
        "journey_status": "ok",
        "journey_message": "",
        "journey_data": [],
        "platform_results": platform_results,
        "nexd": nexd_payload,
        "dashboard": {
            "spend_by_platform": spend_by_platform,
            "daily": daily,
            "campaign_journey_rows": journey_rows,
            "active_platforms": active_platforms,
            "total_invested_brl": invested_total_brl,
        },
        "platform_pages": platform_pages,
        "attention": {
            "no_token_rows": no_token,
            "no_token_total_brl": sum(r["gasto"] for r in no_token),
            "out_of_period_rows": out_of_period,
            "out_of_period_total_brl": sum(r["gasto"] for r in out_of_period),
        },
        "budget": {},
        "_metrics_source": "bq",
    }

    snapshot_at = datetime.now(timezone.utc).isoformat()
    payload_with_meta = _refresh_metadata(payload, snapshot_at=snapshot_at, source="bigquery_reads")
    _update_cache(start, end, payload_with_meta, source="bigquery_reads", snapshot_at=snapshot_at)
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
                bq_snapshot = _build_payload_from_bq(start, end)
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

            # Fase 4: se DASHBOARD_DATA_SOURCE=bq, sobrepõe métricas chave com leitura BQ.
            # Fan-out continua acontecendo (pra `platform_results`, `platform_pages`,
            # `nexd`, `attention`, etc.) — só os 3 cards do home + gráfico daily
            # vêm do line_costs/dim_fx_daily.
            if _dashboard_data_source() == "bq":
                try:
                    _overlay_bq_metrics(payload, start, end)
                except Exception:
                    logger.exception("Falha no overlay BQ; mantendo payload blob.")
            try:
                discord_notify.maybe_notify_partial_after_refresh(
                    trigger=trigger, run_id=run_id, payload=payload
                )
            except Exception:
                logger.exception("Falha ao avaliar/enviar alerta Discord (integrações parciais).")
            _update_cache(start, end, payload, source="live", snapshot_at=snapshot_at)

            if bigquery_store.is_enabled():
                try:
                    # Fase 5+: blob aposentado. Snapshot marker é só timestamp.
                    written_snapshot_at = datetime.now(timezone.utc).isoformat()
                    try:
                        line_daily_rows = _dsp_line_daily_cost_rows_bigquery(
                            run_id=run_id,
                            trigger=trigger,
                            snapshot_ts=written_snapshot_at,
                            period_start=start,
                            period_end=end,
                            platform_results=payload.get("platform_results") or {},
                            exchange_rate_usd_brl=float(
                                payload.get("exchange_rate_usd_brl") or DEFAULT_USD_BRL_RATE
                            ),
                            ingested_at=datetime.now(timezone.utc),
                        )
                        bigquery_store.write_dsp_line_daily_cost_rows(line_daily_rows)
                    except Exception:
                        logger.exception("Falha ao gravar dsp_line_daily_cost no BigQuery.")

                    # Fase 3.2: atualiza dim_fx_daily com PTAX de hoje.
                    try:
                        today_utc = datetime.now(timezone.utc).date()
                        fx_rate, fx_source = _fetch_fx_with_source(today_utc)
                        bigquery_store.upsert_dim_fx_for_date(today_utc, fx_rate, fx_source)
                        logger.info(
                            "dim_fx_daily: wrote %s rate=%.4f source=%s",
                            today_utc.isoformat(), fx_rate, fx_source,
                        )
                    except Exception:
                        logger.exception("Falha ao gravar dim_fx_daily (Fase 3.2).")

                    # Fase 3.1: atualiza dim_campaign (1 row por token, MERGE-like).
                    try:
                        if payload.get("journey_status") == "ok":
                            journey_data = payload.get("journey_data") or []
                            dim_rows = _dim_campaign_rows_from_journey(journey_data)
                            if dim_rows:
                                bigquery_store.upsert_dim_campaign(dim_rows)
                                logger.info(
                                    "dim_campaign: upserted %d tokens", len(dim_rows)
                                )
                        else:
                            logger.warning(
                                "dim_campaign: journey_status=%s; skipping upsert.",
                                payload.get("journey_status"),
                            )
                    except Exception:
                        logger.exception("Falha ao gravar dim_campaign (Fase 3.1).")

                    # Fase 5+: dim_nexd_snapshot (campaigns/layouts/total/cap)
                    try:
                        nexd = payload.get("nexd") or {}
                        if nexd.get("status") == "ok":
                            bigquery_store.upsert_dim_nexd_snapshot(
                                impressions=int(nexd.get("impressions") or 0),
                                cap=int(nexd.get("cap") or 0),
                                campaigns=list(nexd.get("campaigns") or []),
                                layouts=list(nexd.get("layouts") or []),
                            )
                            logger.info(
                                "dim_nexd_snapshot: wrote impressions=%d campaigns=%d layouts=%d",
                                int(nexd.get("impressions") or 0),
                                len(nexd.get("campaigns") or []),
                                len(nexd.get("layouts") or []),
                            )
                    except Exception:
                        logger.exception("Falha ao gravar dim_nexd_snapshot.")

                    # Fase 5+: dim_dv360_line_meta (dimensions DV360 por line_item_id)
                    try:
                        dv = (payload.get("platform_results") or {}).get("DV360") or {}
                        if dv.get("status") == "ok":
                            meta_rows: list[dict[str, Any]] = []
                            for line in dv.get("lines") or []:
                                if not isinstance(line, dict):
                                    continue
                                lid = str(line.get("line_item_id") or "").strip()
                                if not lid:
                                    continue
                                meta_rows.append({
                                    "line_item_id": lid,
                                    "advertiser_id": line.get("dv360_advertiser_id"),
                                    "insertion_order_id": line.get("dv360_insertion_order_id"),
                                    "campaign_id": line.get("dv360_campaign_id"),
                                    "entity_status": line.get("dv360_entity_status"),
                                    "partner_id": line.get("dv360_partner_id"),
                                })
                            if meta_rows:
                                bigquery_store.upsert_dim_dv360_line_meta(meta_rows)
                                logger.info(
                                    "dim_dv360_line_meta: wrote %d line_items", len(meta_rows)
                                )
                    except Exception:
                        logger.exception("Falha ao gravar dim_dv360_line_meta.")

                    # Fase 1: popula `line_costs` a partir do `line_daily` que cada
                    # integração agora emite (Fase 0). Escreve cost_dates dos
                    # últimos `LINE_COSTS_BACKFILL_DAYS` dias (default 3) +
                    # last_day_of_month(today) — esse último cobre os imputed
                    # mensais (Hivestack / Nexd) durante o mês.
                    #
                    # O backfill cobre o lag de relatório das DSPs: DV360 tem até
                    # 48h de delay pra finalizar números, então sem revisar dias
                    # passados o valor fica congelado subestimado.
                    try:
                        today = datetime.now(timezone.utc).date()
                        try:
                            backfill_days = max(
                                0, int(os.getenv("LINE_COSTS_BACKFILL_DAYS", "3"))
                            )
                        except ValueError:
                            backfill_days = 3
                        accept_dates = {
                            today - timedelta(days=i) for i in range(backfill_days + 1)
                        }
                        accept_dates.add(_last_day_of_month(today))
                        groups = _line_costs_rows_from_payload(
                            platform_results=payload.get("platform_results") or {},
                            nexd_data=payload.get("nexd") or {},
                            rate=float(
                                payload.get("exchange_rate_usd_brl") or DEFAULT_USD_BRL_RATE
                            ),
                            snapshot_at=written_snapshot_at,
                            period_end=end,
                            accept_dates=accept_dates,
                        )
                        upsert_failures: list[str] = []
                        upsert_ok: list[str] = []
                        for (platform_name, cd), platform_rows in groups.items():
                            try:
                                bigquery_store.upsert_line_costs_for_platform_and_date(
                                    platform_name, cd, platform_rows
                                )
                                upsert_ok.append(
                                    f"{platform_name}/{cd.isoformat()}({len(platform_rows)})"
                                )
                            except Exception as exc:
                                upsert_failures.append(
                                    f"{platform_name}/{cd.isoformat()}: {exc}"
                                )
                                logger.exception(
                                    "line_costs upsert falhou %s/%s",
                                    platform_name,
                                    cd.isoformat(),
                                )
                        logger.info(
                            "line_costs Fase 1: ok=%s failures=%s",
                            upsert_ok or "[]",
                            upsert_failures or "[]",
                        )
                    except Exception:
                        logger.exception("Falha ao montar/gravar line_costs (Fase 1).")
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
    """Fase 5+: sempre lê de BigQuery. Sem fan-out no path da request.

    Cache em RAM (~30s) só pra evitar query duplicada quando múltiplos clients
    chegam simultaneamente. Conteúdo é o mesmo do BQ — atualização real vem
    do worker `scheduled_hourly` que popula `line_costs` + dims em background.

    `force_refresh=True` dispara fan-out completo sincronamente (caso especial,
    rota `/api/dashboard?force_refresh=true` — provavelmente não usado mais).
    """
    resolved_start, resolved_end = _period_range(start, end)

    if force_refresh:
        return line_observations_pg.merge_observations_into_payload(
            _refresh_dashboard(resolved_start, resolved_end, trigger="force_refresh")
        )

    # Cache RAM de curta duração — só pra deduplicar requests simultâneas
    with _cache_lock:
        if (
            _cache["start"] == resolved_start
            and _cache["end"] == resolved_end
            and _cache["data"] is not None
            and _cache_is_fresh(_cache.get("cached_at"))
        ):
            return line_observations_pg.merge_observations_into_payload(dict(_cache["data"]))

    # SEMPRE lê de BQ — fonte única da verdade
    bq_payload = _build_payload_from_bq(resolved_start, resolved_end)
    if bq_payload is not None:
        return line_observations_pg.merge_observations_into_payload(bq_payload)

    # Fallback (BQ indisponível): fan-out síncrono
    logger.warning("BQ indisponível; caindo pro fan-out síncrono.")
    return line_observations_pg.merge_observations_into_payload(
        _refresh_dashboard(resolved_start, resolved_end, trigger="bq_unavailable")
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
            start, end = _worker_refresh_window()
            _refresh_dashboard(start, end, trigger=trigger_name)
        except Exception:
            logger.exception("Falha no worker `%s`.", trigger_name)
        finally:
            with _worker_state_lock:
                _refresh_status[last_key] = time.time()


def start_background_workers() -> None:
    """Fase 5: 1 worker único a cada `WORKER_HOURLY_INTERVAL_SECONDS` (default 1h).
    Substitui os 2 workers anteriores (`scheduled_fast` 10min + `scheduled_dv360` 30min).

    O worker:
      - Chama TODAS as DSPs (DV360, Xandr, StackAdapt, Hivestack, Nexd)
      - Popula `line_costs` (Fase 1 hook)
      - Popula `dim_campaign` + `dim_fx_daily` (Fase 3 hooks)
      - Atualiza o cache em RAM
    """
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
    interval = _hourly_worker_interval_seconds()
    hourly_thread = threading.Thread(
        target=_worker_loop,
        args=("scheduled_hourly", interval),
        daemon=True,
        name="dashboard-worker-hourly",
    )
    hourly_thread.start()
    logger.info(
        "dashboard worker started: trigger=scheduled_hourly interval=%.0fs", interval
    )


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
