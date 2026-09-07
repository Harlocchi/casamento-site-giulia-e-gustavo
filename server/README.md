# Backend do site de casamento — pagamentos via AbacatePay (API v2)

Servidor Node/Express minúsculo. Ele guarda a **chave secreta da AbacatePay**
e é o único que fala com a API deles. O `index.html` só conversa com `/api/*`
deste servidor — nenhum segredo chega ao navegador.

**Fluxo de presente:** o front chama `POST /api/checkout/create`; o servidor
gera um **checkout hospedado** da AbacatePay (`/v2/checkouts/create`) com
**PIX + Cartão parcelado até 12x** e devolve a `url`; o front redireciona o
convidado pra lá. Ao voltar, cai em `/?obrigado=<cota>` e vê o agradecimento.
A confirmação chega pelo **webhook** `checkout.completed`.

Cada cota é um **produto** no catálogo da AbacatePay (`externalId = id da cota`),
criado por `npm run produtos:sync`. A "Contribuição livre" usa um produto de
R$ 1,00 com `quantity` = valor em reais.

## Rodar

```bash
cd server
cp .env.example .env      # e preencha ABACATEPAY_API_KEY (chave da API v2)
npm install
npm run produtos:sync     # cria os produtos no catálogo da AbacatePay
npm start
```

Abra **http://localhost:3000** — o próprio servidor serve o `index.html` e a
pasta `fotos/`.

Durante o desenvolvimento: `npm run dev` (reinicia ao salvar).

## Banco de dados (PostgreSQL + migrações)

Você define a conexão em `DATABASE_URL` (no `.env` ou nas variáveis do host):

```
DATABASE_URL=postgres://usuario:senha@host:5432/nome_do_banco
```

- `DATABASE_SSL` — `auto` (padrão, liga SSL exceto em localhost), `require` ou `disable`.
- `PGPOOL_MAX` — tamanho do pool (padrão 10).

```bash
npm run migrate            # aplica as migrações pendentes
npm run migrate:status     # mostra o que já foi aplicado
```

As migrações são os `.sql` de `server/migrations/`, aplicados **em ordem**, uma
vez cada (controle na tabela `schema_migrations`), cada um em sua transação e
protegidos por um advisory lock (dois deploys não migram ao mesmo tempo). O
`server.js` também roda as pendentes ao subir — se falhar, ele **não sobe**.
Para uma nova mudança de schema, crie `002_xxx.sql`, `003_xxx.sql`, etc.

### Rodar um Postgres local rápido (Docker)

```bash
docker run -d --name casamento-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=casamento -p 5432:5432 postgres:16-alpine
# DATABASE_URL=postgres://postgres:postgres@localhost:5432/casamento
# DATABASE_SSL=disable
```

**Tabelas:**

| `guests` | | migração |
|---|---|---|
| `id` | PK | 001 |
| `name` | nome do convidado (planilha: `Nome`) | 001 |
| `qrcode` | código do convite, único (planilha: `code`) | 001 |
| `numero` | nº do convidado na planilha (`Numero`), único | 002 |
| `go_sit` | bool — vai à cerimônia / confirmado na planilha | 002 |
| `is_padrinho` | bool — padrinho/madrinha | 002 |
| `created_at` | | 001 |

A migração `003_seed_convidados.sql` carrega a lista de `server/data/lista_convidados.csv`
(idempotente — conflito em `qrcode` atualiza os campos). Para reimportar sem
redeploy: `npm run convidados:import [caminho.csv]` ou `POST /api/guests/import`.

| `gifts` | |
|---|---|
| `id` | PK |
| `guest_user_id` | FK → `guests.id` (ON DELETE CASCADE) |
| `gift_name` | nome da cota presenteada |
| `value` | valor em reais |
| `created_at` | |

## Endpoints

| Método | Rota | Para quê |
|---|---|---|
| `POST` | `/api/checkout/create` | `{ cotaId, valor?, qrcode? }` → gera o link de pagamento `{ id, url }` (PIX + Cartão até 12x) |
| `GET` | `/api/checkout/status/:id` | status do checkout (`PENDING`/`PAID`/…), método e nº de parcelas |
| `POST` | `/api/webhook/abacatepay?webhookSecret=...` | `checkout.completed` → grava em `presentes.jsonl` (e em `gifts` se veio `qrcode`) |
| `POST` | `/api/guests` | **[admin]** cadastra convidado, gera o `qrcode` → `{ id, name, qrcode }` |
| `POST` | `/api/guests/import` | **[admin]** carga em lote — `{ guests: [{ numero, nome, code, go_sit, is_padrinho }] }` (casa por `code`) |
| `GET` | `/api/guests` | **[admin]** lista convidados (+ `numero`, `go_sit`, `is_padrinho`, total presenteado) |
| `GET` | `/api/guests/:qrcode` | público — o convidado consulta o próprio cadastro e presentes |
| `GET` | `/api/presentes` | **[admin]** log de quem já presenteou |
| `POST` | `/api/rsvp` | confirmação de presença (opcional) |

`[admin]` = header `Authorization: Bearer <ADMIN_TOKEN>`.

Logs de eventos (webhooks, cobranças, rsvp) ficam também em
`server/dados/*.jsonl` (um JSON por linha) — fora do git.

## Webhook

No painel da AbacatePay (**Webhooks → Criar**), cadastre a URL:

```
https://SEU_DOMINIO/api/webhook/abacatepay?webhookSecret=SEU_SEGREDO
```

- o `webhookSecret` da URL tem que ser igual ao `ABACATEPAY_WEBHOOK_SECRET` do `.env`;
- além do secret, o servidor valida a **assinatura HMAC** (`X-Webhook-Signature`)
  com a chave pública da AbacatePay — obrigatória em produção, opcional em dev
  (`ABACATEPAY_DEV=1`, pra aceitar simulações do painel);
- idempotência pelo `id` do evento.

Sem webhook o pagamento não é registrado automaticamente — só dá pra conferir
no painel da AbacatePay.

## Produtos

```bash
npm run produtos:preview   # dry-run
npm run produtos:sync      # cria/atualiza os produtos no catálogo
```

Lê as cotas do `index.html`. `--force` recria os que mudaram de preço/nome
(a AbacatePay não tem "editar produto"); `--delete-orphans` remove os que
saíram do site. Com `SITE_URL` no `.env`, usa `fotos/<id>.jpg` como imagem.

## Deploy

Como o banco agora é Postgres gerenciado (Neon, Supabase, Render, Railway, RDS…),
a app não precisa de disco persistente — sobe em **qualquer host de Node**:
Render, Railway, Fly.io, uma VPS, e também os serverless (Vercel/Netlify) se você
adaptar as rotas pra *functions*.

Passos:

1. Crie o banco no provedor e copie a `DATABASE_URL` (geralmente já vem com
   `?sslmode=require`).
2. Configure as variáveis: `DATABASE_URL`, `ABACATEPAY_API_KEY` (v2),
   `ABACATEPAY_WEBHOOK_SECRET`, `ADMIN_TOKEN`, `SITE_URL` (o domínio público).
   Start = `node server.js`.
3. `npm run migrate` roda sozinho no boot; `npm run produtos:sync` uma vez.
4. Cadastre a URL do webhook (pública, HTTPS) no painel da AbacatePay.

> As rotas seguem a **API v2** da AbacatePay (`https://api.abacatepay.com/v2`):
> `/products/*`, `/checkouts/create`, `/checkouts/get`. Se a API mudar, ajuste
> a função `abacate()` e as rotas em `server.js`.
