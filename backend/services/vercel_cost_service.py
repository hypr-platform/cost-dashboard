"""Serviço do dashboard de custo da Vercel.

Consome a Billing API da Vercel (`GET /v1/billing/charges`, formato FOCUS v1.3)
para o intervalo pedido e agrega os charges em várias dimensões: por serviço,
por projeto, por região, por categoria de cobrança e por dia. Custo em USD
(moeda nativa da fatura) convertido para BRL pela cotação PTAX do dia final.

Cache em memória com TTL (igual às abas BigQuery/Notas Fiscais). A integração só
fica ativa quando `VERCEL_API_TOKEN` está configurado; caso contrário `is_enabled()`
retorna False e a rota responde 503.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Iterable

from backend.integrations.vercel_billing import FocusCharge, VercelBillingClient
from backend.models.vercel_cost import (
    VercelCategoryDailyPoint,
    VercelChargeCategoryRow,
    VercelCostResponse,
    VercelDailyRow,
    VercelProjectRow,
    VercelRegionRow,
    VercelServiceRow,
)
from backend.services.exchange_rate import get_exchange_rate

logger = logging.getLogger(__name__)

DEFAULT_CACHE_TTL = 1800
DEFAULT_MAX_RANGE_DAYS = 366  # a Billing API suporta até 1 ano
CENTS = Decimal("0.01")
UNNAMED_PROJECT = "Conta / sem projeto"


def is_enabled() -> bool:
    return bool(_api_token())


def _api_token() -> str:
    return (os.getenv("VERCEL_API_TOKEN") or "").strip()


def _team_id() -> str | None:
    return (os.getenv("VERCEL_TEAM_ID") or "").strip() or None


def _team_slug() -> str | None:
    return (os.getenv("VERCEL_TEAM_SLUG") or "").strip() or None


def _cache_ttl() -> int:
    raw = (os.getenv("VERCEL_COST_CACHE_TTL_SECONDS") or "").strip()
    try:
        return max(0, int(raw)) if raw else DEFAULT_CACHE_TTL
    except ValueError:
        return DEFAULT_CACHE_TTL


def _max_range_days() -> int:
    raw = (os.getenv("VERCEL_COST_MAX_RANGE_DAYS") or "").strip()
    try:
        return max(1, int(raw)) if raw else DEFAULT_MAX_RANGE_DAYS
    except ValueError:
        return DEFAULT_MAX_RANGE_DAYS


_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, VercelCostResponse]] = {}


def _cache_get(key: str) -> VercelCostResponse | None:
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


def _cache_put(key: str, payload: VercelCostResponse) -> None:
    if _cache_ttl() <= 0:
        return
    with _cache_lock:
        _cache[key] = (time.time(), payload)


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _parse_date(value: str | None, *, field: str) -> date:
    if not value:
        raise ValueError(f"`{field}` é obrigatório (YYYY-MM-DD).")
    try:
        return date.fromisoformat(value.strip())
    except ValueError as exc:
        raise ValueError(f"`{field}` deve estar no formato YYYY-MM-DD.") from exc


def _resolve_window(from_str: str | None, to_str: str | None) -> tuple[date, date]:
    from_d = _parse_date(from_str, field="from")
    to_d = _parse_date(to_str, field="to")
    if from_d > to_d:
        raise ValueError("`from` deve ser anterior ou igual a `to`.")
    span = (to_d - from_d).days + 1
    if span > _max_range_days():
        raise ValueError(
            f"Intervalo máximo é {_max_range_days()} dias (recebido: {span})."
        )
    return from_d, to_d


def _q(value: Decimal) -> Decimal:
    return value.quantize(CENTS)


def _pct(part: Decimal, whole: Decimal) -> Decimal:
    if whole == 0:
        return Decimal("0.00")
    return (part / whole * Decimal("100")).quantize(CENTS)


async def build_dashboard(
    from_str: str | None,
    to_str: str | None,
    use_cache: bool = True,
) -> VercelCostResponse:
    if not is_enabled():
        raise RuntimeError(
            "Integração Vercel desabilitada (VERCEL_API_TOKEN ausente)."
        )

    from_d, to_d = _resolve_window(from_str, to_str)
    cache_key = f"{from_d.isoformat()}|{to_d.isoformat()}"
    if use_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached.model_copy(update={"cached": True})

    client = VercelBillingClient(
        api_token=_api_token(),
        team_id=_team_id(),
        team_slug=_team_slug(),
    )
    charges = await client.fetch_charges(from_d, to_d)

    rate = get_exchange_rate(to_d)
    response = _aggregate(charges, from_d, to_d, rate)
    _cache_put(cache_key, response)
    return response


def _aggregate(
    charges: Iterable[FocusCharge],
    from_d: date,
    to_d: date,
    rate: Decimal,
) -> VercelCostResponse:
    def to_brl(usd: Decimal) -> Decimal:
        return _q(usd * rate)

    total_billed = Decimal("0")
    total_effective = Decimal("0")

    by_service: dict[tuple[str, str], dict[str, object]] = {}
    by_project: dict[str, dict[str, object]] = {}
    by_region: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    by_category: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    daily_billed: dict[date, Decimal] = defaultdict(lambda: Decimal("0"))
    daily_effective: dict[date, Decimal] = defaultdict(lambda: Decimal("0"))
    daily_cat: dict[tuple[date, str], Decimal] = defaultdict(lambda: Decimal("0"))

    for charge in charges:
        billed = charge.billed_cost
        effective = charge.effective_cost
        total_billed += billed
        total_effective += effective

        # Por serviço (nome + categoria FOCUS).
        svc_key = (charge.service_name, charge.service_category)
        svc = by_service.get(svc_key)
        if svc is None:
            svc = {
                "billed": Decimal("0"),
                "effective": Decimal("0"),
                "quantity": 0.0,
                "unit": charge.consumed_unit,
            }
            by_service[svc_key] = svc
        svc["billed"] = svc["billed"] + billed  # type: ignore[operator]
        svc["effective"] = svc["effective"] + effective  # type: ignore[operator]
        if charge.consumed_quantity is not None:
            svc["quantity"] = float(svc["quantity"]) + charge.consumed_quantity  # type: ignore[arg-type]
            if not svc["unit"]:
                svc["unit"] = charge.consumed_unit

        # Por projeto.
        proj_name = charge.project_name or UNNAMED_PROJECT
        proj = by_project.get(proj_name)
        if proj is None:
            proj = {
                "project_id": charge.project_id,
                "billed": Decimal("0"),
                "effective": Decimal("0"),
            }
            by_project[proj_name] = proj
        proj["billed"] = proj["billed"] + billed  # type: ignore[operator]
        proj["effective"] = proj["effective"] + effective  # type: ignore[operator]

        # Por região (só faz sentido para custo faturado positivo).
        region = charge.region_name or charge.region_id
        if region:
            by_region[region] += billed

        by_category[charge.charge_category] += billed

        day = charge.day
        daily_billed[day] += billed
        daily_effective[day] += effective
        daily_cat[(day, charge.service_category)] += billed

    services = [
        VercelServiceRow(
            service_name=name,
            service_category=category,
            billed_usd=_q(v["billed"]),  # type: ignore[index]
            billed_brl=to_brl(v["billed"]),  # type: ignore[index]
            effective_usd=_q(v["effective"]),  # type: ignore[index]
            effective_brl=to_brl(v["effective"]),  # type: ignore[index]
            consumed_quantity=(v["quantity"] or None),  # type: ignore[index]
            consumed_unit=v["unit"],  # type: ignore[index]
            share_pct=_pct(v["billed"], total_billed),  # type: ignore[arg-type]
        )
        for (name, category), v in by_service.items()
    ]
    services.sort(key=lambda r: r.billed_usd, reverse=True)

    projects = [
        VercelProjectRow(
            project_id=v["project_id"],  # type: ignore[index]
            project_name=name,
            billed_usd=_q(v["billed"]),  # type: ignore[index]
            billed_brl=to_brl(v["billed"]),  # type: ignore[index]
            effective_usd=_q(v["effective"]),  # type: ignore[index]
            effective_brl=to_brl(v["effective"]),  # type: ignore[index]
            share_pct=_pct(v["billed"], total_billed),  # type: ignore[arg-type]
        )
        for name, v in by_project.items()
    ]
    projects.sort(key=lambda r: r.billed_usd, reverse=True)

    regions = [
        VercelRegionRow(
            region=region,
            billed_usd=_q(value),
            billed_brl=to_brl(value),
            share_pct=_pct(value, total_billed),
        )
        for region, value in by_region.items()
    ]
    regions.sort(key=lambda r: r.billed_usd, reverse=True)

    categories = [
        VercelChargeCategoryRow(
            category=category,
            billed_usd=_q(value),
            billed_brl=to_brl(value),
            share_pct=_pct(value, total_billed),
        )
        for category, value in by_category.items()
    ]
    categories.sort(key=lambda r: r.billed_usd, reverse=True)

    daily = [
        VercelDailyRow(
            day=day,
            billed_usd=_q(daily_billed[day]),
            billed_brl=to_brl(daily_billed[day]),
            effective_usd=_q(daily_effective[day]),
            effective_brl=to_brl(daily_effective[day]),
        )
        for day in sorted(daily_billed.keys())
    ]

    daily_by_category = [
        VercelCategoryDailyPoint(
            day=day,
            category=category,
            billed_usd=_q(value),
            billed_brl=to_brl(value),
        )
        for (day, category), value in sorted(
            daily_cat.items(), key=lambda kv: (kv[0][0], kv[0][1])
        )
    ]

    # Categorias de serviço ordenadas por custo total (para o gráfico empilhado).
    cat_totals: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    for (_day, category), value in daily_cat.items():
        cat_totals[category] += value
    service_categories = [
        c for c, _ in sorted(cat_totals.items(), key=lambda kv: kv[1], reverse=True)
    ]

    usage_billed = by_category.get("Usage", Decimal("0"))
    credits_billed = by_category.get("Credit", Decimal("0"))
    tax_billed = by_category.get("Tax", Decimal("0"))

    return VercelCostResponse(
        from_date=from_d,
        to_date=to_d,
        currency="USD",
        exchange_rate=rate,
        total_billed_usd=_q(total_billed),
        total_billed_brl=to_brl(total_billed),
        total_effective_usd=_q(total_effective),
        total_effective_brl=to_brl(total_effective),
        total_cost_usd=_q(total_billed),
        total_cost_brl=to_brl(total_billed),
        usage_billed_brl=to_brl(usage_billed),
        credits_billed_brl=to_brl(credits_billed),
        tax_billed_brl=to_brl(tax_billed),
        projects_count=len(projects),
        services_count=len(services),
        by_service=services,
        by_project=projects,
        by_region=regions,
        by_charge_category=categories,
        daily=daily,
        daily_by_category=daily_by_category,
        service_categories=service_categories,
        cached=False,
        fetched_at=datetime.now(timezone.utc).isoformat(),
    )
