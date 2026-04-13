# Documentacao Completa da Plataforma Cost Dashboard

## 1) Visao Geral

O **Cost Dashboard** consolida custos de midia paga no periodo **month-to-date (MTD)**, cruza os gastos com a planilha de Campaign Journey (por token) e entrega uma visao operacional para negocio, operacao e account management.

### Objetivos principais

- Consolidar investimento por plataforma (StackAdapt, DV360, Xandr, Amazon DSP, Hivestack e Nexd estimado).
- Padronizar tudo em BRL para comparacao unica.
- Apontar riscos de governanca:
  - lines sem token;
  - gastos fora da vigencia da campanha;
  - discrepancia entre gasto e investido da planilha.
- Disponibilizar snapshots rapidos com refresh controlado, sem depender de leitura live a cada requisicao.

---

## 2) Arquitetura de Alto Nivel

### Camadas

- **Frontend:** `frontend/` (Next.js App Router + SWR + Recharts + Clerk).
- **Backend API:** `backend/main.py` (FastAPI).
- **Servico de consolidacao:** `backend/dashboard_service.py`.
- **Integracoes externas:** `src/apis/*.py`.
- **Utilitarios de dominio:** `src/utils/*.py`.
- **Persistencia de snapshots e execucoes:** BigQuery (`backend/bigquery_store.py`).

### Fluxo resumido

1. Backend calcula periodo MTD (`inicio do mes -> hoje`).
2. Integracoes rodam em paralelo com timeout por fonte.
3. Custos USD sao convertidos para BRL via PTAX (Banco Central).
4. Dados de campanha da planilha sao carregados e correlacionados por token.
5. Payload consolidado e enriquecido com seções de dashboard, atencao e budget.
6. Snapshot vai para cache em memoria e, quando habilitado, para BigQuery.
7. Frontend consome `/api/dashboard`, exibe snapshot e controla refresh.

---

## 3) Regras de Negocio (Core)

Estas sao as regras que governam o comportamento funcional da plataforma:

- **Periodo padrao do dashboard:** sempre MTD (do primeiro dia do mes ate hoje), salvo quando `start/end` sao enviados manualmente.
- **Moeda de consolidacao:** todo valor e normalizado para BRL para comparabilidade entre fontes.
- **Conversao cambial oficial:** USD -> BRL via PTAX Bacen; em indisponibilidade, fallback padrao.
- **Regra de token:** a correlacao com Campaign Journey depende de token no nome da line (`ID-XXXXXX_...`).
- **Campanhas sem token:** entram em alerta e nao entram no cruzamento com investido da planilha.
- **Vigencia de campanha:** gastos de campanhas fora da janela vigente entram em alerta de risco.
- **Nexd:** nao entra com custo de API; custo e estimado por CPM fixo de negocio (`0.0014` BRL por impressao).
- **Budget por share:** alvo dinamico por plataforma e calculado sobre base SA + DV360 + Xandr com shares configuraveis.
- **Resiliencia de dado:** em falha parcial de fonte, sistema devolve snapshot com o maximo de dados possivel.
- **Governanca de refresh:** refresh manual e agendado convivem com cache/snapshot para evitar latencia e indisponibilidade.

---

## 4) Frontend (Next.js)

### Stack

- Next.js 16 (App Router)
- React 19
- SWR (data fetching/revalidacao)
- Recharts (graficos)
- Clerk (autenticacao e sessao)
- html2canvas (exportacao PNG de graficos)

### Rotas principais

- `/` - dashboard consolidado.
- `/[tab]` - alias para dashboard principal.
- `/campaign/[token]` - detalhamento de campanha/token.
- `/sign-in` - login.
- `/sso-callback` - callback SSO.
- `/unauthorized` - acesso negado (dominio fora da regra).

### Autenticacao e autorizacao

- Middleware em `frontend/src/proxy.ts` protege rotas privadas.
- Clerk exige usuario autenticado.
- O app restringe dominio para emails `@hypr.mobi`.
- Sessao invalida redireciona para `sign-in` ou `unauthorized`.

### Consumo de API no frontend

- Dashboard:
  - `GET /api/dashboard`
  - `POST /api/dashboard/refresh`
  - `GET /api/dashboard/refresh/status`
  - `GET /api/dashboard/refresh/metrics`
