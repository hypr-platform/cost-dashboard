"""Leituras analíticas em BigQuery pra alimentar o dashboard (Fase 4).

Separa READS de WRITES (que ficam em `bigquery_store.py`). Cada função retorna
uma estrutura Python pura, sem dependência de Pydantic ou modelos do app.

Cache de 30s em memória (não dura mais que 1 ciclo de refresh do cron).
"""

from __future__ import annotations

import threading
import time
from datetime import date
from typing import Any

from google.cloud import bigquery

from backend import bigquery_store

_CACHE_TTL_SECONDS = 30.0
_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, Any]] = {}


def _fqn(table: str) -> str:
    return f"`{bigquery_store._project_id()}.{bigquery_store._dataset_id()}.{table}`"


def _cached(key: str, fetcher) -> Any:
    """Cache simples thread-safe com TTL de 30s."""
    now = time.time()
    with _cache_lock:
        if key in _cache:
            ts, value = _cache[key]
            if now - ts < _CACHE_TTL_SECONDS:
                return value
    value = fetcher()
    with _cache_lock:
        _cache[key] = (now, value)
    return value


def invalidate_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _params(**kwargs) -> list[bigquery.ScalarQueryParameter]:
    out = []
    for k, v in kwargs.items():
        if isinstance(v, date):
            out.append(bigquery.ScalarQueryParameter(k, "DATE", v.isoformat()))
        elif isinstance(v, int):
            out.append(bigquery.ScalarQueryParameter(k, "INT64", v))
        elif isinstance(v, float):
            out.append(bigquery.ScalarQueryParameter(k, "FLOAT64", v))
        else:
            out.append(bigquery.ScalarQueryParameter(k, "STRING", str(v) if v is not None else None))
    return out


# Predicado SQL que inclui daily rows do período + monthly_imputed do mês todo.
# Granularity NULL é tratado como 'daily' (rows legadas pre-Fase 1).
_PERIOD_PREDICATE = """(
  (cost_date BETWEEN @period_start AND @period_end
    AND (granularity IS NULL OR granularity = 'daily'))
  OR
  (granularity = 'monthly_imputed'
    AND cost_date BETWEEN @period_start AND LAST_DAY(@period_end, MONTH))
)"""


def total_brl(period_start: date, period_end: date) -> float:
    """SUM(spend_brl_delta) cobrindo daily + monthly_imputed do mês.

    Daily rows: filtradas por cost_date <= period_end.
    Monthly_imputed (Hivestack, Nexd): incluídas se cost_date <= last_day_of_month(period_end).
    """
    def _q():
        client = bigquery_store._get_client()
        sql = f"""
            SELECT COALESCE(SUM(spend_brl_delta), 0.0) AS total
            FROM {_fqn('line_costs')}
            WHERE {_PERIOD_PREDICATE}
        """
        cfg = bigquery.QueryJobConfig(
            query_parameters=_params(period_start=period_start, period_end=period_end)
        )
        row = next(client.query(sql, job_config=cfg).result())
        return float(row.total or 0.0)
    return _cached(f"total_brl:{period_start}:{period_end}", _q)


def spend_by_platform(period_start: date, period_end: date) -> list[dict[str, Any]]:
    """[{platform, spend_brl}, ...] no período. Inclui monthly_imputed do mês todo."""
    def _q():
        client = bigquery_store._get_client()
        sql = f"""
            SELECT platform, ROUND(SUM(spend_brl_delta), 2) AS spend_brl
            FROM {_fqn('line_costs')}
            WHERE {_PERIOD_PREDICATE}
            GROUP BY platform
            HAVING spend_brl > 0
            ORDER BY spend_brl DESC
        """
        cfg = bigquery.QueryJobConfig(
            query_parameters=_params(period_start=period_start, period_end=period_end)
        )
        return [
            {"platform": r.platform, "spend_brl": float(r.spend_brl or 0.0)}
            for r in client.query(sql, job_config=cfg).result()
        ]
    return _cached(f"spend_by_platform:{period_start}:{period_end}", _q)


