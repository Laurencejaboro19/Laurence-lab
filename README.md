# Laurence Lab Bot

Chat-based food ordering platform for **Laurence Lab**, Benin City, Nigeria. Customers browse, order,
pay (Paystack), track delivery and get support entirely inside Telegram and WhatsApp. Staff run the
business through a separate Telegram admin bot. There is no web front end.

> **Status:** phase 2 (data model) — no server yet. See [CHANGELOG.md](CHANGELOG.md) for what each tagged release contains
> and `docs/` for architecture, decisions and owner reports as they land.

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

## npm scripts

| Script         | What it does                                                   |
| -------------- | -------------------------------------------------------------- |
| `dev`          | start server + workers with hot reload (`tsx watch`)           |
| `build`        | compile to `dist/`                                             |
| `start`        | run compiled server                                            |
| `test`         | run unit and integration tests (Vitest)                        |
| `lint`         | ESLint + Prettier check                                        |
| `typecheck`    | `tsc --noEmit`                                                 |
| `migrate`      | apply pending SQL migrations                                   |
| `seed`         | load realistic Nigerian menu seed data                         |
| `verify`       | typecheck + lint + secret scan + tests, prints PASS/FAIL table |
| `secrets:scan` | secretlint over the whole tree                                 |

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
