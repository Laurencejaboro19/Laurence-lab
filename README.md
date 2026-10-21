# Laurence Lab Bot

Chat-based food ordering platform for **Laurence Lab**, Benin City, Nigeria. Customers browse, order,
pay (Paystack), track delivery and get support entirely inside Telegram and WhatsApp. Staff run the
business through a separate Telegram admin bot. There is no web front end.

> **Status:** phases 1–4 merged and **live on Vercel since 2026-10-21** (@LaurencelabBot, Supabase
> London, Paystack test mode). Owner guide for the hosted setup: [docs/DEPLOY_VERCEL.md](docs/DEPLOY_VERCEL.md).
> See [CHANGELOG.md](CHANGELOG.md) for what each tagged release contains and `docs/` for
> architecture, decisions and owner reports.

## Stack

- **Runtime:** Node.js LTS (22+), TypeScript in strict mode, ES modules.
- **HTTP:** Fastify (webhooks + versioned internal API, OpenAPI generated from route schemas).
- **Database:** Supabase managed Postgres in staging/production; plain PostgreSQL locally. Same
  migrations everywhere. Our server is the only thing that talks to the database.
- **Core:** framework-independent domain/services/state machine in `src/core`, unit-testable without
  starting the server. Routes only validate, authenticate and call the core.
- **Tooling:** Vitest, ESLint (type-aware), Prettier, secretlint pre-commit hook, gitleaks in CI.

Full reasoning for every choice lives in `docs/DECISION_RECORD.md` (phase 1).

## Local setup

Works on a low-powered laptop and on Android/Termux. Docker is **not** required.

```bash
# 1. Node 22+ (Termux: pkg install nodejs-lts postgresql)
node --version

# 2. Install exact pinned dependencies
npm ci

# 3. Environment
cp .env.example .env     # edit DATABASE_URL_* for your local Postgres

# 4. Checks — this is the one command that must pass before any merge
npm run verify
```

### Local database (plain PostgreSQL, no Docker)

```bash
# Ubuntu/Debian: sudo apt install postgresql     Termux: pkg install postgresql
# Start the server (Termux: initdb $PREFIX/var/lib/postgresql && pg_ctl -D $PREFIX/var/lib/postgresql start)

# 1. Roles (once per machine) — pick two passwords and put them in .env afterwards
psql -h localhost -U postgres -d postgres \
  -v migrate_password="'choose-one'" -v runtime_password="'choose-another'" \
  -f src/db/setup/roles.sql

# 2. Databases + the Supabase API roles used by the lockdown test (once)
psql -h localhost -U postgres -d postgres -f src/db/setup/local-dev.sql

# 3. Apply migrations and load seed data
npm run migrate
npm run seed

# 4. Everything, including the database integration tests
npm run verify
```

`npm run migrate -- status` lists applied and pending migrations. Tests that need a database are
skipped automatically when `DATABASE_URL_TEST` is unset.

### Supabase (staging / production)

1. Create the project in **London (eu-west-2)**; see `docs/DECISION_RECORD.md` DR-004/DR-005.
2. In the SQL editor run `src/db/setup/roles.sql` with the two `:'…'` variables replaced by strong
   passwords, then delete them from the editor history.
3. Set `DATABASE_URL_MIGRATE` to the **session pooler** (port 5432) as `app_migrate`, and
   `DATABASE_URL` / `DATABASE_URL_DIRECT` as `app_runtime` (transaction pooler on 6543 is fine for
   `DATABASE_URL` only). Run `npm run migrate`.
4. Verify the lockdown over HTTP: `SUPABASE_URL=… SUPABASE_ANON_KEY=… node scripts/check-anon-lockdown.mjs`.
5. Dashboard → Settings → API: leave `app` out of the exposed schemas (default) or disable the
   Data API entirely; the app never uses it.

### Run it

```bash
npm run dev                                   # server on :3000; OpenAPI UI at /internal/v1/docs
node scripts/mint-token.mjs system laptop     # bearer token for curl / the docs "Authorize" button
curl -H "Authorization: Bearer $TOKEN" localhost:3000/internal/v1/menu
```

State-changing requests need an `Idempotency-Key` header. Adapter tokens also send `X-Customer-Id`.

## Run the Telegram customer bot locally (Windows PowerShell)

Nothing needs a public URL: the bot long-polls Telegram and Paystack is a local mock.

