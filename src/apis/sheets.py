"""
Google Sheets — leitura da aba _CS Campaing Journey
"""

import json
import os
import re
import base64
from datetime import date, datetime
from pathlib import Path
from collections import defaultdict

import requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google.oauth2 import service_account

PROJECT_ROOT = Path(__file__).parent.parent.parent
SHEET_ID = "1mdEbrJJqwPjdngBO8FyCRYodhc8NQ-KKEY0pmCATuZE"
SHEET_TAB = "_CS Campaing Journey"
INVESTMENT_SHEET_ID = "15-h_4VaWwzPGedXmbsgn40UMdWuVR138tN2X1GFlV5g"
INVESTMENT_SHEET_GID = 876595792

# Índices das colunas (0-based)
COL_CLIENTE   = 0   # A
COL_CAMPANHA  = 1   # B
COL_START     = 6   # G
COL_END       = 7   # H
COL_TOKEN     = 22  # W
COL_INVESTIDO = 26  # AA — fallback legado (Net Invoice)
COL_INVESTIMENTO_TOTAL_CAMPANHA = 10  # K
COL_SHORT_TOKEN_NEW_SHEET = 112  # DI


def _normalize_header(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _resolve_account_management_col(headers: list[str]) -> int | None:
    aliases = {
        "account management",
        "account manager",
        "accountmanagement",
        "responsavel",
        "responsável",
    }
    for idx, header in enumerate(headers):
        normalized = _normalize_header(header).replace("  ", " ")
        compact = normalized.replace(" ", "")
        if normalized in aliases or compact in aliases:
            return idx
    return None


def _resolve_investido_col(headers: list[str]) -> int | None:
    aliases = {
        "net invoice after taxes",
        "netinvoiceaftertaxes",
        "net invoice after tax",
        "netinvoiceaftertax",
    }
    for idx, header in enumerate(headers):
        normalized = _normalize_header(header)
        compact = normalized.replace(" ", "")
        if normalized in aliases or compact in aliases:
            return idx
    return None


def _resolve_produto_vendido_col(headers: list[str]) -> int | None:
    aliases = {
        "produto vendido",
        "produtovendido",
        "produto",
        "product sold",
        "products sold",
        "sold product",
    }
    for idx, header in enumerate(headers):
        normalized = _normalize_header(header)
        compact = normalized.replace(" ", "")
        if normalized in aliases or compact in aliases:
            return idx
    return None


def _looks_like_header(row: list[str]) -> bool:
    normalized = {_normalize_header(col) for col in row}
    hints = {"cliente", "campanha", "token", "account management"}
    matches = sum(1 for hint in hints if hint in normalized)
    return matches >= 2


def _split_header_and_data_rows(rows: list[list[str]]) -> tuple[list[str], list[list[str]]]:
    if not rows:
        return [], []
    max_scan = min(len(rows), 10)
    for idx in range(max_scan):
        candidate = rows[idx]
        if isinstance(candidate, list) and _looks_like_header(candidate):
            return candidate, rows[idx + 1 :]
    return [], rows


def _read_service_account_info():
    """
    Resolve credencial de service account a partir de:
    - DV360_SERVICE_ACCOUNT_JSON_BASE64 (recomendado)
    - DV360_SERVICE_ACCOUNT_JSON (compat)
    """
    raw = os.getenv("DV360_SERVICE_ACCOUNT_JSON_BASE64", "").strip()
    if not raw:
        raw = os.getenv("DV360_SERVICE_ACCOUNT_JSON", "").strip()
    if not raw:
        return None

    try:
        decoded = base64.b64decode(raw, validate=True).decode("utf-8")
        parsed = json.loads(decoded)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass

    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass

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


def _get_token():
    token_path = PROJECT_ROOT / os.getenv("DV360_TOKEN_JSON", "dv360-token.json")
    if token_path.exists():
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

    sa_info = _read_service_account_info()
    if sa_info:
        scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
        creds = service_account.Credentials.from_service_account_info(sa_info, scopes=scopes)
        creds.refresh(Request())
        return creds.token

    raise FileNotFoundError(
        f"Token OAuth não encontrado em '{token_path}'. Configure DV360_TOKEN_JSON ou "
        "DV360_SERVICE_ACCOUNT_JSON_BASE64 para ler a planilha."
    )


def _parse_brl(value):
    """Converte 'R$ 30.000,00' → 30000.0"""
    if not value:
        return 0.0
    raw = str(value).strip()
    if not raw:
        return 0.0
    cleaned = re.sub(r"[R$\s]", "", raw)
    # Formato brasileiro com separador de milhar/decimal.
    if "," in cleaned:
        cleaned = cleaned.replace(".", "").replace(",", ".")
    else:
        # Sem vírgula: preserva ponto como decimal quando for o caso.
        # Ex.: 1234.56 (decimal) ou 1.234 (milhar).
        parts = cleaned.split(".")
        if len(parts) > 2:
            cleaned = "".join(parts)
        elif len(parts) == 2 and len(parts[1]) == 3:
            cleaned = "".join(parts)
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


def _normalize_short_token(value: str | None) -> str:
    normalized = re.sub(r"[^A-Z0-9]", "", (value or "").strip().upper())
    if len(normalized) == 6:
        return normalized
    return ""


def _resolve_sheet_title_by_gid(sheet_id: str, gid: int, headers: dict[str, str]) -> str | None:
    response = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}?fields=sheets(properties(sheetId,title))",
        headers=headers,
        timeout=20,
    )
    response.raise_for_status()
    sheets = response.json().get("sheets", [])
    for sheet in sheets:
        props = sheet.get("properties", {}) or {}
        if int(props.get("sheetId", -1)) == gid:
            title = str(props.get("title", "")).strip()
            return title or None
    return None


