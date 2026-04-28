"""
Observações de lines sem token — armazenadas no PostgreSQL (fora do BigQuery).

URL (ordem): LINE_NO_TOKEN_POSTGRES_URL, POSTGRESS_DATABASE_URL, POSTGRES_DATABASE_URL, POSTGRES_URL;
DATABASE_URL só vale para postgres em localhost se LINE_OBSERVATIONS_USE_DATABASE_URL=1.

Schema: POSTGRESS_DATABASE_PG_SCHEMA ou POSTGRES_DATABASE_PG_SCHEMA; se vazio com URL definida, usa public.

Tabela sugerida:

    CREATE TABLE <schema>.line_no_token_observations (
        platform text NOT NULL,
        line_name text NOT NULL,
        line_item_id text NOT NULL DEFAULT '',
        observation text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (platform, line_name, line_item_id)
    );

Nome da tabela pode ser sobrescrito com LINE_NO_TOKEN_OBSERVATIONS_TABLE (default: line_no_token_observations).

Na primeira leitura/gravação, o backend executa CREATE SCHEMA IF NOT EXISTS (exceto para o schema public)
e CREATE TABLE IF NOT EXISTS com a estrutura acima.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from typing import Any
from urllib.parse import parse_qsl, urlparse, urlencode, urlunparse

logger = logging.getLogger(__name__)

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

_ensure_lock = threading.Lock()
_table_ready = False
_resolution_table_ready = False


def _truthy_env(value: str | None) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _is_local_postgres_host(url: str) -> bool:
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        return host in ("localhost", "127.0.0.1", "::1", "")
    except Exception:
        return False


def _resolved_postgres_url_with_key() -> tuple[str, str] | None:
    """
    Retorna (nome_da_variavel_de_ambiente, url) da fonte vencedora, para diagnóstico sem expor senha.
    """
    for key in (
        "LINE_NO_TOKEN_POSTGRES_URL",
        "POSTGRESS_DATABASE_URL",
        "POSTGRES_DATABASE_URL",
        "POSTGRES_URL",
    ):
        raw = os.getenv(key, "").strip()
        if raw:
            return key, raw

    raw = os.getenv("DATABASE_URL", "").strip()
    if not raw:
        return None
    lower = raw.lower()
    if not (lower.startswith("postgresql://") or lower.startswith("postgres://")):
        return None
    if _is_local_postgres_host(raw) and not _truthy_env(os.getenv("LINE_OBSERVATIONS_USE_DATABASE_URL")):
        return None
    return "DATABASE_URL", raw


def _database_url() -> str | None:
    """
    Ordem: LINE_NO_TOKEN_POSTGRES_URL, POSTGRESS_DATABASE_URL, POSTGRES_DATABASE_URL, POSTGRES_URL.

    DATABASE_URL só entra se for postgres:// e:
    - não for localhost, ou
    - LINE_OBSERVATIONS_USE_DATABASE_URL=1 (para usar Postgres local de propósito).

    Assim evitamos pegar o DATABASE_URL do Prisma/Next apontando para 127.0.0.1:5432 sem Postgres rodando.
    """
    pair = _resolved_postgres_url_with_key()
    return pair[1] if pair else None


def _safe_host_port_from_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        host = parsed.hostname or "?"
        if parsed.port:
            return f"{host}:{parsed.port}"
        return host
    except Exception:
        return "?"


def connection_target_summary() -> str | None:
    """Resumo seguro (sem senha) para logs ou mensagens de erro."""
    pair = _resolved_postgres_url_with_key()
    if not pair:
        return None
    key, url = pair
    return f"{key} → host {_safe_host_port_from_url(url)}"


def _dsn_has_sslmode(url: str) -> bool:
    try:
        pairs = parse_qsl(urlparse(url).query, keep_blank_values=True)
        return any(k.lower() == "sslmode" for k, _ in pairs)
    except Exception:
        return False


def _with_sslmode_require(url: str) -> str:
    parsed = urlparse(url)
    pairs = list(parse_qsl(parsed.query, keep_blank_values=True))
    if any(k.lower() == "sslmode" for k, _ in pairs):
        return url
    pairs.append(("sslmode", "require"))
    new_query = urlencode(pairs)
    return urlunparse(
        (parsed.scheme, parsed.netloc, parsed.path, parsed.params, new_query, parsed.fragment)
    )


def _dsn_connection_candidates(dsn: str) -> list[str]:
    """Tenta a URL original; em host remoto sem sslmode, tenta de novo com sslmode=require."""
    first = [dsn]
    if _dsn_has_sslmode(dsn):
        return first
    if _is_local_postgres_host(dsn):
        return first
    second = _with_sslmode_require(dsn)
    if second != dsn:
        return [dsn, second]
    return first


def _connect_psycopg(*, connect_timeout: int) -> Any:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError("Dependência psycopg ausente.") from exc

    dsn = _database_url()
    assert dsn is not None
    candidates = _dsn_connection_candidates(dsn)
    last_exc: BaseException | None = None
    for idx, candidate in enumerate(candidates):
        try:
            return psycopg.connect(candidate, connect_timeout=connect_timeout)
        except psycopg.OperationalError as exc:
            last_exc = exc
            if idx + 1 < len(candidates):
                continue
            break
        except Exception as exc:
            last_exc = exc
            break
    raise RuntimeError(_friendly_connection_error(last_exc)) from last_exc


def _friendly_connection_error(exc: BaseException | None) -> str:
    detail = str(exc) if exc else "erro desconhecido"
    summary = connection_target_summary()
    head = "Não foi possível conectar ao PostgreSQL. "
    if summary:
        head += f"Quem definiu a URL neste processo: {summary}. "

    pair = _resolved_postgres_url_with_key()
    local_hint = ""
    if pair:
        _, url = pair
        if _is_local_postgres_host(url):
            local_hint = (
                "Essa connection string aponta para esta máquina (localhost/127.0.0.1): "
                "subir o Postgres localmente ou trocar o valor por uma URL do provedor "
                "(Neon: host terminando em .neon.tech ou parecido). "
                "Reinicie o backend depois de editar o .env. "
            )

    return (
        head
        + local_hint
        + "Dica: use LINE_NO_TOKEN_POSTGRES_URL com a URL de conexão copiada do painel do Neon/Supabase "
        "(a API tenta sslmode=require em hosts que não são locais). "
        "DATABASE_URL em localhost só vale com LINE_OBSERVATIONS_USE_DATABASE_URL=1. "
        f"Detalhe técnico: {detail}"
    )


def _schema_name() -> str | None:
    raw = (
        os.getenv("POSTGRESS_DATABASE_PG_SCHEMA", "").strip()
        or os.getenv("POSTGRES_DATABASE_PG_SCHEMA", "").strip()
    )
    if raw:
        return raw
    # URL configurada sem schema explícito: quase sempre é public (Neon, RDS, local).
    if _database_url():
        return "public"
    return None


def _table_basename() -> str:
    return (
        os.getenv("LINE_NO_TOKEN_OBSERVATIONS_TABLE", "").strip()
        or "line_no_token_observations"
    )


def _resolution_table_basename() -> str:
    return (
        os.getenv("LINE_TOKEN_RESOLUTIONS_TABLE", "").strip()
        or "line_token_resolutions"
    )


def _validate_ident(name: str, label: str) -> str:
    if not _IDENTIFIER.match(name):
        raise ValueError(f"{label} inválido para SQL identifier: {name!r}")
    return name


def _qualified_table_sql() -> str:
    schema = _validate_ident(_schema_name() or "", "schema")
    table = _validate_ident(_table_basename(), "table")
    return f'"{schema}"."{table}"'


def _qualified_resolution_table_sql() -> str:
    schema = _validate_ident(_schema_name() or "", "schema")
    table = _validate_ident(_resolution_table_basename(), "table")
    return f'"{schema}"."{table}"'


def _ensure_observations_table() -> None:
    """
    Garante schema (se não for public) e tabela de observações. Idempotente; roda sob lock na primeira vez.
    """
    global _table_ready
    if not is_enabled() or _table_ready:
        return

    schema = _validate_ident(_schema_name() or "", "schema")
    table = _validate_ident(_table_basename(), "table")
    qschema = f'"{schema}"'
    qtable = f'"{schema}"."{table}"'

    with _ensure_lock:
        if _table_ready:
            return
        with _connect_psycopg(connect_timeout=15) as conn:
            with conn.cursor() as cur:
                if schema != "public":
                    cur.execute(f"CREATE SCHEMA IF NOT EXISTS {qschema}")
                cur.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS {qtable} (
                        platform text NOT NULL,
                        line_name text NOT NULL,
                        line_item_id text NOT NULL DEFAULT '',
                        observation text NOT NULL DEFAULT '',
                        updated_at timestamptz NOT NULL DEFAULT now(),
                        PRIMARY KEY (platform, line_name, line_item_id)
                    )
                    """
                )
            conn.commit()
        _table_ready = True
        logger.info("Tabela de observações lines sem token verificada/criada: %s.%s", schema, table)


