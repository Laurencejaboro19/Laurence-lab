/**
 * Shared helpers for integration tests that need a real Postgres.
 *
 * Tests call `describeWithDb('name', (ctx) => …)`. When DATABASE_URL_TEST is not
 * set the whole block is skipped with a visible reason, so `npm test` passes on a
 * machine with no database while CI (which has one) runs everything.
 *
 * `resetDatabase()` drops schema `app` and re-applies every migration, so each
 * test file starts from the exact schema production will have.
 */
import 'dotenv/config';

import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';

export const TEST_MIGRATE_URL = process.env['DATABASE_URL_TEST'];
export const TEST_RUNTIME_URL = process.env['DATABASE_URL_TEST_RUNTIME'];

export interface DbContext {
  /** Pool connected as app_migrate (owner). Use for setup and privileged assertions. */
  migrate: Pool;
  /** Pool connected as app_runtime — what the application actually uses. */
  runtime: Pool;
}

export async function resetDatabase(): Promise<void> {
  if (!TEST_MIGRATE_URL) throw new Error('DATABASE_URL_TEST is not set');
  const client = new Client({ connectionString: TEST_MIGRATE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS app CASCADE');
    await runMigrations(client);
  } finally {
    await client.end();
  }
}

export function describeWithDb(name: string, body: (ctx: DbContext) => void): void {
  if (!TEST_MIGRATE_URL || !TEST_RUNTIME_URL) {
    describe.skip(`${name} (skipped: set DATABASE_URL_TEST and DATABASE_URL_TEST_RUNTIME)`, () => {
      /* skipped */
    });
    return;
  }
  const ctx = {} as DbContext;
  describe(name, () => {
    beforeAll(async () => {
      await resetDatabase();
      ctx.migrate = new Pool({ connectionString: TEST_MIGRATE_URL, max: 4 });
      ctx.runtime = new Pool({ connectionString: TEST_RUNTIME_URL, max: 30 });
    }, 60_000);
    afterAll(async () => {
      await ctx.runtime.end();
      await ctx.migrate.end();
    });
    body(ctx);
  });
}

/** Inserts a minimal customer + category + item + inventory row and returns the item id. */
export async function seedItem(
  runtime: Pool,
  opts: { slug: string; onHand: number; priceKobo?: number },
): Promise<string> {
  await runtime.query(
    `INSERT INTO app.menu_categories (name) VALUES ('Test') ON CONFLICT (name) DO NOTHING`,
  );
  const item = await runtime.query<{ id: string }>(
    `INSERT INTO app.menu_items (category_id, slug, name, price_kobo)
     SELECT id, $1, $1, $2 FROM app.menu_categories WHERE name = 'Test'
     RETURNING id`,
    [opts.slug, opts.priceKobo ?? 150_000],
  );
  const itemId = item.rows[0]!.id;
  await runtime.query(`INSERT INTO app.inventory (item_id, on_hand) VALUES ($1, $2)`, [
    itemId,
    opts.onHand,
  ]);
  return itemId;
}