def daily_by_platform(period_start: date, period_end: date) -> list[dict[str, Any]]:
    """[{date, <platform1>: brl, <platform2>: brl, ..., total: brl}, ...] ordenado por cost_date.

    Pivot lateral em Python — facilita lidar com platforms variáveis.
    """
    def _q():
        client = bigquery_store._get_client()
        sql = f"""
            SELECT cost_date, platform, ROUND(SUM(spend_brl_delta), 2) AS spend
            FROM {_fqn('line_costs')}
            WHERE cost_date BETWEEN @period_start AND @period_end
            GROUP BY cost_date, platform
        """
        cfg = bigquery.QueryJobConfig(
            query_parameters=_params(period_start=period_start, period_end=period_end)
        )
        by_date: dict[str, dict[str, Any]] = {}
        for r in client.query(sql, job_config=cfg).result():
            d = r.cost_date.isoformat()
            slot = by_date.setdefault(d, {"date": d, "total": 0.0})
            slot[r.platform] = float(r.spend or 0.0)
            slot["total"] += float(r.spend or 0.0)
        return [by_date[k] for k in sorted(by_date.keys())]
    return _cached(f"daily_by_platform:{period_start}:{period_end}", _q)


def exchange_rate_for_date(target: date) -> float | None:
    """Retorna fx_usd_brl de `target` (ou None se não houver)."""
    def _q():
        client = bigquery_store._get_client()
        sql = f"""
            SELECT fx_usd_brl FROM {_fqn('dim_fx_daily')}
            WHERE cost_date = @cost_date LIMIT 1
        """
        cfg = bigquery.QueryJobConfig(
            query_parameters=_params(cost_date=target)
        )
        rows = list(client.query(sql, job_config=cfg).result())
        return float(rows[0].fx_usd_brl) if rows else None
    return _cached(f"fx:{target}", _q)


def campaign_journey_rows(
    period_start: date, period_end: date, active_platforms: list[str]
) -> list[dict[str, Any]]:
    """Lista de campanhas com gasto no período, enriquecida via dim_campaign.

    Replica o shape do `dashboard.campaign_journey_rows` produzido pelo
    `_build_payload`:
      - 1 row por token com gasto > 0
      - `investido` é o INVESTIDO TOTAL rateado pelo período (linear por dias
        de vigência), conforme `_invested_for_selected_period`
      - `total_plataformas` é SUM por plataforma
      - cada platform vira coluna com gasto
    """
    def _q():
        client = bigquery_store._get_client()
        plats_list = ", ".join(f"@p_{i}" for i in range(len(active_platforms)))
        plat_params = [
            bigquery.ScalarQueryParameter(f"p_{i}", "STRING", p)
            for i, p in enumerate(active_platforms)
        ]
        # SUM per (token, platform) usando o predicate do mês.
        sql = f"""
            WITH lc AS (
              SELECT resolved_token AS token, platform,
                     SUM(spend_brl_delta) AS spend
              FROM {_fqn('line_costs')}
              WHERE {_PERIOD_PREDICATE}
                AND resolved_token IS NOT NULL
              GROUP BY token, platform
            ),
            tokens_with_spend AS (
              SELECT token, SUM(spend) AS total_plataformas
              FROM lc GROUP BY token HAVING total_plataformas > 0
            ),
            pivot_spend AS (
              SELECT token,
                {", ".join(
                    f"COALESCE(SUM(IF(platform = @p_{i}, spend, 0)), 0.0) AS p_{i}"
                    for i in range(len(active_platforms))
                ) or "0 AS noop"}
              FROM lc GROUP BY token
            )
            SELECT
              t.token,
              d.cliente,
              d.campanha,
              d.account_management,
              d.produto,
              d.campaign_start,
              d.campaign_end,
              d.status,
              d.investido_brl,
              t.total_plataformas,
              p.* EXCEPT (token)
            FROM tokens_with_spend t
            LEFT JOIN {_fqn('dim_campaign')} d ON t.token = d.token
            LEFT JOIN pivot_spend p ON t.token = p.token
            ORDER BY t.total_plataformas DESC
        """
        cfg = bigquery.QueryJobConfig(query_parameters=[
            *_params(period_start=period_start, period_end=period_end),
            *plat_params,
        ])
        rows = []
        for r in client.query(sql, job_config=cfg).result():
            # Rateio linear do investido pelo período
            c_start = r.campaign_start
            c_end = r.campaign_end
            inv_total = float(r.investido_brl or 0.0)
            if inv_total <= 0:
                inv_period = 0.0
            elif c_start is None or c_end is None or c_start > c_end:
                inv_period = inv_total
            else:
                cdays = (c_end - c_start).days + 1
                o_start = max(c_start, period_start)
                o_end = min(c_end, period_end)
                odays = max(0, (o_end - o_start).days + 1)
                inv_period = inv_total * odays / cdays if cdays > 0 else 0.0

            total_p = float(r.total_plataformas or 0.0)
            pct = (total_p / inv_period * 100.0) if inv_period > 0 else 0.0
            row: dict[str, Any] = {
                "token": r.token,
                "cliente": r.cliente or "",
                "campanha": r.campanha or "",
                "campaign_start": c_start.isoformat() if c_start else None,
                "campaign_end": c_end.isoformat() if c_end else None,
                "produto_vendido": r.produto or "",
                "account_management": r.account_management or "",
                "status": r.status or "Encerrada",
                "investido": inv_period,
                "total_plataformas": total_p,
                "pct_investido": pct,
            }
            # Adiciona coluna por plataforma
            for i, p in enumerate(active_platforms):
                row[p] = float(getattr(r, f"p_{i}", 0.0) or 0.0)
            rows.append(row)
        return rows
    key = f"journey:{period_start}:{period_end}:{','.join(sorted(active_platforms))}"
    return _cached(key, _q)


