"""
StackAdapt — GraphQL API
Endpoint: https://api.stackadapt.com/graphql
Autenticação: Bearer token via STACKADAPT_API_KEY no .env
"""

import os
from collections import defaultdict
from datetime import date, timedelta

import requests

GQL_URL = "https://api.stackadapt.com/graphql"

CAMPAIGN_DELIVERY_QUERY = """
{
  campaignDelivery(
    dataType: TABLE
    granularity: TOTAL
    date: { from: "%s", to: "%s" }
  ) {
    ... on CampaignDeliveryOutcome {
      totalStats { cost tpCpmCost tpCpcCost }
      records {
        nodes {
          campaign { id name }
          metrics { cost tpCpmCost tpCpcCost impressionsBigint }
        }
      }
    }
  }
}
"""

DAILY_QUERY = """
{
  campaignGroupDelivery(
    dataType: TABLE
    granularity: DAILY
    date: { from: "%s", to: "%s" }
  ) {
    ... on CampaignGroupDeliveryOutcome {
      records {
        nodes {
          granularity { startTime }
          metrics { cost }
        }
      }
    }
  }
}
"""


def _gql(query: str, token: str) -> dict:
    r = requests.post(
        GQL_URL,
        json={"query": query},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if "errors" in data:
        raise ValueError(data["errors"][0]["message"])
    return data["data"]


def fetch_mtd_cost(start: date, end: date) -> dict:
    token = os.getenv("STACKADAPT_API_KEY", "")
    if not token:
        return {
            "spend": 0.0, "currency": "USD", "status": "no_credentials",
            "message": "STACKADAPT_API_KEY não configurada",
            "lines": [], "cost_types": [], "daily": [],
        }

    try:
        start_str = start.strftime("%Y-%m-%d")
        end_str   = (end + timedelta(days=1)).strftime("%Y-%m-%d")  # API 'to' é exclusivo

        # Campaign-level spend (para lines + tokens)
        camp_data = _gql(CAMPAIGN_DELIVERY_QUERY % (start_str, end_str), token)
        outcome   = camp_data.get("campaignDelivery", {})

        total_stats = outcome.get("totalStats", {})
        total = (
            float(total_stats.get("cost", 0) or 0)
            + float(total_stats.get("tpCpmCost", 0) or 0)
            + float(total_stats.get("tpCpcCost", 0) or 0)
        )

        lines = []
        for node in outcome.get("records", {}).get("nodes", []):
            camp  = node.get("campaign", {})
            name  = camp.get("name", "")
            m     = node.get("metrics", {})
            spend = (
                float(m.get("cost", 0) or 0)
                + float(m.get("tpCpmCost", 0) or 0)
                + float(m.get("tpCpcCost", 0) or 0)
            )
            if spend > 0:
                lines.append({"name": name, "spend": spend})

        lines.sort(key=lambda x: -x["spend"])

        # Daily totals (por campaign group)
        daily = []
        try:
            daily_data = _gql(DAILY_QUERY % (start_str, end_str), token)
            day_totals: dict = defaultdict(float)
            for node in daily_data.get("campaignGroupDelivery", {}).get("records", {}).get("nodes", []):
                start_time = (node.get("granularity") or {}).get("startTime", "")
                day = start_time[:10] if start_time else ""
                cost = float((node.get("metrics") or {}).get("cost", 0) or 0)
                if day and cost > 0:
                    day_totals[day] += cost
            daily = [{"date": d, "spend": v} for d, v in sorted(day_totals.items())]
        except Exception:
            pass

        return {
            "spend": total, "currency": "USD", "status": "ok", "message": "",
            "lines": lines, "cost_types": [], "daily": daily,
        }

    except Exception as e:
        return {
            "spend": 0.0, "currency": "USD", "status": "error",
            "message": str(e), "lines": [], "cost_types": [], "daily": [],
        }
