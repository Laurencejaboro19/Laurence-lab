-- 0001 — schema, extensions, shared helpers, default privileges
--
-- Everything the application owns lives in schema `app`. On Supabase only `public`
-- (and `graphql_public`) are exposed through the auto-generated Data API, so keeping
-- business tables out of `public` is the first line of defence; RLS in 0007 is the second.
-- `pgboss` (the job queue) creates its own schema when it starts.

CREATE SCHEMA IF NOT EXISTS app;

-- pgcrypto gives us digest() for the audit hash chain. gen_random_uuid() is built in
-- since PG13 but pgcrypto is harmless to enable and present on Supabase and Termux.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Nothing in `app` is reachable by the Data API roles, even if the schema is ever exposed.
REVOKE ALL ON SCHEMA app FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA app FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA app FROM authenticated;
  END IF;
END $$;

GRANT USAGE ON SCHEMA app TO app_runtime;

-- Default privileges for objects app_migrate creates from now on: the runtime role
-- gets DML on tables and USAGE on sequences, never DDL. Individual migrations tighten
-- this further where needed (the audit log revokes UPDATE/DELETE).
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO app_runtime;

-- updated_at maintenance, used by most mutable tables.
CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Enumerations. Postgres enums are cheap to read and impossible to misspell in SQL.
-- Adding a value later is `ALTER TYPE … ADD VALUE` (additive, backward compatible).
CREATE TYPE app.channel AS ENUM ('telegram', 'whatsapp');
CREATE TYPE app.language AS ENUM ('en', 'pcm');            -- English, Nigerian Pidgin

CREATE TYPE app.order_status AS ENUM (
  'PLACED', 'AWAITING_PAYMENT', 'PAID', 'ACCEPTED', 'PREPARING', 'READY',
  'DISPATCHED', 'DELIVERED', 'CANCELLED', 'REJECTED', 'EXPIRED',
  'REFUNDED', 'PARTIALLY_REFUNDED'
);
CREATE TYPE app.fulfilment AS ENUM ('delivery', 'pickup');
CREATE TYPE app.actor_type AS ENUM ('customer', 'staff', 'system', 'provider');

CREATE TYPE app.payment_status AS ENUM (
  'initialised', 'success', 'failed', 'abandoned', 'late', 'mismatch'
);
CREATE TYPE app.refund_status AS ENUM ('pending', 'approved', 'processing', 'success', 'failed');
CREATE TYPE app.payment_flag_kind AS ENUM (
  'underpaid', 'overpaid', 'duplicate', 'late', 'currency', 'reference_unknown'
);

CREATE TYPE app.delivery_status AS ENUM (
  'quoted', 'requested', 'no_rider', 'assigned', 'picked_up', 'in_transit',
  'delivered', 'failed', 'cancelled'
);
CREATE TYPE app.delivery_provider AS ENUM ('manual', 'kwik', 'mock');

CREATE TYPE app.inventory_movement_kind AS ENUM (
  'receive', 'adjust', 'waste', 'reserve', 'release', 'commit', 'import'
);

CREATE TYPE app.staff_role AS ENUM ('owner', 'manager', 'kitchen', 'dispatch', 'support');
CREATE TYPE app.ticket_status AS ENUM ('open', 'pending_customer', 'pending_staff', 'closed');
CREATE TYPE app.message_direction AS ENUM ('in', 'out');
CREATE TYPE app.message_category AS ENUM ('service', 'utility', 'marketing', 'authentication');
CREATE TYPE app.consent_kind AS ENUM ('service', 'marketing');