def no_token_rows(period_start: date, period_end: date) -> list[dict[str, Any]]:
    """Lines com gasto mas sem `resolved_token`. Agrupa por (platform, line, line_item_id)."""
    def _q():
        client = bigquery_store._get_client()
        sql = f"""
            SELECT platform,
                   line_name AS line,
                   line_item_id,
                   ROUND(SUM(spend_brl_delta), 2) AS gasto
            FROM {_fqn('line_costs')}
            WHERE {_PERIOD_PREDICATE}
              AND resolved_token IS NULL
            GROUP BY platform, line, line_item_id
            HAVING gasto > 0
            ORDER BY gasto DESC
        """
        cfg = bigquery.QueryJobConfig(
            query_parameters=_params(period_start=period_start, period_end=period_end)
        )
        return [
            {
                "platform": r.platform,
                "line": r.line or "",
                "line_item_id": r.line_item_id,
                "gasto": float(r.gasto or 0.0),
            }
            for r in client.query(sql, job_config=cfg).result()
        ]
    return _cached(f"no_token:{period_start}:{period_end}", _q)


def out_of_period_rows(period_start: date, period_end: date) -> list[dict[str, Any]]:
    """Lines com token cuja campanha não tem overlap com [period_start..period_end]."""
    def _q():
        client = bigquery_store._get_client()
        sql = f"""
            WITH lc AS (
              SELECT resolved_token AS token,
                     platform, line_name, line_item_id,
                     SUM(spend_brl_delta) AS gasto
              FROM {_fqn('line_costs')}
              WHERE {_PERIOD_PREDICATE}
                AND resolved_token IS NOT NULL
              GROUP BY token, platform, line_name, line_item_id
            )
            SELECT lc.platform, lc.token, lc.line_name AS line,
                   lc.line_item_id, ROUND(lc.gasto, 2) AS gasto,
                   d.cliente, d.campanha, d.account_management,
                   d.campaign_start AS vigencia_start,
                   d.campaign_end AS vigencia_end
            FROM lc
            JOIN {_fqn('dim_campaign')} d ON lc.token = d.token
            WHERE lc.gasto > 0
              AND ((d.campaign_start IS NOT NULL AND d.campaign_start > @period_end)
                OR (d.campaign_end IS NOT NULL AND d.campaign_end < @period_start))
            ORDER BY lc.gasto DESC
        """
        cfg = bigquery.QueryJobConfig(
            query_parameters=_params(period_start=period_start, period_end=period_end)
        )
        return [
            {
                "platform": r.platform,
                "token": r.token,
                "line": r.line or "",
                "line_item_id": r.line_item_id,
                "gasto": float(r.gasto or 0.0),
                "cliente": r.cliente or "",
                "campanha": r.campanha or "",
                "account_management": r.account_management or "",
                "vigencia_start": r.vigencia_start.isoformat() if r.vigencia_start else None,
                "vigencia_end": r.vigencia_end.isoformat() if r.vigencia_end else None,
            }
            for r in client.query(sql, job_config=cfg).result()
        ]
    return _cached(f"oop:{period_start}:{period_end}", _q)


