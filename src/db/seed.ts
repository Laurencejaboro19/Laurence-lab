/**
 * Seed data: a realistic Nigerian menu with NGN prices (stored as kobo), two
 * Benin City delivery zones, default settings and FAQ entries.
 *
 * Idempotent: every insert is an upsert on a natural key (slug / name / key), so
 * `npm run seed` can be re-run after edits without duplicating rows. It never
 * touches orders, payments or the audit log. Prices here are placeholders the
 * owner changes from the admin bot (see docs/ASSUMPTIONS.md).
 *
 * Zone polygons are deliberately coarse rectangles around the named areas; they
 * are GeoJSON [longitude, latitude] rings and are meant to be redrawn by the owner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/** ₦ → kobo. Keeps the seed readable while the database stays in integers. */
const naira = (n: number): number => Math.round(n * 100);

interface SeedItem {
  slug: string;
  name: string;
  description: string;
  priceKobo: number;
  aliases: string[];
  prep: number;
  track: boolean;
  onHand: number;
  variants?: { name: string; deltaKobo: number }[];
  addons?: { name: string; priceKobo: number }[];
}

const CATEGORIES: { name: string; items: SeedItem[] }[] = [
  {
    name: 'Rice',
    items: [
      {
        slug: 'jollof-rice',
        name: 'Jollof Rice',
        description: 'Smoky party-style jollof, served with a slice of plantain.',
        priceKobo: naira(1500),
        aliases: ['jollof', 'jollof rice', 'jellof'],
        prep: 20,
        track: true,
        onHand: 60,
        variants: [
          { name: 'Regular', deltaKobo: 0 },
          { name: 'Large', deltaKobo: naira(500) },
        ],
        addons: [
          { name: 'Extra plantain', priceKobo: naira(300) },
          { name: 'Coleslaw', priceKobo: naira(400) },
        ],
      },
      {
        slug: 'fried-rice',
        name: 'Fried Rice',
        description: 'Vegetable fried rice with liver bits.',
        priceKobo: naira(1600),
        aliases: ['fried rice', 'fried', 'fry rice'],
        prep: 20,
        track: true,
        onHand: 40,
        variants: [
          { name: 'Regular', deltaKobo: 0 },
          { name: 'Large', deltaKobo: naira(500) },
        ],
      },
      {
        slug: 'white-rice-stew',
        name: 'White Rice & Stew',
        description: 'Steamed white rice with tomato stew.',
        priceKobo: naira(1300),
        aliases: ['white rice', 'rice and stew', 'rice & stew'],
        prep: 15,
        track: true,
        onHand: 40,
      },
    ],
  },
  {
    name: 'Proteins',
    items: [
      {
        slug: 'chicken',
        name: 'Chicken',
        description: 'Peppered chicken, one piece.',
        priceKobo: naira(2500),
        aliases: ['chicken', 'chiken', 'chicken piece'],
        prep: 10,
        track: true,
        onHand: 50,
      },
      {
        slug: 'turkey',
        name: 'Turkey',
        description: 'Peppered turkey, one piece.',
        priceKobo: naira(3000),
        aliases: ['turkey'],
        prep: 10,
        track: true,
        onHand: 20,
      },
      {
        slug: 'fish',
        name: 'Fried Fish',
        description: 'Fried titus fish, one piece.',
        priceKobo: naira(2000),
        aliases: ['fish', 'titus', 'fried fish'],
        prep: 10,
        track: true,
        onHand: 30,
      },
      {
        slug: 'boiled-egg',
        name: 'Boiled Egg',
        description: 'One boiled egg.',
        priceKobo: naira(300),
        aliases: ['egg', 'boiled egg', 'eggs'],
        prep: 5,
        track: true,
        onHand: 60,
      },
    ],
  },
  {
    name: 'Sides',
    items: [
      {
        slug: 'fried-plantain',
        name: 'Fried Plantain',
        description: 'Sweet ripe plantain, one portion.',
        priceKobo: naira(800),
        aliases: ['plantain', 'dodo', 'fried plantain'],
        prep: 10,
        track: true,
        onHand: 50,
      },
      {
        slug: 'moi-moi',
        name: 'Moi Moi',
        description: 'Steamed bean pudding with egg.',
        priceKobo: naira(700),
        aliases: ['moi moi', 'moimoi', 'moin moin', 'moin-moin'],
        prep: 5,
        track: true,
        onHand: 30,
      },
      {
        slug: 'coleslaw',
        name: 'Coleslaw',
        description: 'Fresh cabbage and carrot salad.',
        priceKobo: naira(500),
        aliases: ['coleslaw', 'salad', 'slaw'],
        prep: 5,
        track: true,
        onHand: 30,
      },
    ],
  },
  {
    name: 'Drinks',
    items: [
      {
        slug: 'chivita',
        name: 'Chivita Juice (1L)',
        description: 'Chivita Active or Exotic, 1 litre.',
        priceKobo: naira(1800),
        aliases: ['chivita', 'juice', 'chivita juice'],
        prep: 0,
        track: true,
        onHand: 24,
      },
      {
        slug: 'bottled-water',
        name: 'Bottled Water',
        description: '75cl table water.',
        priceKobo: naira(300),
        aliases: ['water', 'bottle water', 'bottled water', 'pure water'],
        prep: 0,
        track: false,
        onHand: 0,
      },
      {
        slug: 'soft-drink',
        name: 'Soft Drink (50cl)',
        description: 'Coke, Fanta or Sprite, 50cl PET.',
        priceKobo: naira(500),
        aliases: ['coke', 'fanta', 'sprite', 'soft drink', 'minerals', 'mineral'],
        prep: 0,
        track: false,
        onHand: 0,
        variants: [
          { name: 'Coke', deltaKobo: 0 },
          { name: 'Fanta', deltaKobo: 0 },
          { name: 'Sprite', deltaKobo: 0 },
        ],
      },
      {
        slug: 'malt',
        name: 'Malt Drink',
        description: 'Maltina or Amstel Malta, 33cl.',
        priceKobo: naira(700),
        aliases: ['malt', 'maltina', 'amstel', 'amstel malta'],
        prep: 0,
        track: false,
        onHand: 0,
      },
    ],
  },
];

