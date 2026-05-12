"""Per-user Claude Code daily usage aggregation.

Hits the Claude Code Analytics API (`/v1/organizations/usage_report/claude_code`)
for a single day, aggregates per user (by `actor.email_address`), and caches
the result in-memory for CLAUDE_CACHE_TTL_SECONDS (default 3600s / 1h).

Service accounts (actor_type != "user_actor" / sem email) são ignorados.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal

from backend.integrations.anthropic_admin import AnthropicAdminClient
from backend.models.claude import (
    ClaudeDashboardResponse,
    ClaudeUserRow,
)
from backend.services.exchange_rate import get_exchange_rate

logger = logging.getLogger(__name__)

DEFAULT_CACHE_TTL = 3600


def is_enabled() -> bool:
    return bool((os.getenv("ANTHROPIC_ADMIN_API_KEY") or "").strip())


def _cache_ttl() -> int:
    raw = (os.getenv("CLAUDE_CACHE_TTL_SECONDS") or "").strip()
    if not raw:
        return DEFAULT_CACHE_TTL
    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_CACHE_TTL


_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, ClaudeDashboardResponse]] = {}


def _cache_get(key: str) -> ClaudeDashboardResponse | None:
    ttl = _cache_ttl()
    if ttl <= 0:
        return None
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        ts, payload = entry
        if time.time() - ts > ttl:
            _cache.pop(key, None)
            return None
        return payload


def _cache_put(key: str, payload: ClaudeDashboardResponse) -> None:
    if _cache_ttl() <= 0:
        return
    with _cache_lock:
        _cache[key] = (time.time(), payload)


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def resolve_day(day: str | None) -> date:
    """Returns the target day; defaults to today (UTC)."""
    if not day:
        return datetime.now(timezone.utc).date()
    try:
        return date.fromisoformat(day.strip())
    except ValueError as exc:
        raise ValueError("`date` deve estar no formato YYYY-MM-DD.") from exc


async def build_dashboard(
    day: str | None = None,
    use_cache: bool = True,
) -> ClaudeDashboardResponse:
    if not is_enabled():
        raise RuntimeError(
            "Integração Claude desabilitada: defina ANTHROPIC_ADMIN_API_KEY."
        )

    target = resolve_day(day)
    cache_key = target.isoformat()
    if use_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached.model_copy(update={"cached": True})

    api_key = (os.getenv("ANTHROPIC_ADMIN_API_KEY") or "").strip()
    client = AnthropicAdminClient(api_key=api_key)

    try:
        rows, users = await asyncio.gather(
            client.fetch_claude_code_usage(target),
            client.fetch_users(),
        )
    except Exception as exc:
        logger.exception("Falha ao buscar dados do Claude Code.")
        raise RuntimeError(f"Admin API falhou: {exc}") from exc

    users_by_email: dict[str, str | None] = {}
    for u in users:
        if u.email:
            users_by_email[u.email.strip().lower()] = u.name

    cost_by_email: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    tokens_by_email: dict[str, int] = defaultdict(int)

    for r in rows:
        if not r.actor_email:
            continue
        email = r.actor_email.strip().lower()
        cost_by_email[email] += r.estimated_cost_usd
        tokens_by_email[email] += (
            r.input_tokens
            + r.output_tokens
            + r.cache_read_tokens
            + r.cache_creation_tokens
        )

    rate = get_exchange_rate(target)
    user_rows: list[ClaudeUserRow] = []
    total_usd = Decimal("0")
    total_tokens = 0
    for email, usd in cost_by_email.items():
        usd_q = usd.quantize(Decimal("0.000001"))
        brl = (usd_q * rate).quantize(Decimal("0.01"))
        tokens = int(tokens_by_email.get(email, 0))
        user_rows.append(
            ClaudeUserRow(
                user_name=users_by_email.get(email),
                user_email=email,
                cost_usd=usd_q,
                cost_brl=brl,
                tokens=tokens,
            )
        )
        total_usd += usd_q
        total_tokens += tokens

    user_rows.sort(key=lambda r: r.cost_brl, reverse=True)
    total_brl = (total_usd * rate).quantize(Decimal("0.01"))

    response = ClaudeDashboardResponse(
        date=target,
        exchange_rate=rate.quantize(Decimal("0.0001")),
        total_cost_usd=total_usd.quantize(Decimal("0.01")),
        total_cost_brl=total_brl,
        total_tokens=total_tokens,
        users=user_rows,
        cached=False,
        fetched_at=datetime.now(timezone.utc).isoformat(),
    )

    _cache_put(cache_key, response)
    return response
