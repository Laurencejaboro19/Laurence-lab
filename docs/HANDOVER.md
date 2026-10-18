# Handover

Everything a new developer (or the owner, six months from now) needs to run, change and recover the
system. Updated at the end of every phase. Names of secrets appear here; **values never do**.

## Services and accounts (owner-held)

| Service       | Purpose                                        | Status (2026-10-17)                                                                  |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| GitHub        | source, CI                                     | `Laurencejaboro19/Laurence-lab`, branch `main` — make default + private              |
| Supabase      | Postgres (dev/staging/prod)                    | `laurence-lab-prod` created 2026-10-18 (Free, London `eu-west-2`); roles applied     |
| Paystack      | payments                                       | not yet created; test keys first                                                     |
| Telegram      | customer bot + admin bot                       | @LaurencelabBot, @LaurenceLabAdminBot — tokens in Vercel; revoke+rotate before pilot |
| Meta Business | WhatsApp Cloud API (phase 9)                   | start verification now                                                               |
| Host (pilot)  | Vercel Hobby `laurence-lab-bot`, region `lhr1` | live build; needs Supabase URLs (docs/DEPLOY_VERCEL.md)                              |
| Host (scale)  | Node process (Fly.io, `lhr`)                   | recommended later (DR-004/DR-012)                                                    |
| Sentry        | error tracking                                 | phase 8                                                                              |

## Environment variables

See `.env.example` for the full list with comments. Groups:

- Database: `DATABASE_URL`, `DATABASE_URL_DIRECT`, `DATABASE_URL_MIGRATE`, `DATABASE_POOLED`,
  (`DATABASE_URL_TEST`, `DATABASE_URL_TEST_RUNTIME` for tests)
- Internal API: `INTERNAL_API_SECRET` (32+ random bytes; rotating it invalidates all tokens **and changes the /setup key and Telegram webhook path** — re-run `/setup/telegram` after rotating)
- Vercel only: `CRON_SECRET` (authorises `/jobs/daily`)
- Telegram: `TELEGRAM_CUSTOMER_BOT_TOKEN`, `TELEGRAM_ADMIN_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_MODE`
- Paystack: `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_BASE_URL`
- Delivery / maps / AI / WhatsApp / Sentry: as listed in `.env.example`

Separate values per environment. The app refuses to start with a live Paystack key outside production.

## Running

```bash
npm ci && cp .env.example .env     # fill in database URLs and INTERNAL_API_SECRET
npm run migrate && npm run seed
npm run dev                        # http://localhost:3000/internal/v1/docs
node scripts/mint-token.mjs system laptop   # a bearer token for curl / the docs UI
```

## Database operations

- Migrate: `npm run migrate` (status: `npm run migrate -- status`). Additive only; never edit an
  applied migration — the runner refuses.
- Roles: `src/db/setup/roles.sql` once per database; app runs as `app_runtime`.
- Audit integrity: `GET /internal/v1/audit/verify` (owner/manager token) or
  `SELECT * FROM app.audit_verify()`.
- Backups / restore drill: phase 8 (runbook). Interim: Supabase Pro daily backups + `pg_dump`.

## Key rotation (interim procedure; full runbook in phase 8)

1. `INTERNAL_API_SECRET`: set the new value, restart; all clients re-mint tokens (they do so on start).
2. Database passwords: `ALTER ROLE app_runtime PASSWORD '…'` as a privileged role, update the host
   secret, restart. Do `app_migrate` the same way.
3. Paystack: rotate in the Paystack dashboard; update the host secret; webhook signatures switch
   immediately, so restart within the same minute.

## How a new developer takes over

1. Read `docs/ARCHITECTURE.md`, then `docs/DECISION_RECORD.md`, then `docs/REVIEW_GUIDE.md`.
2. Run the local setup above and `npm run verify` — everything must be green before any change.
3. Follow the branch plan in the README: feature branch → `npm run verify` → PR → merge `--no-ff` → tag.
4. Keep `docs/OWNER_REPORT.md` and `CHANGELOG.md` honest; list anything unfinished under NOT DONE.
