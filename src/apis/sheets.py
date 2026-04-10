"""
Google Sheets — leitura da aba _CS Campaing Journey
"""

import json
import os
import re
from datetime import datetime
from pathlib import Path

import requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials

PROJECT_ROOT = Path(__file__).parent.parent.parent
SHEET_ID = "1mdEbrJJqwPjdngBO8FyCRYodhc8NQ-KKEY0pmCATuZE"
SHEET_TAB = "_CS Campaing Journey"

# Índices das colunas (0-based)
COL_CLIENTE   = 0   # A
COL_CAMPANHA  = 1   # B
COL_START     = 6   # G
COL_END       = 7   # H
COL_TOKEN     = 22  # W
COL_INVESTIDO = 26  # AA — Net Invoice (PI)


def _get_token():
    token_path = PROJECT_ROOT / os.getenv("DV360_TOKEN_JSON", "dv360-token.json")
    with open(token_path) as f:
        td = json.load(f)
    creds = Credentials(
        token=td["token"], refresh_token=td["refresh_token"],
        token_uri=td["token_uri"], client_id=td["client_id"],
        client_secret=td["client_secret"], scopes=td["scopes"],
    )
    creds.refresh(Request())
    # Salva token renovado
    td["token"] = creds.token
    with open(token_path, "w") as f:
        json.dump(td, f, indent=2)
    return creds.token


def _parse_brl(value):
    """Converte 'R$ 30.000,00' → 30000.0"""
    if not value:
        return 0.0
    cleaned = re.sub(r"[R$\s\.]", "", str(value)).replace(",", ".")
    try:
        return float(cleaned)
    except Exception:
        return 0.0


def _parse_date(value):
    """Converte '03/01/2023' → date. Retorna None se inválido."""
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(str(value).strip(), fmt).date()
        except Exception:
            pass
    return None


def fetch_campaign_journey():
    """
    Retorna lista de dicts:
    [{"token": str, "cliente": str, "campanha": str, "investido": float}, ...]
    """
    try:
        access_token = _get_token()
        headers = {"Authorization": f"Bearer {access_token}"}

        import urllib.parse
        range_ = urllib.parse.quote(f"{SHEET_TAB}!A2:AE")
        r = requests.get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/{range_}",
            headers=headers,
            timeout=20,
        )
        r.raise_for_status()
        rows = r.json().get("values", [])

        campaigns = []
        for row in rows:
            token = row[COL_TOKEN].strip() if len(row) > COL_TOKEN else ""
            if not token or len(token) != 6:
                continue
            cliente   = row[COL_CLIENTE].strip()   if len(row) > COL_CLIENTE   else ""
            campanha  = row[COL_CAMPANHA].strip()   if len(row) > COL_CAMPANHA  else ""
            investido = _parse_brl(row[COL_INVESTIDO]) if len(row) > COL_INVESTIDO else 0.0
            start_dt  = _parse_date(row[COL_START])    if len(row) > COL_START     else None
            end_dt    = _parse_date(row[COL_END])      if len(row) > COL_END       else None
            campaigns.append({
                "token":    token,
                "cliente":  cliente,
                "campanha": campanha,
                "investido": investido,
                "start":    start_dt,
                "end":      end_dt,
            })

        return {"data": campaigns, "status": "ok", "message": ""}

    except Exception as e:
        return {"data": [], "status": "error", "message": str(e)}


def extract_token_from_line(line_name):
    """Extrai o short token de nomes como 'ID-CIRON2_HYPR_...' → 'CIRON2'"""
    match = re.search(r"ID-([A-Z0-9]{6})[_\s]", str(line_name))
    return match.group(1) if match else None
