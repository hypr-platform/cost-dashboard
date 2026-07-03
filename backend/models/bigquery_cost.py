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


class BqCostUserDailyPoint(BaseModel):
    """Custo de análise (query) de um usuário num dia — série temporal empilhada."""

    day: date
    user_email: str
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


class BqUserQueryGroup(BaseModel):
    """Padrão de query de um usuário (literais normalizados), agregado."""

    pattern_preview: str
    sample_query: str
    statement_type: str | None
    jobs: int
    bytes_billed: int
    slot_ms: int
    cost_usd: Decimal
    cost_brl: Decimal


class BqUserQueriesResponse(BaseModel):
    """Padrões de query mais caros de um usuário (drill-down da tabela por usuário)."""

    user_email: str
    from_date: date
    to_date: date
    currency: str
    exchange_rate: Decimal
    total_cost_usd: Decimal
    total_cost_brl: Decimal
    groups: list[BqUserQueryGroup]
    cached: bool = False
    fetched_at: str


class BqCostLimitStatus(BaseModel):
    """Estado do limite diário de gasto com BigQuery (escopo projeto).

    `status` resume o dia: `unset` (sem limite), `ok`, `warning` (>= warn_pct),
    `exceeded` (gasto real já passou do limite) e `projected` (gasto atual ok,
    mas a projeção linear do dia estoura).

    `enforcement` reflete o bloqueio real via quota do GCP (consumer override em
    `bigquery.googleapis.com/quota/query/usage`): `enforced` (override ativo),
    `off` (limite salvo mas sem bloqueio aplicado), `stray` (há override sem
    limite salvo), `error` (falha ao consultar/aplicar). Ao estourar, TODA query
    on-demand do projeto falha até a meia-noite do Pacífico.
    """

    day: date
    timezone: str
    regions: list[str]
    limit_brl: Decimal | None
    warn_pct: Decimal
    spent_brl: Decimal
    spent_bytes: int
    spent_usd: Decimal
    projected_brl: Decimal
    pct_used: Decimal | None
    day_fraction_elapsed: Decimal
    status: str
    enforcement: str
    enforced_limit_mib: int | None = None
    enforced_limit_tib: Decimal | None = None
    quota_effective_tib: Decimal | None = None
    enforce_error: str | None = None
    exchange_rate: Decimal
    price_usd_per_tib: Decimal
    updated_at: str | None
    updated_by: str | None
    fetched_at: str


class BqCostDashboardResponse(BaseModel):
    from_date: date
    to_date: date
    regions: list[str]
    exchange_rate: Decimal
    # Tarifa efetiva média (USD/TiB) — blended real, não mais o flat fixo.
    price_usd_per_tib: Decimal
    total_jobs: int
    total_bytes_billed: int
    total_slot_ms: int
    # Total da aba = custo total do serviço BigQuery no billing (análise + storage
    # + outros), para bater com a linha "BigQuery" da aba Google Cloud.
    total_cost_usd: Decimal
    total_cost_brl: Decimal
    by_user: list[BqCostUserRow]
    by_statement_type: list[BqCostStatementRow]
    by_table: list[BqCostTableRow]
    top_queries: list[BqCostQueryRow]
    by_user_daily: list[BqCostUserDailyPoint] = []
    cached: bool = False
    fetched_at: str
    # Moeda nativa do billing (BRL/USD) usada na calibração.
    currency: str = "USD"
    # Se o custo veio calibrado pelo billing export (True) ou do flat on-demand (False).
    calibrated: bool = False
    # Quebra do custo total do serviço BigQuery.
    analysis_cost_usd: Decimal = Decimal("0")
    analysis_cost_brl: Decimal = Decimal("0")
    storage_cost_usd: Decimal = Decimal("0")
    storage_cost_brl: Decimal = Decimal("0")
    other_cost_usd: Decimal = Decimal("0")
    other_cost_brl: Decimal = Decimal("0")
    # Tarifa efetiva por região (USD/TiB), derivada do billing.
    price_by_region: dict[str, Decimal] = {}