def _campaign_lines_in_period(
    client, token_upper: str, period_start: date, period_end: date
) -> list[dict[str, Any]]:
    """Helper interno: line_rows pra (token, período)."""
    sql = f"""
        SELECT
          platform,
          line_name AS line,
          line_item_id,
          ROUND(SUM(spend_brl_delta), 2) AS gasto
        FROM {_fqn('line_costs')}
        WHERE resolved_token = @token
          AND {_PERIOD_PREDICATE}
        GROUP BY platform, line, line_item_id
        HAVING gasto > 0
        ORDER BY gasto DESC
    """
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", token_upper),
        *_params(period_start=period_start, period_end=period_end),
    ])
    return [
        {
            "platform": r.platform,
            "line": r.line or "",
            "line_item_id": r.line_item_id,
            "gasto": float(r.gasto or 0.0),
        }
        for r in client.query(sql, job_config=cfg).result()
    ]


def campaign_detail(token: str, period_start: date, period_end: date) -> dict[str, Any]:
    """Detalhe de uma campanha — usado pelo endpoint `/api/campaign/{token}`.

    Shape compatível com o que o front espera:
      { token, period, campaign, line_rows, daily, active_platforms }

    Se o período pedido não tiver gasto mas a campanha existe (em `dim_campaign`),
    **expande automaticamente** pra todo o histórico 2026 — útil quando o user
    clica numa campanha antiga via URL/link.

    Tudo lido de `line_costs` + `dim_campaign`. Sem fan-out.
    """
    def _q():
        client = bigquery_store._get_client()
        token_upper = (token or "").strip().upper()

        # 1. Linhas com gasto desse token no período (com extended-month pra capturar imputed)
        effective_start = period_start
        effective_end = period_end
        line_rows = _campaign_lines_in_period(client, token_upper, effective_start, effective_end)

        # Se vazio, tenta janela ampla (2026 inteiro) — capta campanhas históricas
        if not line_rows:
            wide_start = date(2026, 1, 1)
            wide_end = max(period_end, date.today())
            line_rows = _campaign_lines_in_period(client, token_upper, wide_start, wide_end)
            if line_rows:
                effective_start = wide_start
                effective_end = wide_end

        # 2. Campaign info via dim_campaign + rateio pelo período
        sql_camp = f"""
            SELECT token, cliente, campanha, account_management, status,
                   produto, investido_brl, campaign_start, campaign_end
            FROM {_fqn('dim_campaign')}
            WHERE token = @token LIMIT 1
        """
        cfg_camp = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", token_upper),
        ])
        camp_rows = list(client.query(sql_camp, job_config=cfg_camp).result())

        total_gasto = sum(r["gasto"] for r in line_rows)
        active_platforms = sorted({r["platform"] for r in line_rows})

        # Preenche `cliente`/`campanha` nos line_rows + monta campaign dict
        campaign: dict[str, Any] | None = None
        if camp_rows:
            r = camp_rows[0]
            c_start = r.campaign_start
            c_end = r.campaign_end
            inv_total = float(r.investido_brl or 0.0)
            # Rateio linear
            if inv_total <= 0:
                inv_period = 0.0
            elif c_start is None or c_end is None or c_start > c_end:
                inv_period = inv_total
            else:
                cdays = (c_end - c_start).days + 1
                o_start = max(c_start, effective_start)
                o_end = min(c_end, effective_end)
                odays = max(0, (o_end - o_start).days + 1)
                inv_period = inv_total * odays / cdays if cdays > 0 else 0.0
            pct = (total_gasto / inv_period * 100.0) if inv_period > 0 else 0.0
            campaign = {
                "token": token_upper,
                "cliente": r.cliente or "",
                "campanha": r.campanha or "",
                "account_management": r.account_management or "",
                "status": r.status or "Encerrada",
                "produto_vendido": r.produto or "",
                "campaign_start": c_start.isoformat() if c_start else None,
                "campaign_end": c_end.isoformat() if c_end else None,
                "investido": inv_period,
                "total_plataformas": total_gasto,
                "pct_investido": pct,
            }
            # Anota linha com cliente/campanha/account
            for lr in line_rows:
                lr["cliente"] = r.cliente or ""
                lr["campanha"] = r.campanha or ""
                lr["account_management"] = r.account_management or ""
                lr["investido"] = None  # nivel-line não rateado
                lr["pct_invest"] = None

        # 3. Daily breakdown — usa effective range (pode ter expandido se MTD = vazio)
        sql_daily = f"""
            SELECT cost_date, platform, ROUND(SUM(spend_brl_delta), 2) AS spend
            FROM {_fqn('line_costs')}
            WHERE resolved_token = @token
              AND {_PERIOD_PREDICATE}
            GROUP BY cost_date, platform
            ORDER BY cost_date
        """
        cfg_daily = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", token_upper),
            *_params(period_start=effective_start, period_end=effective_end),
        ])
        by_date: dict[str, dict[str, Any]] = {}
        for r in client.query(sql_daily, job_config=cfg_daily).result():
            d = r.cost_date.isoformat()
            slot = by_date.setdefault(d, {"date": d, "total": 0.0})
            slot[r.platform] = float(r.spend or 0.0)
            slot["total"] += float(r.spend or 0.0)
        daily = [by_date[k] for k in sorted(by_date.keys())]

        return {
            "token": token_upper,
            "period": {"start": effective_start.isoformat(), "end": effective_end.isoformat()},
            "campaign": campaign,
            "line_rows": line_rows,
            "daily": daily,
            "active_platforms": active_platforms,
        }
    return _cached(f"campaign_detail:{token}:{period_start}:{period_end}", _q)


