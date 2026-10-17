import { expect, it } from 'vitest';

import { describeWithDb, seedItem } from './helpers.js';

/**
 * The overselling guard lives in ONE SQL statement:
 *   UPDATE app.inventory SET reserved = reserved + $qty
 *   WHERE item_id = $id AND on_hand - reserved >= $qty
 * Postgres evaluates the WHERE and applies the SET atomically per row, so two
 * transactions cannot both see "1 left" and both take it — the second one waits
 * for the row lock, re-evaluates the WHERE against the committed value, and
 * updates 0 rows. The CHECK constraints are the backstop if the statement is
 * ever written wrongly. Phase 3's InventoryRepository uses exactly this statement;
 * this test pins the behaviour at the database level.
 */
const RESERVE_SQL = `UPDATE app.inventory SET reserved = reserved + $2
                     WHERE item_id = $1 AND on_hand - reserved >= $2`;

describeWithDb('inventory reservation', (ctx) => {
  it('reserves while stock is available and refuses once it is not', async () => {
    const itemId = await seedItem(ctx.runtime, { slug: 'jollof', onHand: 3 });
    const a = await ctx.runtime.query(RESERVE_SQL, [itemId, 2]);
    expect(a.rowCount).toBe(1);
    const b = await ctx.runtime.query(RESERVE_SQL, [itemId, 2]); // only 1 left
    expect(b.rowCount).toBe(0);
    const c = await ctx.runtime.query(RESERVE_SQL, [itemId, 1]);
    expect(c.rowCount).toBe(1);
    const row = await ctx.runtime.query<{ on_hand: number; reserved: number }>(
      `SELECT on_hand, reserved FROM app.inventory WHERE item_id = $1`,
      [itemId],
    );
    expect(row.rows[0]).toEqual({ on_hand: 3, reserved: 3 });
  });

  it('never oversells under concurrency: 40 buyers, 7 portions, exactly 7 win', async () => {
    const itemId = await seedItem(ctx.runtime, { slug: 'moi-moi', onHand: 7 });
    const attempts = Array.from({ length: 40 }, async () => {
      const client = await ctx.runtime.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query(RESERVE_SQL, [itemId, 1]);
        // Hold the transaction open briefly so the others really do contend for the row.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await client.query('COMMIT');
        return r.rowCount === 1;
      } finally {
        client.release();
      }
    });
    const wins = (await Promise.all(attempts)).filter(Boolean).length;
    expect(wins).toBe(7);
    const row = await ctx.runtime.query<{ on_hand: number; reserved: number }>(
      `SELECT on_hand, reserved FROM app.inventory WHERE item_id = $1`,
      [itemId],
    );
    expect(row.rows[0]).toEqual({ on_hand: 7, reserved: 7 });
  }, 30_000);

  it('the CHECK constraints refuse negative stock and over-reservation outright', async () => {
    const itemId = await seedItem(ctx.runtime, { slug: 'plantain', onHand: 2 });
    await expect(
      ctx.runtime.query(`UPDATE app.inventory SET reserved = 3 WHERE item_id = $1`, [itemId]),
    ).rejects.toThrow(/reserved_within_stock/);
    await expect(
      ctx.runtime.query(`UPDATE app.inventory SET on_hand = -1 WHERE item_id = $1`, [itemId]),
    ).rejects.toThrow(/on_hand_non_negative/);
  });

  it('commit moves stock from reserved to consumed; release gives it back', async () => {
    const itemId = await seedItem(ctx.runtime, { slug: 'chicken', onHand: 5 });
    await ctx.runtime.query(RESERVE_SQL, [itemId, 2]);
    // commit (payment confirmed): on_hand -= qty, reserved -= qty
    const commit = await ctx.runtime.query(
      `UPDATE app.inventory SET on_hand = on_hand - $2, reserved = reserved - $2
       WHERE item_id = $1 AND reserved >= $2`,
      [itemId, 2],
    );
    expect(commit.rowCount).toBe(1);
    await ctx.runtime.query(RESERVE_SQL, [itemId, 1]);
    // release (expiry / cancellation): reserved -= qty
    const release = await ctx.runtime.query(
      `UPDATE app.inventory SET reserved = reserved - $2 WHERE item_id = $1 AND reserved >= $2`,
      [itemId, 1],
    );
    expect(release.rowCount).toBe(1);
    const row = await ctx.runtime.query<{ on_hand: number; reserved: number }>(
      `SELECT on_hand, reserved FROM app.inventory WHERE item_id = $1`,
      [itemId],
    );
    expect(row.rows[0]).toEqual({ on_hand: 3, reserved: 0 });
  });

  it('the movement ledger is append-only', async () => {
    const itemId = await seedItem(ctx.runtime, { slug: 'water', onHand: 1 });
    await ctx.runtime.query(
      `INSERT INTO app.inventory_movements (item_id, kind, delta_on_hand, actor_type)
       VALUES ($1, 'receive', 1, 'staff')`,
      [itemId],
    );
    await expect(
      ctx.runtime.query(`UPDATE app.inventory_movements SET delta_on_hand = 99`),
    ).rejects.toThrow(/permission denied/);
  });
});
