"""
Xandr API client (formerly AppNexus) — REST
Docs: https://docs.xandr.com/bundle/xandr-api/page/report-service.html

Como configurar:
1. Você precisa de um usuário Xandr com acesso à API
2. Peça ao seu Account Manager para habilitar acesso à API
3. Configure no .env:
   - XANDR_USERNAME=seu_usuario
   - XANDR_PASSWORD=sua_senha
   - XANDR_ADVERTISER_IDS=id1,id2  (IDs dos anunciantes separados por vírgula)

Nota: O token expira a cada 2 horas.
"""

import os
import requests
import time
from datetime import date


BASE_URL = "https://api.appnexus.com"

_token_cache: dict = {"token": None, "expires_at": 0}


def _get_token():
    username = os.getenv("XANDR_USERNAME", "")
    password = os.getenv("XANDR_PASSWORD", "")
    if not username or not password:
        return None

    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"]:
        return _token_cache["token"]

    resp = requests.post(
        f"{BASE_URL}/auth",
        json={"auth": {"username": username, "password": password}},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    token = data.get("response", {}).get("token")
    if token:
        _token_cache["token"] = token
        _token_cache["expires_at"] = now + 7200  # 2h
    return token


def fetch_mtd_cost(start: date, end: date) -> dict:
    """
    Returns {"spend": float, "currency": "USD", "status": "ok" | "no_credentials" | "error", "message": str}
    """
    username = os.getenv("XANDR_USERNAME", "")
    password = os.getenv("XANDR_PASSWORD", "")
    advertiser_ids_raw = os.getenv("XANDR_ADVERTISER_IDS", "")

    if not username or not password:
        return {"spend": 0.0, "currency": "USD", "status": "no_credentials", "message": "XANDR_USERNAME ou XANDR_PASSWORD não configurados"}

    try:
        token = _get_token()
        if not token:
            return {"spend": 0.0, "currency": "USD", "status": "error", "message": "Falha na autenticação Xandr"}

        headers = {"Authorization": token}

        advertiser_ids = [i.strip() for i in advertiser_ids_raw.split(",") if i.strip()]

        import io, pandas as pd

        def _run_report(columns):
            body = {
                "report": {
                    "report_type": "advertiser_analytics",
                    "columns": columns,
                    "filters": [{"advertiser_id": i} for i in advertiser_ids] if advertiser_ids else [],
                    "start_date": start.strftime("%Y-%m-%d 00:00:00"),
                    "end_date": end.strftime("%Y-%m-%d 23:59:59"),
                    "format": "csv",
                }
            }
            r = requests.post(f"{BASE_URL}/report", json=body, headers=headers, timeout=30)
            r.raise_for_status()
            report_id = r.json().get("response", {}).get("report_id")
            if not report_id:
                return None, r.json().get("response", {}).get("error", "Report ID não retornado")
            for _ in range(15):
                time.sleep(2)
                sr = requests.get(f"{BASE_URL}/report?id={report_id}", headers=headers, timeout=30)
                if sr.json().get("response", {}).get("execution_status") == "ready":
                    break
            dl = requests.get(f"{BASE_URL}/report-download?id={report_id}", headers=headers, timeout=60)
            dl.raise_for_status()
            return pd.read_csv(io.StringIO(dl.text)), None

        # Relatório por line item e media type
        df, err = _run_report(["day", "line_item_name", "line_item_id", "media_type", "spend"])
        if err or df is None:
            return {"spend": 0.0, "currency": "USD", "status": "error", "message": err or "Sem dados",
                    "lines": [], "cost_types": [], "daily": []}

        spend_col = next((c for c in df.columns if "spend" in c.lower()), None)
        if spend_col:
            df[spend_col] = pd.to_numeric(df[spend_col], errors="coerce").fillna(0)

        total = float(df[spend_col].sum()) if spend_col else 0.0

        # Lines
        lines_out = []
        line_col = next((c for c in df.columns if c.lower() == "line_item_name"), None)
        if line_col and spend_col:
            agg = df.groupby(line_col)[spend_col].sum().reset_index().sort_values(spend_col, ascending=False)
            for _, row in agg.iterrows():
                lines_out.append({"name": str(row[line_col]), "spend": float(row[spend_col])})

        # Cost types (media type)
        types_out = []
        type_col = next((c for c in df.columns if "media_type" in c.lower()), None)
        if type_col and spend_col:
            agg_t = df.groupby(type_col)[spend_col].sum().reset_index().sort_values(spend_col, ascending=False)
            for _, row in agg_t.iterrows():
                types_out.append({"type": str(row[type_col]), "spend": float(row[spend_col])})

        # Daily
        daily_out = []
        day_col = next((c for c in df.columns if c.lower() == "day"), None)
        if day_col and spend_col:
            agg_d = df.groupby(day_col)[spend_col].sum().reset_index().sort_values(day_col)
            for _, row in agg_d.iterrows():
                try:
                    d = pd.to_datetime(row[day_col]).strftime("%Y-%m-%d")
                    daily_out.append({"date": d, "spend": float(row[spend_col])})
                except Exception:
                    pass

        return {
            "spend": total,
            "currency": "USD",
            "status": "ok",
            "message": "",
            "lines": lines_out,
            "cost_types": types_out,
            "daily": daily_out,
        }

    except Exception as e:
        return {"spend": 0.0, "currency": "USD", "status": "error", "message": str(e),
                "lines": [], "cost_types": [], "daily": []}