```powershell
# 0. One-time: Node 22+, PostgreSQL 16 (installer from postgresql.org), Git
git clone https://github.com/Laurencejaboro19/Laurence-lab.git; cd Laurence-lab
npm ci

# 1. Database roles + databases (enter the postgres password you chose at install)
psql -h localhost -U postgres -d postgres -v migrate_password="'migrate-dev'" -v runtime_password="'runtime-dev'" -f src/db/setup/roles.sql
psql -h localhost -U postgres -d postgres -f src/db/setup/local-dev.sql

# 2. Environment
Copy-Item .env.example .env
notepad .env
#   Put the two passwords from step 1 after the role name, e.g. app_runtime:runtime-dev@
#   DATABASE_URL=postgres://app_runtime@localhost:5432/laurence_lab
#   DATABASE_URL_DIRECT=postgres://app_runtime@localhost:5432/laurence_lab
#   DATABASE_URL_MIGRATE=postgres://app_migrate@localhost:5432/laurence_lab
#   DATABASE_URL_TEST=postgres://app_migrate@localhost:5432/laurence_lab_test
#   DATABASE_URL_TEST_RUNTIME=postgres://app_runtime@localhost:5432/laurence_lab_test
#   INTERNAL_API_SECRET=<paste output of: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
#   TELEGRAM_CUSTOMER_BOT_TOKEN=<your @BotFather token>
#   PAYSTACK_SECRET_KEY=sk_test_mock            (any sk_test_ value works with the local mock)
#   PAYSTACK_BASE_URL=http://127.0.0.1:4010

# 3. Schema + menu
npm run migrate
npm run seed

# 4. Two terminals
npm run mock:paystack      # terminal A — fake Paystack with a checkout page on :4010
npm run dev                # terminal B — API on :3000 + the bot polling Telegram
```

Open your bot's `t.me/...` link, send `/start`, order "2 jollof and 1 chicken", share a location
(anywhere near UNIBEN, e.g. 6.40, 5.61 — Zone A), tap **Pay**. The mock checkout page opens; tap
**Pay** there and Telegram receives "Payment received". Kitchen steps can be driven from the API
(`POST /internal/v1/orders/{id}/transition`) until the admin bot lands in phase 5.

**Real Paystack test mode:** set `PAYSTACK_SECRET_KEY=sk_test_…` from your Paystack dashboard and
`PAYSTACK_BASE_URL=https://api.paystack.co`. Webhooks need a public URL: run a tunnel
(`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) and set the webhook URL in
the Paystack dashboard to `https://<tunnel>/webhooks/paystack`. Even without the webhook, the
reconciliation sweep (phase 7) and the "verify" endpoint settle payments.

**Webhook mode for Telegram (production):** `TELEGRAM_MODE=webhook`, `PUBLIC_BASE_URL=https://…`,
`TELEGRAM_WEBHOOK_SECRET=<random>`. The path is derived from the token and never logged. Use a
separate staging bot pair (two more BotFather bots) for staging.

## Hosting the pilot on Vercel

The owner's existing Vercel project runs the same code in serverless mode (`api/index.js` →
`src/http/serverless.ts`): Telegram webhooks, inline processing, request-driven maintenance,
browser-based `/setup/*` bootstrap. Step-by-step owner guide: `docs/DEPLOY_VERCEL.md`. Trade-offs
versus an always-on host: `docs/DECISION_RECORD.md` DR-012.

## npm scripts

| Script          | What it does                                                       |
| --------------- | ------------------------------------------------------------------ |
| `dev`           | start server + workers with hot reload (`tsx watch`)               |
| `build`         | compile to `dist/`                                                 |
| `start`         | run compiled server                                                |
| `test`          | run unit and integration tests (Vitest)                            |
| `lint`          | ESLint + Prettier check                                            |
| `typecheck`     | `tsc --noEmit`                                                     |
| `migrate`       | apply pending SQL migrations                                       |
| `seed`          | load realistic Nigerian menu seed data                             |
| `verify`        | typecheck + lint + secret scan + tests, prints PASS/FAIL table     |
| `mock:paystack` | local Paystack look-alike with a checkout page and signed webhooks |
| `secrets:scan`  | secretlint over the whole tree                                     |

## Database connections

Supabase's **transaction-mode** pooler cannot do prepared statements, session settings or advisory
locks. So:

| Variable               | Used by                                    | Mode required          |
| ---------------------- | ------------------------------------------ | ---------------------- |
| `DATABASE_URL`         | request-time queries (API, webhooks)       | transaction pooler OK  |
| `DATABASE_URL_DIRECT`  | job queue, scheduler locks, LISTEN/NOTIFY  | direct or session mode |
| `DATABASE_URL_MIGRATE` | migrations (separate least-privilege role) | direct or session mode |

Locally all three point at the same Postgres with different roles.

## Repository rules

- `main` only receives merge commits from feature branches (`--no-ff`), each tagged.
- Pre-commit hook runs secretlint on staged files. CI runs `npm run verify`, `npm audit` and gitleaks
  over history.
- Never commit `.env`, live keys or real customer data.

## Documents (filled in as phases complete)

`docs/ARCHITECTURE.md` · `docs/DECISION_RECORD.md` · `docs/ASSUMPTIONS.md` · `docs/OWNER_REPORT.md` ·
`docs/HANDOVER.md` · `docs/REVIEW_GUIDE.md` · `docs/SECURITY.md` · `docs/COSTS.md` ·
`docs/changes/<branch>.md`