- Detalhe de campanha:
  - `GET /api/campaign/{token}`

### Recursos funcionais da interface

- Cards KPI por plataforma e total consolidado.
- Graficos de distribuicao e serie temporal diaria.
- Tabela Campaign Journey com filtro, ordenacao e drill-down por token.
- Paginas/visoes de atencao:
  - lines sem token;
  - gasto fora do mes vigente.
- Detalhe da campanha com:
  - top lines;
  - gasto por DSP;
  - timeline por DSP;
  - copiar dados CSV;
  - exportar graficos em PNG.

---

## 5) Backend (FastAPI)

### Inicializacao

- Carrega `.env` via `python-dotenv`.
- Inicializa CORS com `FRONTEND_ORIGIN`.
- Em startup:
  - inicializa budget store;
  - inicia workers de refresh em background.
- Em shutdown:
  - sinaliza parada dos workers.

### Endpoint e responsabilidades

- `GET /`
  - metadados do servico.
- `GET /health`
  - healthcheck simples.
- `GET /api/dashboard`
  - retorna snapshot consolidado.
  - query params:
    - `start` (opcional, `YYYY-MM-DD`)
    - `end` (opcional, `YYYY-MM-DD`)
    - `force_refresh` (opcional, `true|false`)
- `POST /api/dashboard/refresh`
  - dispara refresh assincrono (manual_api).
- `GET /api/dashboard/refresh/status`
  - status da execucao atual/ultima.
- `GET /api/dashboard/refresh/metrics`
  - metricas de duracao (janela 24h por trigger `manual_api`).
- `GET /api/campaign/{token}`
  - recorte por token para pagina de detalhe.
- `GET /api/budget-target`
  - endpoint informativo (placeholder de alvo por mes/plataforma).

### Comportamento de resiliencia

- Timeout por integracao (com timeout dedicado para DV360).
- Em erro de refresh live:
  - tenta retornar cache anterior com `_warning` e `_error`.
- Fallback DV360:
  - se DV360 falhar no refresh atual e snapshot anterior for valido, reutiliza o ultimo dado valido de DV360.

---

## 6) Servico de Consolidacao (`dashboard_service.py`)

### Plataformas integradas no payload principal

- StackAdapt
- DV360
- Xandr
- Amazon DSP
- Hivestack
- Nexd (modelo por impressoes, custo estimado)

### Regras de negocio centrais

- **Conversao cambial:**
  - USD -> BRL via PTAX (`src/utils/currency.py`).
  - fallback: `5.15`.
- **Nexd:**
  - custo estimado por CPM fixo interno: `NEXD_CPM_BRL = 0.0014`.
- **Correlacao com Campaign Journey:**
  - token extraido via regex do nome da line (`ID-XXXXXX_...`).
  - cruza gasto por token com `investido` da planilha.
- **Atencao (governanca):**
  - lines sem token;
  - lines fora da vigencia da campanha no mes corrente.
- **Budget dinamico por share:**
  - base = gasto BRL consolidado de StackAdapt + DV360 + Xandr (apenas status ok).
  - shares padrao:
    - StackAdapt: 30%
    - DV360: 50%
    - Xandr: 13%
  - podem ser sobrescritos por env vars.

### Cache e atualizacao

- Cache em memoria com TTL (`DASHBOARD_CACHE_TTL_SECONDS`, default 300s).
- Quando BigQuery habilitado:
  - tenta carregar snapshot mais recente do periodo antes de refresh live.
- Workers:
  - worker rapido (`scheduled_fast`) - default 600s.
  - worker DV360 (`scheduled_dv360`) - default 1800s.

---

## 7) Todas as APIs e Fontes Consultadas

## 7.1 StackAdapt

- Tipo: GraphQL
- Endpoint: `https://api.stackadapt.com/graphql`
- Auth: `STACKADAPT_API_KEY` (Bearer)
- Coleta:
  - custo total;
  - custo por campanha/line;
  - serie diaria.
- Observacao:
  - consulta paginada para evitar subcontagem de `records`.

## 7.2 DV360 (Display & Video 360 + Bid Manager)

- Endpoints:
  - `https://doubleclickbidmanager.googleapis.com/v2/queries`
  - `https://displayvideo.googleapis.com/v4/advertisers/{id}/lineItems`
