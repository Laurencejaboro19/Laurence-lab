# feat/telegram-customer → main (phase 4) — tag `v0.2.0-telegram-customer`

## What changed and why

The first customer-facing channel and real payments in test mode:

1. **Paystack** (`src/providers/payments/paystack.ts`, `mock-server.ts`,
   `src/http/routes/webhooks/paystack.ts`): production client against the documented API, a local
   mock that the same client talks to, and the webhook route (verify → dedupe → 200 → background
   → replay sweep). `PaymentService` split into `ingestProviderEvent` + `processRecordedEvent`.
2. **Conversation engine** (`src/core/conversation/`): channel-neutral flow + bilingual copy.
3. **Telegram** (`src/channels/telegram/`): client, adapter, poller, webhook route;
   `src/channels/dispatcher.ts` and `notifications.ts` glue adapters, engine and events.
4. `main.ts` wires polling (local) or webhook (production) and the payment-event replay on boot.

## Files that touch core logic

- `src/core/conversation/engine.ts` — new; calls existing services, no new money rules.
- `src/core/services/payments.ts` — ingest/process split (behaviour unchanged, tested).
- `src/core/services/customers.ts` — `addAddress` accepts a chosen `zoneId` for typed addresses.
- `src/core/channel/types.ts` — `InboundButton.ackToken`.
- New repository `src/db/repositories/conversations.ts` (conversation state, message log, FAQ).

No migrations in this branch.

## Risks

- First live contact with the Telegram and Paystack APIs happens on the owner's machine; the build
  environment could not reach them. Mitigated by faithful fakes and the documented smoke run.
- Background processing is in-process until pg-boss (phase 7); a crash between the 200 and the
  verify is healed by the replay sweep on the next boot.
- The in-memory per-chat ordering is per process; the database row lock is the real guarantee.

## Tests added

`test/core/conversation.test.ts`, `test/telegram/adapter.test.ts`, `test/telegram/journey.test.ts`,
`test/http/paystack-webhook.test.ts` (32 tests). Total suite: 790.

## How to verify

Follow README → "Run the Telegram customer bot locally", then `npm run verify`.

## How to roll back

Revert the merge commit. No schema changes; the previous release keeps working.

## Notes

- One commit (`docs: record merge confirmation`) landed directly on `main` after the previous merge
  to record the builder's confirmation; future confirmations are recorded inside the merge commit
  of the next branch instead.

## Merge confirmation

Builder confirmed on 2026-10-18 ("1 merge and continue"). Merged `--no-ff`, tagged `v0.2.0-telegram-customer`.
