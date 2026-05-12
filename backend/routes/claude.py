"""FastAPI routes for the simplified Claude dashboard.

Single endpoint that aggregates monthly cost per user live from the Anthropic
Admin API. No BigQuery, no scheduler — just a 1h in-memory cache.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from backend.models.claude import ClaudeDashboardResponse
from backend.services import claude_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/claude", tags=["claude"])


@router.get("/dashboard", response_model=ClaudeDashboardResponse)
async def get_dashboard(
    date: str | None = Query(
        default=None,
        description="Dia no formato YYYY-MM-DD (default: hoje UTC).",
    ),
    no_cache: bool = Query(default=False),
) -> ClaudeDashboardResponse:
    if not claude_service.is_enabled():
        raise HTTPException(
            status_code=503,
            detail="Integração Claude desabilitada (ANTHROPIC_ADMIN_API_KEY ausente).",
        )
    try:
        return await claude_service.build_dashboard(
            day=date, use_cache=not no_cache
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao montar dashboard do Claude.")
        raise HTTPException(status_code=502, detail=f"Falha na consulta: {exc}") from exc