- Auth:
  - OAuth local (`DV360_TOKEN_JSON` + `DV360_OAUTH_JSON`) ou
  - service account (`DV360_SERVICE_ACCOUNT_JSON_BASE64`).
- Coleta:
  - custo total;
  - lines;
  - tipos de custo;
  - serie diaria.
- Observacoes operacionais:
  - cria/reutiliza queries de report;
  - roda reports assincronos com polling e backoff;
  - fallback para ultimo report `DONE` quando necessario.

## 7.3 Xandr (AppNexus)

- Endpoint base: `https://api.appnexus.com`
- Auth: `XANDR_USERNAME` + `XANDR_PASSWORD`
- Coleta:
  - advertiser analytics por dia/line/media_type/spend;
  - agregacoes de total, lines, tipos e diario.

## 7.4 Amazon DSP

- Auth: LWA via refresh token:
  - `AMAZON_CLIENT_ID`
  - `AMAZON_CLIENT_SECRET`
  - `AMAZON_REFRESH_TOKEN`
- Endpoints:
  - token: `https://api.amazon.com/auth/o2/token`
  - report: `https://advertising-api*.amazon.com/dsp/reports`
- Coleta:
  - report do tipo `CAMPAIGN` com metrica `totalCost`.

## 7.5 Hivestack

- Fonte: BigQuery (`site-hypr.staging.hivestack_mediacost` por default)
- Auth: credencial GCP base64 + `BQ_PROJECT_ID`
- Coleta:
  - custo BRL por line item (mes)
  - agrega por linha e por mes (campo daily mensal, nao diario).

### 7.5.1 Job de ingestao Hivestack (fonte oficial da tabela)

Este projeto consome os dados da HiveStack a partir da tabela BigQuery populada pelo job:

- `hivestack_mediacost_ingestion_job`

Esse job foi criado para automatizar o fluxo do e-mail da HiveStack com assunto de relatorio pronto, baixar o CSV `HYPR_MEDIACOST`, tratar os dados e fazer carga no BigQuery diariamente.

#### Onde esta implementado

- Definicao do pipeline/job/schedule: `hyprster/hivestack_mediacost/definitions.py`
- Logica das etapas (ops): `hyprster/hivestack_mediacost/ops.py`
- Registro global no Dagster: `hyprster/__init__.py`
- Variaveis e instrucoes: `README.md`

#### Objetivo do job

- Procurar no Gmail um e-mail de relatorio HiveStack ainda nao processado.
- Extrair o link de download do corpo do e-mail.
- Baixar o arquivo CSV.
- Interpretar o CSV no formato HiveStack (com metadados antes do cabecalho real).
- Fazer upsert no BigQuery.
- Marcar o e-mail como processado para nao duplicar execucao.

#### Agendamento

- Nome do schedule: `hivestack_mediacost_daily_6am`
- Cron: `0 6 * * *`
- Timezone: `America/Sao_Paulo`
- Execucao: todos os dias as 06:00

#### Fluxo do pipeline

Pipeline `hivestack_mediacost_pipeline`:

1. `find_report_email`
2. `extract_download_url`
3. `download_report_file`
4. `parse_hivestack_csv`
5. `load_to_bigquery`
6. `finalize`

Resumo das etapas:

- `find_report_email`
  - busca no Gmail por:
    - `subject:HYPR_MEDIACOST`
    - `subject:"is ready"`
    - sem label `BQ-Processed-HiveStack`
    - filtro opcional por remetente (`GMAIL_HIVESTACK_SENDER`)
  - retorna `id`, `subject` e `body` do e-mail mais recente.
- `extract_download_url`
  - analisa HTML/texto;
  - pontua candidatos por sinais de `HYPR_MEDIACOST`, `report definition`, `csv`, `download`, `hivestack`, `report`;
  - escolhe a melhor URL.
- `download_report_file`
  - faz `GET` com redirect habilitado;
  - usa `User-Agent` de browser para reduzir bloqueios;
  - valida arquivo nao vazio.
- `parse_hivestack_csv`
  - decodifica com `utf-8-sig`;
  - detecta automaticamente a linha de cabecalho real (`MONTH`, `LINE_ITEM`, ...);
  - ignora metadados iniciais (ex.: `Report: ...`, `Generated on ...`);
  - normaliza colunas para:
    - `month`, `line_item`, `campaign`, `buyer_net_spend`, `spend`;
  - converte tipos:
    - `month` para data (string normalizada);
    - `buyer_net_spend` e `spend` para numerico;
  - adiciona `ingested_at` (timestamp UTC).
