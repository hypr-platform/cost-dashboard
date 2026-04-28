import os
import re
import logging
from datetime import date
from typing import Any
from urllib.parse import unquote

from fastapi import FastAPI, Query
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from backend.budget_store import init_budget_store
from backend.dashboard_service import (
    build_filtered_daily_series,
    get_cached_dashboard_data,
    get_dashboard_data,
    get_refresh_metrics,
    get_refresh_status,
    start_background_workers,
    stop_background_workers,
    trigger_refresh_async,
)
from backend import line_observations_pg

load_dotenv(override=True)
logger = logging.getLogger(__name__)

app = FastAPI(title="Cost Dashboard API", version="1.0.0")
init_budget_store()
MONTH_KEY_REGEX = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

frontend_origin = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_origin, "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _on_startup() -> None:
    start_background_workers()


@app.on_event("shutdown")
def _on_shutdown() -> None:
    stop_background_workers()


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "cost-dashboard-api",
        "health": "/health",
        "dashboard": "/api/dashboard",
        "frontend": frontend_origin,
        "hint": "Se você vê isto no navegador na porta 3000, o Uvicorn está na porta errada; use 8000 para a API e 3000 só para o Next.",
    }


@app.get("/health")
def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


def _validate_month_key(month_key: str) -> str:
    value = month_key.strip()
    if not MONTH_KEY_REGEX.match(value):
        raise HTTPException(status_code=422, detail="`month` deve estar no formato YYYY-MM.")
    return value


def _normalize_token(value: str | None) -> str:
    return (value or "").strip().upper()


def _parse_csv_query_param(value: str | None) -> list[str]:
    if not value:
        return []
    items: list[str] = []
    for raw in value.split(","):
        token = raw.strip()
        if not token:
            continue
        try:
            decoded = unquote(token).strip()
        except Exception:
            decoded = token
        if decoded:
            items.append(decoded)
    return items


@app.get("/api/budget-target")
def budget_target(
    month: str = Query(..., description="Formato YYYY-MM"),
    platform: str | None = Query(default=None),
):
    """Alvos por plataforma são calculados no /api/dashboard a partir do gasto SA+DV360+Xandr."""
    month_key = _validate_month_key(month)
    platform_name = (platform or "").strip()
    if platform_name:
        return {
            "month_key": month_key,
            "platform": platform_name,
            "target_brl": None,
        }
    return {
        "month_key": month_key,
        "general_target_brl": None,
        "targets_brl": {},
    }


@app.get("/api/dashboard")
def dashboard_data(
    start: date | None = Query(default=None),
    end: date | None = Query(default=None),
    force_refresh: bool = Query(default=False),
    clients: str | None = Query(default=None),
    cs: str | None = Query(default=None),
    campaigns: str | None = Query(default=None),
    campaign_status: str | None = Query(default=None),
    features: str | None = Query(default=None),
    tipo: str | None = Query(default=None),
):
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="`start` deve ser menor ou igual a `end`.")
    try:
        payload = get_dashboard_data(start=start, end=end, force_refresh=force_refresh)
        daily_filtered = build_filtered_daily_series(
            payload,
            clients=_parse_csv_query_param(clients),
            cs=_parse_csv_query_param(cs),
            campaigns=_parse_csv_query_param(campaigns),
            campaign_status=_parse_csv_query_param(campaign_status),
            features=_parse_csv_query_param(features),
            campaign_types=_parse_csv_query_param(tipo),
            include_out_of_period=False,
        )
        dashboard = payload.get("dashboard") or {}
        return {
            **payload,
            "dashboard": {
                **dashboard,
                "daily_filtered": daily_filtered,
            },
        }
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception:
        logger.exception("Falha ao montar payload de dashboard.")
        cached = get_cached_dashboard_data()
        if cached is not None:
            stale_payload = line_observations_pg.merge_observations_into_payload(dict(cached))
            stale_payload["_warning"] = "Erro ao atualizar dados ao vivo; retornando cache anterior."
            stale_payload["_error"] = "Falha temporária ao atualizar integrações."
            return stale_payload

        raise HTTPException(status_code=502, detail="Falha ao montar dashboard.")


@app.post("/api/dashboard/refresh")
def dashboard_refresh(
    start: date | None = Query(default=None),
    end: date | None = Query(default=None),
):
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="`start` deve ser menor ou igual a `end`.")
    try:
        return trigger_refresh_async(start=start, end=end, trigger="manual_api")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception:
        logger.exception("Falha ao disparar refresh assíncrono.")
        raise HTTPException(status_code=500, detail="Falha ao disparar refresh.")


@app.get("/api/dashboard/refresh/status")
def dashboard_refresh_status() -> dict[str, Any]:
    return get_refresh_status()


@app.get("/api/dashboard/refresh/metrics")
def dashboard_refresh_metrics() -> dict[str, Any]:
    return get_refresh_metrics()


class NoTokenLineObservationBody(BaseModel):
    platform: str = Field(..., max_length=512)
    line: str = Field(..., max_length=8192)
    line_item_id: str | None = Field(default=None, max_length=512)
    observation: str = Field(default="", max_length=8000)


