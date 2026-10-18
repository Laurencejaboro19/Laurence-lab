# Owner report

Plain-language status after each phase. Newest first.

---

## Deployment — Vercel pilot hosting (merged to `main` 2026-10-18)

**Decision:** the owner asked for the bot to run on his existing Vercel project
`laurence-lab-bot` (Hobby plan). DR-012 records the serverless trade-offs; the core is untouched.

**Done by the builder:** `src/http/serverless.ts` + `vercel.json`; Vercel env vars set (both bot
tokens as _sensitive_, webhook secret, internal secret, cron secret, mode/log settings, **placeholder**
database URLs); production build green on `main`; `docs/DEPLOY_VERCEL.md` written.

**Blocked on the owner (in this order):**

1. Create the Supabase project and roles, then put the three real `DATABASE_URL*` values into Vercel
   (`docs/DEPLOY_VERCEL.md` §1–2) and redeploy.
2. Open the four `/setup/*?key=…` URLs (§3) — the key is in the chat with the builder.
3. `PAYSTACK_SECRET_KEY` (test) for the Pay button to work on Vercel (§4).
4. Before real customers: revoke and replace both bot tokens (§5); make the repo private.

**Until step 1 is done** the deployment answers `/` and `/healthz`, but every route that needs the
database (including the Telegram webhook) will return an error — expected.

---

## Phase 4 — Telegram customer bot + Paystack test mode (branch `feat/telegram-customer`)

**Date:** 2026-10-17

### What works (and was run)

- **The customer bot, end to end**, driven by real Telegram Update payloads against a fake Bot API in
  tests and smoke-booted as the real process: `/start` → language (English or Pidgin) → privacy
  note → phone (contact button or typed) → persistent Menu / Cart / Track / Help shortcuts → browse
  by category with paging → item detail → add → **or just type** "2 jollof and 1 chicken" →
  confirm → cart editing (➖ ➕ 🗑) → checkout → delivery (saved address, shared pin or typed address
  - area) or pickup → summary with fee and ETA → **Pay** button (Paystack) → cancel link →
    payment-received push → kitchen status pushes → `/track` with live status → reorder →
    `/privacy`, `/export_my_data`, `/delete_my_data`.
- **Paystack for real**: the production client talks to the documented endpoints; locally it talks
  to `npm run mock:paystack`, which serves a checkout page and posts a correctly signed webhook back.
  Bad or tampered signatures are rejected before any parsing; duplicate deliveries are acknowledged
  but ignored; events are processed after the 200 and replayed on restart if the process died.
- Robustness: group chats declined, blocked users marked unreachable (and cleared when they return),
  stale buttons answered with a fresh menu, 429s honoured, callback data kept under 64 bytes,
  HTML escaped, per-user ordering guaranteed by a row lock.
- `npm run verify` → **PASS**, 790 tests.

### Evidence

```
test/core/conversation.test.ts   11 passed  (full journey through the engine)
test/telegram/adapter.test.ts     9 passed  (normalise + render + 403/429 handling)
test/telegram/journey.test.ts     6 passed  (webhook secret/dedupe, onboarding, order, pay, pushes, blocked)
test/http/paystack-webhook.test   6 passed  (real gateway → mock → webhook → PAID; tampering; replay)
smoke: `npx tsx src/main.ts` with a fake Bot API → "telegram customer bot polling — https://t.me/LaurenceLabBot",
       /start handled, welcome message sent
```

### What is mocked or not yet real

- No live Telegram or Paystack call was made from the build environment (outbound network is
  blocked there). The first real run is yours: paste the BotFather token into `.env` and
  `npm run dev` (README → "Run the Telegram customer bot locally").
- Paystack **test keys** only. Live keys are a launch-day owner action.
- Kitchen actions still go through the API; the admin bot is phase 5.
- Delivery is not integrated: READY on a delivery order emits `delivery.requested` and the
  customer gets "on the way" only when staff mark DISPATCHED (phase 6 adds the partner/rider details).
- Scheduler (expire unpaid orders, reconcile payments, run refunds) is phase 7; the functions exist.
- The synthetic Paystack customer email (`<phone>@customers.laurencelab.invalid`) is still to be
  confirmed against the real test API on your first run — if Paystack rejects it, we switch to a
  configurable domain (one-line change in `src/core/services/orders.ts`).

### What could lose money or leak data (and what guards it)

Unchanged from phases 1–3, plus: **webhook authenticity** (constant-time HMAC-SHA512 on raw body,
tested with unsigned/tampered/wrong-key bodies) and **Telegram webhook authenticity** (constant-time
secret token on an unguessable path, tested). See `docs/REVIEW_GUIDE.md` rows 8 and 12.

### NOT DONE (with the risk each creates)

| Item                                                     | Risk                                                        | Planned                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Live run with the real bot token                         | Unknown unknowns on the real Bot API until you run it       | Owner, now                                                        |
| Admin bot                                                | Kitchen uses the API/curl; slow                             | Phase 5                                                           |
| Delivery partner / rider details in "on the way" message | Customer sees no rider name/phone yet                       | Phase 6                                                           |
| Scheduler for expiry/reconcile/refund jobs               | Unpaid orders expire only when the sweep is run manually    | Phase 7                                                           |
| Item photos                                              | Menu is text-only until photos are uploaded via admin bot   | Phase 5                                                           |
| Cross-channel account linking after phone match          | Second channel with the same phone is kept separate for now | Phase 9                                                           |
| Git tags cannot be pushed from the build session         | `v0.1.0-core` exists locally only                           | Owner: `git tag v0.1.0-core aa313f6; git push origin v0.1.0-core` |

### What the owner must do next

