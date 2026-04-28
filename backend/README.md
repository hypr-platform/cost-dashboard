# Backend - Cost Dashboard

API FastAPI que consolida custos do mês corrente das DSPs, persiste snapshots no BigQuery e entrega payload pronto para o frontend.

## Visao geral da arquitetura

1. O backend roda workers internos em paralelo.
2. Os workers fazem refresh periodico das integracoes (StackAdapt, DV360, Xandr, Hivestack, Nexd, Sheets, PTAX).
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
- `DV360_REPORT_POLL_TIMEOUT_SECONDS` (default: `240`)
- `DASHBOARD_FAST_WORKER_INTERVAL_SECONDS` (default: `600`)
- `DASHBOARD_DV360_WORKER_INTERVAL_SECONDS` (default: `1800`)
- `FRONTEND_ORIGIN` (default recomendado: `http://localhost:3000`)

## Frequencia de atualizacao

| Origem | Trigger | Frequencia default | O que atualiza |
| --- | --- | ---: | --- |
| Worker rapido | `scheduled_fast` | 600s (10 min) | StackAdapt, Xandr, Hivestack, Sheets/PTAX/Nexd e reaproveita o ultimo DV360 `ok`, marcado como snapshot reaproveitado |
| Worker DV360 | `scheduled_dv360` | 1800s (30 min) | DV360 e reaproveita as demais plataformas `ok` do snapshot anterior, marcadas como snapshot reaproveitado |
| Botao do frontend | `manual_api` | sob demanda | Todas as plataformas, incluindo DV360 |
| `force_refresh=true` | `force_refresh` | sob demanda | Todas as plataformas, de forma sincrona |

O timeout geral das integracoes rapidas e `DASHBOARD_INTEGRATION_TIMEOUT_SECONDS` (45s). A DV360 tem dois limites: `DV360_REPORT_POLL_TIMEOUT_SECONDS` controla quanto tempo o cliente espera o relatorio assíncrono do Google ficar pronto, e `DASHBOARD_DV360_TIMEOUT_SECONDS` controla quanto tempo o dashboard espera a integracao DV360 inteira terminar.

Se aumentar a tolerancia da DV360, deixe `DASHBOARD_DV360_TIMEOUT_SECONDS` maior que `DV360_REPORT_POLL_TIMEOUT_SECONDS`, porque depois do relatorio pronto ainda existe download de CSV, parse e enriquecimento com metadados. Exemplo:

```env
DV360_REPORT_POLL_TIMEOUT_SECONDS=480
DASHBOARD_DV360_TIMEOUT_SECONDS=600
```

### Trade-offs da separacao da DV360

- O `scheduled_fast` deixa de bloquear por causa da DV360, entao o snapshot rapido continua atualizando as demais plataformas.
- A DV360 pode aparecer com dados mais antigos que as outras plataformas ate o proximo `scheduled_dv360` bem-sucedido.
- Se a DV360 falhar no `scheduled_dv360` ou em um refresh manual, o payload mantem `status=error` e o alerta continua sendo enviado; erro de tentativa real nao e mascarado.
- Quando existe snapshot anterior valido, apenas plataformas nao consultadas no ciclo atual sao reaproveitadas para evitar paginas/linhas zeradas.

## Atualizacao manual no frontend

Ao clicar em `Atualizar dados`, o frontend chama `POST /api/dashboard/refresh` com o periodo atualmente selecionado. Esse endpoint apenas dispara um refresh assincrono (`manual_api`) e retorna rapido; o navegador nao fica esperando todas as APIs terminarem.

Enquanto o refresh roda, o frontend consulta `/api/dashboard/refresh/status` a cada 2s. O botao fica desabilitado, o tempo decorrido aparece na UI e, quando o backend marca o run como `success`, o frontend chama novamente `/api/dashboard` para buscar o snapshot atualizado e tambem recarrega as metricas de refresh. Se o backend marcar `error`, a UI mostra toast de falha.

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
4. `_build_payload` consulta as plataformas do trigger em paralelo com `ThreadPoolExecutor`.
5. Plataformas fora do trigger atual sao reaproveitadas do ultimo snapshot `ok`.
6. Em falha/timeout de plataforma consultada no trigger atual, o payload mantem `status=error`.
7. O payload consolidado recebe `_meta.snapshot_at`.
8. O snapshot e gravado no BigQuery (`dashboard_snapshots`) e o run em `dashboard_refresh_runs`.
9. `/api/dashboard` responde com cache em memoria (TTL), BigQuery ou refresh live quando necessario.
