"""
Google DV360 API client — Display & Video 360 API v2
Docs: https://developers.google.com/display-video/api/reference/rest

Modos de autenticação suportados:

OPÇÃO A — OAuth com sua conta Google (não precisa ser admin):
  1. Crie credencial OAuth no Google Cloud Console (tipo: Desktop app)
  2. Baixe o JSON e salve como oauth-credentials.json
  3. Rode: .venv/bin/python generate_token.py
  4. Configure no .env:
     DV360_OAUTH_JSON=oauth-credentials.json
     DV360_TOKEN_JSON=dv360-token.json
     DV360_PARTNER_ID=seu_partner_id
     DV360_ADVERTISER_IDS=id1,id2

OPÇÃO B — Service Account (precisa de admin no DV360):
  Configure no .env:
     DV360_SERVICE_ACCOUNT_JSON=dv360-credentials.json
     DV360_PARTNER_ID=seu_partner_id
     DV360_ADVERTISER_IDS=id1,id2
"""

import os
import json
import time
import requests
from datetime import date
from pathlib import Path

# Raiz do projeto (dois níveis acima de src/apis/)
PROJECT_ROOT = Path(__file__).parent.parent.parent

QUERIES_URL = "https://doubleclickbidmanager.googleapis.com/v2/queries"


def _resolve(env_var):
    """Resolve caminho relativo ao projeto ou absoluto."""
    val = os.getenv(env_var, "")
    if not val:
        return ""
    p = Path(val)
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    return str(p)

_token_cache = {"token": None, "expires_at": 0}


def _get_access_token():
    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"]:
        return _token_cache["token"]

    # --- Opção A: OAuth token salvo em arquivo ---
    token_path = _resolve("DV360_TOKEN_JSON")
    oauth_path = _resolve("DV360_OAUTH_JSON")
    if token_path and os.path.exists(token_path) and oauth_path and os.path.exists(oauth_path):
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request

        with open(token_path) as f:
            token_data = json.load(f)

        creds = Credentials(
            token=token_data.get("token"),
            refresh_token=token_data.get("refresh_token"),
            token_uri=token_data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=token_data.get("client_id"),
            client_secret=token_data.get("client_secret"),
            scopes=token_data.get("scopes"),
        )
        # Sempre renova — o JSON não guarda expiry, então creds.valid não é confiável
        creds.refresh(Request())
        token_data["token"] = creds.token
        with open(token_path, "w") as f:
            json.dump(token_data, f, indent=2)

        _token_cache["token"] = creds.token
        _token_cache["expires_at"] = now + 3500
        return creds.token

    # --- Opção B: Service Account ---
    sa_path = _resolve("DV360_SERVICE_ACCOUNT_JSON")
    if sa_path and os.path.exists(sa_path):
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request

        scopes = ["https://www.googleapis.com/auth/display-video",
                  "https://www.googleapis.com/auth/doubleclickbidmanager"]
        creds = service_account.Credentials.from_service_account_file(sa_path, scopes=scopes)
        creds.refresh(Request())
        _token_cache["token"] = creds.token
        _token_cache["expires_at"] = now + 3500
        return creds.token

    return None


def _check_credentials():
    has_oauth = (
        os.path.exists(_resolve("DV360_TOKEN_JSON")) and
        os.path.exists(_resolve("DV360_OAUTH_JSON"))
    )
    has_sa = os.path.exists(_resolve("DV360_SERVICE_ACCOUNT_JSON"))
    has_partner = bool(os.getenv("DV360_PARTNER_ID", ""))
    return (has_oauth or has_sa) and has_partner


