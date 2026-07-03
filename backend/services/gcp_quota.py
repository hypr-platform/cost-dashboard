"""Bloqueio efetivo do gasto com BigQuery via GCP Service Usage.

Aplica um *consumer override* na quota `bigquery.googleapis.com/quota/query/usage`
(limite `/d/project`, unidade **MiB/dia**). Ao ultrapassar o override, TODA query
on-demand do projeto passa a falhar com erro de quota até a meia-noite do fuso do
Pacífico — inclusive dashboard e usuários legítimos. É o único mecanismo que de
fato *trava* (budget alert só notifica).

Requer a permissão `serviceusage.quotas.update` na service account (coberta por
roles/owner no projeto site-hypr).
"""

from __future__ import annotations

import logging
import time
from typing import Any

import google.auth
from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account

from backend import bigquery_store

logger = logging.getLogger(__name__)

_SU = "https://serviceusage.googleapis.com"
_METRIC_PATH = "bigquery.googleapis.com%2Fquota%2Fquery%2Fusage"
_LIMIT_ID = "%2Fd%2Fproject"
_LIMIT_UNIT = "1/d/{project}"
_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
_OP_TIMEOUT_SECONDS = 60
_HTTP_TIMEOUT = 30

MIB_PER_TIB = 1024 * 1024  # 1 TiB = 1.048.576 MiB


def is_enabled() -> bool:
    return bigquery_store.is_enabled()


def _session() -> AuthorizedSession:
    info = bigquery_store._credentials_info()
    if info:
        creds = service_account.Credentials.from_service_account_info(info, scopes=_SCOPES)
    else:
        creds, _ = google.auth.default(scopes=_SCOPES)
    return AuthorizedSession(creds)


def _parent() -> str:
    project = bigquery_store._project_id()
    return (
        f"projects/{project}/services/bigquery.googleapis.com/"
        f"consumerQuotaMetrics/{_METRIC_PATH}"
    )


def _poll(session: AuthorizedSession, op_name: str) -> Any:
    deadline = time.time() + _OP_TIMEOUT_SECONDS
    url = f"{_SU}/v1/{op_name}"
    while time.time() < deadline:
        resp = session.get(url, timeout=_HTTP_TIMEOUT)
        resp.raise_for_status()
        body = resp.json()
        if body.get("done"):
            if body.get("error"):
                raise RuntimeError(f"Operação de quota falhou: {body['error']}")
            return body.get("response")
        time.sleep(1.5)
    raise TimeoutError("Timeout aguardando operação de quota do GCP.")


def get_status() -> dict[str, Any]:
    """Estado atual da quota /d/project em MiB (effective/default/consumer override)."""
    session = _session()
    resp = session.get(f"{_SU}/v1beta1/{_parent()}", timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    out: dict[str, Any] = {
        "effective_mib": None,
        "default_mib": None,
        "consumer_override_mib": None,
        "consumer_override_id": None,
    }
    for lim in data.get("consumerQuotaLimits", []):
        if lim.get("unit") != _LIMIT_UNIT:
            continue
        buckets = lim.get("quotaBuckets") or []
        if not buckets:
            continue
        bucket = buckets[0]
        if bucket.get("effectiveLimit") is not None:
            out["effective_mib"] = int(bucket["effectiveLimit"])
        if bucket.get("defaultLimit") is not None:
            out["default_mib"] = int(bucket["defaultLimit"])
        override = bucket.get("consumerOverride")
        if override:
            out["consumer_override_mib"] = int(override["overrideValue"])
            out["consumer_override_id"] = override["name"].rsplit("/", 1)[-1]
    return out


def set_daily_limit_mib(mib: int) -> dict[str, Any]:
    """Define o bloqueio diário em `mib` MiB/dia (cria ou substitui o override)."""
    if mib <= 0:
        raise ValueError("mib deve ser maior que zero.")
    session = _session()
    status = get_status()
    # O consumer override não pode exceder o teto do producer/default. Limites
    # acima disso são inócuos (a quota maior já vigora), então limitamos ao teto.
    ceiling = status.get("effective_mib") or status.get("default_mib")
    if ceiling and mib > int(ceiling):
        logger.info("Override %s MiB acima do teto %s; limitando ao teto.", mib, ceiling)
        mib = int(ceiling)
    existing = status.get("consumer_override_id")
    body = {"overrideValue": str(int(mib))}
    base = f"{_SU}/v1beta1/{_parent()}/limits/{_LIMIT_ID}/consumerOverrides"
    if existing:
        # PATCH in-place: atualiza sem remover antes (não deixa o projeto sem
        # bloqueio na janela entre delete e create).
        resp = session.patch(
            f"{base}/{existing}?force=true&updateMask=overrideValue",
            json=body,
            timeout=_HTTP_TIMEOUT,
        )
    else:
        resp = session.post(f"{base}?force=true", json=body, timeout=_HTTP_TIMEOUT)
    if resp.status_code >= 400:
        # Loga o corpo completo (pode conter e-mail da SA / nº do projeto), mas
        # não propaga isso para o cliente.
        logger.error("Service Usage %s ao aplicar quota: %s", resp.status_code, resp.text)
        raise RuntimeError(f"Falha na API de quota do GCP (HTTP {resp.status_code}).")
    op = resp.json()
    if op.get("name") and not op.get("done"):
        _poll(session, op["name"])
    # Verifica que o override aplicado bate com o pedido; senão o bloqueio não
    # está de fato valendo (fail-open) e precisamos sinalizar.
    applied = get_status()
    got = applied.get("consumer_override_mib")
    if got is None or abs(int(got) - int(mib)) > max(1, int(mib) // 1000):
        raise RuntimeError(
            f"Override aplicado ({got} MiB) diverge do solicitado ({mib} MiB)."
        )
    return applied


def _delete_override(session: AuthorizedSession, override_id: str) -> None:
    url = (
        f"{_SU}/v1beta1/{_parent()}/limits/{_LIMIT_ID}"
        f"/consumerOverrides/{override_id}?force=true"
    )
    resp = session.delete(url, timeout=_HTTP_TIMEOUT)
    if resp.status_code >= 400:
        logger.error("Service Usage %s ao remover quota: %s", resp.status_code, resp.text)
        raise RuntimeError(f"Falha na API de quota do GCP (HTTP {resp.status_code}).")
    op = resp.json()
    if op.get("name") and not op.get("done"):
        _poll(session, op["name"])


def clear_daily_limit() -> bool:
    """Remove o override (volta ao teto padrão/producer). True se havia override."""
    session = _session()
    override_id = get_status().get("consumer_override_id")
    if not override_id:
        return False
    _delete_override(session, override_id)
    return True
