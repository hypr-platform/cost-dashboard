"""USD -> BRL exchange rate resolution with per-date caching.

Source is configurable via USD_BRL_RATE_SOURCE (`ptax` or `fixed`). PTAX is
queried via the public Banco Central endpoint with a fallback to the configured
fixed rate when a specific date has no quote (weekends, holidays, network failure).
"""

from __future__ import annotations

import logging
import os
import threading
from datetime import date, timedelta
from decimal import Decimal
from typing import Final

import requests

logger = logging.getLogger(__name__)

DEFAULT_FIXED_RATE: Final[Decimal] = Decimal("4.92")
PTAX_URL = (
    "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/"
    "CotacaoDolarDia(dataCotacao=@dataCotacao)"
)
HTTP_TIMEOUT_SECONDS = 8.0

_cache: dict[date, Decimal] = {}
_cache_lock = threading.Lock()


def _source() -> str:
    return (os.getenv("USD_BRL_RATE_SOURCE", "ptax") or "ptax").strip().lower()


def _fixed_rate() -> Decimal:
    raw = (os.getenv("USD_BRL_RATE_FIXED", "") or "").strip()
    if not raw:
        return DEFAULT_FIXED_RATE
    try:
        return Decimal(raw)
    except Exception:
        return DEFAULT_FIXED_RATE


def _query_ptax(ref: date) -> Decimal | None:
    params = {
        "@dataCotacao": f"'{ref.strftime('%m-%d-%Y')}'",
        "$top": 1,
        "$format": "json",
        "$select": "cotacaoVenda",
    }
    try:
        resp = requests.get(PTAX_URL, params=params, timeout=HTTP_TIMEOUT_SECONDS)
        resp.raise_for_status()
        values = resp.json().get("value") or []
        if values:
            return Decimal(str(values[0]["cotacaoVenda"]))
    except Exception:
        return None
    return None


def get_exchange_rate(reference_date: date) -> Decimal:
    """Return the USD->BRL rate for the given date.

    Falls back to the most recent available PTAX quote (up to 7 calendar days
    earlier) and finally to the fixed rate when nothing else is available.
    """
    with _cache_lock:
        cached = _cache.get(reference_date)
        if cached is not None:
            return cached

    if _source() == "fixed":
        rate = _fixed_rate()
        with _cache_lock:
            _cache[reference_date] = rate
        return rate

    for delta in range(0, 7):
        candidate = reference_date - timedelta(days=delta)
        rate = _query_ptax(candidate)
        if rate is not None:
            with _cache_lock:
                _cache[reference_date] = rate
            return rate

    fallback = _fixed_rate()
    logger.warning(
        "exchange_rate_fallback date=%s rate=%s reason=ptax_unavailable",
        reference_date.isoformat(),
        fallback,
    )
    with _cache_lock:
        _cache[reference_date] = fallback
    return fallback


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()
