-- Local development databases. Run as postgres, once:
--   psql -h localhost -U postgres -d postgres -f src/db/setup/local-dev.sql
-- (Termux: pg_ctl -D $PREFIX/var/lib/postgresql start, then the same command.)
SELECT 'CREATE DATABASE laurence_lab OWNER app_migrate'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'laurence_lab') \gexec
SELECT 'CREATE DATABASE laurence_lab_test OWNER app_migrate'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'laurence_lab_test') \gexec

-- Supabase ships these roles; create them locally (NOLOGIN, no privileges) so the
-- lockdown test proves the Data API roles cannot reach business tables here too.
SELECT 'CREATE ROLE anon NOLOGIN NOINHERIT'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') \gexec
SELECT 'CREATE ROLE authenticated NOLOGIN NOINHERIT'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') \gexec
SELECT 'CREATE ROLE service_role NOLOGIN NOINHERIT'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') \gexec
