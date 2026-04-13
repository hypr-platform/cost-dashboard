"""
Nexd API — impressions (não custo).
Endpoint: GET /group/campaigns/analytics/summary?start={unix}&end={unix}
API key configurada em .env como NEXD_API_KEY.
"""

import os
import requests
from datetime import date, datetime


BASE_URL = "https://api.nexd.com"
MONTHLY_CAP = 10_000_000


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
            "campaigns": [], "layouts": [],
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
        for camp_id, camp in summary.get("result", {}).items():
            imps = camp.get("impressions", 0) or 0
            total_impressions += imps
            if imps > 0:
                campaigns.append({
                    "name": camp.get("campaign_name", camp_id),
                    "advertiser": camp.get("advertiser", ""),
                    "impressions": imps,
                    "creatives": camp.get("live_creatives", 0),
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

        return {
            "impressions": total_impressions,
            "cap": MONTHLY_CAP,
            "status": "ok",
            "message": "",
            "campaigns": campaigns,
            "layouts": layouts,
        }

    except Exception as e:
        return {
            "impressions": 0, "cap": MONTHLY_CAP,
            "status": "error", "message": str(e),
            "campaigns": [], "layouts": [],
        }