// Coarse rectangles; [lon, lat] rings closed on the first point.
const ZONES = [
  {
    name: 'Zone A — Ugbowo, Ekosodin, Uselu',
    feeKobo: naira(500),
    minOrderKobo: naira(2000),
    eta: 30,
    sort: 1,
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [5.585, 6.375],
          [5.645, 6.375],
          [5.645, 6.425],
          [5.585, 6.425],
          [5.585, 6.375],
        ],
      ],
    },
  },
  {
    name: 'Zone B — GRA, Ring Road, Sapele Road',
    feeKobo: naira(1000),
    minOrderKobo: naira(2000),
    eta: 45,
    sort: 2,
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [5.59, 6.3],
          [5.67, 6.3],
          [5.67, 6.375],
          [5.59, 6.375],
          [5.59, 6.3],
        ],
      ],
    },
  },
];

const SETTINGS: Record<string, unknown> = {
  'brand.name': 'Laurence Lab',
  'brand.default_language': 'en',
  'store.open': true,
  'store.hours': {
    timezone: 'Africa/Lagos',
    days: {
      mon: ['09:00', '21:00'],
      tue: ['09:00', '21:00'],
      wed: ['09:00', '21:00'],
      thu: ['09:00', '21:00'],
      fri: ['09:00', '21:00'],
      sat: ['09:00', '21:00'],
      sun: ['09:00', '21:00'],
    },
  },
  'store.busy_mode': { enabled: false, max_orders_per_15m: 20, extra_eta_minutes: 15 },
  'store.default_prep_minutes': 25,
  'orders.payment_timeout_minutes': 15,
  'orders.daily_cap': 50,
  'orders.max_unpaid_pending_per_customer': 2,
  'orders.max_quantity_per_line': 20,
  'payments.provider': 'paystack',
  'payments.enabled': true,
  'delivery.provider': 'manual',
  'delivery.enabled': true,
  'delivery.pickup_enabled': true,
  'support.hours': { timezone: 'Africa/Lagos', from: '09:00', to: '21:00' },
  'support.phone': '',
  'refunds.policy_text':
    'Full refund if cancelled before we accept your order or if we cannot deliver. After dispatch, refunds only for wrong or missing items. Refunds go back to your card/bank through Paystack within 5–7 working days.',
  'fraud.max_orders_per_hour': 5,
  'fraud.max_failed_payments_per_day': 5,
  'inventory.low_stock_threshold_default': 5,
  'ai.enabled': false,
  'privacy.policy_url': '',
};

const FAQS = [
  {
    q: 'What are your opening hours?',
    a: 'We are open every day from 9:00 AM to 9:00 PM.',
    k: ['hours', 'open', 'close', 'time'],
  },
  {
    q: 'Where do you deliver?',
    a: 'Ugbowo, Ekosodin, Uselu, GRA, Ring Road and Sapele Road in Benin City. Share your location and we will confirm your zone and fee.',
    k: ['deliver', 'delivery', 'area', 'zone', 'location'],
  },
  {
    q: 'How do I pay?',
    a: 'Securely online through Paystack: card, bank transfer or USSD. We do not take cash on delivery.',
    k: ['pay', 'payment', 'transfer', 'card', 'cash', 'pos'],
  },
  {
    q: 'How long does delivery take?',
    a: 'Usually 30–45 minutes depending on your zone. You get a message at every step, including the rider details.',
    k: ['long', 'eta', 'when', 'arrive', 'time'],
  },
  {
    q: 'Can I cancel my order?',
    a: 'Yes, any time before we accept it — tap Cancel on your order. After that, message support.',
    k: ['cancel', 'refund', 'change'],
  },
];

const FAQS_PCM = [
  {
    q: 'Wetin time una dey open?',
    a: 'We dey open every day from 9 for morning reach 9 for night.',
    k: ['time', 'open', 'close'],
  },
  {
    q: 'Where una dey deliver go?',
    a: 'Ugbowo, Ekosodin, Uselu, GRA, Ring Road and Sapele Road for Benin. Share your location make we confirm your zone and price.',
    k: ['deliver', 'area', 'where'],
  },
];

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected RETURNING row');
  return row;
}

