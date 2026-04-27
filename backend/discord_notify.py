"""
Alertas via webhook do Discord (opcional).

Configure DISCORD_WEBHOOK_URL com a URL do webhook do canal.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import date
from typing import Any

import requests

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_last_fingerprint_at: dict[str, float] = {}


def webhook_configured() -> bool:
    return bool(os.getenv("DISCORD_WEBHOOK_URL", "").strip())


def _cooldown_seconds() -> float:
    raw = os.getenv("DISCORD_ALERT_COOLDOWN_SECONDS", "600").strip()
    try:
        value = float(raw)
        return max(0.0, value)
    except ValueError:
        return 600.0


def _partial_alerts_enabled() -> bool:
    return os.getenv("DISCORD_NOTIFY_PARTIAL_FAILURES", "true").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def _should_send(fingerprint: str) -> bool:
    cooldown = _cooldown_seconds()
    if cooldown <= 0:
        return True
    now = time.time()
    with _lock:
        last = _last_fingerprint_at.get(fingerprint, 0.0)
        if now - last < cooldown:
            return False
        _last_fingerprint_at[fingerprint] = now
        return True


def _post_embed(*, title: str, description: str, color: int = 15158332) -> None:
    url = os.getenv("DISCORD_WEBHOOK_URL", "").strip()
    if not url:
        return
    body: dict[str, Any] = {
        "embeds": [
            {
                "title": title[:256],
                "description": description[:4000],
                "color": color,
            }
        ]
    }
    try:
        resp = requests.post(url, json=body, timeout=10)
        resp.raise_for_status()
    except Exception:
        logger.exception("Falha ao enviar alerta ao Discord.")


def collect_partial_issues(payload: dict[str, Any]) -> tuple[list[str], list[str]]:
    """
    Retorna (linhas para o embed, nomes estáveis para deduplicação no cooldown).
    """
    lines: list[str] = []
    names: list[str] = []

    pr = payload.get("platform_results") or {}
    if isinstance(pr, dict):
        for platform_name in sorted(pr.keys(), key=str):
            data = pr.get(platform_name)
            if not isinstance(data, dict):
                continue
            if data.get("status") == "ok":
                continue
            key = str(platform_name)
            names.append(key)
            msg = str(data.get("message") or "sem mensagem").strip()[:900]
            lines.append(f"**{key}**: {msg}")

    if payload.get("journey_status") == "error":
        names.append("campaign_journey")
        jm = str(payload.get("journey_message") or "sem mensagem").strip()[:900]
        lines.append(f"**Campaign journey**: {jm}")

    nexd = payload.get("nexd") or {}
    if isinstance(nexd, dict) and nexd.get("status") != "ok":
        names.append("Nexd")
        nm = str(nexd.get("message") or "sem mensagem").strip()[:900]
        lines.append(f"**Nexd**: {nm}")

    return lines, names


def notify_dashboard_refresh_failed(
    *,
    trigger: str,
    run_id: str | None,
    exc: BaseException,
    period_start: date,
    period_end: date,
) -> None:
    if not webhook_configured():
        return
    fingerprint = f"full:{trigger}:{type(exc).__name__}"
    if not _should_send(fingerprint):
        return
    msg = str(exc).strip()[:3500]
    period = f"{period_start.isoformat()} → {period_end.isoformat()}"
    rid = run_id or "—"
    desc = (
        f"**Trigger:** `{trigger}`\n"
        f"**Run ID:** `{rid}`\n"
        f"**Período:** {period}\n"
        f"**Tipo:** `{type(exc).__name__}`\n\n"
        f"```{msg}```"
    )
    _post_embed(title="Cost Dashboard — refresh falhou", description=desc)


def notify_dashboard_partial_errors(
    *,
    trigger: str,
    run_id: str | None,
    lines: list[str],
    names: list[str],
) -> None:
    if not webhook_configured() or not _partial_alerts_enabled():
        return
    if not lines or not names:
        return
    fingerprint = "partial:" + trigger + ":" + ",".join(sorted(names))
    if not _should_send(fingerprint):
        return
    body = "\n".join(lines)[:3800]
    rid = run_id or "—"
    desc = f"**Trigger:** `{trigger}`\n**Run ID:** `{rid}`\n\n{body}"
    _post_embed(title="Cost Dashboard — integrações com erro", description=desc)


def maybe_notify_partial_after_refresh(
    *,
    trigger: str,
    run_id: str | None,
    payload: dict[str, Any],
) -> None:
    lines, names = collect_partial_issues(payload)
    if not lines:
        return
    notify_dashboard_partial_errors(trigger=trigger, run_id=run_id, lines=lines, names=names)
