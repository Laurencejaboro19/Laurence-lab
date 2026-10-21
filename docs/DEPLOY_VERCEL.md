# Deploying the pilot on Vercel (owner guide)

This is the exact sequence that took the bot live on **2026-10-21**, written so you can repeat it
for a second project (staging, a second restaurant) or hand it to someone else. Every service here
is on a free plan: Supabase Free, Vercel Hobby, Paystack test mode, GitHub.

What is where, after this guide:

| Thing        | Lives in                                   | Who holds it        |
| ------------ | ------------------------------------------ | ------------------- |
| Code         | GitHub `Laurencejaboro19/Laurence-lab`     | you                 |
| Running bot  | Vercel project `laurence-lab-bot` (London) | you                 |
| Database     | Supabase project `laurence-lab-prod`       | you                 |
| Secrets      | Vercel → Settings → Environment Variables  | you (values hidden) |
| Telegram bot | @LaurencelabBot (+ @LaurenceLabAdminBot)   | you, via @BotFather |
| Payments     | Paystack dashboard, **Test Mode**          | you                 |

---

## 1. Supabase — the database (≈10 minutes)

1. https://supabase.com → **Start your project** → sign in with GitHub.
2. **Create an organization** → Name `Laurencejaboro` (anything), Type **Personal**, Plan
   **Free** → Create.
3. **New project**:
   - Project name: `laurence-lab-prod`
   - Database password: **Generate a password** → save it in your notes (this is the `postgres`
     superuser password; the bot never uses it)
   - Region: click the region box and pick **West Europe (London) `eu-west-2`** — not the plain
     "Europe" button, which lets Supabase choose any city
   - GitHub repository: **leave empty** (Supabase branching is a different workflow)
   - Security: untick **Automatically expose new tables**, tick **Enable automatic RLS**
   - **Create new project** → wait for the green "Project is ready" (~2 minutes)
4. Left sidebar → **SQL Editor** → **New query** → paste, with two passwords of your own in place
   of `PASSWORD-B` and `PASSWORD-C`, then **Run** (expect "Success. No rows returned"):

```sql
CREATE ROLE app_migrate LOGIN PASSWORD 'PASSWORD-B' NOINHERIT;
CREATE ROLE app_runtime LOGIN PASSWORD 'PASSWORD-C' NOINHERIT;
GRANT app_runtime TO app_migrate;
ALTER ROLE app_runtime CONNECTION LIMIT 40;
ALTER ROLE app_migrate CONNECTION LIMIT 5;
GRANT CREATE ON DATABASE postgres TO app_migrate;
```

5. Top bar → **Connect** → tab **Direct** ("Connection string") → Method **Session pooler**.
   Note the two values shown under "Connection parameters":
   - host: `aws-0-eu-west-2.pooler.supabase.com`
   - user: `postgres.<ref>` — the part after `postgres.` is your **project ref**
     (ours: `zgajsaptaxkctfyppacr`)

That is everything in Supabase. You never need to open it again except to look at data.

## 2. Vercel — the server (≈5 minutes)

Direct link: https://vercel.com/laurence-jaboro/laurence-lab-bot/settings/environment-variables

The "Add Environment Variable" form at the top accepts a whole `.env` block pasted into the
**Key** box; it splits into rows by itself. Set **Type: Config** for anything you may need to read
back later, **Secret** for the rest. Tick **Production** (and Preview). Then **Save**.

The variables the bot needs (names only — values are yours):

```
PUBLIC_BASE_URL=https://laurence-lab-bot.vercel.app
LOG_LEVEL=info
INTERNAL_API_SECRET=<64 hex chars: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
CRON_SECRET=<48 hex chars, same recipe>
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_SECRET=<48 hex chars, same recipe>
TELEGRAM_CUSTOMER_BOT_TOKEN=<from @BotFather>
TELEGRAM_ADMIN_BOT_TOKEN=<from @BotFather>
DATABASE_POOLED=true
DATABASE_URL=<app_runtime, PASSWORD-C, port 6543 — see recipe below>
DATABASE_URL_DIRECT=<app_runtime, PASSWORD-C, port 5432>
DATABASE_URL_MIGRATE=<app_migrate, PASSWORD-B, port 5432>
PAYSTACK_SECRET_KEY=<sk_test_… from Paystack, step 4>
PAYSTACK_BASE_URL=https://api.paystack.co
```

Recipe for the three database values — `postgresql://` + user + `.` + ref + `:` + password +
`@` + host + `:` + port + `/postgres`, i.e. user `app_runtime.<ref>` with PASSWORD-C on port
6543 (`DATABASE_URL`) and 5432 (`DATABASE_URL_DIRECT`), and user `app_migrate.<ref>` with
PASSWORD-B on 5432 (`DATABASE_URL_MIGRATE`). Host and ref come from step 1.5.

Things we learned the hard way:

- **Do not add `NODE_ENV`** — Vercel sets it to `production` itself and rejects the row in red.
- **"already exists" in red** on every row means a previous Save already went through. Reload the
  page and check the list below the form.
- **Variables only reach new deployments.** After any change: **Deployments** → top row → **⋯**
  (three dots, right of "Visit") → **Redeploy** → **Redeploy**. Wait for the green **Ready**.
  The GitHub integration is not connected to this project, so pushing to `main` does _not_
  deploy by itself; the builder deploys through the Vercel API, or you press Redeploy.
- Port 6543 is the **transaction** pooler (fine for request traffic), 5432 the **session**
  pooler (needed for migrations and jobs). The pooler requires the `role.<ref>` username form.

## 3. Switch it on from the browser (4 clicks)

