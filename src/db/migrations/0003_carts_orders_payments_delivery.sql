-- 0003 — carts, promos, orders (with snapshots and status history), payments,
--        refunds, payment flags, delivery tasks and events

-- ---------------------------------------------------------------------------
-- Promotions
-- ---------------------------------------------------------------------------
CREATE TABLE app.promos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,         -- stored upper-case
  kind              text NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value             integer NOT NULL CHECK (value > 0),  -- percent (1..100) or kobo
  first_order_only  boolean NOT NULL DEFAULT false,
  max_uses          integer CHECK (max_uses IS NULL OR max_uses > 0),
  uses              integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  max_uses_per_customer integer NOT NULL DEFAULT 1,
  min_order_kobo    bigint NOT NULL DEFAULT 0,
  max_discount_kobo bigint,                       -- cap for percent promos
  starts_at         timestamptz,
  ends_at           timestamptz,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT percent_in_range CHECK (kind <> 'percent' OR value <= 100),
  CONSTRAINT code_upper CHECK (code = upper(code))
);
CREATE TRIGGER promos_updated_at BEFORE UPDATE ON app.promos
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Carts. One active cart per customer. Converted to an order at checkout.
-- ---------------------------------------------------------------------------
CREATE TABLE app.carts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES app.customers(id),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'abandoned')),
  fulfilment   app.fulfilment,
  address_id   uuid REFERENCES app.addresses(id),
  promo_code   text,
  note         text,
  reminder_sent_at timestamptz,                   -- abandoned-cart reminder dedupe
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX carts_one_active_per_customer ON app.carts (customer_id) WHERE status = 'active';
CREATE TRIGGER carts_updated_at BEFORE UPDATE ON app.carts
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE app.cart_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id     uuid NOT NULL REFERENCES app.carts(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL REFERENCES app.menu_items(id),
  variant_id  uuid REFERENCES app.menu_variants(id),
  addon_ids   uuid[] NOT NULL DEFAULT '{}',
  quantity    integer NOT NULL CHECK (quantity > 0 AND quantity <= 50),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cart_items_cart_idx ON app.cart_items (cart_id);

-- ---------------------------------------------------------------------------
-- Orders. Prices are SNAPSHOTS: changing the menu later never changes an old order.
-- `version` supports optimistic locking from the admin bot (two staff tapping Accept).
-- ---------------------------------------------------------------------------
CREATE TABLE app.orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref          text NOT NULL UNIQUE,       -- LL-7K3M9 — what humans say on the phone
  customer_id         uuid NOT NULL REFERENCES app.customers(id),
  channel             app.channel NOT NULL,
  status              app.order_status NOT NULL DEFAULT 'PLACED',
  fulfilment          app.fulfilment NOT NULL,
  address_id          uuid REFERENCES app.addresses(id),
  address_snapshot    jsonb,                      -- {text, latitude, longitude, zone_name}
  zone_id             uuid REFERENCES app.delivery_zones(id),
  subtotal_kobo       bigint NOT NULL CHECK (subtotal_kobo >= 0),
  delivery_fee_kobo   bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_kobo >= 0),
  discount_kobo       bigint NOT NULL DEFAULT 0 CHECK (discount_kobo >= 0),
  total_kobo          bigint NOT NULL CHECK (total_kobo >= 0),
  promo_id            uuid REFERENCES app.promos(id),
  customer_note       text,
  eta_minutes         integer,
  payment_expires_at  timestamptz,
  placed_at           timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  accepted_at         timestamptz,
  ready_at            timestamptz,
  dispatched_at       timestamptz,
  delivered_at        timestamptz,
  closed_at           timestamptz,                -- any terminal status
  cancel_reason       text,
  reject_reason       text,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT total_matches_parts CHECK (total_kobo = subtotal_kobo + delivery_fee_kobo - discount_kobo),
  CONSTRAINT delivery_needs_address CHECK (fulfilment = 'pickup' OR address_snapshot IS NOT NULL)
);
CREATE INDEX orders_customer_idx ON app.orders (customer_id, created_at DESC);
CREATE INDEX orders_status_idx ON app.orders (status, created_at);
CREATE INDEX orders_awaiting_payment_idx ON app.orders (payment_expires_at) WHERE status = 'AWAITING_PAYMENT';
CREATE INDEX orders_created_day_idx ON app.orders (created_at);
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON app.orders
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE app.order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES app.orders(id) ON DELETE CASCADE,
  item_id           uuid REFERENCES app.menu_items(id),  -- may be NULL if the item is later purged
  name_snapshot     text NOT NULL,
  variant_snapshot  text,
  addons_snapshot   jsonb NOT NULL DEFAULT '[]',  -- [{name, price_kobo}]
  unit_price_kobo   bigint NOT NULL CHECK (unit_price_kobo >= 0),
  quantity          integer NOT NULL CHECK (quantity > 0),
  line_total_kobo   bigint NOT NULL CHECK (line_total_kobo >= 0)
);
CREATE INDEX order_items_order_idx ON app.order_items (order_id);

