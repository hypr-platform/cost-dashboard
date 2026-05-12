"""FastAPI routes for the GCP Billing dashboard."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from backend.models.gcp_billing import GcpBillingDashboardResponse
from backend.services import gcp_billing_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/gcp-billing", tags=["gcp-billing"])


@router.get("/dashboard", response_model=GcpBillingDashboardResponse)
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
) -> GcpBillingDashboardResponse:
    if not gcp_billing_service.is_enabled():
        raise HTTPException(
            status_code=503,
            detail="Integração GCP Billing desabilitada (configure GCP_BILLING_TABLE e credenciais BQ).",
        )
    try:
        return await gcp_billing_service.build_dashboard(
            from_str=from_date,
            to_str=to_date,
            use_cache=not no_cache,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Falha ao montar dashboard de GCP Billing.")
        raise HTTPException(status_code=502, detail=f"Falha na consulta: {exc}") from exc
