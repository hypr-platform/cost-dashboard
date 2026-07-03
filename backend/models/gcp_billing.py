"""Pydantic models for the GCP Billing dashboard.

Fonte: standard billing export do GCP (`gcp_billing_export_v1_*` em BigQuery).
Custo líquido = `cost + SUM(credits.amount)` (créditos vêm negativos).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class GcpBillingProjectRow(BaseModel):
    project_id: str
    project_name: str | None
    cost_usd: Decimal
    cost_brl: Decimal
    credits_usd: Decimal


class GcpBillingServiceRow(BaseModel):
    service_id: str
    service_description: str
    cost_usd: Decimal
    cost_brl: Decimal


class GcpBillingSkuRow(BaseModel):
    sku_id: str
    sku_description: str
    service_description: str
    cost_usd: Decimal
    cost_brl: Decimal
    usage_amount: Decimal
    usage_unit: str | None


class GcpBillingDailyPoint(BaseModel):
    day: date
    cost_usd: Decimal
    cost_brl: Decimal


class GcpCloudRunByLabelRow(BaseModel):
    service_name: str
    cost_usd: Decimal
    cost_brl: Decimal
    # Total de requests no período (Cloud Monitoring). 0 quando indisponível.
    requests: int = 0
    # Custo por 1M de requests, na moeda de exibição. None quando sem requests.
    cost_per_million_usd: Decimal | None = None
    cost_per_million_brl: Decimal | None = None
    # Latência de request em ms (percentis da distribuição). None quando indisponível.
    latency_p50_ms: Decimal | None = None
    latency_p95_ms: Decimal | None = None
    latency_p99_ms: Decimal | None = None
    # Taxa de erro (fração 0–1): (4xx + 5xx) / total. None quando sem requests.
    error_rate: Decimal | None = None


class GcpBillingDashboardResponse(BaseModel):
    from_date: date
    to_date: date
    currency: str
    exchange_rate: Decimal
    total_cost_usd: Decimal
    total_cost_brl: Decimal
    total_credits_usd: Decimal
    total_gross_usd: Decimal
    by_project: list[GcpBillingProjectRow]
    by_service: list[GcpBillingServiceRow]
    by_sku: list[GcpBillingSkuRow]
    daily: list[GcpBillingDailyPoint]
    cloud_run_by_label: list[GcpCloudRunByLabelRow]
    cached: bool = False
    fetched_at: str


class GcpBillingDayDetailResponse(BaseModel):
    """Detalhamento de custo de um único dia (drill-down do gráfico diário)."""

    date: date
    currency: str
    exchange_rate: Decimal
    total_cost_usd: Decimal
    total_cost_brl: Decimal
    total_credits_usd: Decimal
    total_gross_usd: Decimal
    by_project: list[GcpBillingProjectRow]
    by_service: list[GcpBillingServiceRow]
    by_sku: list[GcpBillingSkuRow]
    cached: bool = False
    fetched_at: str


class GcpServiceDeltaRow(BaseModel):
    """Variação de custo de um serviço entre o período atual e o anterior."""

    service_id: str
    service_description: str
    current_usd: Decimal
    current_brl: Decimal
    previous_usd: Decimal
    previous_brl: Decimal
    delta_usd: Decimal
    delta_brl: Decimal
    # Variação relativa (fração). None quando não havia custo antes (serviço novo).
    delta_pct: Decimal | None


class GcpBillingComparisonResponse(BaseModel):
    """Comparação do período atual com o período imediatamente anterior de mesma duração."""

    from_date: date
    to_date: date
    prev_from_date: date
    prev_to_date: date
    currency: str
    exchange_rate: Decimal
    current_total_usd: Decimal
    current_total_brl: Decimal
    previous_total_usd: Decimal
    previous_total_brl: Decimal
    delta_total_usd: Decimal
    delta_total_brl: Decimal
    delta_total_pct: Decimal | None
    by_service_delta: list[GcpServiceDeltaRow]
    cached: bool = False
    fetched_at: str


class GcpBillingDaySkusResponse(BaseModel):
    """SKUs de um serviço num único dia (drill-down encadeado do detalhamento)."""

    date: date
    service_id: str
    service_description: str | None
    currency: str
    exchange_rate: Decimal
    by_sku: list[GcpBillingSkuRow]
    cached: bool = False
    fetched_at: str
