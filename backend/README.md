# Backend - Cost Dashboard

API FastAPI que consolida custos do mês corrente das DSPs, persiste snapshots no BigQuery e entrega payload pronto para o frontend.

## Visao geral da arquitetura

1. O backend roda workers internos em paralelo.
2. Os workers fazem refresh periodico das integracoes (StackAdapt, DV360, Xandr, Amazon DSP, Nexd, Sheets, PTAX).
3. Cada refresh gera um snapshot consolidado.
4. O snapshot e salvo no BigQuery (dataset `cost_dashboard_rt`).
5. O endpoint `/api/dashboard` le prioritariamente o snapshot (BigQuery/cache), com opcao de forcar refresh.
6. Budget targets (`/api/budget-target`) tambem sao persistidos no BigQuery.

## Endpoints

- `GET /health`
- `GET /api/dashboard`
  - query params opcionais:
    - `start=YYYY-MM-DD`
    - `end=YYYY-MM-DD`
    - `force_refresh=true|false` (refresh sincrono imediato)
- `POST /api/dashboard/refresh`
  - dispara refresh assincrono (manual) para o periodo informado
- `GET /api/dashboard/refresh/status`
  - status do ultimo run de refresh
- `GET /api/budget-target`
- `PUT /api/budget-target`
- `DELETE /api/budget-target`

## BigQuery (snapshot store)

Quando `BQ_PROJECT_ID` e `GCP_CREDS_JSON_CREDS_BASE64` estao configurados, o backend cria automaticamente:

- dataset: `cost_dashboard_rt` (ou `BQ_DATASET_ID`)
- tabela: `dashboard_snapshots`
- tabela: `dashboard_refresh_runs`
- tabela: `budget_targets_history`

As tabelas sao criadas em startup/primeiro acesso, na localizacao `US` (ou `BQ_LOCATION`).

## Variaveis de ambiente

### Integracoes DSP

- `STACKADAPT_API_KEY`
- `DV360_SERVICE_ACCOUNT_JSON_BASE64`
- `DV360_PARTNER_ID`
- `DV360_ADVERTISER_IDS`
- `DV360_TOKEN_JSON`
- `DV360_OAUTH_JSON`
- `XANDR_USERNAME`
- `XANDR_PASSWORD`
- `XANDR_ADVERTISER_IDS`
- `AMAZON_CLIENT_ID`
- `AMAZON_CLIENT_SECRET`
- `AMAZON_REFRESH_TOKEN`
- `AMAZON_DSP_ADVERTISER_IDS`
- `AMAZON_DSP_REGION`
- `NEXD_API_KEY`

### BigQuery

- `BQ_PROJECT_ID`
- `GCP_CREDS_JSON_CREDS_BASE64` (JSON da service account em Base64)
- `BQ_DATASET_ID` (default: `cost_dashboard_rt`)
- `BQ_LOCATION` (default: `US`)

### Performance / workers

- `DASHBOARD_CACHE_TTL_SECONDS` (default: `300`)
- `DASHBOARD_INTEGRATION_TIMEOUT_SECONDS` (default: `45`)
- `DASHBOARD_DV360_TIMEOUT_SECONDS` (default: `240`)
- `DASHBOARD_FAST_WORKER_INTERVAL_SECONDS` (default: `600`)
- `DASHBOARD_DV360_WORKER_INTERVAL_SECONDS` (default: `1800`)
- `FRONTEND_ORIGIN` (default recomendado: `http://localhost:3000`)

## Como rodar localmente

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

API local: `http://localhost:8000`.

## Fluxo tecnico detalhado

1. `backend/main.py` sobe a API e inicia workers (`start_background_workers`).
2. Worker rapido e worker DV360 rodam em paralelo e disparam refresh periodico.
3. Cada refresh chama `dashboard_service._build_payload`.
4. `_build_payload` consulta plataformas em paralelo com `ThreadPoolExecutor`.
5. Em falha/timeout da DV360, o servico usa fallback do ultimo snapshot valido (evita lines zeradas).
6. O payload consolidado recebe `_meta.snapshot_at`.
7. O snapshot e gravado no BigQuery (`dashboard_snapshots`) e o run em `dashboard_refresh_runs`.
8. `/api/dashboard` responde com cache em memoria (TTL), BigQuery ou refresh live quando necessario.