export async function seed(
  client: Client,
  log: (l: string) => void = () => undefined,
): Promise<void> {
  await client.query('BEGIN');
  try {
    for (const [ci, cat] of CATEGORIES.entries()) {
      const c = await client.query<{ id: string }>(
        `INSERT INTO app.menu_categories (name, sort_order) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET sort_order = EXCLUDED.sort_order RETURNING id`,
        [cat.name, ci],
      );
      const categoryId = firstRow(c.rows).id;
      for (const [ii, item] of cat.items.entries()) {
        const r = await client.query<{ id: string }>(
          `INSERT INTO app.menu_items (category_id, slug, name, description, price_kobo, prep_minutes, aliases, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (slug) DO UPDATE SET
             category_id = EXCLUDED.category_id, name = EXCLUDED.name, description = EXCLUDED.description,
             prep_minutes = EXCLUDED.prep_minutes, aliases = EXCLUDED.aliases, sort_order = EXCLUDED.sort_order
           RETURNING id`,
          [
            categoryId,
            item.slug,
            item.name,
            item.description,
            item.priceKobo,
            item.prep,
            item.aliases,
            ii,
          ],
        );
        const itemId = firstRow(r.rows).id;
        // Stock is only set on first insert: re-seeding must never overwrite real counts.
        await client.query(
          `INSERT INTO app.inventory (item_id, track, on_hand) VALUES ($1, $2, $3)
           ON CONFLICT (item_id) DO UPDATE SET track = EXCLUDED.track`,
          [itemId, item.track, item.onHand],
        );
        for (const [vi, v] of (item.variants ?? []).entries()) {
          await client.query(
            `INSERT INTO app.menu_variants (item_id, name, price_delta_kobo, sort_order) VALUES ($1, $2, $3, $4)
             ON CONFLICT (item_id, name) DO UPDATE SET price_delta_kobo = EXCLUDED.price_delta_kobo, sort_order = EXCLUDED.sort_order`,
            [itemId, v.name, v.deltaKobo, vi],
          );
        }
        for (const [ai, a] of (item.addons ?? []).entries()) {
          await client.query(
            `INSERT INTO app.menu_addons (item_id, name, price_kobo, sort_order) VALUES ($1, $2, $3, $4)
             ON CONFLICT (item_id, name) DO UPDATE SET price_kobo = EXCLUDED.price_kobo, sort_order = EXCLUDED.sort_order`,
            [itemId, a.name, a.priceKobo, ai],
          );
        }
      }
      log(`category ${cat.name}: ${cat.items.length} items`);
    }

    for (const z of ZONES) {
      await client.query(
        `INSERT INTO app.delivery_zones (name, fee_kobo, min_order_kobo, eta_minutes, polygon, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name) DO UPDATE SET polygon = EXCLUDED.polygon, sort_order = EXCLUDED.sort_order`,
        [z.name, z.feeKobo, z.minOrderKobo, z.eta, JSON.stringify(z.polygon), z.sort],
      );
    }
    log(`zones: ${ZONES.length}`);

    // Settings: insert only if absent, so the owner's changes survive re-seeding.
    for (const [key, value] of Object.entries(SETTINGS)) {
      await client.query(
        `INSERT INTO app.settings (key, value, updated_by) VALUES ($1, $2, 'seed') ON CONFLICT (key) DO NOTHING`,
        [key, JSON.stringify(value)],
      );
    }
    log(`settings: ${Object.keys(SETTINGS).length} keys (existing values kept)`);

    await client.query(`DELETE FROM app.faq_entries WHERE language = 'en' AND question = ANY($1)`, [
      FAQS.map((f) => f.q),
    ]);
    for (const [i, f] of FAQS.entries()) {
      await client.query(
        `INSERT INTO app.faq_entries (language, question, answer, keywords, sort_order) VALUES ('en', $1, $2, $3, $4)`,
        [f.q, f.a, f.k, i],
      );
    }
    await client.query(
      `DELETE FROM app.faq_entries WHERE language = 'pcm' AND question = ANY($1)`,
      [FAQS_PCM.map((f) => f.q)],
    );
    for (const [i, f] of FAQS_PCM.entries()) {
      await client.query(
        `INSERT INTO app.faq_entries (language, question, answer, keywords, sort_order) VALUES ('pcm', $1, $2, $3, $4)`,
        [f.q, f.a, f.k, i],
      );
    }
    log(`faq: ${FAQS.length} en, ${FAQS_PCM.length} pcm`);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main(): Promise<void> {
  const { loadEnv } = await import('../config/env.js');
  const env = loadEnv();
  if (env.NODE_ENV === 'production' && process.argv[2] !== '--i-know-this-is-production') {
    throw new Error('Refusing to seed production without --i-know-this-is-production');
  }
  const client = new Client({ connectionString: env.DATABASE_URL_DIRECT });
  await client.connect();
  try {
    await seed(client, (l) => process.stdout.write(`${l}\n`));
    process.stdout.write('seed complete\n');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
