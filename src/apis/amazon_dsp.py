"""
Amazon DSP API client — Amazon Advertising API
Docs: https://advertising.amazon.com/API/docs/en-us/dsp-reports

Como configurar (passo a passo):
1. Acesse https://advertising.amazon.com/API/docs
2. Vá em "Getting Started" > "Registering as a developer"
3. Faça login com sua conta Amazon Advertising
4. Crie um aplicativo LWA (Login with Amazon):
   - Acesse https://developer.amazon.com/loginwithamazon/console/site/lwa/overview.html
   - Crie um novo security profile
   - Anote o Client ID e Client Secret
5. Gere o refresh token:
   - Siga o fluxo OAuth em: https://advertising.amazon.com/API/docs/en-us/setting-up/authorization
   - Use a URL: https://www.amazon.com/ap/oa?client_id=YOUR_CLIENT_ID&scope=advertising::campaign_management&response_type=code&redirect_uri=YOUR_REDIRECT_URI
6. Configure no .env:
   - AMAZON_CLIENT_ID=amzn1.application-oa2-client.xxx
   - AMAZON_CLIENT_SECRET=xxx
   - AMAZON_REFRESH_TOKEN=Atzr|xxx
   - AMAZON_DSP_ADVERTISER_IDS=id1,id2
   - AMAZON_DSP_REGION=NA  (NA, EU, ou FE)
"""

import os
import requests
import time
from datetime import date


REGIONS = {
    "NA": "https://advertising-api.amazon.com",
    "EU": "https://advertising-api-eu.amazon.com",
    "FE": "https://advertising-api-fe.amazon.com",
}

TOKEN_URL = "https://api.amazon.com/auth/o2/token"
REPORT_POLL_TIMEOUT_SECONDS = 90
REPORT_POLL_INTERVAL_SECONDS = 3

_token_cache: dict = {"token": None, "expires_at": 0}


def _get_access_token():
    client_id = os.getenv("AMAZON_CLIENT_ID", "")
    client_secret = os.getenv("AMAZON_CLIENT_SECRET", "")
    refresh_token = os.getenv("AMAZON_REFRESH_TOKEN", "")

    if not all([client_id, client_secret, refresh_token]):
        return None

    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"]:
        return _token_cache["token"]

    resp = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    token = data.get("access_token")
    expires_in = int(data.get("expires_in", 3600))
    if token:
        _token_cache["token"] = token
        _token_cache["expires_at"] = now + expires_in - 60
    return token


def fetch_mtd_cost(start: date, end: date) -> dict:
    """
    Returns {"spend": float, "currency": "USD", "status": "ok" | "no_credentials" | "error", "message": str}
    """
    client_id = os.getenv("AMAZON_CLIENT_ID", "")
    client_secret = os.getenv("AMAZON_CLIENT_SECRET", "")
    refresh_token = os.getenv("AMAZON_REFRESH_TOKEN", "")
    advertiser_ids_raw = os.getenv("AMAZON_DSP_ADVERTISER_IDS", "")
    region = os.getenv("AMAZON_DSP_REGION", "NA")

    if not all([client_id, client_secret, refresh_token]):
        return {"spend": 0.0, "currency": "USD", "status": "no_credentials", "lines": [], "cost_types": [], "message": "AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET ou AMAZON_REFRESH_TOKEN não configurados"}

    try:
        token = _get_access_token()
        if not token:
            return {"spend": 0.0, "currency": "USD", "status": "error", "lines": [], "cost_types": [], "message": "Falha na autenticação Amazon"}

        base_url = REGIONS.get(region, REGIONS["NA"])
        headers = {
            "Authorization": f"Bearer {token}",
            "Amazon-Advertising-API-ClientId": client_id,
            "Content-Type": "application/json",
        }

        advertiser_ids = [i.strip() for i in advertiser_ids_raw.split(",") if i.strip()]

        report_body = {
            "startDate": start.strftime("%Y%m%d"),
            "endDate": end.strftime("%Y%m%d"),
            "format": "JSON",
            "type": "CAMPAIGN",
            "metrics": ["totalCost"],
        }
        if advertiser_ids:
            report_body["advertiserIds"] = advertiser_ids

        resp = requests.post(
            f"{base_url}/dsp/reports",
            json=report_body,
            headers=headers,
            timeout=30,
        )
        resp.raise_for_status()
        report_id = resp.json().get("reportId")

        if not report_id:
            return {"spend": 0.0, "currency": "USD", "status": "error", "lines": [], "cost_types": [], "message": "Report ID não retornado"}

        # Polling até ficar pronto (com estados explícitos)
        status_data: dict = {}
        report_status = ""
        deadline = time.time() + REPORT_POLL_TIMEOUT_SECONDS
        while time.time() < deadline:
            status_resp = requests.get(f"{base_url}/dsp/reports/{report_id}", headers=headers, timeout=30)
            status_resp.raise_for_status()
            status_data = status_resp.json()
            report_status = str(status_data.get("status", "")).upper()
            if report_status == "SUCCESS":
                break
            if report_status in {"FAILURE", "FAILED", "CANCELLED"}:
                failure_message = (
                    status_data.get("statusDetails")
                    or status_data.get("message")
                    or "Relatório Amazon DSP falhou."
                )
                return {
                    "spend": 0.0,
                    "currency": "USD",
                    "status": "error",
                    "lines": [],
                    "cost_types": [],
                    "message": f"{report_status}: {failure_message}",
                }
            time.sleep(REPORT_POLL_INTERVAL_SECONDS)

        if report_status != "SUCCESS":
            status_msg = report_status or "DESCONHECIDO"
            return {
                "spend": 0.0,
                "currency": "USD",
                "status": "error",
                "lines": [],
                "cost_types": [],
                "message": (
                    f"Timeout no relatório Amazon DSP após {REPORT_POLL_TIMEOUT_SECONDS}s "
                    f"(último status: {status_msg})."
                ),
            }

        dl_url = status_data.get("location")
        if not dl_url:
            return {"spend": 0.0, "currency": "USD", "status": "error", "lines": [], "cost_types": [], "message": "URL de download não disponível"}

        dl_resp = requests.get(dl_url, timeout=60)
        dl_resp.raise_for_status()

        data = dl_resp.json()
        total = sum(float(row.get("totalCost", 0) or 0) for row in data)
        return {"spend": total, "currency": "USD", "status": "ok", "message": ""}

    except Exception as e:
        return {"spend": 0.0, "currency": "USD", "status": "error", "lines": [], "cost_types": [], "message": str(e)}
