# Changelog

All notable changes to this project are recorded here. Each tagged release corresponds to a merged
branch in the branch plan (see README). Format follows Keep a Changelog; dates are UTC.

## [Unreleased]

### Added
- Vercel serverless entry (webhook mode, inline background work, request-driven maintenance,
  `/setup/*` bootstrap routes, daily cron), `vercel.json`, `docs/DEPLOY_VERCEL.md`, DR-012.

## [0.2.0-telegram-customer] — 2026-10-18

### Added
- Phase 4: Telegram customer bot (client with rate limiting, adapter, polling + webhook modes),
  channel-neutral conversation engine in English and Pidgin (onboarding, menu, text ordering, cart,
  checkout with pins/typed addresses, Paystack button, tracking, reorder, privacy commands), customer
  notifications on status changes, real Paystack gateway + local mock server + signed webhook route
  with background processing and replay sweep. `npm run mock:paystack`.

## [0.1.0-core] — 2026-10-17

### Added
- Phase 3: pure domain (kobo money, order state machine as data, pricing, zones, text order parser),
  ports and pg repositories, services (settings, customers, catalog, cart, orders, payments),
  transactional in-process event bus, mock Paystack gateway, Fastify internal API v1 with signed
  tokens, idempotency keys, rate limits, uniform errors and generated OpenAPI; `scripts/mint-token.mjs`;
  `docs/REVIEW_GUIDE.md`, `docs/HANDOVER.md`, `docs/OWNER_REPORT.md`, `docs/changes/feat-core-platform.md`.
- Phase 1: `docs/ARCHITECTURE.md`, `docs/DECISION_RECORD.md`, `docs/ASSUMPTIONS.md`; channel adapter
  contract (`src/core/channel`) with limit checks and a paginator.
- Phase 2: seven SQL migrations (schema `app`, menu/inventory, orders/payments/delivery,
  conversations/staff/settings, hash-chained audit log, WhatsApp tables, RLS lockdown), a checksummed
  migration runner, role setup scripts, Nigerian menu seed, anon-key probe script, and database
  integration tests (lockdown, audit chain + tamper detection, overselling under concurrency,
  migration immutability). `docs/DATA_MODEL.md`.
- Repository scaffold: strict TypeScript, ESLint (type-aware), Prettier, Vitest, secretlint
  pre-commit hook, CI workflow (verify + npm audit + gitleaks), `.env.example`, README, `docs/`.
