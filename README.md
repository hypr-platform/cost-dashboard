# Cost Dashboard

Dashboard de mês corrente (month-to-date) de midia paga com frontend em Next.js e backend em Python (FastAPI). O projeto consolida custos de multiplas plataformas, converte para BRL e cruza os gastos com a planilha de Campaign Journey por token.

## Arquitetura atual (produzida neste repo)

- Frontend: `frontend/` (Next.js + SWR + Clerk)
- Backend: `backend/` (FastAPI + workers internos paralelos)
- Fonte da verdade: APIs das DSPs (DV360, Xandr, Amazon DSP, StackAdapt, Nexd)
- Serving layer: snapshots no BigQuery (`cost_dashboard_rt`)
- Budget targets: persistidos no BigQuery (tabela historica `budget_targets_history`)
- Cache local: memoria do backend com TTL de 5 minutos

Fluxo:

1. Workers do backend rodam periodicamente e coletam dados em paralelo.
2. Payload consolidado e persistido no BigQuery.
3. Frontend consome `/api/dashboard` (snapshot rapido).
4. Usuario pode clicar em **Forcar atualizacao na fonte** para refresh imediato.
5. A UI exibe o horario real do snapshot mostrado.

## O que este projeto faz

- Consolida gasto do mês corrente de `StackAdapt`, `DV360`, `Xandr` e `Amazon DSP`.
- Calcula custo estimado de `Nexd` por impressoes (CPM fixo).
- Converte custos em USD para BRL usando PTAX (Banco Central).
- Cruza lines/campanhas com a planilha de Campaign Journey via token de 6 caracteres.
- Exibe:
  - Dashboard consolidado (cards + graficos por plataforma + serie diaria).
  - Visao por plataforma (detalhe de lines e % sobre investido).
  - Pagina de atencao com inconsistencias (sem token, fora de vigencia).

## Integracoes e APIs consultadas

### 1) StackAdapt

- Tipo: GraphQL
- Endpoint: `https://api.stackadapt.com/graphql`
- Auth: `STACKADAPT_API_KEY` (Bearer)
- Dados usados:
  - custo total do mês corrente
  - custo por line/campaign
  - serie diaria

### 2) Google DV360 / Bid Manager

- Tipo: REST
- Endpoints principais:
  - `https://doubleclickbidmanager.googleapis.com/v2/queries`
  - `https://displayvideo.googleapis.com/v4/advertisers/{id}/lineItems`
- Auth:
  - OAuth (`dv360-token.json` + `oauth-credentials.json`) ou
  - Service Account (`DV360_SERVICE_ACCOUNT_JSON_BASE64`)
- Dados usados:
  - custo total do mês corrente
  - custo por line item
  - custo por tipo
  - serie diaria

### 3) Xandr (AppNexus)

- Tipo: REST
- Endpoint base: `https://api.appnexus.com`
- Auth: `XANDR_USERNAME` + `XANDR_PASSWORD` (token de sessao)
- Dados usados:
  - report de advertiser analytics
  - gasto total, por line item, por media type e por dia

### 4) Amazon DSP

- Tipo: REST (Amazon Advertising API)
- Endpoints:
  - auth: `https://api.amazon.com/auth/o2/token`
  - reports: `https://advertising-api*.amazon.com/dsp/reports`
- Auth:
  - `AMAZON_CLIENT_ID`
  - `AMAZON_CLIENT_SECRET`
  - `AMAZON_REFRESH_TOKEN`
- Dados usados:
  - custo total do mês corrente por report (CAMPAIGN / totalCost)

### 5) Nexd

- Tipo: REST
- Endpoint base: `https://api.nexd.com`
- Auth: `NEXD_API_KEY` (Bearer)
- Dados usados:
  - impressoes do mês corrente por campanha
  - impressoes por formato/layout
- Observacao:
  - Nexd nao retorna custo diretamente neste projeto.
  - Custo estimado: `impressions * 0.0014` BRL (CPM fixo definido no app).

### 6) Google Sheets (Campaign Journey)

- Tipo: REST
- Endpoint:
  - `https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}`
- Auth:
  - Usa o token OAuth salvo em `DV360_TOKEN_JSON`
- Aba lida:
  - `_CS Campaing Journey`
- Campos usados:
  - cliente, campanha, vigencia, token, investido

