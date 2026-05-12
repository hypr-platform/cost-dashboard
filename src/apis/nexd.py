"""
Nexd API — impressions (não custo).
Endpoint: GET /group/campaigns/analytics/summary?start={unix}&end={unix}
API key configurada em .env como NEXD_API_KEY.
"""

import calendar
import os
from datetime import date, datetime

import requests


BASE_URL = "https://api.nexd.com"
MONTHLY_CAP = 10_000_000
# CPM Nexd em BRL — fonte da verdade está em dashboard_service.NEXD_CPM_BRL.
# Duplicado aqui pra evitar import circular; manter sincronizado.
NEXD_CPM_BRL = 0.0014


def _synthesize_line_daily_enabled() -> bool:
    return os.getenv("NEXD_SYNTHESIZE_LINE_DAILY", "").strip() in {"1", "true", "True", "yes"}


def _last_day_of_month(any_day: date) -> date:
    last = calendar.monthrange(any_day.year, any_day.month)[1]
    return date(any_day.year, any_day.month, last)


def _to_unix(d: date) -> int:
    return int(datetime(d.year, d.month, d.day).timestamp())


def _get_headers() -> dict:
    api_key = os.getenv("NEXD_API_KEY", "")
    return {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}


def fetch_mtd_impressions(start: date, end: date) -> dict:
    """
    Retorna total de impressões do mês corrente, detalhamento por campanha e por formato/layout.

    Returns:
    {
        "impressions": int,
        "cap": int,               # 10_000_000
        "status": "ok" | "no_credentials" | "error",
        "message": str,
        "campaigns": [{"name": str, "advertiser": str, "impressions": int}, ...],
        "layouts":   [{"layout": str, "impressions": int, "creatives": int}, ...],
    }
    """
    api_key = os.getenv("NEXD_API_KEY", "")
    if not api_key:
        return {
            "impressions": 0, "cap": MONTHLY_CAP,
            "status": "no_credentials", "message": "NEXD_API_KEY não configurada",
            "campaigns": [], "layouts": [], "line_daily": [],
        }

    try:
        start_ts = _to_unix(start)
        end_ts = int(datetime(end.year, end.month, end.day, 23, 59, 59).timestamp())
        headers = _get_headers()
        params = {"start": start_ts, "end": end_ts}

        # Campaign-level summary
        r_summary = requests.get(
            f"{BASE_URL}/group/campaigns/analytics/summary",
            params=params, headers=headers, timeout=30,
        )
        r_summary.raise_for_status()
        summary = r_summary.json()

        total_impressions = 0
        campaigns = []
        # raw_for_line_daily mantém (camp_id, name, imps) pra síntese de line_daily.
        raw_for_line_daily: list[dict] = []
        for camp_id, camp in summary.get("result", {}).items():
            imps = camp.get("impressions", 0) or 0
            total_impressions += imps
            if imps > 0:
                name = camp.get("campaign_name", camp_id)
                campaigns.append({
                    "name": name,
                    "advertiser": camp.get("advertiser", ""),
                    "impressions": imps,
                    "creatives": camp.get("live_creatives", 0),
                })
                raw_for_line_daily.append({
                    "camp_id": str(camp_id),
                    "name": name,
                    "impressions": imps,
                })
        campaigns.sort(key=lambda x: -x["impressions"])

        # Layout/format breakdown
        r_perf = requests.get(
            f"{BASE_URL}/group/campaigns/analytics/performance",
            params=params, headers=headers, timeout=30,
        )
        layouts = []
        if r_perf.status_code == 200:
            for row in r_perf.json().get("result", []):
                imps = row.get("impressions", 0) or 0
                if imps > 0:
                    layouts.append({
                        "layout": row.get("layout", "—"),
                        "impressions": imps,
                        "creatives": row.get("creatives", 0),
                    })
            layouts.sort(key=lambda x: -x["impressions"])

        # line_daily — atribuído ao last_day_of_month porque a API Nexd não
        # entrega breakdown por dia real:
        # - `summary?start=X&end=Y` retorna *unique* impressions no range,
        #   não a soma diária. Quando o range é maior, a dedup é maior,
        #   então somar dailies isolados NÃO bate com o total do mês.
        # - Cumulative delta também não funciona: a curva converge cedo
        #   (dias finais ficam = 0).
        # Workaround: imputar tudo no last_day. Documentado nos badges como
        # `granularity=monthly_imputed`.
        line_daily: list[dict] = []
        if _synthesize_line_daily_enabled():
            target_date = _last_day_of_month(end).isoformat()
            for entry in raw_for_line_daily:
                spend_brl = float(entry["impressions"]) * NEXD_CPM_BRL
                if spend_brl <= 0:
                    continue
                line_daily.append({
                    "date": target_date,
                    "line_item_id": entry["camp_id"] or None,
                    "name": entry["name"],
                    "spend": spend_brl,
                    "currency": "BRL",
                    "granularity": "monthly_imputed",
                    "is_estimated": True,
                })

        return {
            "impressions": total_impressions,
            "cap": MONTHLY_CAP,
            "status": "ok",
            "message": "",
            "campaigns": campaigns,
            "layouts": layouts,
            "line_daily": line_daily,
        }

    except Exception as e:
        return {
            "impressions": 0, "cap": MONTHLY_CAP,
            "status": "error", "message": str(e),
            "campaigns": [], "layouts": [], "line_daily": [],
        }
