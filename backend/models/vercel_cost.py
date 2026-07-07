"""Pydantic models para o dashboard de custo da Vercel.

Fonte: Vercel Billing API (`GET /v1/billing/charges`), formato FOCUS v1.3.
Cada resposta agrega os "charges" do intervalo em várias dimensões: por serviço,
por projeto, por região, por categoria de cobrança e por dia — sempre com custo
em USD (moeda nativa da fatura) e em BRL (convertido pela cotação do dia final).

Convenção de custo: `billed_*` é o valor que compõe a fatura (FOCUS `BilledCost`),
`effective_*` é o custo amortizado incluindo créditos/descontos (`EffectiveCost`).
O "total" canônico do dashboard é o billed, alinhado ao que a Vercel cobra.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class VercelServiceRow(BaseModel):
    service_name: str
    service_category: str
    billed_usd: Decimal
    billed_brl: Decimal
    effective_usd: Decimal
    effective_brl: Decimal
    consumed_quantity: float | None
    consumed_unit: str | None
    share_pct: Decimal  # fração do billed total, 0–100


class VercelProjectRow(BaseModel):
    project_id: str | None
    project_name: str
    billed_usd: Decimal
    billed_brl: Decimal
    effective_usd: Decimal
    effective_brl: Decimal
    share_pct: Decimal


class VercelRegionRow(BaseModel):
    region: str
    billed_usd: Decimal
    billed_brl: Decimal
    share_pct: Decimal


class VercelChargeCategoryRow(BaseModel):
    category: str  # Usage | Purchase | Credit | Tax | Adjustment
    billed_usd: Decimal
    billed_brl: Decimal
    share_pct: Decimal


class VercelDailyRow(BaseModel):
    day: date
    billed_usd: Decimal
    billed_brl: Decimal
    effective_usd: Decimal
    effective_brl: Decimal


class VercelCategoryDailyPoint(BaseModel):
    """Ponto (dia, categoria de serviço) para o gráfico empilhado."""

    day: date
    category: str
    billed_usd: Decimal
    billed_brl: Decimal


class VercelCostResponse(BaseModel):
    from_date: date
    to_date: date
    currency: str = "USD"
    exchange_rate: Decimal

    total_billed_usd: Decimal
    total_billed_brl: Decimal
    total_effective_usd: Decimal
    total_effective_brl: Decimal
    # Alias do envelope compartilhado com as demais abas (== billed).
    total_cost_usd: Decimal
    total_cost_brl: Decimal

    usage_billed_brl: Decimal
    credits_billed_brl: Decimal  # normalmente negativo
    tax_billed_brl: Decimal

    projects_count: int
    services_count: int

    by_service: list[VercelServiceRow]
    by_project: list[VercelProjectRow]
    by_region: list[VercelRegionRow]
    by_charge_category: list[VercelChargeCategoryRow]
    daily: list[VercelDailyRow]
    daily_by_category: list[VercelCategoryDailyPoint]
    service_categories: list[str]

    cached: bool = False
    fetched_at: str