### 7) Cambio USD -> BRL

- Fonte: PTAX Banco Central (API publica)
- Endpoint base:
  - `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/...`
- Sem autenticacao

## Arquitetura (resumo)

- `frontend/`: interface Next.js (cards, graficos e tabelas).
- `backend/main.py`: API FastAPI com endpoint `GET /api/dashboard`.
- `backend/dashboard_service.py`: consolidacao de dados e regras de negocio do dashboard.
- `src/apis/*.py`: clientes de API por plataforma.
- `src/apis/sheets.py`: leitura da planilha Campaign Journey e extracao de token.
- `src/utils/currency.py`: taxa PTAX e conversao USD -> BRL.
- `src/utils/date_utils.py`: utilitarios de datas do mês corrente.
- `generate_token.py`: gera token OAuth para Google APIs (DV360/Sheets).

## Estrutura de pastas

```text
cost-dashboard/
├── frontend/                  # Next.js app (UI)
├── backend/
│   ├── main.py               # FastAPI app
│   └── dashboard_service.py  # consolidacao dos dados
├── src/
│   ├── apis/                 # integracoes com plataformas
│   └── utils/                # utilitarios
├── generate_token.py
├── requirements.txt
└── .env.example
```

## Fluxo de dados do app

1. Define periodo do mês corrente (inicio do mes ate hoje).
2. Consulta plataformas de midia e coleta custo/linhas/daily.
3. Consulta PTAX e converte USD para BRL.
4. Consulta planilha Campaign Journey.
5. Extrai token das lines (padrao `ID-XXXXXX_...`).
6. Cruza gasto por token com investido da planilha.
7. Renderiza dashboard consolidado, abas por plataforma e alertas.

## Cache e atualizacao

- `st.cache_data` com TTL de 1 hora.
- Cache local em `cache/last_fetch.json`.
- Botao `Atualizar dados` limpa cache e refaz consultas.

## Requisitos

- Python 3.10+ (recomendado)
- `pip`
- Credenciais/chaves das plataformas que voce deseja consultar

## Como rodar (passo a passo)

### Execucao manual (2 terminais)

### 1) Entrar na pasta do projeto

```bash
cd "/Users/mateus-hypr/Projects/cost-dashboard"
```

### 2) Backend (FastAPI)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### 3) Frontend (Next.js)

Em outro terminal:

```bash
cd "/Users/mateus-hypr/Projects/cost-dashboard/frontend"
npm install
cp .env.local.example .env.local
npm run dev
```

No arquivo `frontend/.env.local`, configure tambem as chaves do Clerk:

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx
CLERK_SECRET_KEY=sk_test_xxx
```

No painel do Clerk:

1. Habilite apenas o provider **Google** em Sign-in methods.
2. Desabilite email/password e outros providers.
3. (Recomendado) Configure restricao de dominio para `hypr.mobi`.

### 4) Configurar variaveis de ambiente

Crie o arquivo `.env` com base no exemplo:

```bash
cp .env.example .env
```

Preencha no `.env`:

```env
# StackAdapt
STACKADAPT_API_KEY=

# Nexd
NEXD_API_KEY=

# Google DV360
DV360_SERVICE_ACCOUNT_JSON_BASE64=
DV360_PARTNER_ID=
DV360_ADVERTISER_IDS=123456,789012

# Xandr
XANDR_USERNAME=
XANDR_PASSWORD=
XANDR_ADVERTISER_IDS=123456,789012

# Amazon DSP
AMAZON_CLIENT_ID=
AMAZON_CLIENT_SECRET=
AMAZON_REFRESH_TOKEN=
AMAZON_DSP_ADVERTISER_IDS=123456,789012
AMAZON_DSP_REGION=NA
```

Se usar OAuth para DV360/Sheets, inclua tambem:

```env
DV360_TOKEN_JSON=dv360-token.json
DV360_OAUTH_JSON=oauth-credentials.json
```

Se usar service account no formato Base64, gere assim:

```bash
base64 -i "secrets/dv360-service-account.json" | tr -d '\n'
```

Cole a saida na variavel `DV360_SERVICE_ACCOUNT_JSON_BASE64`.

Backend/frontend:

```env
FRONTEND_ORIGIN=http://localhost:3000
```

### 5) (Opcional, recomendado para DV360 OAuth) Gerar token uma vez

1. Coloque `oauth-credentials.json` na raiz do projeto.
2. Execute:

```bash
python generate_token.py
```

O script abre o navegador para autenticacao e salva `dv360-token.json`.

### 6) Abrir a aplicacao

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:8000` (`/health` e `/api/dashboard`)