- `load_to_bigquery`
  - resource: `bq_hivestack`;
  - garante dataset;
  - upsert por chave `month + line_item + campaign`;
  - remove duplicadas no lote;
  - estrategia:
    - se tabela nao existe: cria via `load_table_from_dataframe` (autodetect);
    - se existe: carrega em staging `__staging_upsert` e executa `MERGE`.
- `finalize`
  - cria label `BQ-Processed-HiveStack` (se necessario);
  - envia notificacao de sucesso no Discord;
  - marca e-mail como processado e remove `UNREAD`.

#### Tabela de destino no BigQuery

Default atual:

- `site-hypr.staging.hivestack_mediacost`

Composicao:

- Projeto: `BQ_PROJECT_ID` (default `site-hypr`)
- Dataset: `BQ_HIVESTACK_DATASET_ID` (fallback `BQ_DATASET_ID`, default `staging`)
- Tabela: `BQ_HIVESTACK_TABLE_ID` (default `hivestack_mediacost`)

Essa e a fonte que voce roda para gravar os dados HiveStack consumidos por esta plataforma.

## 7.6 Nexd

- Endpoint base: `https://api.nexd.com`
- Endpoints usados:
  - `/group/campaigns/analytics/summary`
  - `/group/campaigns/analytics/performance`
- Auth: `NEXD_API_KEY` (Bearer)
- Coleta:
  - impressoes totais;
  - por campanha;
  - por layout/formato.
- Regra de custo:
  - custo estimado no app com CPM fixo interno.

## 7.7 Google Sheets (Campaign Journey)

- Endpoint:
  - `https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}`
- Auth:
  - token OAuth Google ou service account (mesma estrategia usada no DV360).
- Fontes:
  - planilha principal `_CS Campaing Journey`
  - planilha secundaria de investimento total por short token.
- Uso:
  - cliente, campanha, vigencia, token, account management, investido.

## 7.8 Cambio PTAX (USD/BRL)

- Endpoint PTAX Bacen (Olinda OData)
- Sem autenticacao
- Busca cotacao do dia e retrocede ate 5 dias (fim de semana/feriado).

## 7.9 APIs complementares do job de ingestao HiveStack

Para abastecer a tabela `site-hypr.staging.hivestack_mediacost`, o job de ingestao tambem bate nas seguintes APIs/servicos:

- Gmail API (busca e leitura do e-mail de relatorio, alem de atualizacao de labels/status).
- URL de download do relatorio HiveStack (extraida do corpo do e-mail e consumida via HTTP GET).
- BigQuery API (carga de dataframe, staging e `MERGE` de upsert).
- Discord Webhook/API (notificacao de sucesso na etapa `finalize`).

Com isso, o ciclo de dados HiveStack fica completo: e-mail -> download CSV -> tratamento -> BigQuery -> consumo no dashboard.

---

## 8) Modelo de Dados da API

### 8.1 `GET /api/dashboard` (visao macro)

Campos principais retornados:

- `period`
- `exchange_rate_usd_brl`
- `total_brl`
- `platform_results`
- `dashboard`
  - `spend_by_platform`
  - `daily`
  - `campaign_journey_rows`
  - `active_platforms`
- `platform_pages`
- `attention`
  - `no_token_rows`
  - `out_of_period_rows`
- `budget`
- `_meta`
  - `snapshot_at`
  - `source` (`live` ou `bigquery`)
  - `cache_ttl_seconds`

### 8.2 `GET /api/campaign/{token}` (visao detalhada)

- `token`
- `period`
- `campaign`
- `line_rows`
- `daily`
- `active_platforms`

### 8.3 Status de integracoes

Padrao comum por plataforma em `platform_results`:

- `status`: `ok | error | no_credentials`
- `message`
- `spend`
- `currency`
- `lines`
- `daily`

---

## 9) Mecanismo de Refresh e Metricas

### Trigger de refresh

- `force_refresh=true` em `/api/dashboard` (sincrono).
- `POST /api/dashboard/refresh` (assincrono).
- workers internos periodicos:
  - `scheduled_fast`
  - `scheduled_dv360`

