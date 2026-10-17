# Review guide — where a bug costs money or leaks data

Read these in order. Each entry says why it matters and which test proves it. Every location is also
marked in the source with a `REVIEW:` comment.

| #   | Where                                                                       | Why it matters                                                                                                                       | Covered by                                                                 |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | `src/core/services/payments.ts` → `settle()`                                | The only path to `PAID`. Must verify status, amount (kobo), currency and reference against the provider; mismatches flag, never pay. | `test/core/payments.test.ts` (under/over/currency/late/duplicate/unknown)  |
| 2   | `src/db/repositories/inventory.ts` → `reserve()`                            | Overselling guard: one conditional `UPDATE`; commit/release are ledger-aware so retries cannot touch other orders' stock.            | `test/db/inventory.test.ts` (40 buyers, 7 portions), `checkout.test.ts`    |
| 3   | `src/core/services/orders.ts` → `checkout()`                                | Two-phase checkout around the gateway call; failure path must cancel and release. Caps and velocity limits live here.                | `test/core/checkout.test.ts`                                               |
| 4   | `src/core/domain/order-status.ts`                                           | The transition table. A wrong entry lets a refund happen twice or a kitchen accept an unpaid order.                                  | `src/core/domain/order-status.test.ts` (full 13×13×4 matrix)               |
| 5   | `src/db/repositories/orders.ts` → `setStatus()`                             | `WHERE … AND status = $from` after `FOR UPDATE`: two staff tapping Accept at once cannot both succeed.                               | `checkout.test.ts` (no-op second DISPATCHED)                               |
| 6   | `src/core/services/orders.ts` → `queueRefund()`                             | Refund amount is bounded by paid − already refunded; idempotency key stops a double refund.                                          | `payments.test.ts` (partial bounds, execute twice → one gateway call)      |
| 7   | `src/core/services/customers.ts` → `assertCanAccess`; `orders.ts` → `get()` | IDOR guard: customers only reach their own rows. Enforced in services so every client inherits it.                                   | `test/core/idor.test.ts`, `test/http/api.test.ts` (404 for other customer) |
| 8   | `src/http/auth.ts`                                                          | Token signing/verification; constant-time compare; expiry; adapter tokens need `X-Customer-Id`.                                      | `api.test.ts` (forged, expired, wrong secret, missing header)              |
| 9   | `src/http/plugins.ts` → idempotency                                         | Replays must return the stored response, not re-run the action; mismatched bodies must be refused.                                   | `api.test.ts`                                                              |
| 10  | `src/db/migrations/0005_audit_log.sql`                                      | Hash chain computed by trigger; append-only for everyone. If this is wrong, history can be rewritten silently.                       | `test/db/audit-log.test.ts` (tamper detection)                             |
| 11  | `src/db/migrations/0007_rls_lockdown.sql`                                   | Supabase anon/authenticated/service_role must have no path to business data.                                                         | `test/db/lockdown.test.ts`, `scripts/check-anon-lockdown.mjs`              |
| 12  | `src/providers/payments/mock-gateway.ts` → `verifyWebhookSignature`         | The real Paystack client (phase 4) must keep the same constant-time HMAC-SHA512 scheme.                                              | phase 4 tests                                                              |

## Things that are deliberately NOT trusted

- A webhook body. It is a hint to call `verify`.
- A redirect/callback URL hit. Same.
- The amount in our own `payments` row alone — we compare it with what the provider says was paid.
- Any `hash`/`prev_hash` supplied by the application to the audit log (the trigger overwrites it).
- Role claims from the admin bot UI — the service layer re-checks `actor.role`.
