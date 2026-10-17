# feat/core-platform → main (phases 1, 2, 3) — tag `v0.1.0-core`

## What changed and why

The foundation everything else plugs into:

1. **Phase 1 — design.** `docs/ARCHITECTURE.md` (shape, layout, adapter contract, flows, lifecycle
   table, hard problems), `docs/DECISION_RECORD.md` (pg + SQL, pg-boss, Zod, Fly.io London next to
   Supabase `eu-west-2`, connection modes, maps, AI, charts), `docs/ASSUMPTIONS.md`, and the channel
   adapter contract in `src/core/channel/` sized to the strictest platform (WhatsApp).
2. **Phase 2 — data.** Seven SQL migrations creating schema `app` (including the WhatsApp tables so
   phase 9 is additive), a checksummed migration runner with an advisory lock, least-privilege roles,
   a trigger-computed hash-chained audit log, RLS lockdown with a reusable `app.lock_down_table()`,
   Nigerian menu seed, and the anon-key probe script. `docs/DATA_MODEL.md`.
3. **Phase 3 — core + API.** Pure domain (money, state machine, pricing, geo, parser), ports, pg
   repositories, services (settings, customers, catalog, cart, orders, payments), an in-process
   event bus with post-commit flush, the mock payment gateway, and the Fastify internal API v1 with
   signed tokens, idempotency keys, per-actor rate limits, uniform errors and generated OpenAPI.

## Files that touch core logic

- `src/core/domain/order-status.ts` — the transition table (actors + effects)
- `src/core/services/orders.ts` — checkout, transitions, expiry
- `src/core/services/payments.ts` — settlement rules, reconciliation, refunds
- `src/db/repositories/inventory.ts` — reserve / commit / release
- `src/db/repositories/orders.ts` — `lockForUpdate` + conditional `setStatus`
- `src/db/migrations/0005_audit_log.sql`, `0007_rls_lockdown.sql`

## Risks

- Paystack is mocked; the synthetic customer email format must be confirmed against the real test API
  (phase 4).
- The event bus is in-process: if the process dies after COMMIT and before `flush`, a notification is
  lost (not an order, not money). Phase 7 moves events to pg-boss, which is transactional.
- Migration `0003` was edited (added `order_items.line_no`) before any release. From this tag on,
  migrations are immutable.

## Tests added

- Domain: money, pricing, geo, ids, parser; state machine full matrix (676 cases).
- DB: lockdown on every table, audit chain + tamper detection, overselling under concurrency,
  reserve/commit/release, migration idempotence and immutability.
- Core: checkout happy path and failures (out of stock, provider down, minimum, closed, caps),
  kitchen lifecycle with roles, expiry; payment edge cases (duplicate webhook, untrusted webhook,
  under/over/currency/late/unknown, reconciliation, full/partial refunds, double charge); IDOR.
- HTTP: health/ready/OpenAPI, token failures, error shape, idempotency replay/mismatch, full API
  journey with role checks, rate limiting.

## How to verify

```bash
psql -h localhost -U postgres -d postgres -v migrate_password="'x'" -v runtime_password="'y'" -f src/db/setup/roles.sql
psql -h localhost -U postgres -d postgres -f src/db/setup/local-dev.sql
cp .env.example .env   # set DATABASE_URL_* (incl. TEST and TEST_RUNTIME), INTERNAL_API_SECRET
npm ci && npm run migrate && npm run seed && npm run verify
npm run dev            # then open http://localhost:3000/internal/v1/docs
```

## How to roll back

Nothing is deployed. Reverting the merge commit restores an empty `main` (scaffold only). The
migrations have not run anywhere but local databases; `DROP SCHEMA app CASCADE` resets one.

## Merge confirmation

Builder confirmed on 2026-10-17 ("Merge … continue"). Merged `--no-ff`, tagged `v0.1.0-core`.
