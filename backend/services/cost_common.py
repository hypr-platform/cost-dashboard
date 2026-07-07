"""Helpers compartilhados pelas abas de custo (BigQuery, Notas Fiscais, Vercel).

Consolida o que era copiado em cada `*_cost_service.py`: cache TTL thread-safe,
parsing de data e validação de janela. Cada serviço injeta seu próprio TTL e
limite de dias (lidos de env vars distintas) — a mecânica é idêntica, só a
configuração muda.
"""

from __future__ import annotations

import os
import threading
import time
from datetime import date
from typing import Callable, Generic, TypeVar

T = TypeVar("T")


def env_int(name: str, default: int, *, minimum: int = 0) -> int:
    """Lê um inteiro de env var, aplicando piso e caindo no default se ausente
    ou inválido."""
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return max(minimum, int(raw))
    except ValueError:
        return default


class TTLCache(Generic[T]):
    """Cache em memória, thread-safe, com TTL resolvido dinamicamente.

    O TTL é lido a cada acesso (via `ttl_seconds`) para respeitar mudanças de
    env var em runtime; `ttl <= 0` desliga o cache por completo.
    """

    def __init__(self, ttl_seconds: Callable[[], int]) -> None:
        self._ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._store: dict[str, tuple[float, T]] = {}

    def get(self, key: str) -> T | None:
        ttl = self._ttl_seconds()
        if ttl <= 0:
            return None
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            ts, payload = entry
            if time.time() - ts > ttl:
                self._store.pop(key, None)
                return None
            return payload

    def put(self, key: str, payload: T) -> None:
        if self._ttl_seconds() <= 0:
            return
        with self._lock:
            self._store[key] = (time.time(), payload)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()


def parse_date(value: str | None, *, field: str) -> date:
    """Converte `YYYY-MM-DD` em `date`, com mensagens de erro padronizadas."""
    if not value:
        raise ValueError(f"`{field}` é obrigatório (YYYY-MM-DD).")
    try:
        return date.fromisoformat(value.strip())
    except ValueError as exc:
        raise ValueError(f"`{field}` deve estar no formato YYYY-MM-DD.") from exc


def resolve_window(
    from_str: str | None, to_str: str | None, *, max_days: int
) -> tuple[date, date]:
    """Valida e resolve a janela `[from, to]`, garantindo ordem e span máximo."""
    from_d = parse_date(from_str, field="from")
    to_d = parse_date(to_str, field="to")
    if from_d > to_d:
        raise ValueError("`from` deve ser anterior ou igual a `to`.")
    span = (to_d - from_d).days + 1
    if span > max_days:
        raise ValueError(f"Intervalo máximo é {max_days} dias (recebido: {span}).")
    return from_d, to_d