### 7) Parar a aplicacao

No terminal do Streamlit, pressione `Ctrl + C`.

## Deploy do backend no Cloud Run

Este repositorio inclui um script para deploy do backend FastAPI no Cloud Run com 1 instancia fixa (sem cold start):

- `min-instances=1`
- `max-instances=1`

### 1) Criar arquivo de variaveis do Cloud Run

Copie os valores do `.env` para `cloudrun.backend.env.yaml`.

Observacoes:

- O arquivo `cloudrun.backend.env.yaml` esta no `.gitignore`.
- Nao commite segredos.

### 2) Rodar o deploy

```bash
PROJECT_ID=site-hypr SERVICE_NAME=cost-dashboard-api REGION=southamerica-east1 ./deploy-backend-cloudrun.sh
```

Se quiser usar os defaults do script (`SERVICE_NAME=cost-dashboard-api` e `REGION=southamerica-east1`), rode:

```bash
PROJECT_ID=site-hypr ./deploy-backend-cloudrun.sh
```

### 3) Validar o backend publicado

Depois do deploy, teste:

```bash
curl https://SUA_URL_DO_CLOUD_RUN/health
```

## Variaveis de ambiente (referencia)

| Variavel | Obrigatoria | Uso |
| --- | --- | --- |
| `STACKADAPT_API_KEY` | Se usar StackAdapt | Auth StackAdapt |
| `NEXD_API_KEY` | Se usar Nexd | Auth Nexd |
| `DV360_SERVICE_ACCOUNT_JSON_BASE64` | Opcional (modo SA) | JSON da Service Account DV360 em Base64 |
| `DV360_PARTNER_ID` | Se usar DV360 | Escopo de consulta DV360 |
| `DV360_ADVERTISER_IDS` | Recomendado | Filtro de anunciantes DV360 |
| `DV360_TOKEN_JSON` | Se usar OAuth | Token OAuth Google (arquivo local) |
| `DV360_OAUTH_JSON` | Se usar OAuth | Credencial OAuth Google (arquivo local) |
| `XANDR_USERNAME` | Se usar Xandr | Auth Xandr |
| `XANDR_PASSWORD` | Se usar Xandr | Auth Xandr |
| `XANDR_ADVERTISER_IDS` | Opcional | Filtro de anunciantes Xandr |
| `AMAZON_CLIENT_ID` | Se usar Amazon DSP | Auth Amazon |
| `AMAZON_CLIENT_SECRET` | Se usar Amazon DSP | Auth Amazon |
| `AMAZON_REFRESH_TOKEN` | Se usar Amazon DSP | Auth Amazon |
| `AMAZON_DSP_ADVERTISER_IDS` | Opcional | Filtro de anunciantes Amazon DSP |
| `AMAZON_DSP_REGION` | Opcional (`NA`, `EU`, `FE`) | Regiao da API Amazon DSP |

## Paginas da interface

- `Dashboard`: consolidado do mês corrente, distribuicao por plataforma, cards de alertas e tabela de Campaign Journey.
- Os dados detalhados por plataforma e alertas de atencao sao expostos no payload da API (`/api/dashboard`) para evolucao de novas telas no frontend.

## Solucao de problemas rapida

- **`ModuleNotFoundError`**: confirme se `.venv` esta ativo e rode `pip install -r requirements.txt`.
- **Erro de credenciais/API**: revise `.env`, permissoes e caminhos dos JSONs.
- **DV360/Sheets sem dados**: gere/renove token com `python generate_token.py`.
- **Porta ocupada**:
  - Frontend: `npm run dev -- --port 3001`
  - Backend: `uvicorn backend.main:app --reload --port 8001`
- **Ambiente inconsistente**: recrie o `.venv` e reinstale dependencias.

## Observacoes de seguranca

- `.env` e `*.json` estao no `.gitignore` para evitar commit de segredos.
- Nunca commite tokens, chaves ou arquivos de credenciais.