def platform_page_rows(
    platform: str, period_start: date, period_end: date
) -> list[dict[str, Any]]:
    """Linhas detalhadas da DSP page — usado em cold-start pra popular
    `platform_pages[platform].rows`.

    Cada row contém: line, line_item_id, token, cliente, campanha,
    account_management, gasto (BRL), investido (rateado pelo período),
    pct_invest. Shape compatível com o que `_build_payload` produz.
    """
    def _q():
        client = bigquery_store._get_client()
        # JOIN line_costs + dim_campaign. Rateio do investido feito em SQL.
        sql = f"""
            WITH lc AS (
              SELECT
                line_item_id,
                line_name,
                resolved_token,
                ANY_VALUE(token_resolution_source) AS token_resolution_source,
                ROUND(SUM(spend_brl_delta), 2) AS gasto
              FROM {_fqn('line_costs')}
              WHERE platform = @platform AND {_PERIOD_PREDICATE}
              GROUP BY line_item_id, line_name, resolved_token
              HAVING gasto > 0
            ),
            rateio AS (
              SELECT lc.*,
                d.cliente, d.campanha, d.account_management,
                d.campaign_start, d.campaign_end,
                d.investido_brl AS investido_total,
                -- Rateio linear do investido pelo overlap [campaign, período]
                CASE
                  WHEN d.investido_brl IS NULL OR d.investido_brl <= 0 THEN 0.0
                  WHEN d.campaign_start IS NULL OR d.campaign_end IS NULL
                    THEN d.investido_brl
                  WHEN d.campaign_start > d.campaign_end THEN d.investido_brl
                  ELSE d.investido_brl * GREATEST(
                    0,
                    DATE_DIFF(
                      LEAST(d.campaign_end, @period_end),
                      GREATEST(d.campaign_start, @period_start),
                      DAY
                    ) + 1
                  ) / (DATE_DIFF(d.campaign_end, d.campaign_start, DAY) + 1)
                END AS investido_rateado
              FROM lc
              LEFT JOIN {_fqn('dim_campaign')} d ON lc.resolved_token = d.token
            )
            SELECT
              line_item_id,
              line_name,
              resolved_token,
              token_resolution_source,
              gasto,
              cliente, campanha, account_management,
              ROUND(investido_rateado, 2) AS investido,
              CASE
                WHEN investido_rateado > 0 THEN ROUND(gasto / investido_rateado * 100, 2)
                ELSE NULL
              END AS pct_invest
            FROM rateio
            ORDER BY gasto DESC
        """
        cfg = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("platform", "STRING", platform),
            *_params(period_start=period_start, period_end=period_end),
        ])
        rows: list[dict[str, Any]] = []
        for r in client.query(sql, job_config=cfg).result():
            rows.append({
                "line": r.line_name or "",
                "line_item_id": r.line_item_id,
                "token": (r.resolved_token or "—") if r.resolved_token else "—",
                "token_resolution_source": r.token_resolution_source,
                "cliente": r.cliente or "—",
                "campanha": r.campanha or "—",
                "account_management": r.account_management or "—",
                "gasto": float(r.gasto or 0.0),
                "investido": float(r.investido) if r.investido is not None else None,
                "pct_invest": float(r.pct_invest) if r.pct_invest is not None else None,
            })
        return rows
    return _cached(f"plat_page_rows:{platform}:{period_start}:{period_end}", _q)