def _ensure_resolution_table() -> None:
    """
    Garante a tabela que resolve token por line estável. Idempotente; roda sob lock.
    """
    global _resolution_table_ready
    if not is_enabled() or _resolution_table_ready:
        return

    schema = _validate_ident(_schema_name() or "", "schema")
    table = _validate_ident(_resolution_table_basename(), "table")
    qschema = f'"{schema}"'
    qtable = f'"{schema}"."{table}"'

    with _ensure_lock:
        if _resolution_table_ready:
            return
        with _connect_psycopg(connect_timeout=15) as conn:
            with conn.cursor() as cur:
                if schema != "public":
                    cur.execute(f"CREATE SCHEMA IF NOT EXISTS {qschema}")
                cur.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS {qtable} (
                        platform text NOT NULL,
                        line_key text NOT NULL,
                        line_item_id text NOT NULL DEFAULT '',
                        current_line_name text NOT NULL DEFAULT '',
                        manual_line_name text NOT NULL DEFAULT '',
                        manual_token text NOT NULL DEFAULT '',
                        historical_line_name text NOT NULL DEFAULT '',
                        historical_token text NOT NULL DEFAULT '',
                        source text NOT NULL DEFAULT '',
                        updated_by text NOT NULL DEFAULT '',
                        created_at timestamptz NOT NULL DEFAULT now(),
                        updated_at timestamptz NOT NULL DEFAULT now(),
                        PRIMARY KEY (platform, line_key)
                    )
                    """
                )
            conn.commit()
        _resolution_table_ready = True
        logger.info("Tabela de resolução de tokens verificada/criada: %s.%s", schema, table)


def is_enabled() -> bool:
    return bool(_database_url() and _schema_name())


def _normalize_line_item_id(value: Any) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    return s


def _normalize_token(value: Any) -> str:
    token = re.sub(r"[^A-Z0-9]", "", str(value or "").strip().upper())
    return token if len(token) == 6 else ""


def extract_token_from_manual_line_name(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    match = re.search(r"ID-([A-Z0-9]{6})(?:[_\s|]|$)", text.upper())
    if match:
        return match.group(1)
    return _normalize_token(text)


def _line_key(platform: str, line: str, line_item_id: str | None) -> str:
    lid = _normalize_line_item_id(line_item_id)
    if lid:
        return lid
    return str(line or "").strip()


def row_natural_key(row: dict[str, Any]) -> tuple[str, str, str]:
    platform = str(row.get("platform") or "").strip()
    line = str(row.get("line") or "").strip()
    lid = _normalize_line_item_id(row.get("line_item_id"))
    return platform, line, lid


def row_resolution_key(row: dict[str, Any]) -> tuple[str, str] | None:
    platform = str(row.get("platform") or "").strip()
    line = str(row.get("line") or row.get("name") or "").strip()
    key = _line_key(platform, line, row.get("line_item_id"))
    if not platform or not key:
        return None
    return platform, key


def fetch_observation_map(rows: list[dict[str, Any]]) -> dict[tuple[str, str, str], str]:
    if not rows or not is_enabled():
        return {}
    keys = []
    seen: set[tuple[str, str, str]] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        k = row_natural_key(row)
        if k[0] and k[1] and k not in seen:
            seen.add(k)
            keys.append(k)
    if not keys:
        return {}

    qtable = _qualified_table_sql()
    out: dict[tuple[str, str, str], str] = {}

    try:
        _ensure_observations_table()
    except Exception:
        logger.exception("Falha ao criar/verificar tabela de observações no PostgreSQL.")
        return {}

    chunk_size = 300
    for i in range(0, len(keys), chunk_size):
        chunk = keys[i : i + chunk_size]
        conditions: list[str] = []
        flat: list[Any] = []
        for p, ln, lid in chunk:
            conditions.append("(%s::text = platform AND %s::text = line_name AND %s::text = line_item_id)")
            flat.extend([p, ln, lid])
        sql = (
            f"SELECT platform, line_name, line_item_id, observation FROM {qtable} WHERE "
            + " OR ".join(conditions)
        )
        with _connect_psycopg(connect_timeout=8) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, flat)
                for rec in cur.fetchall():
                    p, ln, lid, obs = rec[0], rec[1], rec[2], rec[3] if len(rec) > 3 else ""
                    out[(str(p), str(ln), _normalize_line_item_id(lid))] = str(obs or "")
    return out


def upsert_observation(platform: str, line: str, line_item_id: str | None, observation: str) -> None:
    if not is_enabled():
        raise RuntimeError("PostgreSQL para observações não está configurado.")
    p = str(platform or "").strip()
    ln = str(line or "").strip()
    if not p or not ln:
        raise ValueError("`platform` e `line` são obrigatórios.")
    lid = _normalize_line_item_id(line_item_id)
    obs = str(observation or "")
    if len(obs) > 8000:
        raise ValueError("Observação excede o limite de 8000 caracteres.")

    qtable = _qualified_table_sql()
    sql = f"""
        INSERT INTO {qtable} (platform, line_name, line_item_id, observation, updated_at)
        VALUES (%s, %s, %s, %s, now())
        ON CONFLICT (platform, line_name, line_item_id)
        DO UPDATE SET observation = EXCLUDED.observation, updated_at = EXCLUDED.updated_at
    """
    _ensure_observations_table()
    with _connect_psycopg(connect_timeout=8) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (p, ln, lid, obs))
        conn.commit()


def fetch_resolution_map(rows: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, str]]:
    if not rows or not is_enabled():
        return {}
    keys: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        k = row_resolution_key(row)
        if k and k not in seen:
            seen.add(k)
            keys.append(k)
    if not keys:
        return {}

    try:
        _ensure_resolution_table()
    except Exception:
        logger.exception("Falha ao criar/verificar tabela de resolução de tokens no PostgreSQL.")
        return {}

    qtable = _qualified_resolution_table_sql()
    out: dict[tuple[str, str], dict[str, str]] = {}
    chunk_size = 300
    for i in range(0, len(keys), chunk_size):
        chunk = keys[i : i + chunk_size]
        conditions: list[str] = []
        flat: list[Any] = []
        for platform, line_key in chunk:
            conditions.append("(%s::text = platform AND %s::text = line_key)")
            flat.extend([platform, line_key])
        sql = f"""
            SELECT platform, line_key, line_item_id, current_line_name, manual_line_name,
                   manual_token, historical_line_name, historical_token, source, updated_by
            FROM {qtable}
            WHERE {" OR ".join(conditions)}
        """
        with _connect_psycopg(connect_timeout=8) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, flat)
                for rec in cur.fetchall():
                    platform, line_key = str(rec[0]), str(rec[1])
                    out[(platform, line_key)] = {
                        "line_item_id": str(rec[2] or ""),
                        "current_line_name": str(rec[3] or ""),
                        "manual_line_name": str(rec[4] or ""),
                        "manual_token": str(rec[5] or ""),
                        "historical_line_name": str(rec[6] or ""),
                        "historical_token": str(rec[7] or ""),
                        "source": str(rec[8] or ""),
                        "updated_by": str(rec[9] or ""),
                    }
    return out


def upsert_line_token_history(rows: list[dict[str, Any]]) -> None:
    if not rows or not is_enabled():
        return
    prepared: list[tuple[str, str, str, str, str, str]] = []
    seen: set[tuple[str, str]] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        platform = str(row.get("platform") or "").strip()
        line = str(row.get("line") or row.get("name") or "").strip()
        line_item_id = _normalize_line_item_id(row.get("line_item_id"))
        token = _normalize_token(row.get("token") or row.get("resolved_token"))
        key = _line_key(platform, line, line_item_id)
        if not platform or not key or not token:
            continue
        natural = (platform, key)
        if natural in seen:
            continue
        seen.add(natural)
        prepared.append((platform, key, line_item_id, line, line, token))
    if not prepared:
        return

    _ensure_resolution_table()
    qtable = _qualified_resolution_table_sql()
    sql = f"""
        INSERT INTO {qtable} AS target (
            platform, line_key, line_item_id, current_line_name,
            historical_line_name, historical_token, source, updated_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, 'name_extracted', now())
        ON CONFLICT (platform, line_key)
        DO UPDATE SET
            line_item_id = EXCLUDED.line_item_id,
            current_line_name = EXCLUDED.current_line_name,
            historical_line_name = EXCLUDED.historical_line_name,
            historical_token = EXCLUDED.historical_token,
            source = CASE
                WHEN target.manual_token <> '' THEN target.source
                ELSE 'name_extracted'
            END,
            updated_at = EXCLUDED.updated_at
    """
    with _connect_psycopg(connect_timeout=8) as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, prepared)
        conn.commit()


def upsert_manual_line_name(
    platform: str,
    line: str,
    line_item_id: str | None,
    manual_line_name: str,
    *,
    updated_by: str = "",
) -> str:
    if not is_enabled():
        raise RuntimeError("PostgreSQL para resolução de tokens não está configurado.")
    p = str(platform or "").strip()
    ln = str(line or "").strip()
    lid = _normalize_line_item_id(line_item_id)
    manual_name = str(manual_line_name or "").strip()
    if not p:
        raise ValueError("`platform` é obrigatório.")
    if not ln and not lid:
        raise ValueError("`line` ou `line_item_id` é obrigatório.")
    if not manual_name:
        raise ValueError("Informe o nome correto da line.")
    if len(manual_name) > 8192:
        raise ValueError("Nome da line excede o limite de 8192 caracteres.")
    token = extract_token_from_manual_line_name(manual_name)
    if not token:
        raise ValueError("O nome informado precisa conter um token no padrão ID-XXXXXX ou um short token de 6 caracteres.")

    key = _line_key(p, ln, lid)
    qtable = _qualified_resolution_table_sql()
    sql = f"""
        INSERT INTO {qtable} (
            platform, line_key, line_item_id, current_line_name,
            manual_line_name, manual_token, source, updated_by, updated_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, 'manual', %s, now())
        ON CONFLICT (platform, line_key)
        DO UPDATE SET
            line_item_id = EXCLUDED.line_item_id,
            current_line_name = EXCLUDED.current_line_name,
            manual_line_name = EXCLUDED.manual_line_name,
            manual_token = EXCLUDED.manual_token,
            source = 'manual',
            updated_by = EXCLUDED.updated_by,
            updated_at = EXCLUDED.updated_at
    """
    _ensure_resolution_table()
    with _connect_psycopg(connect_timeout=8) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (p, key, lid, ln, manual_name, token, str(updated_by or "").strip()))
        conn.commit()
    return token


def merge_observations_into_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Anexa o campo `observation` em cada entrada de attention.no_token_rows quando o PG está ativo.
    """
    if not is_enabled():
        return payload
    attention = payload.get("attention")
    if not isinstance(attention, dict):
        return payload
    rows = attention.get("no_token_rows")
    if not isinstance(rows, list) or not rows:
        return payload

    dict_rows = [r for r in rows if isinstance(r, dict)]
    try:
        obs_map = fetch_observation_map(dict_rows)
    except Exception:
        logger.exception("Falha ao buscar observações de lines sem token no PostgreSQL.")
        return payload

    new_rows: list[Any] = []
    for r in rows:
        if not isinstance(r, dict):
            new_rows.append(r)
            continue
        row_copy = dict(r)
        key = row_natural_key(row_copy)
        row_copy["observation"] = obs_map.get(key, str(row_copy.get("observation") or ""))
        new_rows.append(row_copy)

    out = dict(payload)
    att = dict(attention)
    att["no_token_rows"] = new_rows
    out["attention"] = att
    return out
