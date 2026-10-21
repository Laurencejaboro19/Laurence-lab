-- 0008 — audit hash chain without pgcrypto
--
-- Why: on Supabase the pgcrypto extension is installed in the `extensions`
-- schema, which is not on the runtime role's search_path, so digest() in the
-- audit trigger raised "function digest(text, unknown) does not exist" on every
-- write (the first live run, 2026-10-21). PostgreSQL has had a core sha256()
-- since version 11; it needs no extension and no search_path. For a UTF-8
-- database sha256(convert_to(x, 'UTF8')) equals digest(x, 'sha256'), so rows
-- hashed before this migration still verify.
--
-- Both functions are replaced in place; the triggers that reference them are
-- unchanged. Migration 0001's CREATE EXTENSION stays (harmless, and local
-- databases already have it).

CREATE OR REPLACE FUNCTION app.audit_log_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev text;
BEGIN
  -- Serialise writers so prev_hash always refers to the true last row.
  PERFORM pg_advisory_xact_lock(hashtext('app.audit_log'));

  SELECT hash INTO v_prev FROM app.audit_log ORDER BY id DESC LIMIT 1;
  IF v_prev IS NULL THEN
    v_prev := repeat('0', 64);
  END IF;

  NEW.at        := coalesce(NEW.at, now());
  NEW.prev_hash := v_prev;
  NEW.hash      := encode(sha256(convert_to(
    v_prev || app.audit_canonical(NEW.at, NEW.actor_type, NEW.actor_id, NEW.action,
                                  NEW.entity_type, NEW.entity_id, NEW.before, NEW.after,
                                  NEW.request_id),
    'UTF8')), 'hex');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.audit_verify()
RETURNS TABLE (ok boolean, checked bigint, first_bad_id bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r app.audit_log%ROWTYPE;
  v_prev text := repeat('0', 64);
  v_expected text;
  v_count bigint := 0;
BEGIN
  FOR r IN SELECT * FROM app.audit_log ORDER BY id LOOP
    v_count := v_count + 1;
    v_expected := encode(sha256(convert_to(
      v_prev || app.audit_canonical(r.at, r.actor_type, r.actor_id, r.action, r.entity_type,
                                    r.entity_id, r.before, r.after, r.request_id), 'UTF8')), 'hex');
    IF r.prev_hash <> v_prev OR r.hash <> v_expected THEN
      ok := false; checked := v_count; first_bad_id := r.id;
      RETURN NEXT; RETURN;
    END IF;
    v_prev := r.hash;
  END LOOP;
  ok := true; checked := v_count; first_bad_id := NULL;
  RETURN NEXT;
END $$;
