-- 0005 — tamper-evident, append-only audit log with a SHA-256 hash chain
--
-- How the chain works
--   Each row stores `prev_hash` (the previous row's hash, or 64 zeros for the first)
--   and `hash = sha256(prev_hash || canonical text of this row's content)`. The hash
--   is computed BY THE DATABASE in a BEFORE INSERT trigger, so the application cannot
--   supply a forged one. Rewriting or deleting any historical row changes the hash
--   every later row was computed from, and `app.audit_verify()` reports the first
--   row where the chain breaks.
--
-- Why an advisory lock in the trigger
--   Two inserts in flight at once would both read the same "last hash" and produce
--   a fork. `pg_advisory_xact_lock` serialises inserts for the duration of each
--   transaction. Audit writes are low-volume (one per business action), so this
--   costs nothing noticeable.
--
-- Access
--   app_runtime: INSERT and SELECT only (grant below). On top of that the trigger
--   rejects UPDATE/DELETE for everyone, including the owner role. Changing history
--   requires dropping the trigger as app_migrate — which is itself visible in the
--   Postgres logs and in Supabase's dashboard history.

CREATE TABLE app.audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_type    app.actor_type NOT NULL,
  actor_id      text,
  action        text NOT NULL,                    -- "order.transition", "setting.update", "refund.approve"
  entity_type   text NOT NULL,                    -- "order", "setting", "menu_item"
  entity_id     text,
  before        jsonb,
  after         jsonb,
  request_id    text,                             -- correlates with structured logs
  prev_hash     text NOT NULL,
  hash          text NOT NULL,
  CONSTRAINT hash_is_sha256 CHECK (hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT prev_hash_is_sha256 CHECK (prev_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_log_entity_idx ON app.audit_log (entity_type, entity_id, at DESC);
CREATE INDEX audit_log_actor_idx  ON app.audit_log (actor_type, actor_id, at DESC);
CREATE INDEX audit_log_at_idx     ON app.audit_log (at);

-- Canonical text for hashing. jsonb::text is deterministic for a given jsonb value
-- (keys are stored sorted), and we pin timestamp formatting so the chain can be
-- re-verified byte-for-byte from any client.
CREATE OR REPLACE FUNCTION app.audit_canonical(
  p_at timestamptz, p_actor_type app.actor_type, p_actor_id text, p_action text,
  p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb, p_request_id text
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws(E'\x1f',
    to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_actor_type::text, coalesce(p_actor_id, ''), p_action,
    p_entity_type, coalesce(p_entity_id, ''),
    coalesce(p_before::text, 'null'), coalesce(p_after::text, 'null'),
    coalesce(p_request_id, ''))
$$;

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
  NEW.hash      := encode(digest(
    v_prev || app.audit_canonical(NEW.at, NEW.actor_type, NEW.actor_id, NEW.action,
                                  NEW.entity_type, NEW.entity_id, NEW.before, NEW.after,
                                  NEW.request_id),
    'sha256'), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_chain();

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.forbid_change();

-- Belt and braces: even without the trigger the runtime role lacks the privilege.
REVOKE UPDATE, DELETE, TRUNCATE ON app.audit_log FROM app_runtime;
GRANT SELECT, INSERT ON app.audit_log TO app_runtime;

-- Walks the chain and returns the first broken row (NULL id = chain intact).
-- Run it from the admin bot's "audit check" or the nightly job.
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
    v_expected := encode(digest(
      v_prev || app.audit_canonical(r.at, r.actor_type, r.actor_id, r.action, r.entity_type,
                                    r.entity_id, r.before, r.after, r.request_id), 'sha256'), 'hex');
    IF r.prev_hash <> v_prev OR r.hash <> v_expected THEN
      ok := false; checked := v_count; first_bad_id := r.id;
      RETURN NEXT; RETURN;
    END IF;
    v_prev := r.hash;
  END LOOP;
  ok := true; checked := v_count; first_bad_id := NULL;
  RETURN NEXT;
END $$;
