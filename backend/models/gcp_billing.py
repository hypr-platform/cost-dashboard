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
