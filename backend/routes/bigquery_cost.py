"""FastAPI routes for the BigQuery cost dashboard."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from backend.models.bigquery_cost import BqCostDashboardResponse, BqCostLimitStatus
from backend.services import bigquery_cost_service


class BqLimitPayload(BaseModel):
    limit_brl: float = Field(..., gt=0, description="Limite diário de gasto em BRL.")
    warn_pct: float | None = Field(
        default=None, ge=0, le=100, description="Percentual para alerta amarelo (padrão 80)."
    )

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bigquery-cost", tags=["bigquery-cost"])


@router.get("/dashboard", response_model=BqCostDashboardResponse)
async def get_dashboard(
    from_date: str | None = Query(
        default=None,
        alias="from",
        description="Início do intervalo (YYYY-MM-DD).",
    ),
    to_date: str | None = Query(
        default=None,
        alias="to",
        description="Fim do intervalo (YYYY-MM-DD).",
    ),
    regions: str | None = Query(
        default=None,
        description="Regiões BigQuery separadas por vírgula (ex: us,southamerica-east1).",
    ),
    no_cache: bool = Query(default=False),
) -> BqCostDashboardResponse:
    if not bigquery_cost_service.is_enabled():
        raise HTTPException(
            status_code=503,
            detail="Integração BigQuery desabilitada (BQ_PROJECT_ID/credenciais ausentes).",
        )
    try:
        return await bigquery_cost_service.build_dashboard(
            from_str=from_date,
            to_str=to_date,
            regions_str=regions,
            use_cache=not no_cache,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao montar dashboard de custos BigQuery.")
        raise HTTPException(status_code=502, detail=f"Falha na consulta: {exc}") from exc


@router.get("/limit", response_model=BqCostLimitStatus)
def get_limit_status(no_cache: bool = Query(default=False)) -> BqCostLimitStatus:
    """Estado do limite diário: gasto de hoje vs. limite + projeção de fim de dia."""
    if not bigquery_cost_service.is_enabled():
        raise HTTPException(
            status_code=503,
            detail="Integração BigQuery desabilitada (BQ_PROJECT_ID/credenciais ausentes).",
        )
    try:
        return bigquery_cost_service.build_limit_status(use_cache=not no_cache)
    except Exception as exc:
        logger.exception("Falha ao calcular status do limite BigQuery.")
        raise HTTPException(status_code=502, detail=f"Falha ao calcular limite: {exc}") from exc


@router.put("/limit", response_model=BqCostLimitStatus)
def put_limit(
    payload: BqLimitPayload,
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
) -> BqCostLimitStatus:
    """Define/atualiza o limite diário e aplica o bloqueio na quota do GCP."""
    if not bigquery_cost_service.is_enabled():
        raise HTTPException(status_code=503, detail="Integração BigQuery desabilitada.")
    try:
        enforce_error = bigquery_cost_service.set_limit(
            payload.limit_brl, warn_pct=payload.warn_pct, updated_by=x_user_email
        )
        status = bigquery_cost_service.build_limit_status(use_cache=False)
        # Se o bloqueio não foi aplicado, propaga o motivo (o status recalcula a
        # partir da quota atual e não teria a mensagem do erro de escrita).
        if enforce_error and status.enforcement != "enforced":
            status = status.model_copy(update={"enforce_error": enforce_error})
        return status
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao gravar limite BigQuery.")
        raise HTTPException(status_code=502, detail=f"Falha ao gravar limite: {exc}") from exc


@router.delete("/limit", response_model=BqCostLimitStatus)
def delete_limit(
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
) -> BqCostLimitStatus:
    """Remove o limite e o bloqueio da quota (volta ao teto padrão)."""
    if not bigquery_cost_service.is_enabled():
        raise HTTPException(status_code=503, detail="Integração BigQuery desabilitada.")
    try:
        bigquery_cost_service.clear_limit(updated_by=x_user_email)
        return bigquery_cost_service.build_limit_status(use_cache=False)
    except Exception as exc:
        logger.exception("Falha ao remover limite BigQuery.")
        raise HTTPException(status_code=502, detail=f"Falha ao remover limite: {exc}") from exc