def platform_data_from_line_costs(
    platform: str, period_start: date, period_end: date
) -> dict[str, Any]:
    """Reconstrói `platform_data` (shape de `platform_results[X]`) a partir de
    `line_costs`. Usado pra reusar DSPs entre cron workers (Fase 5.2) e pra
    cold-start (Fase 5.1) — substitui o reuse via blob snapshot.

    Marca `reused_from_line_costs=True` e `message="..."`.
    Status fica `"ok"` se houver rows; `"stale"` se vazio.
    """
    def _q():
        client = bigquery_store._get_client()
        # Soma agregada por (line) — usa MAX(spend_brl_mtd) por (line) que é
        # o snapshot MTD na última data conhecida pra essa line.
        sql_lines = f"""
            WITH per_line AS (
              SELECT
                line_item_id,
                line_name,
                resolved_token,
                token_resolution_source,
                ANY_VALUE(currency_native) AS currency_native,
                ANY_VALUE(exchange_rate_usd_brl) AS exchange_rate_usd_brl,
                MAX(cost_date) AS max_cost_date,
                ROUND(SUM(spend_brl_delta), 2) AS spend_brl,
                ROUND(SUM(spend_native_delta), 2) AS spend_native
              FROM {_fqn('line_costs')}
              WHERE platform = @platform AND {_PERIOD_PREDICATE}
              GROUP BY line_item_id, line_name, resolved_token, token_resolution_source
              HAVING spend_brl > 0
            )
            SELECT * FROM per_line ORDER BY spend_brl DESC
        """
        cfg = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("platform", "STRING", platform),
            *_params(period_start=period_start, period_end=period_end),
        ])

        lines: list[dict[str, Any]] = []
        currency = "USD"
        for r in client.query(sql_lines, job_config=cfg).result():
            currency = str(r.currency_native or currency)
            # spend que `_build_payload` espera é em currency_native
            spend_native = float(r.spend_native or 0.0) if r.spend_native is not None else float(r.spend_brl or 0.0)
            lines.append({
                "name": r.line_name or "",
                "line_item_id": r.line_item_id,
                "spend": spend_native,
                "resolved_token": r.resolved_token,
                "resolved_line_name": r.line_name or "",
                "token_resolution_source": r.token_resolution_source,
            })

        if not lines:
            return {
                "status": "stale",
                "currency": currency,
                "spend": 0.0,
                "message": f"{platform} sem dados em line_costs no período [{period_start}..{period_end}].",
                "lines": [],
                "daily": [],
                "line_daily": [],
                "reused_from_line_costs": True,
            }

        # Daily totals por dia (em currency native)
        sql_daily = f"""
            SELECT cost_date,
                   ROUND(SUM(spend_native_delta), 2) AS spend_native,
                   ROUND(SUM(spend_brl_delta), 2) AS spend_brl
            FROM {_fqn('line_costs')}
            WHERE platform = @platform AND {_PERIOD_PREDICATE}
            GROUP BY cost_date HAVING spend_brl > 0
            ORDER BY cost_date
        """
        cfg_daily = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("platform", "STRING", platform),
            *_params(period_start=period_start, period_end=period_end),
        ])
        daily = [
            {"date": r.cost_date.isoformat(), "spend": float(r.spend_native or r.spend_brl or 0.0)}
            for r in client.query(sql_daily, job_config=cfg_daily).result()
        ]

        # line_daily — 1 row por (line, day)
        sql_ld = f"""
            SELECT cost_date, line_item_id, line_name,
                   ROUND(SUM(spend_native_delta), 2) AS spend_native,
                   ROUND(SUM(spend_brl_delta), 2) AS spend_brl
            FROM {_fqn('line_costs')}
            WHERE platform = @platform AND {_PERIOD_PREDICATE}
            GROUP BY cost_date, line_item_id, line_name
            HAVING spend_brl > 0
        """
        cfg_ld = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("platform", "STRING", platform),
            *_params(period_start=period_start, period_end=period_end),
        ])
        line_daily = [
            {
                "date": r.cost_date.isoformat(),
                "line_item_id": r.line_item_id,
                "name": r.line_name or "",
                "spend": float(r.spend_native or r.spend_brl or 0.0),
            }
            for r in client.query(sql_ld, job_config=cfg_ld).result()
        ]

        total_native = sum(float(l["spend"] or 0) for l in lines)
        return {
            "status": "ok",
            "currency": currency,
            "spend": total_native,
            "message": f"{platform} reaproveitado de line_costs (sem fan-out neste ciclo).",
            "lines": lines,
            "daily": daily,
            "line_daily": line_daily,
            "reused_from_line_costs": True,
        }
    return _cached(f"plat_reuse:{platform}:{period_start}:{period_end}", _q)


