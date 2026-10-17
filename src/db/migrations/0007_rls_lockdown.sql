-- 0007 — row-level security lockdown and privilege sweep
--
-- Threat: on Supabase the auto-generated Data API (PostgREST) serves every table in
-- an exposed schema to anyone holding the public *anon* key. Our tables are in
-- schema `app`, which is NOT exposed, but a future dashboard setting change could
-- expose it. So every table gets RLS enabled and the only policy that exists is
-- for `app_runtime`. The `anon` and `authenticated` roles get no policies and no
-- grants, so even an exposed schema returns nothing. test/db/lockdown.test.ts
-- asserts this for every table; scripts/check-anon-lockdown.mjs probes a real
-- Supabase project over HTTP.
--
-- Note on owners: the table owner (app_migrate) bypasses RLS unless FORCE is set.
-- We FORCE it too, so the migration role is also subject to the policy — it has no
-- business reading customer data, it only runs DDL. The one exception is the
-- migration ledger itself, which app_migrate must write.

-- Reusable for every future migration that adds a table:  SELECT app.lock_down_table('new_table');
CREATE OR REPLACE FUNCTION app.lock_down_table(p_table text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', p_table);
  IF p_table <> 'schema_migrations' THEN
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', p_table);
  END IF;
  EXECUTE format('DROP POLICY IF EXISTS runtime_all ON app.%I', p_table);
  EXECUTE format(
    'CREATE POLICY runtime_all ON app.%I FOR ALL TO app_runtime USING (true) WITH CHECK (true)',
    p_table);
  -- Hard revoke for the Data API roles, if they exist on this server (they do on Supabase).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE ALL ON app.%I FROM anon', p_table);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('REVOKE ALL ON app.%I FROM authenticated', p_table);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    -- The service_role key must never be used by the app either; keep it out.
    EXECUTE format('REVOKE ALL ON app.%I FROM service_role', p_table);
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION app.lock_down_table(text) FROM PUBLIC, app_runtime;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    PERFORM app.lock_down_table(t.tablename);
  END LOOP;
END $$;

-- Sequences in `app`: runtime only.
DO $$
DECLARE
  s record;
BEGIN
  FOR s IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'app' LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE app.%I TO app_runtime', s.sequencename);
  END LOOP;
END $$;

-- The runtime may read (not write) the migration ledger, so /readyz can report
-- the schema version it is running against.
GRANT SELECT ON app.schema_migrations TO app_runtime;
