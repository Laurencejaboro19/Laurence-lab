-- 0006 — WhatsApp-specific tables, created now so phase 9 never needs a redesign.
--
-- All of these are keyed by channel_identity (channel = 'whatsapp') and are
-- harmless while WhatsApp is not enabled.

-- 24-hour customer-service window. `window_expires_at = last_inbound_at + 24h`.
-- Free-form sends are allowed only while now() < window_expires_at; otherwise the
-- outbound queue must pick an approved template.
CREATE TABLE app.wa_windows (
  channel_identity_id uuid PRIMARY KEY REFERENCES app.channel_identities(id) ON DELETE CASCADE,
  last_inbound_at     timestamptz NOT NULL,
  window_expires_at   timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER wa_windows_updated_at BEFORE UPDATE ON app.wa_windows
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Delivery receipts from Meta (sent/delivered/read/failed), kept separately from
-- messages.status because they arrive out of order and we want the raw sequence.
CREATE TABLE app.wa_delivery_receipts (
  id                 bigserial PRIMARY KEY,
  message_id         uuid REFERENCES app.messages(id) ON DELETE CASCADE,
  external_message_id text NOT NULL,
  status             text NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  error_code         text,
  error_title        text,
  occurred_at        timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wa_delivery_receipts_msg_idx ON app.wa_delivery_receipts (external_message_id, occurred_at);

-- Template registry: our copy of what was submitted to Meta and its approval state.
-- The outbound renderer refuses to send a template that is not 'approved'.
CREATE TABLE app.wa_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,                 -- order_confirmed_v1
  language         text NOT NULL DEFAULT 'en',
  category         app.message_category NOT NULL,
  body             text NOT NULL,                 -- with {{1}}, {{2}} placeholders
  variables        jsonb NOT NULL DEFAULT '[]',   -- [{"index":1,"name":"order_ref","sample":"LL-7K3M9"}]
  buttons          jsonb,                         -- optional URL/quick-reply buttons as submitted
  meta_template_id text,
  meta_status      text NOT NULL DEFAULT 'draft'  -- draft | pending | approved | rejected | paused | disabled
                   CHECK (meta_status IN ('draft','pending','approved','rejected','paused','disabled')),
  rejection_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, language)
);
CREATE TRIGGER wa_templates_updated_at BEFORE UPDATE ON app.wa_templates
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Consent records (opt-in / opt-out) with source and time. Marketing goes only to
-- customers whose latest 'marketing' row has granted = true. Used by both channels.
CREATE TABLE app.consents (
  id           bigserial PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES app.customers(id) ON DELETE CASCADE,
  channel      app.channel NOT NULL,
  kind         app.consent_kind NOT NULL,
  granted      boolean NOT NULL,
  source       text NOT NULL,                     -- 'onboarding' | 'keyword:STOP' | 'admin' | 'checkout'
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_lookup_idx ON app.consents (customer_id, channel, kind, created_at DESC);

-- Monthly counts per channel and category, maintained by the outbound sender, so
-- the admin bot can estimate the WhatsApp bill without scanning the message log.
CREATE TABLE app.channel_cost_counts (
  channel    app.channel NOT NULL,
  category   app.message_category NOT NULL,
  month      date NOT NULL,                       -- first day of month, UTC
  count      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, category, month)
);

-- Account-level health snapshots (quality rating, tier, token validity), polled by a job.
CREATE TABLE app.wa_health_snapshots (
  id              bigserial PRIMARY KEY,
  quality_rating  text,
  messaging_tier  text,
  token_valid     boolean,
  token_expires_at timestamptz,
  failed_send_rate_24h numeric(5,4),
  raw             jsonb,
  captured_at     timestamptz NOT NULL DEFAULT now()
);
