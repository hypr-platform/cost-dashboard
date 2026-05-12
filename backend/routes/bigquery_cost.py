"""FastAPI routes for the BigQuery cost dashboard."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from backend.models.bigquery_cost import BqCostDashboardResponse
from backend.services import bigquery_cost_service

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
