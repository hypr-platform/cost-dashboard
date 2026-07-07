"""Serviço do dashboard de custo da Vercel.

Consome a Billing API da Vercel (`GET /v1/billing/charges`, formato FOCUS v1.3)
para o intervalo pedido e agrega os charges em várias dimensões: por serviço,
por projeto, por região, por categoria de cobrança e por dia. Custo em USD
(moeda nativa da fatura) convertido para BRL pela cotação PTAX do dia final.

Pipeline em duas etapas, deliberadamente separadas (SRP):
  1. `_accumulate` — domínio puro: soma os charges em USD/Decimal, clipando ao
     intervalo pedido. Não conhece câmbio nem formatação.
  2. `_build_response` — apresentação: converte para BRL, quantiza, ordena e
     calcula participações, montando o DTO de resposta.

Cache em memória com TTL (via `cost_common.TTLCache`, igual às abas BigQuery/
Notas Fiscais). A integração só fica ativa quando `VERCEL_API_TOKEN` está
configurado; caso contrário `is_enabled()` retorna False e a rota responde 503.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
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
from backend.services.cost_common import TTLCache, env_int, resolve_window
from backend.services.exchange_rate import get_exchange_rate

logger = logging.getLogger(__name__)

DEFAULT_CACHE_TTL = 1800
DEFAULT_MAX_RANGE_DAYS = 366  # a Billing API suporta até 1 ano
CENTS = Decimal("0.01")
UNNAMED_PROJECT = "Conta / sem projeto"


# ── Configuração ──────────────────────────────────────────────────────────


def is_enabled() -> bool:
    return bool(_api_token())


def _api_token() -> str:
    return (os.getenv("VERCEL_API_TOKEN") or "").strip()


def _team_id() -> str | None:
    return (os.getenv("VERCEL_TEAM_ID") or "").strip() or None


def _team_slug() -> str | None:
    return (os.getenv("VERCEL_TEAM_SLUG") or "").strip() or None


def _cache_ttl() -> int:
    return env_int("VERCEL_COST_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL)


def _max_range_days() -> int:
    return env_int("VERCEL_COST_MAX_RANGE_DAYS", DEFAULT_MAX_RANGE_DAYS, minimum=1)


_cache: TTLCache[VercelCostResponse] = TTLCache(_cache_ttl)


def clear_cache() -> None:
    _cache.clear()


# ── Orquestração ──────────────────────────────────────────────────────────


async def build_dashboard(
    from_str: str | None,
    to_str: str | None,
    use_cache: bool = True,
) -> VercelCostResponse:
    if not is_enabled():
        raise RuntimeError(
            "Integração Vercel desabilitada (VERCEL_API_TOKEN ausente)."
        )

    from_d, to_d = resolve_window(from_str, to_str, max_days=_max_range_days())
    cache_key = f"{from_d.isoformat()}|{to_d.isoformat()}"
    if use_cache:
        cached = _cache.get(cache_key)
        if cached is not None:
            return cached.model_copy(update={"cached": True})

    client = VercelBillingClient(
        api_token=_api_token(),
        team_id=_team_id(),
        team_slug=_team_slug(),
    )
    charges = await client.fetch_charges(from_d, to_d)

    rate = get_exchange_rate(to_d)
    buckets = _accumulate(charges, from_d, to_d)
    response = _build_response(buckets, from_d, to_d, rate)
    _cache.put(cache_key, response)
    return response


# ── Etapa 1: agregação (domínio puro, USD/Decimal) ─────────────────────────


@dataclass
class _ServiceAcc:
    service_name: str
    service_category: str
    billed: Decimal = Decimal("0")
    effective: Decimal = Decimal("0")
    quantity: float = 0.0
    unit: str | None = None
    has_quantity: bool = False


@dataclass
class _ProjectAcc:
    project_name: str
    project_id: str | None = None
    billed: Decimal = Decimal("0")
    effective: Decimal = Decimal("0")


@dataclass
class _Buckets:
    total_billed: Decimal = Decimal("0")
    total_effective: Decimal = Decimal("0")
    by_service: dict[tuple[str, str], _ServiceAcc] = field(default_factory=dict)
    by_project: dict[str, _ProjectAcc] = field(default_factory=dict)
    by_region: dict[str, Decimal] = field(default_factory=dict)
    by_category: dict[str, Decimal] = field(default_factory=dict)
    daily_billed: dict[date, Decimal] = field(default_factory=dict)
    daily_effective: dict[date, Decimal] = field(default_factory=dict)
    daily_category: dict[tuple[date, str], Decimal] = field(default_factory=dict)


def _accumulate(
    charges: Iterable[FocusCharge], from_d: date, to_d: date
) -> _Buckets:
    """Soma os charges (USD) nas várias dimensões, clipando ao intervalo.

    A Vercel define o "dia" de cobrança em fuso do Pacífico (período
    `[dia 07:00Z, dia+1 07:00Z)`). Como consultamos a janela em meia-noite UTC,
    a Billing API devolve por sobreposição o dia Pacífico anterior a `from_d`.
    `charge.day` (data UTC do ChargePeriodStart) já é o dia-calendário do
    Pacífico; basta clipar ao intervalo pedido para não exibir bordas fora dele.
    """
    b = _Buckets()
    for charge in charges:
        if charge.day < from_d or charge.day > to_d:
            continue

        b.total_billed += charge.billed_cost
        b.total_effective += charge.effective_cost

        svc_key = (charge.service_name, charge.service_category)
        svc = b.by_service.get(svc_key)
        if svc is None:
            svc = _ServiceAcc(charge.service_name, charge.service_category)
            b.by_service[svc_key] = svc
        svc.billed += charge.billed_cost
        svc.effective += charge.effective_cost
        if charge.consumed_quantity is not None:
            svc.quantity += charge.consumed_quantity
            svc.has_quantity = True
            if not svc.unit:
                svc.unit = charge.consumed_unit

        proj_name = charge.project_name or UNNAMED_PROJECT
        proj = b.by_project.get(proj_name)
        if proj is None:
            proj = _ProjectAcc(proj_name, project_id=charge.project_id)
            b.by_project[proj_name] = proj
        proj.billed += charge.billed_cost
        proj.effective += charge.effective_cost

        region = charge.region_name or charge.region_id
        if region:
            b.by_region[region] = b.by_region.get(region, Decimal("0")) + charge.billed_cost

        b.by_category[charge.charge_category] = (
            b.by_category.get(charge.charge_category, Decimal("0")) + charge.billed_cost
        )

        day = charge.day
        b.daily_billed[day] = b.daily_billed.get(day, Decimal("0")) + charge.billed_cost
        b.daily_effective[day] = (
            b.daily_effective.get(day, Decimal("0")) + charge.effective_cost
        )
        cat_key = (day, charge.service_category)
        b.daily_category[cat_key] = (
            b.daily_category.get(cat_key, Decimal("0")) + charge.billed_cost
        )

    return b


# ── Etapa 2: montagem do DTO (apresentação: BRL, quantização, ordenação) ────


def _q(value: Decimal) -> Decimal:
    return value.quantize(CENTS)


def _pct(part: Decimal, whole: Decimal) -> Decimal:
    if whole == 0:
        return Decimal("0.00")
    return (part / whole * Decimal("100")).quantize(CENTS)


def _build_response(
    b: _Buckets, from_d: date, to_d: date, rate: Decimal
) -> VercelCostResponse:
    def to_brl(usd: Decimal) -> Decimal:
        return _q(usd * rate)

    def share(part: Decimal) -> Decimal:
        return _pct(part, b.total_billed)

    services = sorted(
        (
            VercelServiceRow(
                service_name=svc.service_name,
                service_category=svc.service_category,
                billed_usd=_q(svc.billed),
                billed_brl=to_brl(svc.billed),
                effective_usd=_q(svc.effective),
                effective_brl=to_brl(svc.effective),
                consumed_quantity=svc.quantity if svc.has_quantity else None,
                consumed_unit=svc.unit,
                share_pct=share(svc.billed),
            )
            for svc in b.by_service.values()
        ),
        key=lambda r: r.billed_usd,
        reverse=True,
    )

    projects = sorted(
        (
            VercelProjectRow(
                project_id=proj.project_id,
                project_name=proj.project_name,
                billed_usd=_q(proj.billed),
                billed_brl=to_brl(proj.billed),
                effective_usd=_q(proj.effective),
                effective_brl=to_brl(proj.effective),
                share_pct=share(proj.billed),
            )
            for proj in b.by_project.values()
        ),
        key=lambda r: r.billed_usd,
        reverse=True,
    )

    regions = sorted(
        (
            VercelRegionRow(
                region=region,
                billed_usd=_q(value),
                billed_brl=to_brl(value),
                share_pct=share(value),
            )
            for region, value in b.by_region.items()
        ),
        key=lambda r: r.billed_usd,
        reverse=True,
    )

    categories = sorted(
        (
            VercelChargeCategoryRow(
                category=category,
                billed_usd=_q(value),
                billed_brl=to_brl(value),
                share_pct=share(value),
            )
            for category, value in b.by_category.items()
        ),
        key=lambda r: r.billed_usd,
        reverse=True,
    )

    daily = [
        VercelDailyRow(
            day=day,
            billed_usd=_q(b.daily_billed[day]),
            billed_brl=to_brl(b.daily_billed[day]),
            effective_usd=_q(b.daily_effective.get(day, Decimal("0"))),
            effective_brl=to_brl(b.daily_effective.get(day, Decimal("0"))),
        )
        for day in sorted(b.daily_billed.keys())
    ]

    daily_by_category = [
        VercelCategoryDailyPoint(
            day=day,
            category=category,
            billed_usd=_q(value),
            billed_brl=to_brl(value),
        )
        for (day, category), value in sorted(
            b.daily_category.items(), key=lambda kv: (kv[0][0], kv[0][1])
        )
    ]

    # Categorias de serviço ordenadas por custo total (para o gráfico empilhado).
    cat_totals: dict[str, Decimal] = {}
    for (_day, category), value in b.daily_category.items():
        cat_totals[category] = cat_totals.get(category, Decimal("0")) + value
    service_categories = [
        c for c, _ in sorted(cat_totals.items(), key=lambda kv: kv[1], reverse=True)
    ]

    return VercelCostResponse(
        from_date=from_d,
        to_date=to_d,
        currency="USD",
        exchange_rate=rate,
        total_billed_usd=_q(b.total_billed),
        total_billed_brl=to_brl(b.total_billed),
        total_effective_usd=_q(b.total_effective),
        total_effective_brl=to_brl(b.total_effective),
        total_cost_usd=_q(b.total_billed),
        total_cost_brl=to_brl(b.total_billed),
        usage_billed_brl=to_brl(b.by_category.get("Usage", Decimal("0"))),
        credits_billed_brl=to_brl(b.by_category.get("Credit", Decimal("0"))),
        tax_billed_brl=to_brl(b.by_category.get("Tax", Decimal("0"))),
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
