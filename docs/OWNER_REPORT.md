# Owner report

Plain-language status after each phase. Newest first.

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
