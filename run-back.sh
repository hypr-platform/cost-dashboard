#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

source ".venv/bin/activate"
pip install -r requirements.txt

uvicorn_cmd=(uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000)
if [ -f ".env" ]; then
  uvicorn_cmd+=(--env-file ".env")
fi

echo "API (Uvicorn): http://127.0.0.1:8000 — use ./run-front.sh para o Next em http://localhost:3000"
exec "${uvicorn_cmd[@]}"
