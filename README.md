# Cost Dashboard

Dashboard MTD (month-to-date) de midia paga em Streamlit. O projeto consolida custos de multiplas plataformas, converte para BRL e cruza os gastos com a planilha de Campaign Journey por token.

## O que este projeto faz

- Consolida gasto MTD de `StackAdapt`, `DV360`, `Xandr` e `Amazon DSP`.
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
  - custo total MTD
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
  - custo total MTD
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
  - custo total MTD por report (CAMPAIGN / totalCost)

### 5) Nexd

- Tipo: REST
- Endpoint base: `https://api.nexd.com`
- Auth: `NEXD_API_KEY` (Bearer)
- Dados usados:
  - impressoes MTD por campanha
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

- `app.py`: interface Streamlit, consolidacao, visualizacoes e regras de alerta.
- `src/apis/*.py`: clientes de API por plataforma.
- `src/apis/sheets.py`: leitura da planilha Campaign Journey e extracao de token.
- `src/utils/currency.py`: taxa PTAX e conversao USD -> BRL.
- `src/utils/date_utils.py`: utilitarios de datas MTD.
- `generate_token.py`: gera token OAuth para Google APIs (DV360/Sheets).

## Estrutura de pastas

```text
cost-dashboard/
├── app.py
├── generate_token.py
├── requirements.txt
├── .env.example
└── src/
    ├── apis/
    │   ├── amazon_dsp.py
    │   ├── dv360.py
    │   ├── nexd.py
    │   ├── sheets.py
    │   ├── stackadapt.py
    │   └── xandr.py
    └── utils/
        ├── currency.py
        └── date_utils.py
```

## Fluxo de dados do app

1. Define periodo MTD (inicio do mes ate hoje).
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

### Opcao rapida (script)

Comando unico para preparar e subir o projeto:

```bash
./start.sh
```

O script:

- cria `.venv` se ainda nao existir
- ativa o ambiente virtual
- instala dependencias do `requirements.txt`
- inicia o Streamlit (`streamlit run app.py`)

Para parar, pressione `Ctrl + C` no terminal onde o script estiver rodando.

### 1) Entrar na pasta do projeto

```bash
cd "/Users/mateus-hypr/Projects/cost-dashboard"
```

### 2) Criar e ativar ambiente virtual

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Se o ambiente estiver ativo, voce vera `(.venv)` no inicio da linha do terminal.

### 3) Instalar dependencias

```bash
pip install -r requirements.txt
```

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

### 5) (Opcional, recomendado para DV360 OAuth) Gerar token uma vez

1. Coloque `oauth-credentials.json` na raiz do projeto.
2. Execute:

```bash
python generate_token.py
```

O script abre o navegador para autenticacao e salva `dv360-token.json`.

### 6) Rodar o dashboard

```bash
streamlit run app.py
```

A aplicacao normalmente abre em `http://localhost:8501`.

### 7) Parar a aplicacao

No terminal do Streamlit, pressione `Ctrl + C`.

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

- `Dashboard`: consolidado MTD, distribuicao por plataforma, serie diaria e tabela de Campaign Journey.
- `StackAdapt` / `DV360` / `Xandr` / `Amazon DSP`: detalhamento por line com token, cliente, campanha e % investido.
- `Nexd`: impressoes, uso do cap mensal, ranking por campanha e por formato.
- `Atencao`: lines sem token e gasto em campanhas fora de vigencia.

## Solucao de problemas rapida

- **`ModuleNotFoundError`**: confirme se `.venv` esta ativo e rode `pip install -r requirements.txt`.
- **Erro de credenciais/API**: revise `.env`, permissoes e caminhos dos JSONs.
- **DV360/Sheets sem dados**: gere/renove token com `python generate_token.py`.
- **Porta ocupada**: use `streamlit run app.py --server.port 8502`.
- **Ambiente inconsistente**: recrie o `.venv` e reinstale dependencias.

## Observacoes de seguranca

- `.env` e `*.json` estao no `.gitignore` para evitar commit de segredos.
- Nunca commite tokens, chaves ou arquivos de credenciais.
