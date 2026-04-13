#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$PROJECT_DIR/frontend"

cd "$FRONTEND_DIR"
npm install

if [ ! -f ".env.local" ] && [ -f ".env.local.example" ]; then
  cp .env.local.example .env.local
fi

if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Erro: a porta 3000 já está em uso. O Next.js precisa dela para o frontend."
  echo "O backend (Uvicorn) deve rodar na porta 8000 (./run-back.sh). Processo atual na 3000:"
  lsof -nP -iTCP:3000 -sTCP:LISTEN
  echo "Pare o processo acima (ex.: kill <PID>) ou mova o serviço para outra porta."
  exit 1
fi

exec npm run dev