def _fetch_investido_totals_by_token(
    headers: dict[str, str], allowed_tokens: set[str] | None = None
) -> dict[str, float]:
    """Soma Investimento total da campanha (K) agrupado por Short Token (DI)."""
    import urllib.parse

    sheet_title = _resolve_sheet_title_by_gid(INVESTMENT_SHEET_ID, INVESTMENT_SHEET_GID, headers)
    if not sheet_title:
        return {}

    range_ = urllib.parse.quote(f"{sheet_title}!A1:DI")
    response = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{INVESTMENT_SHEET_ID}/values/{range_}",
        headers=headers,
        timeout=20,
    )
    response.raise_for_status()
    rows = response.json().get("values", [])
    if not rows:
        return {}

    _, data_rows = _split_header_and_data_rows(rows)
    totals_by_token: dict[str, float] = defaultdict(float)
    for row in data_rows:
        token_raw = row[COL_SHORT_TOKEN_NEW_SHEET] if len(row) > COL_SHORT_TOKEN_NEW_SHEET else ""
        token = _normalize_short_token(token_raw)
        if not token:
            continue
        if allowed_tokens is not None and token not in allowed_tokens:
            continue
        invested_raw = row[COL_INVESTIMENTO_TOTAL_CAMPANHA] if len(row) > COL_INVESTIMENTO_TOTAL_CAMPANHA else ""
        invested = _parse_brl(invested_raw)
        if invested <= 0:
            continue
        totals_by_token[token] += invested

    return dict(totals_by_token)


def _campaign_overlaps_period(
    campaign_start: date | None, campaign_end: date | None, period_start: date, period_end: date
) -> bool:
    return not ((campaign_start and campaign_start > period_end) or (campaign_end and campaign_end < period_start))


def fetch_campaign_journey(period_start: date | None = None, period_end: date | None = None):
    """
    Retorna lista de dicts:
    [{"token": str, "cliente": str, "campanha": str, "investido": float}, ...]
    """
    try:
        access_token = _get_token()
        headers = {"Authorization": f"Bearer {access_token}"}

        import urllib.parse
        range_ = urllib.parse.quote(f"{SHEET_TAB}!A1:AZ")
        r = requests.get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/{range_}",
            headers=headers,
            timeout=20,
        )
        r.raise_for_status()
        rows = r.json().get("values", [])
        if not rows:
            return {"data": [], "status": "ok", "message": ""}

        headers, data_rows = _split_header_and_data_rows(rows)
        account_management_col = _resolve_account_management_col(headers)
        investido_col = _resolve_investido_col(headers)
        produto_vendido_col = _resolve_produto_vendido_col(headers)
        if investido_col is None:
            investido_col = COL_INVESTIDO

        campaigns = []
        for row in data_rows:
            token = row[COL_TOKEN].strip() if len(row) > COL_TOKEN else ""
            if not token or len(token) != 6:
                continue
            cliente   = row[COL_CLIENTE].strip()   if len(row) > COL_CLIENTE   else ""
            campanha  = row[COL_CAMPANHA].strip()   if len(row) > COL_CAMPANHA  else ""
            investido = _parse_brl(row[investido_col]) if len(row) > investido_col else 0.0
            produto_vendido = (
                row[produto_vendido_col].strip()
                if produto_vendido_col is not None and len(row) > produto_vendido_col
                else ""
            )
            start_dt  = _parse_date(row[COL_START])    if len(row) > COL_START     else None
            end_dt    = _parse_date(row[COL_END])      if len(row) > COL_END       else None
            account_management = (
                row[account_management_col].strip()
                if account_management_col is not None and len(row) > account_management_col
                else ""
            )
            campaigns.append({
                "token":    token,
                "cliente":  cliente,
                "campanha": campanha,
                "investido": investido,
                "produto_vendido": produto_vendido,
                "start":    start_dt,
                "end":      end_dt,
                "account_management": account_management,
            })

        active_tokens_for_period: set[str] | None = None
        if period_start and period_end:
            active_tokens_for_period = {
                str(c.get("token", "")).strip().upper()
                for c in campaigns
                if _campaign_overlaps_period(c.get("start"), c.get("end"), period_start, period_end)
            }

        try:
            invested_totals_by_token = _fetch_investido_totals_by_token(headers, active_tokens_for_period)
        except Exception:
            invested_totals_by_token = {}

        for campaign in campaigns:
            token = str(campaign.get("token", "")).strip().upper()
            if token in invested_totals_by_token:
                campaign["investido"] = invested_totals_by_token[token]

        return {"data": campaigns, "status": "ok", "message": ""}

    except Exception as e:
        return {"data": [], "status": "error", "message": str(e)}


def extract_token_from_line(line_name):
    """Extrai o short token de nomes como 'ID-CIRON2_HYPR_...' → 'CIRON2'"""
    match = re.search(r"ID-([A-Z0-9]{6})[_\s]", str(line_name))
    return match.group(1) if match else None
