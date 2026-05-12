"""Pydantic models for the BigQuery cost dashboard.

Fed by `INFORMATION_SCHEMA.JOBS_BY_PROJECT` aggregated by user, statement type,
referenced table and top queries. Custo estimado on-demand a partir de
`total_bytes_billed`.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class BqCostUserRow(BaseModel):
    user_email: str
    jobs: int
    bytes_billed: int
    slot_ms: int
    cost_usd: Decimal
    cost_brl: Decimal


class BqCostStatementRow(BaseModel):
    statement_type: str
    jobs: int
    bytes_billed: int
    slot_ms: int
    cost_usd: Decimal
    cost_brl: Decimal


class BqCostTableRow(BaseModel):
    table_fqn: str
    jobs: int
    bytes_billed: int
    cost_usd: Decimal
    cost_brl: Decimal


class BqCostQueryRow(BaseModel):
    job_id: str
    user_email: str | None
    statement_type: str | None
    creation_time: str
    bytes_billed: int
    slot_ms: int
    cost_usd: Decimal
    cost_brl: Decimal
    query_preview: str
    region: str


class BqCostDashboardResponse(BaseModel):
    from_date: date
    to_date: date
    regions: list[str]
    exchange_rate: Decimal
    price_usd_per_tib: Decimal
    total_jobs: int
    total_bytes_billed: int
    total_slot_ms: int
    total_cost_usd: Decimal
    total_cost_brl: Decimal
    by_user: list[BqCostUserRow]
    by_statement_type: list[BqCostStatementRow]
    by_table: list[BqCostTableRow]
    top_queries: list[BqCostQueryRow]
    cached: bool = False
    fetched_at: str
