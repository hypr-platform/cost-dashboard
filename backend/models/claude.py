"""Pydantic models for the per-user Claude Code daily usage dashboard.

Fed by `/v1/organizations/usage_report/claude_code` (Claude Code Analytics API)
— retorna custo estimado por usuário por dia. Cache em memória configurável.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class ClaudeUserRow(BaseModel):
    user_name: str | None
    user_email: str
    cost_usd: Decimal
    cost_brl: Decimal
    tokens: int


class ClaudeDashboardResponse(BaseModel):
    date: date
    exchange_rate: Decimal
    total_cost_usd: Decimal
    total_cost_brl: Decimal
    total_tokens: int
    users: list[ClaudeUserRow]
    cached: bool = False
    fetched_at: str
