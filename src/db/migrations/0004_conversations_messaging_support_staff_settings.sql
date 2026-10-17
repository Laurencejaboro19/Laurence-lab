-- 0004 — webhook dedupe, conversation state, message log (with retention),
--        support tickets, staff / roles / sessions / confirmations, settings, FAQ, broadcasts

-- ---------------------------------------------------------------------------
-- Inbound dedupe for EVERY webhook source (telegram update_id, whatsapp message id,
-- paystack event hash, delivery partner event id). Insert-or-ignore happens in the
-- request handler before enqueueing; a 0-row insert means "already seen, return 200".
-- ---------------------------------------------------------------------------
CREATE TABLE app.inbound_events (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL,                     -- 'telegram:customer' | 'telegram:admin' | 'whatsapp' | 'paystack' | 'kwik'
  external_id  text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (source, external_id)
);
CREATE INDEX inbound_events_received_idx ON app.inbound_events (received_at);

-- API idempotency keys. Replaying the same key by the same actor returns the stored
-- response instead of performing the action twice.
CREATE TABLE app.idempotency_keys (
  actor_key     text NOT NULL,                    -- "<client>:<actor id>"
  key           text NOT NULL,
  request_hash  text NOT NULL,                    -- reject same key with a different body
  status_code   integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_key, key)
);
CREATE INDEX idempotency_keys_created_idx ON app.idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- Conversation state: one row per chat identity. `state` is the node in the
-- deterministic flow ("idle", "await_address", "await_phone", …); `context` holds
-- small flow data (current page, pending action id). Locked FOR UPDATE while a
-- user's event is processed so that user's messages are handled in order.
-- ---------------------------------------------------------------------------
CREATE TABLE app.conversations (
  channel_identity_id uuid PRIMARY KEY REFERENCES app.channel_identities(id) ON DELETE CASCADE,
  state        text NOT NULL DEFAULT 'idle',
  context      jsonb NOT NULL DEFAULT '{}',
  last_event_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON app.conversations
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Message log, both directions. `body` is kept for support context and deleted by
-- the retention job after ~90 days (`delete_after`). Category feeds WhatsApp cost
-- estimates. Status tracks WhatsApp receipts and Telegram send failures.
CREATE TABLE app.messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_identity_id  uuid NOT NULL REFERENCES app.channel_identities(id) ON DELETE CASCADE,
  direction            app.message_direction NOT NULL,
  kind                 text NOT NULL,             -- text | buttons | list | location | contact | template | …
  category             app.message_category NOT NULL DEFAULT 'service',
  body                 text,
  payload              jsonb,                     -- structured content (choices, template vars) — no secrets
  external_message_id  text,
  template_name        text,                      -- WhatsApp template used, if any
  status               text NOT NULL DEFAULT 'queued', -- queued | sent | delivered | read | failed
  error_code           text,
  error_detail         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  delete_after         timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);
CREATE INDEX messages_identity_idx ON app.messages (channel_identity_id, created_at DESC);
CREATE INDEX messages_external_idx ON app.messages (external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX messages_delete_after_idx ON app.messages (delete_after);

-- ---------------------------------------------------------------------------
-- Staff. Identity is the Telegram user id (allowlist). Role checks live in the
-- service layer; the admin bot UI only hides buttons as a courtesy.
-- ---------------------------------------------------------------------------
CREATE TABLE app.staff (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id  bigint NOT NULL UNIQUE,
  name              text NOT NULL,
  role              app.staff_role NOT NULL,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES app.staff(id)
);
CREATE TRIGGER staff_updated_at BEFORE UPDATE ON app.staff
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- An "elevated" session is what owner/manager get after passing the second
-- confirmation step; sensitive actions require elevated_until > now().
CREATE TABLE app.staff_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id        uuid NOT NULL REFERENCES app.staff(id) ON DELETE CASCADE,
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  elevated_until  timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX staff_sessions_staff_idx ON app.staff_sessions (staff_id) WHERE revoked_at IS NULL;

-- One-time confirmation codes for sensitive actions. Only the hash is stored.
CREATE TABLE app.staff_confirmations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES app.staff(id) ON DELETE CASCADE,
  action      text NOT NULL,                      -- "refund:<order id>", "price:<item id>", "role:<staff id>"
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_confirmations_open_idx ON app.staff_confirmations (staff_id) WHERE used_at IS NULL;

-- Abuse / fraud strikes against customers (velocity breaches, repeated unpaid orders).
CREATE TABLE app.abuse_strikes (
  id           bigserial PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES app.customers(id) ON DELETE CASCADE,
  kind         text NOT NULL,                     -- order_velocity | failed_payments | unpaid_pending | spam
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX abuse_strikes_customer_idx ON app.abuse_strikes (customer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Support tickets
-- ---------------------------------------------------------------------------
CREATE TABLE app.tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref    text NOT NULL UNIQUE,             -- T-4F2K
  customer_id   uuid NOT NULL REFERENCES app.customers(id),
  order_id      uuid REFERENCES app.orders(id),
  channel       app.channel NOT NULL,
  status        app.ticket_status NOT NULL DEFAULT 'open',
  subject       text,
  assigned_to   uuid REFERENCES app.staff(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz
);
CREATE INDEX tickets_status_idx ON app.tickets (status, created_at);
CREATE INDEX tickets_customer_idx ON app.tickets (customer_id);
CREATE TRIGGER tickets_updated_at BEFORE UPDATE ON app.tickets
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE app.ticket_messages (
  id          bigserial PRIMARY KEY,
  ticket_id   uuid NOT NULL REFERENCES app.tickets(id) ON DELETE CASCADE,
  staff_id    uuid REFERENCES app.staff(id),      -- NULL = customer wrote it
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_messages_ticket_idx ON app.ticket_messages (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- Settings the business changes without a deploy. Values are JSON, validated by
-- a Zod schema per key in the application. Every change also lands in history
-- and the audit log.
-- ---------------------------------------------------------------------------
CREATE TABLE app.settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE app.settings_history (
  id          bigserial PRIMARY KEY,
  key         text NOT NULL,
  old_value   jsonb,
  new_value   jsonb NOT NULL,
  changed_by  text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settings_history_key_idx ON app.settings_history (key, changed_at DESC);
CREATE TRIGGER settings_history_append_only
  BEFORE UPDATE OR DELETE ON app.settings_history
  FOR EACH ROW EXECUTE FUNCTION app.forbid_change();
REVOKE UPDATE, DELETE ON app.settings_history FROM app_runtime;

CREATE TABLE app.faq_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  language    app.language NOT NULL DEFAULT 'en',
  question    text NOT NULL,
  answer      text NOT NULL,
  keywords    text[] NOT NULL DEFAULT '{}',
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER faq_entries_updated_at BEFORE UPDATE ON app.faq_entries
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE app.broadcasts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body           text NOT NULL,
  audience       jsonb NOT NULL DEFAULT '{"channels":["telegram","whatsapp"]}',
  category       app.message_category NOT NULL DEFAULT 'marketing',
  scheduled_at   timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  target_count   integer NOT NULL DEFAULT 0,
  sent_count     integer NOT NULL DEFAULT 0,
  failed_count   integer NOT NULL DEFAULT 0,
  created_by     uuid REFERENCES app.staff(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
