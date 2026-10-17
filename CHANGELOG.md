# Changelog

All notable changes to this project are recorded here. Each tagged release corresponds to a merged
branch in the branch plan (see README). Format follows Keep a Changelog; dates are UTC.

## [Unreleased]

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
