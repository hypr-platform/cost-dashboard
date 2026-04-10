"""
Taxa de câmbio USD/BRL via Banco Central do Brasil (PTAX).
API oficial, gratuita, sem chave. Atualiza todo dia útil.
"""

import requests
from datetime import date, timedelta

_cache: dict = {"rate": None, "date": None}


def _fetch_ptax(ref_date: date):
    date_str = ref_date.strftime("%m-%d-%Y")
    url = (
        f"https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/"
        f"CotacaoDolarDia(dataCotacao=@dataCotacao)"
        f"?@dataCotacao='{date_str}'&$top=1&$format=json&$select=cotacaoVenda"
    )
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        values = resp.json().get("value", [])
        if values:
            return float(values[0]["cotacaoVenda"])
    except Exception:
        pass
    return None


def get_usd_to_brl() -> float:
    today = date.today()
    if _cache["rate"] and _cache["date"] == today:
        return _cache["rate"]

    # Tenta hoje e até 5 dias anteriores (fins de semana e feriados não têm PTAX)
    for delta in range(6):
        ref = today - timedelta(days=delta)
        rate = _fetch_ptax(ref)
        if rate:
            _cache["rate"] = rate
            _cache["date"] = today
            return rate

    return 5.15  # fallback


def to_brl(usd: float) -> float:
    return usd * get_usd_to_brl()


def fmt_brl(usd: float) -> str:
    return f"R$ {to_brl(usd):,.2f}"
