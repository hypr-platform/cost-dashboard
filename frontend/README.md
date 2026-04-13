# Frontend - Cost Dashboard

Frontend em Next.js para visualizacao do dashboard de custos do mês corrente.

## Stack

- Next.js (App Router)
- React
- SWR (data fetching)
- Recharts (graficos)
- Clerk (autenticacao)

## Requisitos

- Node.js 20+
- Backend FastAPI rodando (por padrao em `http://localhost:8000`)
- Projeto no Clerk configurado

## Setup

1) Instalar dependencias:

```bash
npm install
```

2) Criar variaveis locais:

```bash
cp .env.local.example .env.local
```

3) Preencher `frontend/.env.local`:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx
CLERK_SECRET_KEY=sk_test_xxx
```

## Auth (Clerk)

Regra de acesso esperada:

- Login apenas com Google
- Apenas usuarios do dominio `hypr.mobi`

No dashboard do Clerk:

1. Em `Sign-in methods`, habilite somente Google.
2. Desabilite email/password e outros providers.
3. Configure restricao de dominio para `hypr.mobi` (recomendado).

No app, o dominio tambem e validado e usuarios fora de `@hypr.mobi` sao desconectados.

## Comandos

```bash
npm run dev
npm run lint
npm run build
npm run start
```

Aplicacao local: `http://localhost:3000`.

## Fluxo de dados do frontend

1. O frontend chama `GET /api/dashboard` via SWR.
2. O backend retorna snapshot consolidado com `_meta.snapshot_at`.
3. A sidebar mostra:
   - horario exato do snapshot exibido
   - idade do snapshot ("Atualizado ha X min")
4. O botao **"Forcar atualizacao na fonte"** dispara:
   - `GET /api/dashboard?force_refresh=true`
   - o backend consulta as fontes e atualiza o snapshot.

## Comportamento de refresh

- Refresh automatico de tela: via SWR (sem flood em foco/reconexao).
- Refresh forcado manual: botao do usuario.
- UI deixa explicito quando esta atualizando na fonte.

## Rotas importantes

- `/` dashboard principal
- `/sign-in` login
- `/sso-callback` callback OAuth
- `/unauthorized` acesso negado
