"""Async HTTP client for the Anthropic Admin Usage & Cost API.

Reference: https://docs.anthropic.com/en/api/usage-cost-api
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Literal

import httpx
from decimal import Decimal

logger = logging.getLogger(__name__)

BASE_URL = "https://api.anthropic.com"
USAGE_PATH = "/v1/organizations/usage_report/messages"
COST_PATH = "/v1/organizations/cost_report"
CLAUDE_CODE_USAGE_PATH = "/v1/organizations/usage_report/claude_code"
API_KEYS_PATH = "/v1/organizations/api_keys"
USERS_PATH = "/v1/organizations/users"
ANTHROPIC_VERSION = "2023-06-01"

DEFAULT_USAGE_GROUP_BY = (
    "workspace_id",
    "api_key_id",
    "model",
    "service_tier",
    "context_window",
)
DEFAULT_COST_GROUP_BY = ("workspace_id", "description")

MAX_RETRIES = 5
BASE_BACKOFF_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 30.0


@dataclass
class UsageBucket:
    starting_at: datetime
    ending_at: datetime
    workspace_id: str | None
    api_key_id: str | None
    model: str
    service_tier: str
    context_window: str | None
    uncached_input_tokens: int
    cached_input_tokens: int
    cache_creation_tokens: int
    output_tokens: int
    server_tool_use_tokens: int
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class CostBucket:
    starting_at: datetime
    ending_at: datetime
    workspace_id: str | None
    description: str  # typically the model
    api_key_id: str | None
    cost_usd: float
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class ApiKeyRef:
    id: str
    name: str | None
    workspace_id: str | None
    created_by: str | None
    status: str | None


@dataclass
class UserRef:
    id: str
    name: str | None
    email: str | None


@dataclass
class ClaudeCodeModelRow:
    """Per-actor, per-day, per-model row from the Claude Code Analytics endpoint."""

    day: str  # YYYY-MM-DD as returned by the API
    actor_type: str  # "user_actor" | "api_actor" | other
    actor_email: str | None
    actor_api_key_name: str | None
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    estimated_cost_usd: Decimal  # converted from cents
    raw: dict[str, Any] = field(default_factory=dict)


class AnthropicAdminError(RuntimeError):
    """Raised when the Admin API returns an unrecoverable error."""


class AnthropicAdminClient:
    def __init__(self, api_key: str, http_timeout: float = 30.0):
        if not api_key:
            raise ValueError("api_key is required")
        self._api_key = api_key
        self._http_timeout = http_timeout
        self._call_count = 0

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset_call_count(self) -> None:
        self._call_count = 0

    async def fetch_usage(
        self,
        starting_at: datetime,
        ending_at: datetime,
        bucket_width: Literal["1m", "1h", "1d"] = "1d",
        group_by: list[str] | None = None,
    ) -> list[UsageBucket]:
        params: dict[str, Any] = {
            "starting_at": _to_iso(starting_at),
            "ending_at": _to_iso(ending_at),
            "bucket_width": bucket_width,
            "group_by[]": list(group_by or DEFAULT_USAGE_GROUP_BY),
        }
        pages = await self._paginate(USAGE_PATH, params)
        buckets: list[UsageBucket] = []
        for page in pages:
            for raw_bucket in page.get("data") or []:
                start = _parse_iso(raw_bucket.get("starting_at"))
                end = _parse_iso(raw_bucket.get("ending_at"))
                for result in raw_bucket.get("results") or []:
                    buckets.append(
                        UsageBucket(
                            starting_at=start,
                            ending_at=end,
                            workspace_id=_clean(result.get("workspace_id")),
                            api_key_id=_clean(result.get("api_key_id")),
                            model=str(result.get("model") or "unknown"),
                            service_tier=str(result.get("service_tier") or "standard"),
                            context_window=_clean(result.get("context_window")),
                            uncached_input_tokens=int(
                                result.get("uncached_input_tokens") or 0
                            ),
                            cached_input_tokens=int(
                                result.get("cached_input_tokens") or 0
                            ),
                            cache_creation_tokens=int(
                                result.get("cache_creation_tokens") or 0
                            ),
                            output_tokens=int(result.get("output_tokens") or 0),
                            server_tool_use_tokens=int(
                                result.get("server_tool_use_tokens") or 0
                            ),
                            raw=result,
                        )
                    )
        return buckets

    async def fetch_cost(
        self,
        starting_at: datetime,
        ending_at: datetime,
        group_by: list[str] | None = None,
    ) -> list[CostBucket]:
        params: dict[str, Any] = {
            "starting_at": _to_iso(starting_at),
            "ending_at": _to_iso(ending_at),
            "group_by[]": list(group_by or DEFAULT_COST_GROUP_BY),
        }
        pages = await self._paginate(COST_PATH, params)
        buckets: list[CostBucket] = []
        for page in pages:
            for raw_bucket in page.get("data") or []:
                start = _parse_iso(raw_bucket.get("starting_at"))
                end = _parse_iso(raw_bucket.get("ending_at"))
                for result in raw_bucket.get("results") or []:
                    cost_amount = result.get("amount")
                    if isinstance(cost_amount, dict):
                        cost_value = float(cost_amount.get("amount") or 0)
                    else:
                        cost_value = float(cost_amount or result.get("cost_usd") or 0)
                    buckets.append(
                        CostBucket(
                            starting_at=start,
                            ending_at=end,
                            workspace_id=_clean(result.get("workspace_id")),
                            description=str(
                                result.get("description")
                                or result.get("model")
                                or "unknown"
                            ),
                            api_key_id=None,
                            cost_usd=cost_value,
                            raw=result,
                        )
                    )
        return buckets

    async def fetch_claude_code_usage(self, day: date) -> list[ClaudeCodeModelRow]:
        """Fetch Claude Code usage for a single day, flattened per (actor, model).

        Reference:
        https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api

        The endpoint returns one entry per (actor, day) with a `model_breakdown[]`
        containing per-model token usage and `estimated_cost.amount` in **cents USD**.
        Pagination uses `has_more` + `next_page` (opaque cursor).
        """
        params: dict[str, Any] = {
            "starting_at": day.isoformat(),
            "limit": 1000,
        }
        rows: list[ClaudeCodeModelRow] = []
        next_token: str | None = None
        async with httpx.AsyncClient(
            base_url=BASE_URL,
            timeout=self._http_timeout,
            headers={
                "x-api-key": self._api_key,
                "anthropic-version": ANTHROPIC_VERSION,
                "accept": "application/json",
            },
        ) as client:
            while True:
                request_params = dict(params)
                if next_token:
                    request_params["page"] = next_token
                payload = await self._request_with_retries(
                    client, CLAUDE_CODE_USAGE_PATH, request_params
                )
                for entry in payload.get("data") or []:
                    actor = entry.get("actor") or {}
                    actor_type = str(actor.get("type") or "")
                    email = _clean(actor.get("email_address"))
                    key_name = _clean(actor.get("api_key_name"))
                    day_str = str(entry.get("date") or day.isoformat())
                    for mb in entry.get("model_breakdown") or []:
                        tokens = mb.get("tokens") or {}
                        cost = mb.get("estimated_cost") or {}
                        cost_amount_cents = cost.get("amount") or 0
                        try:
                            cost_usd = Decimal(str(cost_amount_cents)) / Decimal(100)
                        except Exception:
                            cost_usd = Decimal("0")
                        rows.append(
                            ClaudeCodeModelRow(
                                day=day_str,
                                actor_type=actor_type,
                                actor_email=email,
                                actor_api_key_name=key_name,
                                model=str(mb.get("model") or "unknown"),
                                input_tokens=int(tokens.get("input") or 0),
                                output_tokens=int(tokens.get("output") or 0),
                                cache_read_tokens=int(tokens.get("cache_read") or 0),
                                cache_creation_tokens=int(
                                    tokens.get("cache_creation") or 0
                                ),
                                estimated_cost_usd=cost_usd,
                                raw=entry,
                            )
                        )
                if not payload.get("has_more"):
                    break
                next_token = payload.get("next_page")
                if not next_token:
                    break
                await asyncio.sleep(0.1)
        return rows

    async def fetch_api_keys(self) -> list[ApiKeyRef]:
        rows = await self._list_paginate(API_KEYS_PATH)
        out: list[ApiKeyRef] = []
        for raw in rows:
            kid = _clean(raw.get("id"))
            if not kid:
                continue
            out.append(
                ApiKeyRef(
                    id=kid,
                    name=_clean(raw.get("name")),
                    workspace_id=_clean(raw.get("workspace_id")),
                    created_by=_extract_actor_id(raw.get("created_by")),
                    status=_clean(raw.get("status")),
                )
            )
        return out

    async def fetch_users(self) -> list[UserRef]:
        rows = await self._list_paginate(USERS_PATH)
        out: list[UserRef] = []
        for raw in rows:
            uid = _clean(raw.get("id"))
            if not uid:
                continue
            out.append(
                UserRef(
                    id=uid,
                    name=_clean(raw.get("name")),
                    email=_clean(raw.get("email")),
                )
            )
        return out

    async def _list_paginate(self, path: str) -> list[dict[str, Any]]:
        """Cursor pagination for list endpoints (/api_keys, /users).

        These use `has_more` + `last_id` (Admin Console pagination). Distinct
        from the usage/cost report pagination which is `has_more` + `next_page`.
        """
        rows: list[dict[str, Any]] = []
        after_id: str | None = None
        async with httpx.AsyncClient(
            base_url=BASE_URL,
            timeout=self._http_timeout,
            headers={
                "x-api-key": self._api_key,
                "anthropic-version": ANTHROPIC_VERSION,
                "accept": "application/json",
            },
        ) as client:
            while True:
                params: dict[str, Any] = {"limit": 100}
                if after_id:
                    params["after_id"] = after_id
                payload = await self._request_with_retries(client, path, params)
                page_rows = payload.get("data") or []
                rows.extend(page_rows)
                if not payload.get("has_more") or not page_rows:
                    break
                last_id = payload.get("last_id") or _clean(page_rows[-1].get("id"))
                if not last_id or last_id == after_id:
                    break
                after_id = last_id
                await asyncio.sleep(0.1)
        return rows

    async def _paginate(self, path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        pages: list[dict[str, Any]] = []
        next_page_token: str | None = None
        page_index = 0
        async with httpx.AsyncClient(
            base_url=BASE_URL,
            timeout=self._http_timeout,
            headers={
                "x-api-key": self._api_key,
                "anthropic-version": ANTHROPIC_VERSION,
                "accept": "application/json",
            },
        ) as client:
            while True:
                request_params = dict(params)
                if next_page_token:
                    request_params["page"] = next_page_token
                payload = await self._request_with_retries(client, path, request_params)
                pages.append(payload)
                page_index += 1
                if not payload.get("has_more"):
                    break
                next_page_token = payload.get("next_page")
                if not next_page_token:
                    break
                # gentle pacing
                await asyncio.sleep(0.2)
        logger.debug(
            "anthropic_api_paginate path=%s pages=%d", path, page_index
        )
        return pages

    async def _request_with_retries(
        self,
        client: httpx.AsyncClient,
        path: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        attempt = 0
        while True:
            attempt += 1
            self._call_count += 1
            t0 = time.monotonic()
            try:
                response = await client.get(path, params=params)
                duration_ms = int((time.monotonic() - t0) * 1000)
                logger.debug(
                    "anthropic_api_call path=%s status=%s duration_ms=%s",
                    path,
                    response.status_code,
                    duration_ms,
                )
                if response.status_code == 429 or 500 <= response.status_code < 600:
                    if attempt >= MAX_RETRIES:
                        raise AnthropicAdminError(
                            f"Admin API {path} failed after {attempt} attempts: "
                            f"status={response.status_code} body={response.text[:300]}"
                        )
                    delay = _retry_delay(response, attempt)
                    logger.warning(
                        "anthropic_api_retry path=%s status=%s attempt=%d sleep=%.2fs",
                        path,
                        response.status_code,
                        attempt,
                        delay,
                    )
                    await asyncio.sleep(delay)
                    continue
                if response.status_code >= 400:
                    raise AnthropicAdminError(
                        f"Admin API {path} returned {response.status_code}: "
                        f"{response.text[:500]}"
                    )
                return response.json()
            except httpx.TimeoutException as exc:
                if attempt >= MAX_RETRIES:
                    raise AnthropicAdminError(
                        f"Admin API {path} timed out after {attempt} attempts"
                    ) from exc
                delay = _retry_delay(None, attempt)
                logger.warning(
                    "anthropic_api_timeout path=%s attempt=%d sleep=%.2fs",
                    path,
                    attempt,
                    delay,
                )
                await asyncio.sleep(delay)


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    if response is not None:
        retry_after = response.headers.get("retry-after")
        if retry_after:
            try:
                return min(float(retry_after), MAX_BACKOFF_SECONDS)
            except ValueError:
                pass
    base = min(BASE_BACKOFF_SECONDS * (2 ** (attempt - 1)), MAX_BACKOFF_SECONDS)
    return base + random.uniform(0, base * 0.25)


def _to_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(raw: Any) -> datetime:
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    if not raw:
        return datetime.now(timezone.utc)
    text = str(raw).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return datetime.now(timezone.utc)


def _clean(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _extract_actor_id(actor: Any) -> str | None:
    """The Admin API returns `created_by` either as a plain string id or as
    a `{type, id}` object. Normalize to the bare id."""
    if isinstance(actor, dict):
        return _clean(actor.get("id"))
    return _clean(actor)
