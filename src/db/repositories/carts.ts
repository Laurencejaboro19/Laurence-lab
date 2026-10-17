import { notFound } from '../../core/domain/errors.js';
import type { Cart, CartLine, CartRepository, Tx } from '../../core/ports/index.js';
import { pgOf } from '../client.js';

interface CartRow {
  id: string;
  customer_id: string;
  fulfilment: 'delivery' | 'pickup' | null;
  address_id: string | null;
  promo_code: string | null;
  note: string | null;
}

interface LineRow {
  id: string;
  item_id: string;
  variant_id: string | null;
  addon_ids: string[];
  quantity: number;
}

const lineOf = (r: LineRow): CartLine => ({
  id: r.id,
  itemId: r.item_id,
  variantId: r.variant_id,
  addonIds: r.addon_ids,
  quantity: r.quantity,
});

const CART_COLS = 'id, customer_id, fulfilment, address_id, promo_code, note';

export class PgCartRepository implements CartRepository {
  private async withLines(tx: Tx, row: CartRow): Promise<Cart> {
    const lines = await pgOf(tx).query<LineRow>(
      `SELECT id, item_id, variant_id, addon_ids, quantity FROM app.cart_items WHERE cart_id = $1 ORDER BY created_at`,
      [row.id],
    );
    return {
      id: row.id,
      customerId: row.customer_id,
      fulfilment: row.fulfilment,
      addressId: row.address_id,
      promoCode: row.promo_code,
      note: row.note,
      lines: lines.rows.map(lineOf),
    };
  }

  async findActive(tx: Tx, customerId: string): Promise<Cart | null> {
    const r = await pgOf(tx).query<CartRow>(
      `SELECT ${CART_COLS} FROM app.carts WHERE customer_id = $1 AND status = 'active' FOR UPDATE`,
      [customerId],
    );
    return r.rows[0] ? this.withLines(tx, r.rows[0]) : null;
  }

  async create(tx: Tx, customerId: string): Promise<Cart> {
    const r = await pgOf(tx).query<CartRow>(
      `INSERT INTO app.carts (customer_id) VALUES ($1) RETURNING ${CART_COLS}`,
      [customerId],
    );
    return this.withLines(tx, r.rows[0]!);
  }

  async addLine(tx: Tx, cartId: string, line: Omit<CartLine, 'id'>): Promise<CartLine> {
    const client = pgOf(tx);
    // Same item + same variant + same add-ons → bump quantity instead of a second line.
    const existing = await client.query<LineRow>(
      `SELECT id, item_id, variant_id, addon_ids, quantity FROM app.cart_items
       WHERE cart_id = $1 AND item_id = $2 AND variant_id IS NOT DISTINCT FROM $3 AND addon_ids = $4::uuid[]`,
      [cartId, line.itemId, line.variantId, line.addonIds],
    );
    if (existing.rows[0]) {
      const r = await client.query<LineRow>(
        `UPDATE app.cart_items SET quantity = LEAST(50, quantity + $2) WHERE id = $1
         RETURNING id, item_id, variant_id, addon_ids, quantity`,
        [existing.rows[0].id, line.quantity],
      );
      return lineOf(r.rows[0]!);
    }
    const r = await client.query<LineRow>(
      `INSERT INTO app.cart_items (cart_id, item_id, variant_id, addon_ids, quantity)
       VALUES ($1, $2, $3, $4::uuid[], $5) RETURNING id, item_id, variant_id, addon_ids, quantity`,
      [cartId, line.itemId, line.variantId, line.addonIds, line.quantity],
    );
    return lineOf(r.rows[0]!);
  }

  async updateLine(tx: Tx, cartId: string, lineId: string, quantity: number): Promise<boolean> {
    const r = await pgOf(tx).query(
      `UPDATE app.cart_items SET quantity = $3 WHERE id = $2 AND cart_id = $1`,
      [cartId, lineId, quantity],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async removeLine(tx: Tx, cartId: string, lineId: string): Promise<boolean> {
    const r = await pgOf(tx).query(`DELETE FROM app.cart_items WHERE id = $2 AND cart_id = $1`, [
      cartId,
      lineId,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async clearLines(tx: Tx, cartId: string): Promise<void> {
    await pgOf(tx).query(`DELETE FROM app.cart_items WHERE cart_id = $1`, [cartId]);
  }

  async update(
    tx: Tx,
    cartId: string,
    patch: Partial<Pick<Cart, 'fulfilment' | 'addressId' | 'promoCode' | 'note'>>,
  ): Promise<Cart> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, v: unknown): void => {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.fulfilment !== undefined) push('fulfilment', patch.fulfilment);
    if (patch.addressId !== undefined) push('address_id', patch.addressId);
    if (patch.promoCode !== undefined) push('promo_code', patch.promoCode);
    if (patch.note !== undefined) push('note', patch.note);
    values.push(cartId);
    const r = await pgOf(tx).query<CartRow>(
      `UPDATE app.carts SET ${sets.length ? sets.join(', ') : 'updated_at = now()'}
       WHERE id = $${values.length} AND status = 'active' RETURNING ${CART_COLS}`,
      values,
    );
    if (!r.rows[0]) throw notFound('cart', cartId);
    return this.withLines(tx, r.rows[0]);
  }

  async markConverted(tx: Tx, cartId: string): Promise<void> {
    await pgOf(tx).query(`UPDATE app.carts SET status = 'converted' WHERE id = $1`, [cartId]);
  }
}
