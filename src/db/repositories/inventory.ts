import { notFound } from '../../core/domain/errors.js';
import type { Actor, InventoryRepository, StockMovement, Tx } from '../../core/ports/index.js';
import { pgOf } from '../client.js';

/**
 * Stock reservation. See test/db/inventory.test.ts for the concurrency proof.
 *
 * REVIEW: the three statements below are the overselling guard. Each is a single
 * conditional UPDATE, so the check and the change are atomic per row. Untracked
 * items (track = false) are skipped — they are "unlimited".
 */
export class PgInventoryRepository implements InventoryRepository {
  /**
   * Reserves every line or none. Lines are processed in item-id order so two
   * orders that overlap always lock rows in the same sequence (no deadlocks).
   * On the first failure the caller's transaction must roll back — this method
   * returns the failing item ids rather than throwing so the service can build
   * a helpful "X and Y just sold out" message.
   */
  async reserve(tx: Tx, orderId: string, lines: StockMovement[]): Promise<string[]> {
    const client = pgOf(tx);
    const failed: string[] = [];
    const sorted = [...lines].sort((a, b) => a.itemId.localeCompare(b.itemId));
    for (const line of sorted) {
      // Untracked items match the WHERE but keep `reserved` unchanged (unlimited stock).
      const r = await client.query<{ track: boolean }>(
        `UPDATE app.inventory
            SET reserved = CASE WHEN track THEN reserved + $2 ELSE reserved END
          WHERE item_id = $1 AND (NOT track OR on_hand - reserved >= $2)
          RETURNING track`,
        [line.itemId, line.quantity],
      );
      if ((r.rowCount ?? 0) === 0) {
        failed.push(line.itemId);
        continue;
      }
      if (r.rows[0]?.track) {
        await client.query(
          `INSERT INTO app.inventory_movements (item_id, kind, delta_reserved, order_id, actor_type, actor_id)
           VALUES ($1, 'reserve', $2, $3, 'system', 'checkout')`,
          [line.itemId, line.quantity, orderId],
        );
      }
    }
    return failed;
  }

  /**
   * How much of this order's reservation is still outstanding for an item, from
   * the ledger: reserves minus releases/commits. Makes commit/release idempotent
   * and order-aware — a retried job or a double transition cannot touch stock
   * that another order holds.
   */
  private async outstanding(tx: Tx, orderId: string, itemId: string): Promise<number> {
    const r = await pgOf(tx).query<{ n: string }>(
      `SELECT coalesce(sum(delta_reserved), 0)::text AS n FROM app.inventory_movements
       WHERE order_id = $1 AND item_id = $2`,
      [orderId, itemId],
    );
    return Math.max(0, Number(r.rows[0]?.n ?? 0));
  }

  /** Payment confirmed: reserved → consumed. */
  async commit(tx: Tx, orderId: string, lines: StockMovement[]): Promise<void> {
    const client = pgOf(tx);
    for (const line of lines) {
      const qty = Math.min(line.quantity, await this.outstanding(tx, orderId, line.itemId));
      if (qty === 0) continue;
      const r = await client.query(
        `UPDATE app.inventory SET on_hand = on_hand - $2, reserved = reserved - $2
         WHERE item_id = $1 AND track AND reserved >= $2`,
        [line.itemId, qty],
      );
      if ((r.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO app.inventory_movements (item_id, kind, delta_on_hand, delta_reserved, order_id, actor_type, actor_id)
           VALUES ($1, 'commit', $2, $3, $4, 'system', 'payment')`,
          [line.itemId, -qty, -qty, orderId],
        );
      }
    }
  }

  /** Expiry / cancellation before payment: give the reservation back. */
  async release(tx: Tx, orderId: string, lines: StockMovement[]): Promise<void> {
    const client = pgOf(tx);
    for (const line of lines) {
      const qty = Math.min(line.quantity, await this.outstanding(tx, orderId, line.itemId));
      if (qty === 0) continue;
      const r = await client.query(
        `UPDATE app.inventory SET reserved = reserved - $2
         WHERE item_id = $1 AND track AND reserved >= $2`,
        [line.itemId, qty],
      );
      if ((r.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO app.inventory_movements (item_id, kind, delta_reserved, order_id, actor_type, actor_id)
           VALUES ($1, 'release', $2, $3, 'system', 'release')`,
          [line.itemId, -qty, orderId],
        );
      }
    }
  }

  async adjust(
    tx: Tx,
    input: {
      itemId: string;
      deltaOnHand: number;
      kind: 'receive' | 'adjust' | 'waste' | 'import';
      actor: Actor;
      note?: string;
    },
  ): Promise<{ onHand: number; reserved: number }> {
    const client = pgOf(tx);
    const r = await client.query<{ on_hand: number; reserved: number }>(
      `INSERT INTO app.inventory (item_id, on_hand) VALUES ($1, GREATEST($2, 0))
       ON CONFLICT (item_id) DO UPDATE SET on_hand = app.inventory.on_hand + $2
       RETURNING on_hand, reserved`,
      [input.itemId, input.deltaOnHand],
    );
    if (!r.rows[0]) throw notFound('inventory', input.itemId);
    await client.query(
      `INSERT INTO app.inventory_movements (item_id, kind, delta_on_hand, actor_type, actor_id, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.itemId,
        input.kind,
        input.deltaOnHand,
        input.actor.type,
        input.actor.id,
        input.note ?? null,
      ],
    );
    return { onHand: r.rows[0].on_hand, reserved: r.rows[0].reserved };
  }

  async setThreshold(tx: Tx, itemId: string, threshold: number): Promise<void> {
    await pgOf(tx).query(`UPDATE app.inventory SET low_stock_threshold = $2 WHERE item_id = $1`, [
      itemId,
      threshold,
    ]);
  }

  async lowStock(
    tx: Tx,
  ): Promise<{ itemId: string; name: string; available: number; threshold: number }[]> {
    const r = await pgOf(tx).query<{
      item_id: string;
      name: string;
      available: number;
      threshold: number;
    }>(
      `SELECT inv.item_id, i.name, inv.on_hand - inv.reserved AS available, inv.low_stock_threshold AS threshold
       FROM app.inventory inv JOIN app.menu_items i ON i.id = inv.item_id
       WHERE inv.track AND i.active AND i.deleted_at IS NULL
         AND inv.on_hand - inv.reserved <= inv.low_stock_threshold
       ORDER BY available`,
    );
    return r.rows.map((x) => ({
      itemId: x.item_id,
      name: x.name,
      available: x.available,
      threshold: x.threshold,
    }));
  }
}