-- Every transition, with who and why. Also append-only.
CREATE TABLE app.order_status_history (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES app.orders(id) ON DELETE CASCADE,
  from_status app.order_status,
  to_status   app.order_status NOT NULL,
  actor_type  app.actor_type NOT NULL,
  actor_id    text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_idx ON app.order_status_history (order_id, created_at);
CREATE TRIGGER order_status_history_append_only
  BEFORE UPDATE OR DELETE ON app.order_status_history
  FOR EACH ROW EXECUTE FUNCTION app.forbid_change();
REVOKE UPDATE, DELETE ON app.order_status_history FROM app_runtime;

-- Now that orders exists, tie the inventory ledger to it.
ALTER TABLE app.inventory_movements
  ADD CONSTRAINT inventory_movements_order_fk FOREIGN KEY (order_id) REFERENCES app.orders(id);
CREATE INDEX inventory_movements_order_idx ON app.inventory_movements (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE app.promo_redemptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id      uuid NOT NULL REFERENCES app.promos(id),
  order_id      uuid NOT NULL REFERENCES app.orders(id),
  customer_id   uuid NOT NULL REFERENCES app.customers(id),
  discount_kobo bigint NOT NULL CHECK (discount_kobo >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promo_id, order_id)
);
CREATE INDEX promo_redemptions_customer_idx ON app.promo_redemptions (promo_id, customer_id);

-- ---------------------------------------------------------------------------
-- Payments. One row per Paystack transaction attempt. `reference` is OUR unique
-- reference sent to Paystack; it is how a webhook or verify response is matched.
-- ---------------------------------------------------------------------------
CREATE TABLE app.payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES app.orders(id),
  provider           text NOT NULL DEFAULT 'paystack',
  reference          text NOT NULL UNIQUE,
  amount_kobo        bigint NOT NULL CHECK (amount_kobo > 0),  -- what we asked for
  currency           text NOT NULL DEFAULT 'NGN',
  status             app.payment_status NOT NULL DEFAULT 'initialised',
  paid_amount_kobo   bigint,                      -- what Paystack says was paid (verify)
  paid_currency      text,
  provider_status    text,                        -- raw status string from verify
  provider_channel   text,                        -- card / bank_transfer / ussd …
  provider_tx_id     text,                        -- Paystack transaction id (for refunds)
  authorization_url  text,
  access_code        text,
  mode               text NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
  verified_at        timestamptz,
  expires_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON app.payments (order_id);
CREATE INDEX payments_pending_idx ON app.payments (created_at) WHERE status = 'initialised';
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON app.payments
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Webhook dedupe and audit for provider events. The payload is stored REDACTED
-- (the service strips authorization/card objects before insert) and only for 90 days.
CREATE TABLE app.payment_events (
  id                 bigserial PRIMARY KEY,
  provider           text NOT NULL,
  external_event_id  text NOT NULL,              -- Paystack has no event id; we hash event+reference+status
  event_type         text NOT NULL,
  reference          text,
  payment_id         uuid REFERENCES app.payments(id),
  payload_redacted   jsonb,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  outcome            text,
  UNIQUE (provider, external_event_id)
);

-- Anything that needs a human: underpaid, overpaid, duplicate success, late payment.
CREATE TABLE app.payment_flags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid REFERENCES app.orders(id),
  payment_id   uuid REFERENCES app.payments(id),
  kind         app.payment_flag_kind NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  text,
  resolution   text
);
CREATE INDEX payment_flags_open_idx ON app.payment_flags (created_at) WHERE resolved_at IS NULL;

CREATE TABLE app.refunds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES app.orders(id),
  payment_id      uuid NOT NULL REFERENCES app.payments(id),
  amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
  reason          text NOT NULL,
  status          app.refund_status NOT NULL DEFAULT 'pending',
  provider_ref    text,                           -- Paystack refund id
  requested_by    text NOT NULL,                  -- staff id or 'system'
  approved_by     text,                           -- second confirmation for owner/manager
  idempotency_key text NOT NULL UNIQUE,           -- never refund twice for the same request
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX refunds_order_idx ON app.refunds (order_id);
CREATE TRIGGER refunds_updated_at BEFORE UPDATE ON app.refunds
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Delivery
-- ---------------------------------------------------------------------------
CREATE TABLE app.delivery_tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES app.orders(id),
  provider       app.delivery_provider NOT NULL,
  external_id    text,                            -- partner task id
  status         app.delivery_status NOT NULL DEFAULT 'requested',
  quote_kobo     bigint,
  charged_kobo   bigint,                          -- mismatch with quote → flag
  rider_name     text,
  rider_phone    text,
  tracking_url   text,
  failure_reason text,
  attempt        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
CREATE INDEX delivery_tasks_order_idx ON app.delivery_tasks (order_id);
CREATE INDEX delivery_tasks_open_idx ON app.delivery_tasks (updated_at)
  WHERE status IN ('requested', 'assigned', 'picked_up', 'in_transit');
CREATE TRIGGER delivery_tasks_updated_at BEFORE UPDATE ON app.delivery_tasks
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE app.delivery_events (
  id           bigserial PRIMARY KEY,
  task_id      uuid NOT NULL REFERENCES app.delivery_tasks(id) ON DELETE CASCADE,
  external_event_id text,                         -- dedupe partner webhooks
  status       app.delivery_status NOT NULL,
  payload      jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, external_event_id)
);