1. Put `TELEGRAM_CUSTOMER_BOT_TOKEN` in `.env`, follow the README PowerShell steps, and send `/start`
   to your bot. Report anything odd — screenshots are perfect.
2. Reply **"merge and continue"** on PR #2 (`feat/telegram-customer`).
3. Set `main` as the default branch, make the repo private, push the tag (command above).
4. Create a Paystack account and get **test** keys when you want to see the real checkout page.

---

## Phases 1–3 — architecture, data model, core and internal API (branch `feat/core-platform`)

**Date:** 2026-10-17

### What works (and was run)

- `npm run verify` passes: typecheck, lint, secret scan and **760+ tests**, including integration tests
  against a real local PostgreSQL 16 (see "Evidence").
- The database schema (`app`), with every table RLS-locked, append-only ledgers, and a tamper-evident
  audit log whose chain is verified by `app.audit_verify()`.
- A migration runner that refuses to run edited or missing migrations.
- The core business logic, independent of Telegram/WhatsApp/HTTP:
  - menu with variants/add-ons and live availability; sold-out toggle; price changes (owner/manager)
  - carts with zone fees, minimum order, promo rules
  - **checkout** that reserves stock atomically and starts a Paystack payment (mock for now)
  - the full order lifecycle with role checks (kitchen / dispatch / support / manager / owner)
  - payment settlement that **verifies before marking PAID** and flags underpaid, overpaid,
    wrong-currency, late (after expiry), duplicate and unknown-reference payments for a human
  - refunds (full and partial) that cannot exceed what was paid and cannot be sent twice
  - expiry of unpaid orders with stock release; reconciliation of missed webhooks
  - customer identity per chat channel, phone capture without silent account merging,
    NDPA data export and anonymising deletion
- An internal HTTP API (`/internal/v1`, 32 routes) with signed tokens, per-actor rate limits,
  mandatory `Idempotency-Key` on every state-changing request, a uniform error format and a
  generated OpenAPI document at `/internal/v1/docs`.

### Evidence

```
npm run verify            → RESULT: PASS (typecheck, lint, secrets, test)
vitest                    → 6 DB files, 3 core files, 1 HTTP file, 2 domain files
state machine matrix      → 676 generated cases (13×13 statuses × 4 actors)
overselling               → 40 concurrent buyers for 7 portions: exactly 7 succeed
audit tamper              → editing row 2 after disabling the guard is detected at row 2
API journey               → identify → phone → address (zone A) → cart → checkout →
                            provider event → PAID → ACCEPTED, with IDOR and role checks
live boot                 → GET /healthz {ok:true}, /readyz {schemaVersion:7}, docs 200, menu 401 → 200 with token
```

### What is mocked or not yet real

- **Paystack** is an in-memory mock (`MockPaymentGateway`). It uses the same signature scheme as
  Paystack (HMAC-SHA512 of the raw body). The real client, the local mock HTTP server and the
  webhook route arrive in phase 4.
- **Telegram** is not connected yet (phase 4). Nothing customer-facing exists today; the API is the
  surface.
- **Background jobs** are not scheduled yet (phase 7). The functions exist and are tested
  (`expireOverdue`, `reconcilePending`, `executeRefund`); the scheduler that calls them does not.
- Domain events go to an in-process bus; phase 7 moves them to pg-boss.
- Delivery, maps, AI: interfaces only.

### What could lose money or leak data (and what guards it)

See `docs/REVIEW_GUIDE.md`. In one line each:

1. Marking an order paid without verifying — guarded by `settle()`; tested for every mismatch case.
2. Selling the same portion twice — single conditional UPDATE + CHECK constraints; concurrency test.
3. Refunding twice — unique idempotency key per refund; tested.
4. One customer reading another's order — IDOR guard in services; tested at service and API level.
5. Rewriting the audit log — trigger-computed hash chain; tamper test.
6. The Supabase anon key reading business tables — RLS + revokes; tested locally, probe script for
   real projects.

### NOT DONE (with the risk each creates)

| Item                                                                | Risk                                                        | Planned                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Real Paystack client + webhook route + local mock server            | Nothing can be paid for yet                                 | Phase 4                                                                   |
| Telegram customer bot                                               | No customer can order yet                                   | Phase 4                                                                   |
| Admin bot                                                           | Staff actions only via API/curl today                       | Phase 5                                                                   |
| Scheduler for expiry / reconciliation / refunds                     | Unpaid orders are not expired automatically yet             | Phase 7                                                                   |
| Staff table wiring for token minting                                | Staff tokens are minted by a script, not from the allowlist | Phase 5                                                                   |
| Synthetic customer email for Paystack (`<phone>@customers…invalid`) | Paystack may reject the TLD; verify with the test API       | Phase 4                                                                   |
| Supabase anon-key probe against a real project                      | Lockdown proven only on local Postgres so far               | Owner: create the dev project, then run `scripts/check-anon-lockdown.mjs` |
| Migration `0003` gained a `line_no` column before release           | None (pre-release); noted for transparency                  | —                                                                         |

### What the owner must do next

1. Switch the repository's default branch to `main` and make it **private** (GitHub → Settings).
2. Review and reply **"merge and continue"** on the `feat/core-platform` pull request.
3. Create a free Supabase project (London, `eu-west-2`) for development and run
   `src/db/setup/roles.sql` there when you are ready to try the migrations against Supabase.
4. Create the two Telegram bots with @BotFather (customer + admin) and keep the tokens for phase 4.
5. Start the Paystack business registration (test keys are enough for now; live keys only at launch).
6. Start **Meta Business verification** now — it takes weeks and gates the WhatsApp phase.
