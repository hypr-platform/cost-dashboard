"""FastAPI routes para o dashboard de custo de notas fiscais."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from backend.models.invoice_cost import InvoiceCostResponse
from backend.services import invoice_cost_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/invoice-cost", tags=["invoice-cost"])


@router.get("/dashboard", response_model=InvoiceCostResponse)
async def get_dashboard(
    from_date: str | None = Query(default=None, alias="from", description="Início (YYYY-MM-DD)."),
    to_date: str | None = Query(default=None, alias="to", description="Fim (YYYY-MM-DD)."),
    no_cache: bool = Query(default=False),
) -> InvoiceCostResponse:
    if not invoice_cost_service.is_enabled():
        raise HTTPException(
            status_code=503,
            detail="Integração de custo de notas desabilitada (BQ/GCP_BILLING_TABLE ausentes).",
        )
    try:
        return await invoice_cost_service.build_dashboard(
            from_str=from_date,
            to_str=to_date,
            use_cache=not no_cache,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao montar dashboard de custo de notas.")
        raise HTTPException(status_code=502, detail=f"Falha na consulta: {exc}") from exc
