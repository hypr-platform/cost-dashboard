"""Async HTTP client for the Vercel Billing (FOCUS) API.

Reads `GET /v1/billing/charges`, which streams billing charge data in the
FinOps **FOCUS v1.3** open-standard format as newline-delimited JSON (JSONL),
at 1-day granularity, for a date range of up to one year.

Reference:
- https://vercel.com/docs/rest-api/billing/list-focus-billing-charges
- https://focus.finops.org/

Each JSONL line is a "charge" record. The fields we care about (all present in
the Vercel extension of the FOCUS schema):

- ``BilledCost``       amount serving as the basis for invoicing (USD)
- ``EffectiveCost``    amortized cost incl. discounts / prepaid credits (USD)
- ``ChargeCategory``   Usage | Purchase | Credit | Tax | Adjustment
- ``ChargePeriodStart``/``ChargePeriodEnd`` ISO-8601 UTC (daily buckets)
- ``ServiceName``      display name of the product (e.g. "Edge Functions")
- ``ServiceCategory``  high-level FOCUS category (Compute, Storage, ...)
- ``ConsumedQuantity``/``ConsumedUnit`` measured usage volume + unit
- ``RegionId``/``RegionName`` provider region (nullable)
- ``Tags``             metadata; carries Vercel ``ProjectId``/``ProjectName``
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

logger = logging.getLogger(__name__)

BASE_URL = "https://api.vercel.com"
CHARGES_PATH = "/v1/billing/charges"

MAX_RETRIES = 5
BASE_BACKOFF_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 30.0


@dataclass
class FocusCharge:
    """One FOCUS billing charge line, normalized to our types."""

    charge_period_start: datetime
    charge_period_end: datetime
    charge_category: str
    service_name: str
    service_category: str
    billed_cost: Decimal
    effective_cost: Decimal
    billing_currency: str
    consumed_quantity: float | None
    consumed_unit: str | None
    region_id: str | None
    region_name: str | None
    project_id: str | None
    project_name: str | None
    tags: dict[str, str] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def day(self) -> date:
        """UTC calendar day the charge falls on (buckets are daily)."""
        return self.charge_period_start.astimezone(timezone.utc).date()


class VercelBillingError(RuntimeError):
    """Raised when the Billing API returns an unrecoverable error."""


class VercelBillingClient:
    """Thin async client around the FOCUS billing endpoint.

    Only reads are supported. The bearer token needs one of the team roles the
    endpoint requires (Owner, Member, Developer, Security, Billing, Enterprise
    Viewer) for the supplied team.
    """

    def __init__(
        self,
        api_token: str,
        team_id: str | None = None,
        team_slug: str | None = None,
        http_timeout: float = 60.0,
    ) -> None:
        if not api_token:
            raise ValueError("api_token is required")
        self._api_token = api_token
        self._team_id = (team_id or "").strip() or None
        self._team_slug = (team_slug or "").strip() or None
        self._http_timeout = http_timeout
        self._call_count = 0

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset_call_count(self) -> None:
        self._call_count = 0

    async def fetch_charges(self, from_d: date, to_d: date) -> list[FocusCharge]:
        """Return all FOCUS charges whose day is within ``[from_d, to_d]``.

        ``from`` is inclusive and ``to`` is exclusive on the Vercel side, so we
        query ``[from_d 00:00Z, (to_d + 1 day) 00:00Z)`` to cover ``to_d`` fully.
        """
        params: dict[str, Any] = {
            "from": _to_iso(from_d),
            "to": _to_iso(to_d + timedelta(days=1)),
        }
        if self._team_id:
            params["teamId"] = self._team_id
        if self._team_slug:
            params["slug"] = self._team_slug

        body = await self._request_with_retries(CHARGES_PATH, params)
        charges = _parse_jsonl(body)
        logger.debug(
            "vercel_billing_fetch from=%s to=%s lines=%d",
            from_d.isoformat(),
            to_d.isoformat(),
            len(charges),
        )
        return charges

    async def _request_with_retries(
        self, path: str, params: dict[str, Any]
    ) -> str:
        attempt = 0
        headers = {
            "Authorization": f"Bearer {self._api_token}",
            # httpx transparently decompresses gzip, so asking for it keeps the
            # (potentially large) JSONL payload small on the wire.
            "Accept-Encoding": "gzip",
            "Accept": "application/jsonl",
        }
        async with httpx.AsyncClient(
            base_url=BASE_URL, timeout=self._http_timeout, headers=headers
        ) as client:
            while True:
                attempt += 1
                self._call_count += 1
                t0 = time.monotonic()
                try:
                    response = await client.get(path, params=params)
                    duration_ms = int((time.monotonic() - t0) * 1000)
                    logger.debug(
                        "vercel_api_call path=%s status=%s duration_ms=%s",
                        path,
                        response.status_code,
                        duration_ms,
                    )
                    if response.status_code == 429 or 500 <= response.status_code < 600:
                        if attempt >= MAX_RETRIES:
                            raise VercelBillingError(
                                f"Billing API {path} failed after {attempt} attempts: "
                                f"status={response.status_code} body={response.text[:300]}"
                            )
                        delay = _retry_delay(response, attempt)
                        logger.warning(
                            "vercel_api_retry path=%s status=%s attempt=%d sleep=%.2fs",
                            path,
                            response.status_code,
                            attempt,
                            delay,
                        )
                        await asyncio.sleep(delay)
                        continue
                    if response.status_code >= 400:
                        raise VercelBillingError(
                            f"Billing API {path} returned {response.status_code}: "
                            f"{response.text[:500]}"
                        )
                    return response.text
                except httpx.TimeoutException as exc:
                    if attempt >= MAX_RETRIES:
                        raise VercelBillingError(
                            f"Billing API {path} timed out after {attempt} attempts"
                        ) from exc
                    delay = _retry_delay(None, attempt)
                    logger.warning(
                        "vercel_api_timeout path=%s attempt=%d sleep=%.2fs",
                        path,
                        attempt,
                        delay,
                    )
                    await asyncio.sleep(delay)


def _parse_jsonl(body: str) -> list[FocusCharge]:
    import json

    charges: list[FocusCharge] = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            record = json.loads(stripped)
        except json.JSONDecodeError:
            logger.warning("vercel_billing_skip_bad_line line=%s", stripped[:120])
            continue
        if not isinstance(record, dict):
            continue
        charges.append(_charge_from_record(record))
    return charges


def _charge_from_record(record: dict[str, Any]) -> FocusCharge:
    tags_raw = record.get("Tags")
    tags: dict[str, str] = {}
    if isinstance(tags_raw, dict):
        tags = {str(k): str(v) for k, v in tags_raw.items() if v is not None}
    return FocusCharge(
        charge_period_start=_parse_iso(record.get("ChargePeriodStart")),
        charge_period_end=_parse_iso(record.get("ChargePeriodEnd")),
        charge_category=str(record.get("ChargeCategory") or "Usage"),
        service_name=str(record.get("ServiceName") or "Outros"),
        service_category=str(record.get("ServiceCategory") or "Other"),
        billed_cost=_to_decimal(record.get("BilledCost")),
        effective_cost=_to_decimal(record.get("EffectiveCost")),
        billing_currency=str(record.get("BillingCurrency") or "USD"),
        consumed_quantity=_to_float(record.get("ConsumedQuantity")),
        consumed_unit=_clean(record.get("ConsumedUnit")),
        region_id=_clean(record.get("RegionId")),
        region_name=_clean(record.get("RegionName")),
        project_id=_clean(tags.get("ProjectId")),
        project_name=_clean(tags.get("ProjectName")),
        tags=tags,
        raw=record,
    )


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


def _to_iso(d: date) -> str:
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def _parse_iso(raw: Any) -> datetime:
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    if not raw:
        return datetime.now(timezone.utc)
    text = str(raw).replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return datetime.now(timezone.utc)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _to_decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0")


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def _clean(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
