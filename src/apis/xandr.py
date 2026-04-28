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
import logging
from datetime import date


BASE_URL = "https://api.appnexus.com"
REPORT_POLL_TIMEOUT_SECONDS = 90
REPORT_POLL_INTERVAL_SECONDS = 2

_token_cache: dict = {"token": None, "expires_at": 0}
logger = logging.getLogger(__name__)


class XandrApiError(RuntimeError):
    pass


def _format_api_error(response: requests.Response, context: str) -> str:
    parts = [
        f"{context} falhou",
        f"HTTP {response.status_code}",
        f"reason={response.reason or 'sem reason'}",
        f"url={response.url}",
    ]
    try:
        payload = response.json()
    except ValueError:
        raw_body = response.text.strip()
        if raw_body:
            parts.append(f"body={raw_body[:500]}")
        return " - ".join(parts)

    response_payload = payload.get("response", {}) if isinstance(payload, dict) else {}
    if isinstance(response_payload, dict):
        error_id = response_payload.get("error_id")
        error = response_payload.get("error")
        error_description = response_payload.get("error_description")
        dbg_info = response_payload.get("dbg_info") or response_payload.get("debug_info") or {}
        request_id = (
            dbg_info.get("request_id") or dbg_info.get("instance")
            if isinstance(dbg_info, dict)
            else None
        )

        if error_id:
            parts.append(f"error_id={error_id}")
        if error:
            parts.append(f"error={error}")
        if error_description:
            parts.append(f"description={error_description}")
        if request_id:
            parts.append(f"debug_id={request_id}")
    return " - ".join(parts)


def _raise_for_xandr_error(response: requests.Response, context: str) -> None:
    if response.ok:
        return
    message = _format_api_error(response, context)
    logger.warning(message)
    raise XandrApiError(message)


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
    _raise_for_xandr_error(resp, "Autenticação Xandr")
    data = resp.json()
    token = data.get("response", {}).get("token")
    if not token:
        raise XandrApiError(_format_api_error(resp, "Autenticação Xandr sem token"))
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
            _raise_for_xandr_error(r, "Criação de relatório Xandr")
            report_id = r.json().get("response", {}).get("report_id")
            if not report_id:
                return None, r.json().get("response", {}).get("error", "Report ID não retornado")

            status = ""
            deadline = time.time() + REPORT_POLL_TIMEOUT_SECONDS
            while time.time() < deadline:
                sr = requests.get(f"{BASE_URL}/report?id={report_id}", headers=headers, timeout=30)
                _raise_for_xandr_error(sr, "Status de relatório Xandr")
                response_payload = sr.json().get("response", {})
                status = str(response_payload.get("execution_status", "")).lower()
                if status == "ready":
                    break
                if status in {"failed", "failure", "error"}:
                    error_message = response_payload.get("error", "Report status marcado como failed")
                    return None, f"Relatório Xandr falhou: {error_message}"
                time.sleep(REPORT_POLL_INTERVAL_SECONDS)

            if status != "ready":
                status_msg = status or "desconhecido"
                return None, (
                    f"Timeout no relatório Xandr após {REPORT_POLL_TIMEOUT_SECONDS}s "
                    f"(último status: {status_msg})"
                )

            dl = requests.get(f"{BASE_URL}/report-download?id={report_id}", headers=headers, timeout=60)
            _raise_for_xandr_error(dl, "Download de relatório Xandr")
            return pd.read_csv(io.StringIO(dl.text)), None

        # Relatório por line item e media type
        df, err = _run_report(["day", "line_item_name", "line_item_id", "media_type", "spend"])
        if err or df is None:
            return {"spend": 0.0, "currency": "USD", "status": "error", "message": err or "Sem dados",
                    "lines": [], "cost_types": [], "daily": []}

        spend_col = next((c for c in df.columns if "spend" in c.lower()), None)
        if spend_col:
            df.loc[:, spend_col] = pd.to_numeric(df[spend_col], errors="coerce").fillna(0)

        total = float(df[spend_col].sum()) if spend_col else 0.0

        # Lines
        lines_out = []
        line_col = next((c for c in df.columns if c.lower() == "line_item_name"), None)
        line_id_col = next((c for c in df.columns if c.lower() == "line_item_id"), None)
        if line_col and spend_col and line_id_col:
            agg = (
                df.groupby([line_id_col, line_col], dropna=False)[spend_col]
                .sum()
                .reset_index()
                .sort_values(spend_col, ascending=False)
            )
            for _, row in agg.iterrows():
                raw_id = row[line_id_col]
                line_item_id = "" if raw_id != raw_id else str(raw_id).strip()
                lines_out.append(
                    {
                        "name": str(row[line_col]),
                        "spend": float(row[spend_col]),
                        "line_item_id": line_item_id or None,
                    }
                )
        elif line_col and spend_col:
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
