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
     DV360_SERVICE_ACCOUNT_JSON_BASE64=<json_da_service_account_em_base64>
     DV360_PARTNER_ID=seu_partner_id
     DV360_ADVERTISER_IDS=id1,id2
"""

import os
import json
import time
import base64
import random
import re
import threading
import requests
from datetime import date
from pathlib import Path

# Raiz do projeto (dois níveis acima de src/apis/)
PROJECT_ROOT = Path(__file__).parent.parent.parent

QUERIES_URL = "https://doubleclickbidmanager.googleapis.com/v2/queries"
REPORT_BACKOFF_BASE_SECONDS = 5
REPORT_BACKOFF_MAX_SECONDS = 80
REPORT_POLL_TIMEOUT_SECONDS = 240
QUERY_TITLE_PREFIX = "Cost Dashboard"
LINE_NAME_CACHE_TTL_SECONDS = 1800


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
_line_name_cache: dict[str, dict[str, object]] = {}
_line_name_cache_lock = threading.RLock()


def _line_name_cache_ttl_seconds() -> int:
    raw = os.getenv("DV360_LINE_NAME_CACHE_TTL_SECONDS", "").strip()
    if not raw:
        return LINE_NAME_CACHE_TTL_SECONDS
    try:
        parsed = int(raw)
        if parsed > 0:
            return parsed
    except Exception:
        pass
    return LINE_NAME_CACHE_TTL_SECONDS


def _is_probably_line_id(value: str | None) -> bool:
    if not value:
        return False
    return bool(re.fullmatch(r"\d{6,}", value.strip()))


def _normalize_advertiser_ids(advertiser_ids_raw: str) -> list[str]:
    return [adv.strip() for adv in advertiser_ids_raw.split(",") if adv.strip()]


def _fetch_line_names_for_advertiser(advertiser_id: str, headers: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    page_token = None
    while True:
        params = {
            "pageSize": 200,
            "fields": "lineItems(lineItemId,displayName),nextPageToken",
        }
        if page_token:
            params["pageToken"] = page_token
        response = requests.get(
            f"https://displayvideo.googleapis.com/v4/advertisers/{advertiser_id}/lineItems",
            params=params,
            headers=headers,
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        for item in payload.get("lineItems", []):
            line_item_id = str(item.get("lineItemId", "")).strip()
            display_name = str(item.get("displayName", "")).strip()
            if line_item_id and display_name:
                out[line_item_id] = display_name
        page_token = payload.get("nextPageToken")
        if not page_token:
            break
    return out


def _line_id_to_name_map(headers: dict, advertiser_ids_raw: str) -> dict[str, str]:
    advertiser_ids = _normalize_advertiser_ids(advertiser_ids_raw)
    if not advertiser_ids:
        return {}
    now = time.time()
    ttl = _line_name_cache_ttl_seconds()
    aggregate: dict[str, str] = {}
    for advertiser_id in advertiser_ids:
        with _line_name_cache_lock:
            cached_entry = _line_name_cache.get(advertiser_id)
            if cached_entry and float(cached_entry.get("expires_at", 0)) > now:
                cached_map = cached_entry.get("data")
                if isinstance(cached_map, dict):
                    aggregate.update({str(k): str(v) for k, v in cached_map.items()})
                    continue
        fetched_map = _fetch_line_names_for_advertiser(advertiser_id, headers)
        with _line_name_cache_lock:
            _line_name_cache[advertiser_id] = {
                "expires_at": now + ttl,
                "data": dict(fetched_map),
            }
        aggregate.update(fetched_map)
    return aggregate


def _get_service_account_info():
    """
    Lê a credencial da service account via DV360_SERVICE_ACCOUNT_JSON_BASE64.

    Formato esperado:
      - Base64 do JSON da service account (recomendado).

    Compatibilidade:
      - Caminho para arquivo JSON (formato legado).
      - JSON puro na variável.
    """
    raw = os.getenv("DV360_SERVICE_ACCOUNT_JSON_BASE64", "").strip()
    # Compatibilidade com nome antigo
    if not raw:
        raw = os.getenv("DV360_SERVICE_ACCOUNT_JSON", "").strip()
    if not raw:
        return None

    # Recomendado: valor em base64
    try:
        decoded = base64.b64decode(raw, validate=True).decode("utf-8")
        parsed = json.loads(decoded)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass

    # Compat: JSON direto na variável
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass

    # Compat legado: caminho para JSON no disco
    p = Path(raw)
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    if p.exists():
        try:
            with open(p) as f:
                parsed = json.load(f)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass

    return None


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
    sa_info = _get_service_account_info()
    if sa_info:
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request

        scopes = ["https://www.googleapis.com/auth/display-video",
                  "https://www.googleapis.com/auth/doubleclickbidmanager"]
        creds = service_account.Credentials.from_service_account_info(sa_info, scopes=scopes)
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
    has_sa = _get_service_account_info() is not None
    has_partner = bool(os.getenv("DV360_PARTNER_ID", ""))
    return (has_oauth or has_sa) and has_partner


def _build_filters(partner_id: str, advertiser_ids_raw: str) -> list[dict[str, str]]:
    filters: list[dict[str, str]] = []
    if advertiser_ids_raw:
        for adv_id in advertiser_ids_raw.split(","):
            adv_id = adv_id.strip()
            if adv_id:
                filters.append({"type": "FILTER_ADVERTISER", "value": adv_id})
    if not filters:
        filters = [{"type": "FILTER_PARTNER", "value": partner_id}]
    return filters


def _build_custom_date_range(start: date, end: date) -> dict:
    return {
        "range": "CUSTOM_DATES",
        "customStartDate": {"year": start.year, "month": start.month, "day": start.day},
        "customEndDate": {"year": end.year, "month": end.month, "day": end.day},
    }


def _safe_query_title(suffix: str, partner_id: str, advertiser_ids_raw: str) -> str:
    advertisers = ",".join(sorted([v.strip() for v in advertiser_ids_raw.split(",") if v.strip()])) if advertiser_ids_raw else ""
    scope = f"partner={partner_id}" if not advertisers else f"advertisers={advertisers}"
    return f"{QUERY_TITLE_PREFIX} | {suffix} | {scope}"


def _list_queries(headers: dict) -> list[dict]:
    out: list[dict] = []
    page_token = None
    while True:
        params = {"pageSize": 200}
        if page_token:
            params["pageToken"] = page_token
        response = requests.get(QUERIES_URL, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        payload = response.json()
        out.extend(payload.get("queries", []))
        page_token = payload.get("nextPageToken")
        if not page_token:
            break
    return out


def _ensure_query_id(title: str, group_bys: list[str], filters: list[dict], headers: dict) -> str:
    for query in _list_queries(headers):
        if query.get("metadata", {}).get("title") == title:
            query_id = query.get("queryId")
            if query_id:
                return str(query_id)

    body = {
        "metadata": {
            "title": title,
            "dataRange": {"range": "LAST_7_DAYS"},
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
    response = requests.post(QUERIES_URL, json=body, headers=headers, timeout=30)
    response.raise_for_status()
    query_id = response.json().get("queryId")
    if not query_id:
        raise RuntimeError(f"Falha ao criar query DV360 ({title}).")
    return str(query_id)


def _run_query(query_id: str, start: date, end: date, headers: dict) -> dict:
    response = requests.post(
        f"{QUERIES_URL}/{query_id}:run",
        params={"synchronous": "false"},
        json={"dataRange": _build_custom_date_range(start, end)},
        headers=headers,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def _extract_report_id(report_payload: dict | None) -> str | None:
    if not isinstance(report_payload, dict):
        return None
    report_id = report_payload.get("key", {}).get("reportId")
    if report_id:
        return str(report_id)
    # Fallback defensivo para estruturas alternativas.
    report_id = report_payload.get("reportId")
    if report_id:
        return str(report_id)
    return None


def _get_report(query_id: str, report_id: str, headers: dict) -> dict:
    response = requests.get(f"{QUERIES_URL}/{query_id}/reports/{report_id}", headers=headers, timeout=30)
    response.raise_for_status()
    return response.json()


def _list_reports(query_id: str, headers: dict, page_size: int = 10) -> list[dict]:
    response = requests.get(
        f"{QUERIES_URL}/{query_id}/reports",
        headers=headers,
        params={"orderBy": "key.reportId desc", "pageSize": page_size},
        timeout=30,
    )
    response.raise_for_status()
    return response.json().get("reports", [])


def _fetch_report_csv(report: dict) -> str | None:
    url = report.get("metadata", {}).get("googleCloudStoragePath")
    if not url:
        return None
    return requests.get(url, timeout=60).text


def _latest_done_report_csv(query_id: str, headers: dict) -> str | None:
    for report in _list_reports(query_id, headers, page_size=20):
        state = report.get("metadata", {}).get("status", {}).get("state")
        if state == "DONE":
            csv = _fetch_report_csv(report)
            if csv:
                return csv
    return None


def _wait_report_csv(query_id: str, report_id: str | None, headers: dict) -> str | None:
    started_at = time.time()
    attempt = 0
    tracked_report_id = report_id

    while time.time() - started_at < REPORT_POLL_TIMEOUT_SECONDS:
        if not tracked_report_id:
            reports = _list_reports(query_id, headers, page_size=1)
            if not reports:
                delay = min(REPORT_BACKOFF_BASE_SECONDS * (2 ** attempt), REPORT_BACKOFF_MAX_SECONDS)
                time.sleep(delay + random.uniform(0, 1))
                attempt += 1
                continue
            tracked_report_id = _extract_report_id(reports[0])
            if not tracked_report_id:
                delay = min(REPORT_BACKOFF_BASE_SECONDS * (2 ** attempt), REPORT_BACKOFF_MAX_SECONDS)
                time.sleep(delay + random.uniform(0, 1))
                attempt += 1
                continue

        report = _get_report(query_id, tracked_report_id, headers)
        state = report.get("metadata", {}).get("status", {}).get("state")
        if state == "DONE":
            return _fetch_report_csv(report)
        if state == "FAILED":
            return _latest_done_report_csv(query_id, headers)

        delay = min(REPORT_BACKOFF_BASE_SECONDS * (2 ** attempt), REPORT_BACKOFF_MAX_SECONDS)
        time.sleep(delay + random.uniform(0, 1))
        attempt += 1

    # Timeout: tenta reaproveitar o último report pronto antes de falhar.
    return _latest_done_report_csv(query_id, headers)


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
        filters = _build_filters(partner_id, advertiser_ids_raw)

        import io
        import pandas as pd

        def _run_report(group_bys, title):
            query_id = _ensure_query_id(title, group_bys, filters, headers)
            report = _run_query(query_id, start, end, headers)
            report_id = _extract_report_id(report)
            return _wait_report_csv(query_id, report_id, headers)

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
            lines_title = _safe_query_title("Lines", partner_id, advertiser_ids_raw)
            daily_title = _safe_query_title("Daily", partner_id, advertiser_ids_raw)
            fut_lines = ex.submit(
                _run_report,
                ["FILTER_LINE_ITEM", "FILTER_LINE_ITEM_NAME", "FILTER_LINE_ITEM_TYPE"],
                lines_title,
            )
            fut_daily = ex.submit(_run_report, ["FILTER_DATE"], daily_title)
            csv_lines = fut_lines.result()
            csv_daily = fut_daily.result()

        df_lines = _parse_csv(csv_lines)

        if df_lines.empty:
            return {"spend": 0.0, "currency": "USD", "status": "error",
                    "message": "Relatório não disponível. Tente novamente.", "lines": [], "cost_types": [], "daily": []}

        rev_col = next((c for c in df_lines.columns if "Revenue" in c or "Cost" in c), None)
        id_col = next((c for c in df_lines.columns if "ID" in c), None)
        type_col = next((c for c in df_lines.columns if "Type" in c), None)
        name_col = next(
            (
                c for c in df_lines.columns
                if ("Line Item" in c or "Line item" in c)
                and "ID" not in c
                and "Type" not in c
            ),
            None,
        )

        if rev_col:
            df_lines.loc[:, rev_col] = pd.to_numeric(df_lines[rev_col], errors="coerce").fillna(0)

        total = float(df_lines[rev_col].sum()) if rev_col else 0.0

        lines_out = []
        if rev_col and id_col:
            # Agrega por ID para garantir um único gasto por line item e resolve nome depois.
            agg = df_lines.groupby(id_col)[rev_col].sum().reset_index()
            agg = agg.sort_values(rev_col, ascending=False)

            name_by_line_id: dict[str, str] = {}
            if name_col and name_col in df_lines.columns:
                for _, row in df_lines[[id_col, name_col]].dropna(subset=[id_col]).iterrows():
                    raw_id = row[id_col]
                    raw_name = row[name_col]
                    if raw_id != raw_id:
                        continue
                    try:
                        line_id = str(int(raw_id)).strip()
                    except Exception:
                        line_id = str(raw_id).strip()
                    candidate = str(raw_name).strip() if raw_name == raw_name else ""
                    if not candidate:
                        continue
                    if _is_probably_line_id(candidate):
                        continue
                    name_by_line_id[line_id] = candidate

            aggregated_line_ids: list[str] = []
            for _, row in agg.iterrows():
                if row[id_col] != row[id_col]:
                    continue
                try:
                    line_id = str(int(row[id_col])).strip()
                except Exception:
                    line_id = str(row[id_col]).strip()
                if line_id:
                    aggregated_line_ids.append(line_id)

            needs_lookup = any(not name_by_line_id.get(line_id) for line_id in aggregated_line_ids)
            line_id_to_name = _line_id_to_name_map(headers, advertiser_ids_raw) if needs_lookup else {}

            for _, row in agg.iterrows():
                line_id = ""
                if row[id_col] == row[id_col]:
                    try:
                        line_id = str(int(row[id_col]))
                    except Exception:
                        line_id = str(row[id_col]).strip()
                if not line_id:
                    continue
                name = (
                    name_by_line_id.get(line_id)
                    or line_id_to_name.get(line_id)
                    or line_id
                )
                lines_out.append({"name": name, "spend": float(row[rev_col])})
        elif rev_col and name_col:
            agg = df_lines.groupby(name_col)[rev_col].sum().reset_index()
            agg = agg.sort_values(rev_col, ascending=False)
            for _, row in agg.iterrows():
                raw_name = row[name_col]
                if raw_name != raw_name:
                    continue
                name = str(raw_name).strip()
                if not name:
                    continue
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
                df_daily.loc[:, rev_col_d] = pd.to_numeric(df_daily[rev_col_d], errors="coerce").fillna(0)
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