The setup key is derived from `INTERNAL_API_SECRET` (`npm run setup-key` prints it locally with
the same secret in `.env`). Open these in order; each returns a short JSON line:

| #   | URL                                                        | Expect                                                                                   |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | `https://laurence-lab-bot.vercel.app/setup?key=…`          | `"database":"reachable","paystack":"paystack"`                                           |
| 2   | `https://laurence-lab-bot.vercel.app/setup/migrate?key=…`  | `"applied":[…]` first time, then `alreadyUpToDate`                                       |
| 3   | `https://laurence-lab-bot.vercel.app/setup/seed?key=…`     | `"seeded":["category Rice: 3 items", …]`                                                 |
| 4   | `https://laurence-lab-bot.vercel.app/setup/telegram?key=…` | `"webhook":"installed","bot":"https://t.me/LaurencelabBot"`                              |
| 5   | `https://laurence-lab-bot.vercel.app/setup/paystack?key=…` | `"ok":true,"checkoutPage":"https://checkout.paystack.com/…"` — or Paystack's exact error |

Re-run 2 after every release that adds a migration (the response says what it applied). 3 and 4
are safe to repeat; the seed keeps existing values.

Then Telegram → **@LaurencelabBot** → `/start`.

## 4. Paystack — payments (≈5 minutes, test mode)

1. https://dashboard.paystack.com/#/signup → create the business account. No documents are needed
   for test mode.
2. Stay in **Test Mode** (toggle at the top right).
3. Left menu → **Settings** → **API Keys & Webhooks**
   (https://dashboard.paystack.com/#/settings/developers).
4. **Test Secret Key** → copy icon → put it into Vercel as `PAYSTACK_SECRET_KEY` (step 2) → Redeploy.
5. **Test Webhook URL** → `https://laurence-lab-bot.vercel.app/webhooks/paystack` → **Save changes**.
   Leave Callback URL and IP Whitelist empty.

Test card: `4084 0840 8408 4081`, any future expiry, CVV `408`, OTP `123456`. No money moves.

**Going live later:** finish **Compliance** in the Paystack menu (business documents, bank
account; Paystack reviews it). When approved: copy the **Live** secret key into the same Vercel
variable, set the **Live Webhook URL** to the same address, Redeploy. Nothing else changes. The
app refuses an `sk_live_` key anywhere except the production deployment.

## 5. Security notes (do these before real customers)

- Both bot tokens were shared as screenshots in chat. Send `/revoke` to @BotFather for each bot,
  paste the new tokens into Vercel, Redeploy, open `/setup/telegram?key=…` again.
- The Supabase `postgres` password and the two role passwords were typed into the chat. Reset
  them: Supabase → Project Settings → Database → **Reset database password** for `postgres`; for
  the roles run in the SQL Editor `ALTER ROLE app_runtime PASSWORD '…'; ALTER ROLE app_migrate
PASSWORD '…';`, then update the three `DATABASE_URL*` values in Vercel and Redeploy.
- `INTERNAL_API_SECRET` was also pasted in chat. Rotating it changes the setup key and the
  Telegram webhook path: set a new value, Redeploy, open `/setup/telegram` with the new key.
- **Database TLS.** Supabase's certificate chain is signed by Supabase's own CA, which Node does
  not trust out of the box, so the app encrypts the connection but does not verify the server
  certificate until `DATABASE_SSL_CA` is set. Launch item: Supabase → Project Settings →
  Database → **SSL** → download the certificate, paste its PEM text into a Vercel variable named
  `DATABASE_SSL_CA`, Redeploy. Verification then switches on automatically.
- The Supabase **anon** key is not used anywhere; keep the Data API's exposed schemas at the
  default (`public`) so `app` stays unreachable. Verify with
  `SUPABASE_URL=… SUPABASE_ANON_KEY=… node scripts/check-anon-lockdown.mjs`.
- Vercel Hobby runs the daily cron at 03:00 UTC; day-to-day maintenance runs on request traffic
  (DR-012).
- Make the GitHub repository private (Settings → General → Danger Zone → Change visibility).

## 6. Troubleshooting (every one of these happened on 2026-10-18/21)

| Symptom                                                                       | Cause and fix                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel page "500 FUNCTION_INVOCATION_FAILED"                                  | Old build without the variables, or a start-up crash. Redeploy; the newer `api/index.js` shows the real cause as JSON instead of this page.                                                          |
| JSON `"error":"function failed"` mentioning `content-disposition`             | A Swagger-UI dependency cannot load on Node 24. Fixed in code (`docsUi: false` on Vercel); update to `main`.                                                                                         |
| `/setup` says `database: error: self-signed certificate in certificate chain` | Supabase's CA. Fixed in code (`sslFor()` in `src/db/client.ts`); update to `main`. Set `DATABASE_SSL_CA` for full verification.                                                                      |
| Bot answers every message "Something went wrong on our side"                  | A database write is failing. First suspect: a migration not applied — open `/setup/migrate`. The live cause was pgcrypto's `digest()` not on the search path; migration 0008 removed the dependency. |
| `/setup/telegram` returns 400                                                 | `TELEGRAM_CUSTOMER_BOT_TOKEN` or `TELEGRAM_WEBHOOK_SECRET` missing on the deployment.                                                                                                                |
| Variables edited but nothing changes                                          | Redeploy; variables apply only to deployments created after the edit.                                                                                                                                |
| Vercel env form: `NODE_ENV` in red                                            | Reserved by Vercel; delete that row.                                                                                                                                                                 |
| Vercel env form: every row red, "already exists"                              | It was saved already; reload the page.                                                                                                                                                               |
