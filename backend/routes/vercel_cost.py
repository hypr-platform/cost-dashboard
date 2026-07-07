"""FastAPI routes for the Vercel cost dashboard."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from backend.models.vercel_cost import VercelCostResponse
from backend.services import vercel_cost_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vercel-cost", tags=["vercel-cost"])

_DISABLED_DETAIL = (
    "Integração Vercel desabilitada (defina VERCEL_API_TOKEN e, opcionalmente, "
    "VERCEL_TEAM_ID/VERCEL_TEAM_SLUG)."
)


@router.get("/dashboard", response_model=VercelCostResponse)
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
    no_cache: bool = Query(default=False),
) -> VercelCostResponse:
    if not vercel_cost_service.is_enabled():
        raise HTTPException(status_code=503, detail=_DISABLED_DETAIL)
    try:
        return await vercel_cost_service.build_dashboard(
            from_str=from_date,
            to_str=to_date,
            use_cache=not no_cache,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao montar dashboard de custos Vercel.")
        raise HTTPException(status_code=502, detail=f"Falha na consulta: {exc}") from exc