def nexd_snapshot() -> dict[str, Any] | None:
    """Retorna o snapshot mais recente do Nexd (impressões + campaigns + layouts).

    Shape compatível com `payload["nexd"]` esperado pelo front:
      {impressions, cap, campaigns: [...], layouts: [...], status: "ok"|"stale", message}
    """
    def _q():
        import json as _json
        client = bigquery_store._get_client()
        sql = f"""
            SELECT snapshot_at, impressions, cap,
                   TO_JSON_STRING(campaigns_json) AS campaigns_str,
                   TO_JSON_STRING(layouts_json) AS layouts_str
            FROM {_fqn('dim_nexd_snapshot')}
            LIMIT 1
        """
        rows = list(client.query(sql).result())
        if not rows:
            return None
        r = rows[0]
        # campaigns_json é JSON column → TO_JSON_STRING devolve string JSON dupla-encoded
        # Precisamos parsear 2x: 1ª pra unwrap, 2ª pra obter list
        try:
            campaigns = _json.loads(_json.loads(r.campaigns_str or '"[]"'))
        except Exception:
            campaigns = []
        try:
            layouts = _json.loads(_json.loads(r.layouts_str or '"[]"'))
        except Exception:
            layouts = []
        return {
            "impressions": int(r.impressions or 0),
            "cap": int(r.cap or 0),
            "campaigns": campaigns,
            "layouts": layouts,
            "status": "ok",
            "message": "",
            "_snapshot_at": r.snapshot_at.isoformat() if r.snapshot_at else None,
        }
    return _cached("nexd_snapshot", _q)


def dv360_line_meta_map(line_item_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Retorna {line_item_id: {advertiser_id, insertion_order_id, campaign_id,
    entity_status, partner_id}} pra os IDs requisitados."""
    if not line_item_ids:
        return {}
    # Cache por subset ordenado pra reaproveitar entre requests
    cache_key = f"dv360_meta:{','.join(sorted(set(line_item_ids)))}"

    def _q():
        client = bigquery_store._get_client()
        ids_norm = sorted({str(x).strip() for x in line_item_ids if x})
        if not ids_norm:
            return {}
        sql = f"""
            SELECT line_item_id, advertiser_id, insertion_order_id,
                   campaign_id, entity_status, partner_id
            FROM {_fqn('dim_dv360_line_meta')}
            WHERE line_item_id IN UNNEST(@ids)
        """
        from google.cloud import bigquery as _bq
        cfg = _bq.QueryJobConfig(
            query_parameters=[_bq.ArrayQueryParameter("ids", "STRING", ids_norm)]
        )
        out: dict[str, dict[str, Any]] = {}
        for r in client.query(sql, job_config=cfg).result():
            out[str(r.line_item_id)] = {
                "advertiser_id": r.advertiser_id,
                "insertion_order_id": r.insertion_order_id,
                "campaign_id": r.campaign_id,
                "entity_status": r.entity_status,
                "partner_id": r.partner_id,
            }
        return out
    return _cached(cache_key, _q)


def latest_exchange_rate() -> float | None:
    """Retorna o fx_usd_brl mais recente (cost_date máximo). Fallback se hoje não tem."""
    def _q():
        client = bigquery_store._get_client()
        sql = f"""
            SELECT fx_usd_brl FROM {_fqn('dim_fx_daily')}
            ORDER BY cost_date DESC LIMIT 1
        """
        rows = list(client.query(sql).result())
        return float(rows[0].fx_usd_brl) if rows else None
    return _cached("fx:latest", _q)