def fetch_mtd_cost(start, end):
    """
    Returns {"spend": float, "currency": "USD", "status": "ok" | "no_credentials" | "error", "message": str}
    """
    if not _check_credentials():
        return {
            "spend": 0.0,
            "currency": "USD",
            "status": "no_credentials",
            "message": "DV360 não configurado. Rode generate_token.py e preencha o .env",
        }

    try:
        token = _get_access_token()
        if not token:
            return {"spend": 0.0, "currency": "USD", "status": "error", "message": "Falha ao obter token de acesso"}

        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        partner_id = os.getenv("DV360_PARTNER_ID", "")
        advertiser_ids_raw = os.getenv("DV360_ADVERTISER_IDS", "")

        filters = []
        if advertiser_ids_raw:
            for adv_id in advertiser_ids_raw.split(","):
                adv_id = adv_id.strip()
                if adv_id:
                    filters.append({"type": "FILTER_ADVERTISER", "value": adv_id})
        if not filters:
            filters = [{"type": "FILTER_PARTNER", "value": partner_id}]

        import io
        import pandas as pd

        def _run_query(group_bys, title):
            body = {
                "metadata": {
                    "title": title,
                    "dataRange": {
                        "range": "CUSTOM_DATES",
                        "customStartDate": {"year": start.year, "month": start.month, "day": start.day},
                        "customEndDate": {"year": end.year, "month": end.month, "day": end.day},
                    },
                    "format": "CSV",
                },
                "params": {
                    "type": "STANDARD",
                    "groupBys": group_bys,
                    "metrics": ["METRIC_REVENUE_USD"],
                    "filters": filters,
                },
                "schedule": {"frequency": "ONE_TIME"},
            }
            r = requests.post(QUERIES_URL, json=body, headers=headers, timeout=30)
            r.raise_for_status()
            qid = r.json().get("queryId")
            if not qid:
                return None
            requests.post(f"{QUERIES_URL}/{qid}:run", headers=headers, timeout=30)
            for _ in range(15):
                time.sleep(3)
                rr = requests.get(f"{QUERIES_URL}/{qid}/reports", headers=headers, timeout=30)
                reports = rr.json().get("reports", [])
                if reports:
                    latest = reports[-1]
                    if latest.get("metadata", {}).get("status", {}).get("state") == "DONE":
                        url = latest.get("metadata", {}).get("googleCloudStoragePath")
                        csv = requests.get(url, timeout=60).text
                        return csv
            return None

        def _parse_csv(raw):
            if not raw:
                return pd.DataFrame()
            lines_raw = raw.splitlines()
            # Encontra header — primeira linha que não começa com espaço/vírgula/Report
            start_i = next(
                (i for i, l in enumerate(lines_raw)
                 if l and not l.startswith(",") and not l.startswith("Report") and ":" not in l[:20]),
                None
            )
            if start_i is None:
                return pd.DataFrame()
            data_lines = [lines_raw[start_i]]
            for line in lines_raw[start_i + 1:]:
                if line.strip() == "" or line.startswith(","):
                    break
                data_lines.append(line)
            return pd.read_csv(io.StringIO("\n".join(data_lines)))

        # Query 1: por Line Item | Query 2: por Data (em paralelo via threads)
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
            fut_lines = ex.submit(_run_query, ["FILTER_LINE_ITEM", "FILTER_LINE_ITEM_TYPE"], f"MTD Lines {start}")
            fut_daily = ex.submit(_run_query, ["FILTER_DATE"], f"MTD Daily {start}")
            csv_lines = fut_lines.result()
            csv_daily = fut_daily.result()

        df_lines = _parse_csv(csv_lines)

        if df_lines.empty:
            return {"spend": 0.0, "currency": "USD", "status": "error",
                    "message": "Relatório não disponível. Tente novamente.", "lines": [], "cost_types": [], "daily": []}

        rev_col = next((c for c in df_lines.columns if "Revenue" in c or "Cost" in c), None)
        id_col = next((c for c in df_lines.columns if "ID" in c), None)
        type_col = next((c for c in df_lines.columns if "Type" in c), None)

        if rev_col:
            df_lines[rev_col] = pd.to_numeric(df_lines[rev_col], errors="coerce").fillna(0)

        total = float(df_lines[rev_col].sum()) if rev_col else 0.0

        # Busca nomes dos line items via DV360 Management API v4
        line_id_to_name = {}
        advertiser_ids_raw = os.getenv("DV360_ADVERTISER_IDS", "")
        for adv_id in advertiser_ids_raw.split(","):
            adv_id = adv_id.strip()
            if not adv_id:
                continue
            page_token = None
            while True:
                params = {"pageSize": 200, "fields": "lineItems(lineItemId,displayName),nextPageToken"}
                if page_token:
                    params["pageToken"] = page_token
                try:
                    r = requests.get(
                        f"https://displayvideo.googleapis.com/v4/advertisers/{adv_id}/lineItems",
                        params=params, headers=headers, timeout=30,
                    )
                    data = r.json()
                    for item in data.get("lineItems", []):
                        line_id_to_name[str(item["lineItemId"])] = item.get("displayName", item["lineItemId"])
                    page_token = data.get("nextPageToken")
                    if not page_token:
                        break
                except Exception:
                    break

        lines_out = []
        if id_col and rev_col:
            agg = df_lines.groupby(id_col)[rev_col].sum().reset_index()
            agg = agg.sort_values(rev_col, ascending=False)
            for _, row in agg.iterrows():
                li_id = str(int(row[id_col])) if row[id_col] == row[id_col] else ""
                name = line_id_to_name.get(li_id, li_id)
                lines_out.append({"name": name, "spend": float(row[rev_col])})

        types_out = []
        if type_col and rev_col:
            agg_t = df_lines.groupby(type_col)[rev_col].sum().reset_index()
            agg_t = agg_t.sort_values(rev_col, ascending=False)
            for _, row in agg_t.iterrows():
                types_out.append({"type": row[type_col], "spend": float(row[rev_col])})

        # Daily breakdown
        daily_out = []
        df_daily = _parse_csv(csv_daily)
        if not df_daily.empty:
            date_col = next((c for c in df_daily.columns if "Date" in c), None)
            rev_col_d = next((c for c in df_daily.columns if "Revenue" in c or "Cost" in c), None)
            if date_col and rev_col_d:
                df_daily[rev_col_d] = pd.to_numeric(df_daily[rev_col_d], errors="coerce").fillna(0)
                for _, row in df_daily.iterrows():
                    try:
                        d = pd.to_datetime(row[date_col]).strftime("%Y-%m-%d")
                        daily_out.append({"date": d, "spend": float(row[rev_col_d])})
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
