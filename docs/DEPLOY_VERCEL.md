# Deploying the pilot on Vercel (owner guide)

The Vercel project `laurence-lab-bot` already holds the bot tokens and server secrets (set by the
builder on 2026-10-18). The one thing Vercel cannot provide is the database. This page is the
complete list of owner actions; everything else is automated.

## 1. Create the Supabase project (≈5 minutes, free)

1. supabase.com → **New project** → name `laurence-lab-prod`, region **London (eu-west-2)**, choose
   a strong database password (save it — it is the `postgres` user's password).
2. When the project is ready: **Project Settings → Database → Connection string**. Copy the
   **Session pooler** URI. It looks like
   `postgresql://postgres.<ref>:…@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`.
3. **SQL Editor → New query**, paste the following with two passwords of your choice, run it:

```sql
-- App roles (never run the app as postgres). Pick two strong passwords.
CREATE ROLE app_migrate LOGIN PASSWORD 'CHOOSE-ONE' NOINHERIT;
CREATE ROLE app_runtime LOGIN PASSWORD 'CHOOSE-ANOTHER' NOINHERIT;
GRANT app_runtime TO app_migrate;
ALTER ROLE app_runtime CONNECTION LIMIT 40;
ALTER ROLE app_migrate CONNECTION LIMIT 5;
GRANT CREATE ON DATABASE postgres TO app_migrate;
```

## 2. Give the connection strings to the deployment

Either paste these three into **Vercel → laurence-lab-bot → Settings → Environment Variables**
(replace the existing placeholders), or send them to the builder to set:

| Variable               | Value                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | user `app_runtime.<ref>`, password CHOOSE-ANOTHER, host from step 1.2, **port 6543**, db `postgres` |
| `DATABASE_URL_DIRECT`  | user `app_runtime.<ref>`, password CHOOSE-ANOTHER, same host, **port 5432**, db `postgres`          |
| `DATABASE_URL_MIGRATE` | user `app_migrate.<ref>`, password CHOOSE-ONE, same host, **port 5432**, db `postgres`              |

Assemble each as `postgresql://USER:PASSWORD@HOST:PORT/postgres`.

(`<ref>` and the host come from the string you copied in step 1.2; the pooler needs the
`role.<ref>` username form. Port 6543 = transaction pooler, 5432 = session pooler.)

Then **Deployments → ⋯ → Redeploy** so the new values are picked up (or push any commit to
`main`; Vercel rebuilds automatically).

Notes from the first real run: Vercel refuses a user-set `NODE_ENV` (it sets `production`
itself — leave it out), and the whole block can be pasted into the **Key** box of the "Add"
form in one go; it splits into rows.

## 3. Bootstrap from the browser

The builder gives you a **setup key** (derived from `INTERNAL_API_SECRET`; or run
`npm run setup-key` locally with the same secret). Open, in order:

1. `https://laurence-lab-bot.vercel.app/setup?key=…` → should say `"database":"reachable"`
2. `https://laurence-lab-bot.vercel.app/setup/migrate?key=…` → applies the 7 migrations
3. `https://laurence-lab-bot.vercel.app/setup/seed?key=…` → loads the menu and zones
4. `https://laurence-lab-bot.vercel.app/setup/telegram?key=…` → installs the Telegram webhook

Then open **t.me/LaurencelabBot** and send `/start`.

## 4. Payments

Without a Paystack key the **Pay** button cannot work on Vercel (the local mock only runs on a
laptop). Create a Paystack account, copy the **test** secret key (`sk_test_…`) and set
`PAYSTACK_SECRET_KEY` in Vercel, then in the Paystack dashboard set the webhook URL to
`https://laurence-lab-bot.vercel.app/webhooks/paystack`. Redeploy. Test cards are listed in
Paystack's docs; no real money moves in test mode.

## 5. Security notes

- Both bot tokens were shared as screenshots in chat. Before real customers use the bot, send
  `/revoke` to @BotFather for each bot, paste the new tokens into Vercel, redeploy, and open
  `/setup/telegram?key=…` again.
- The Supabase **anon** key is not used anywhere; keep the Data API's exposed schemas at the
  default (`public`) so `app` stays unreachable. Verify with
  `SUPABASE_URL=… SUPABASE_ANON_KEY=… node scripts/check-anon-lockdown.mjs`.
- Vercel Hobby runs the daily cron at 03:00 UTC; day-to-day maintenance runs on request traffic
  (DR-012).

## 6. Troubleshooting

- **A JSON page saying `"error": "function failed"`** — the function could not start. The
  `message` names the cause (a missing or malformed environment variable, a module that failed
  to load). Fix the variable in Vercel, redeploy, retry. `api/index.js` produces this page so
  the cause is never hidden behind Vercel's generic `FUNCTION_INVOCATION_FAILED` screen.
- **`/setup` says `database: error: …`** — the connection string is wrong or the Supabase
  project is paused. Check the three `DATABASE_URL*` values (§2) and the project status.
- **`/setup/telegram` returns 400** — `TELEGRAM_CUSTOMER_BOT_TOKEN` or
  `TELEGRAM_WEBHOOK_SECRET` is not set on the deployment.
- **Variables edited but nothing changes** — environment variables apply only to deployments
  created *after* the edit. Redeploy (Deployments → ⋯ → Redeploy).