### Estado de refresh (`/api/dashboard/refresh/status`)

- `running`
- `run_id`
- `trigger`
- `started_at`
- `finished_at`
- `status`
- `error`

### Metricas (`/api/dashboard/refresh/metrics`)

Na janela padrao de 24h e trigger `manual_api`:

- `sample_size`
- `avg_duration_seconds`
- `p50_duration_seconds`
- `p95_duration_seconds`

Essas metricas vem de `dashboard_refresh_runs` no BigQuery quando habilitado.

---

## 10) BigQuery: Tabelas e Finalidade

Dataset default: `cost_dashboard_rt` (configuravel por `BQ_DATASET_ID`).

- `dashboard_snapshots`
  - armazena payload consolidado por periodo.
- `dashboard_refresh_runs`
  - auditoria/telemetria de cada refresh.
- `budget_targets_history`
  - historico de eventos de alvo (upsert/delete logico).

Caracteristicas:

- particionamento por tempo;
- clustering para consultas operacionais;
- criacao automatica de infraestrutura quando BigQuery esta habilitado.

---

## 11) Variaveis de Ambiente

Referencias completas em `.env.example`.

### Integracoes

- `STACKADAPT_API_KEY`
- `NEXD_API_KEY`
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
- `HIVESTACK_BQ_TABLE`

### Infra/servico

- `FRONTEND_ORIGIN`
- `BQ_PROJECT_ID`
- `GCP_CREDS_JSON_CREDS_BASE64`
- `BQ_DATASET_ID`
- `BQ_LOCATION`

### Performance/refresh

- `DASHBOARD_CACHE_TTL_SECONDS`
- `DASHBOARD_INTEGRATION_TIMEOUT_SECONDS`
- `DASHBOARD_DV360_TIMEOUT_SECONDS`
- `DASHBOARD_FAST_WORKER_INTERVAL_SECONDS`
- `DASHBOARD_DV360_WORKER_INTERVAL_SECONDS`

### Share de budget

- `DASHBOARD_SHARE_STACKADAPT_PCT`
- `DASHBOARD_SHARE_DV360_PCT`
- `DASHBOARD_SHARE_XANDR_PCT`

---

## 12) Execucao e Deploy

### Desenvolvimento local

- Backend:
  - `./run-back.sh`
  - sobe FastAPI em `http://localhost:8000`
- Frontend:
  - `./run-front.sh`
  - sobe Next.js em `http://localhost:3000`

### Deploy backend (Cloud Run)

- Script: `deploy-backend-cloudrun.sh`
- Entradas:
  - `PROJECT_ID` (obrigatorio)
  - `SERVICE_NAME` (default `cost-dashboard-api`)
  - `REGION` (default `southamerica-east1`)
  - `ENV_FILE` (default `cloudrun.backend.env.yaml`)
- Config de runtime aplicada:
  - `min-instances=1`
  - `max-instances=1`
  - `concurrency=1`
  - `timeout=300`

---

## 13) Limites, Premissas e Pontos de Atencao

- Nexd nao retorna custo real nesta implementacao; custo e estimado por CPM fixo.
- Hivestack vem de tabela BigQuery (nao API direta), entao depende do pipeline de ingestao externo.
- `GET /api/budget-target` atualmente e informativo/placeholder e nao grava alvo.
- Caso BigQuery nao esteja habilitado, o sistema opera com cache em memoria e refresh live.
- Falhas pontuais de integracao podem aparecer como `status=error` por plataforma sem derrubar o payload inteiro.

---

## 14) Boas Praticas Operacionais

- Nunca versionar segredos em `.env`, YAML de deploy ou JSON de credenciais.
- Monitorar:
  - tempo de refresh (avg/p50/p95),
  - taxa de erro por plataforma,
  - crescimento de linhas em `attention`.
- Revisar periodicamente:
  - shares de budget,
  - timeout de integracoes,
  - qualidade de naming das lines (token padrao).

---

## 15) Roadmap Tecnico Sugerido

- Expor contrato OpenAPI com exemplos de payload por endpoint.
- Adicionar endpoint dedicado para alertas e filtros server-side.
- Incluir healthchecks por integracao (status detalhado por fonte).
- Implementar testes automatizados para regras de correlacao token/vigencia.
- Evoluir observabilidade com traces e metricas por etapa do refresh.

