-- One-time role setup. Run ONCE per environment with a privileged role
-- (locally: postgres; on Supabase: the postgres role from the dashboard SQL editor),
-- BEFORE the first `npm run migrate`. Migrations never create roles because role
-- creation is cluster-wide and not safely repeatable.
--
-- Local (psql variables supply the passwords; never put them in this file):
--   psql -h localhost -U postgres -d postgres \
--     -v migrate_password="'…'" -v runtime_password="'…'" -f src/db/setup/roles.sql
--
-- Supabase SQL editor: replace the :'…' variables by hand, run, then delete the
-- passwords from the editor history. Store them only in the host's secret store.
--
-- Why two roles:
--   app_migrate  owns the schema and all objects; runs `npm run migrate` only.
--   app_runtime  is what the server connects as. It can read/write business tables
--                but cannot DROP/ALTER anything, and on the audit log it has INSERT
--                and SELECT only. A compromised runtime cannot rewrite history.

-- psql variables are not expanded inside DO blocks, so each statement is built
-- with format() and executed through \gexec. Safe to re-run: existing roles are kept.
SELECT format('CREATE ROLE app_migrate LOGIN PASSWORD %L NOINHERIT', :'migrate_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrate') \gexec
SELECT format('CREATE ROLE app_runtime LOGIN PASSWORD %L NOINHERIT', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') \gexec

-- The migration role must be able to grant on objects it owns to app_runtime,
-- which requires membership for ALTER DEFAULT PRIVILEGES ... FOR ROLE to work.
GRANT app_runtime TO app_migrate;

-- Connection limits are belt-and-braces against a runaway pool: Supabase Micro
-- allows ~60 direct connections. Raise with the compute size.
ALTER ROLE app_runtime CONNECTION LIMIT 40;
ALTER ROLE app_migrate CONNECTION LIMIT 5;