class NoTokenLineNameBody(BaseModel):
    platform: str = Field(..., max_length=512)
    line: str = Field(default="", max_length=8192)
    line_item_id: str | None = Field(default=None, max_length=512)
    line_name: str = Field(..., max_length=8192)
    updated_by: str | None = Field(default=None, max_length=512)


@app.post("/api/attention/no-token-lines/observation")
def save_no_token_line_observation(body: NoTokenLineObservationBody) -> dict[str, str]:
    if not line_observations_pg.is_enabled():
        raise HTTPException(
            status_code=503,
            detail=(
                "Observações em PostgreSQL não configuradas. Defina LINE_NO_TOKEN_POSTGRES_URL "
                "ou POSTGRESS_DATABASE_URL / POSTGRES_DATABASE_URL / POSTGRES_URL; "
                "DATABASE_URL em localhost só conta com LINE_OBSERVATIONS_USE_DATABASE_URL=1. "
                "Schema: POSTGRESS_DATABASE_PG_SCHEMA (opcional se for public)."
            ),
        )
    try:
        line_observations_pg.upsert_observation(
            body.platform,
            body.line,
            body.line_item_id,
            body.observation,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception:
        logger.exception("Falha ao gravar observação de line sem token.")
        raise HTTPException(
            status_code=500,
            detail="Falha ao gravar observação. Verifique os logs do backend e a conexão com o PostgreSQL.",
        )
    return {"status": "ok"}


@app.post("/api/attention/no-token-lines/line-name")
def save_no_token_line_name(body: NoTokenLineNameBody) -> dict[str, str]:
    if not line_observations_pg.is_enabled():
        raise HTTPException(
            status_code=503,
            detail=(
                "Resolução de tokens em PostgreSQL não configurada. Defina LINE_NO_TOKEN_POSTGRES_URL "
                "ou POSTGRESS_DATABASE_URL / POSTGRES_DATABASE_URL / POSTGRES_URL."
            ),
        )
    try:
        token = line_observations_pg.upsert_manual_line_name(
            body.platform,
            body.line,
            body.line_item_id,
            body.line_name,
            updated_by=body.updated_by or "",
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception:
        logger.exception("Falha ao gravar nome/token manual de line sem token.")
        raise HTTPException(
            status_code=500,
            detail="Falha ao salvar nome da line. Verifique os logs do backend e a conexão com o PostgreSQL.",
        )
    return {"status": "ok", "token": token}


@app.get("/api/campaign/{token}")
def campaign_data(
    token: str,
    start: date | None = Query(default=None),
    end: date | None = Query(default=None),
):
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="`start` deve ser menor ou igual a `end`.")

    normalized_token = _normalize_token(token)
    if not normalized_token:
        raise HTTPException(status_code=422, detail="`token` inválido.")

    try:
        payload = get_dashboard_data(start=start, end=end, force_refresh=False)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception:
        logger.exception("Falha ao montar payload de campanha.")
        raise HTTPException(status_code=502, detail="Falha ao montar campanha.")

    dashboard_section = payload.get("dashboard", {})
    campaign_rows = dashboard_section.get("campaign_journey_rows", []) or []
    campaign = next(
        (
            row
            for row in campaign_rows
            if _normalize_token(str(row.get("token", ""))) == normalized_token
        ),
        None,
    )

    line_rows: list[dict[str, Any]] = []
    platform_pages = payload.get("platform_pages", {}) or {}
    for platform_name, platform_data in platform_pages.items():
        rows = (platform_data or {}).get("rows", []) or []
        for row in rows:
            if _normalize_token(str(row.get("token", ""))) != normalized_token:
                continue
            lr = {
                "platform": platform_name,
                "line": row.get("line", ""),
                "line_item_id": row.get("line_item_id"),
                "cliente": row.get("cliente", ""),
                "campanha": row.get("campanha", ""),
                "account_management": row.get("account_management", ""),
                "gasto": row.get("gasto", 0.0),
                "investido": row.get("investido"),
                "pct_invest": row.get("pct_invest"),
            }
            for _dk in (
                "dv360_advertiser_id",
                "dv360_insertion_order_id",
                "dv360_campaign_id",
                "dv360_entity_status",
                "dv360_partner_id",
            ):
                _v = row.get(_dk)
                if _v is not None and str(_v).strip() != "":
                    lr[_dk] = str(_v).strip()
            line_rows.append(lr)
    line_rows.sort(key=lambda row: float(row.get("gasto", 0.0)), reverse=True)

    active_platforms = sorted({str(row["platform"]) for row in line_rows if row.get("platform")})
    filtered_daily: list[dict[str, Any]] = []
    for daily_row in dashboard_section.get("daily", []) or []:
        filtered_row: dict[str, Any] = {"date": str(daily_row.get("date", "")), "total": 0.0}
        for platform_name in active_platforms:
            value = float(daily_row.get(platform_name, 0) or 0)
            filtered_row[platform_name] = value
            filtered_row["total"] += value
        if filtered_row["total"] > 0:
            filtered_daily.append(filtered_row)

    return {
        "token": normalized_token,
        "period": payload.get("period", {}),
        "campaign": campaign,
        "line_rows": line_rows,
        "daily": filtered_daily,
        "active_platforms": active_platforms,
    }
