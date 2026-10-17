-- 0002 — customers and identities, addresses, zones, menu, inventory
--
-- Money is ALWAYS integer kobo in a bigint column named *_kobo. ₦1 = 100 kobo.
-- Timestamps are timestamptz (UTC on the wire); Africa/Lagos is applied only when rendering.

-- ---------------------------------------------------------------------------
-- Customers: one row per person, however many chat identities they have.
-- PII lives here (phone, name) so a deletion request can anonymise one row and
-- leave orders/payments intact for the 7-year financial retention requirement.
-- ---------------------------------------------------------------------------
CREATE TABLE app.customers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       text,
  phone_e164         text UNIQUE,                 -- digits only, e.g. 2348012345678
  phone_verified_at  timestamptz,                 -- set when the contact button was used
  language           app.language NOT NULL DEFAULT 'en',
  first_order_at     timestamptz,
  order_count        integer NOT NULL DEFAULT 0 CHECK (order_count >= 0),
  blocked_until      timestamptz,                 -- fraud/abuse strikes park a customer here
  anonymised_at      timestamptz,                 -- NDPA deletion request fulfilled
  unreachable_at     timestamptz,                 -- all identities blocked us
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phone_e164_digits CHECK (phone_e164 IS NULL OR phone_e164 ~ '^[1-9][0-9]{7,14}$')
);
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON app.customers
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- A Telegram user id or a WhatsApp number that maps to a customer. Linking a second
-- identity to an existing customer is an explicit, confirmed step (never silent) —
-- see docs/ARCHITECTURE.md and the WhatsApp identity rules.
CREATE TABLE app.channel_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES app.customers(id),
  channel           app.channel NOT NULL,
  external_user_id  text NOT NULL,
  external_chat_id  text NOT NULL,
  handle            text,
  last_inbound_at   timestamptz,                  -- drives the WhatsApp 24-hour window
  last_outbound_at  timestamptz,
  unreachable_at    timestamptz,                  -- platform said "blocked"; stop retrying
  reverify_after    timestamptz,                  -- recycled-number guard for WhatsApp
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_user_id)
);
CREATE INDEX channel_identities_customer_idx ON app.channel_identities (customer_id);
CREATE TRIGGER channel_identities_updated_at BEFORE UPDATE ON app.channel_identities
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Delivery zones: our own data. Polygon is GeoJSON (lon/lat pairs) checked in
-- application code with a point-in-polygon test, so no PostGIS dependency.
-- ---------------------------------------------------------------------------
CREATE TABLE app.delivery_zones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  fee_kobo        bigint NOT NULL CHECK (fee_kobo >= 0),
  min_order_kobo  bigint NOT NULL DEFAULT 0 CHECK (min_order_kobo >= 0),
  eta_minutes     integer NOT NULL DEFAULT 30 CHECK (eta_minutes > 0),
  polygon         jsonb NOT NULL,                -- GeoJSON Polygon geometry
  active          boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER delivery_zones_updated_at BEFORE UPDATE ON app.delivery_zones
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE app.addresses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES app.customers(id),
  label         text NOT NULL DEFAULT 'Home',
  text_address  text,                             -- "Block 4, Ekosodin, opposite blue gate"
  latitude      double precision,
  longitude     double precision,
  zone_id       uuid REFERENCES app.delivery_zones(id),
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT address_has_pin_or_text CHECK (text_address IS NOT NULL OR (latitude IS NOT NULL AND longitude IS NOT NULL)),
  CONSTRAINT latitude_range  CHECK (latitude  IS NULL OR latitude  BETWEEN -90 AND 90),
  CONSTRAINT longitude_range CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);
CREATE INDEX addresses_customer_idx ON app.addresses (customer_id) WHERE deleted_at IS NULL;
-- At most one default address per customer.
CREATE UNIQUE INDEX addresses_one_default_idx ON app.addresses (customer_id)
  WHERE is_default AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------------
CREATE TABLE app.menu_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER menu_categories_updated_at BEFORE UPDATE ON app.menu_categories
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE app.menu_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id    uuid NOT NULL REFERENCES app.menu_categories(id),
  slug           text NOT NULL UNIQUE,            -- stable key for seeds, imports and the text parser
  name           text NOT NULL,
  description    text,
  price_kobo     bigint NOT NULL CHECK (price_kobo >= 0),
  photo_ref      text,                            -- Telegram file_id / WhatsApp media id / https URL
  prep_minutes   integer NOT NULL DEFAULT 25 CHECK (prep_minutes >= 0),
  -- Aliases the plain-text order parser recognises: {"jollof","jollof rice"}
  aliases        text[] NOT NULL DEFAULT '{}',
  -- Optional availability windows: [{"days":[1,2,3,4,5],"from":"09:00","to":"15:00"}] in Africa/Lagos
  availability   jsonb,
  active         boolean NOT NULL DEFAULT true,   -- staff "sold out" toggle flips this quickly
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX menu_items_category_idx ON app.menu_items (category_id) WHERE deleted_at IS NULL;
CREATE TRIGGER menu_items_updated_at BEFORE UPDATE ON app.menu_items
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE app.menu_variants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id          uuid NOT NULL REFERENCES app.menu_items(id),
  name             text NOT NULL,                 -- "Regular", "Large"
  price_delta_kobo bigint NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  UNIQUE (item_id, name)
);

CREATE TABLE app.menu_addons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES app.menu_items(id),
  name        text NOT NULL,                      -- "Extra chicken"
  price_kobo  bigint NOT NULL CHECK (price_kobo >= 0),
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  UNIQUE (item_id, name)
);

-- ---------------------------------------------------------------------------
-- Inventory. `on_hand` is physical stock; `reserved` is held by orders awaiting
-- payment. Available = on_hand - reserved. The CHECK constraints make it impossible
-- for a bug to drive either negative — the database refuses, the transaction rolls
-- back, and the customer sees "sold out" instead of the kitchen seeing an order it
-- cannot cook. `track=false` means unlimited (drinks bought ad hoc, for example).
-- ---------------------------------------------------------------------------
CREATE TABLE app.inventory (
  item_id              uuid PRIMARY KEY REFERENCES app.menu_items(id),
  track                boolean NOT NULL DEFAULT true,
  on_hand              integer NOT NULL DEFAULT 0,
  reserved             integer NOT NULL DEFAULT 0,
  low_stock_threshold  integer NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  low_stock_alerted_at timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT on_hand_non_negative  CHECK (on_hand >= 0),
  CONSTRAINT reserved_non_negative CHECK (reserved >= 0),
  CONSTRAINT reserved_within_stock CHECK (reserved <= on_hand)
);
CREATE TRIGGER inventory_updated_at BEFORE UPDATE ON app.inventory
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Append-only ledger. Every change to on_hand/reserved writes one row here, so the
-- current numbers can always be re-derived and a discrepancy can be traced.
CREATE TABLE app.inventory_movements (
  id          bigserial PRIMARY KEY,
  item_id     uuid NOT NULL REFERENCES app.menu_items(id),
  kind        app.inventory_movement_kind NOT NULL,
  delta_on_hand  integer NOT NULL DEFAULT 0,
  delta_reserved integer NOT NULL DEFAULT 0,
  order_id    uuid,                               -- FK added in 0003 after orders exists
  actor_type  app.actor_type NOT NULL,
  actor_id    text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_item_idx ON app.inventory_movements (item_id, created_at DESC);

CREATE OR REPLACE FUNCTION app.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER inventory_movements_append_only
  BEFORE UPDATE OR DELETE ON app.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION app.forbid_change();
REVOKE UPDATE, DELETE ON app.inventory_movements FROM app_runtime;
