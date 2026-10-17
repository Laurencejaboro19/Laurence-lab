# Changelog

All notable changes to this project are recorded here. Each tagged release corresponds to a merged
branch in the branch plan (see README). Format follows Keep a Changelog; dates are UTC.

## [Unreleased]

### Added
- Phase 1: `docs/ARCHITECTURE.md`, `docs/DECISION_RECORD.md`, `docs/ASSUMPTIONS.md`; channel adapter
  contract (`src/core/channel`) with limit checks and a paginator.
- Phase 2: seven SQL migrations (schema `app`, menu/inventory, orders/payments/delivery,
  conversations/staff/settings, hash-chained audit log, WhatsApp tables, RLS lockdown), a checksummed
  migration runner, role setup scripts, Nigerian menu seed, anon-key probe script, and database
  integration tests (lockdown, audit chain + tamper detection, overselling under concurrency,
  migration immutability). `docs/DATA_MODEL.md`.
- Repository scaffold: strict TypeScript, ESLint (type-aware), Prettier, Vitest, secretlint
  pre-commit hook, CI workflow (verify + npm audit + gitleaks), `.env.example`, README, `docs/`.
