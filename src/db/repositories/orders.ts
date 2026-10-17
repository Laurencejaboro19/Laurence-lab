import type { Channel } from '../../core/channel/types.js';
import { kobo } from '../../core/domain/money.js';
import type { OrderStatus } from '../../core/domain/order-status.js';
import type {
  Actor,
  Order,
  OrderItem,
  OrderListFilter,
  OrderRepository,
  Tx,
} from '../../core/ports/index.js';
import { pgOf } from '../client.js';

interface OrderRow {
  id: string;
  public_ref: string;
  customer_id: string;
  channel: Channel;
  status: OrderStatus;
  fulfilment: 'delivery' | 'pickup';
  address_snapshot: Record<string, unknown> | null;
  zone_id: string | null;
  subtotal_kobo: string;
  delivery_fee_kobo: string;
  discount_kobo: string;
  total_kobo: string;
  promo_id: string | null;
  customer_note: string | null;
  eta_minutes: number | null;
  payment_expires_at: Date | null;
  placed_at: Date;
  paid_at: Date | null;
  version: number;
  items: ItemRow[] | null;
}

interface ItemRow {
  id: string;
  item_id: string | null;
  name_snapshot: string;
  variant_snapshot: string | null;
  addons_snapshot: { name: string; price_kobo: number }[];
  unit_price_kobo: string;
  quantity: number;
  line_total_kobo: string;
}

const itemOf = (r: ItemRow): OrderItem => ({
  id: r.id,
  itemId: r.item_id,
  nameSnapshot: r.name_snapshot,
  variantSnapshot: r.variant_snapshot,
  addonsSnapshot: r.addons_snapshot,
  unitPriceKobo: kobo(r.unit_price_kobo),
  quantity: r.quantity,
  lineTotalKobo: kobo(r.line_total_kobo),
});

const orderOf = (r: OrderRow): Order => ({
  id: r.id,
  publicRef: r.public_ref,
  customerId: r.customer_id,
  channel: r.channel,
  status: r.status,
  fulfilment: r.fulfilment,
  addressSnapshot: r.address_snapshot,
  zoneId: r.zone_id,
  subtotalKobo: kobo(r.subtotal_kobo),
  deliveryFeeKobo: kobo(r.delivery_fee_kobo),
  discountKobo: kobo(r.discount_kobo),
  totalKobo: kobo(r.total_kobo),
  promoId: r.promo_id,
  customerNote: r.customer_note,
  etaMinutes: r.eta_minutes,
  paymentExpiresAt: r.payment_expires_at,
  placedAt: r.placed_at,
  paidAt: r.paid_at,
  version: r.version,
  items: (r.items ?? []).map(itemOf),
});

const ORDER_SELECT = `
  SELECT o.id, o.public_ref, o.customer_id, o.channel, o.status, o.fulfilment, o.address_snapshot,
         o.zone_id, o.subtotal_kobo::text, o.delivery_fee_kobo::text, o.discount_kobo::text,
         o.total_kobo::text, o.promo_id, o.customer_note, o.eta_minutes, o.payment_expires_at,
         o.placed_at, o.paid_at, o.version,
         (SELECT json_agg(json_build_object(
             'id', oi.id, 'item_id', oi.item_id, 'name_snapshot', oi.name_snapshot,
             'variant_snapshot', oi.variant_snapshot, 'addons_snapshot', oi.addons_snapshot,
             'unit_price_kobo', oi.unit_price_kobo::text, 'quantity', oi.quantity,
             'line_total_kobo', oi.line_total_kobo::text) ORDER BY oi.line_no, oi.id)
          FROM app.order_items oi WHERE oi.order_id = o.id) AS items
  FROM app.orders o`;

/** Columns that a status change may also set, keyed by target status. */
const TIMESTAMP_FOR: Partial<Record<OrderStatus, string>> = {
  PAID: 'paid_at',
  ACCEPTED: 'accepted_at',
  READY: 'ready_at',
  DISPATCHED: 'dispatched_at',
  DELIVERED: 'delivered_at',
};
const CLOSING: ReadonlySet<OrderStatus> = new Set([
  'DELIVERED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'REFUNDED',
]);

export class PgOrderRepository implements OrderRepository {
  async create(
    tx: Tx,
    input: Omit<Order, 'id' | 'placedAt' | 'paidAt' | 'version' | 'items' | 'status'> & {
      items: Omit<OrderItem, 'id'>[];
    },
  ): Promise<Order> {
    const client = pgOf(tx);
    const r = await client.query<{ id: string }>(
      `INSERT INTO app.orders (public_ref, customer_id, channel, fulfilment, address_snapshot, zone_id,
         subtotal_kobo, delivery_fee_kobo, discount_kobo, total_kobo, promo_id, customer_note,
         eta_minutes, payment_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [
        input.publicRef,
        input.customerId,
        input.channel,
        input.fulfilment,
        input.addressSnapshot === null ? null : JSON.stringify(input.addressSnapshot),
        input.zoneId,
        input.subtotalKobo,
        input.deliveryFeeKobo,
        input.discountKobo,
        input.totalKobo,
        input.promoId,
        input.customerNote,
        input.etaMinutes,
        input.paymentExpiresAt,
      ],
    );
    const id = (r.rows[0] as { id: string }).id;
    for (const [lineNo, item] of input.items.entries()) {
      await client.query(
        `INSERT INTO app.order_items (order_id, line_no, item_id, name_snapshot, variant_snapshot, addons_snapshot,
           unit_price_kobo, quantity, line_total_kobo) VALUES ($1, $9, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          item.itemId,
          item.nameSnapshot,
          item.variantSnapshot,
          JSON.stringify(item.addonsSnapshot),
          item.unitPriceKobo,
          item.quantity,
          item.lineTotalKobo,
          lineNo,
        ],
      );
    }
    await client.query(
      `INSERT INTO app.order_status_history (order_id, from_status, to_status, actor_type, actor_id)
       VALUES ($1, NULL, 'PLACED', 'customer', $2)`,
      [id, input.customerId],
    );
    const created = await this.findById(tx, id);
    if (!created) throw new Error('order vanished after insert');
    return created;
  }

  async findById(tx: Tx, id: string): Promise<Order | null> {
    const r = await pgOf(tx).query<OrderRow>(`${ORDER_SELECT} WHERE o.id = $1`, [id]);
    return r.rows[0] ? orderOf(r.rows[0]) : null;
  }

  async findByRef(tx: Tx, publicRef: string): Promise<Order | null> {
    const r = await pgOf(tx).query<OrderRow>(`${ORDER_SELECT} WHERE o.public_ref = $1`, [
      publicRef.toUpperCase(),
    ]);
    return r.rows[0] ? orderOf(r.rows[0]) : null;
  }

  async lockForUpdate(tx: Tx, id: string): Promise<Order | null> {
    // Lock the row first (FOR UPDATE cannot be combined with the aggregate subquery), then read.
    const lock = await pgOf(tx).query(`SELECT id FROM app.orders WHERE id = $1 FOR UPDATE`, [id]);
    if ((lock.rowCount ?? 0) === 0) return null;
    return this.findById(tx, id);
  }

  async setStatus(
    tx: Tx,
    id: string,
    input: {
      from: OrderStatus;
      to: OrderStatus;
      actor: Actor;
      reason?: string;
      at: Date;
      extra?: Record<string, unknown>;
    },
  ): Promise<void> {
    const client = pgOf(tx);
    // $4 (the timestamp) is always referenced so the parameter list is stable.
    const sets = ['status = $2', 'version = version + 1', 'updated_at = $4'];
    const values: unknown[] = [id, input.to, input.from];
    const ts = TIMESTAMP_FOR[input.to];
    if (ts) sets.push(`${ts} = coalesce(${ts}, $4)`);
    if (CLOSING.has(input.to)) sets.push(`closed_at = coalesce(closed_at, $4)`);
    values.push(input.at);
    if (input.to === 'CANCELLED') {
      values.push(input.reason ?? null);
      sets.push(`cancel_reason = $${values.length}`);
    }
    if (input.to === 'REJECTED') {
      values.push(input.reason ?? null);
      sets.push(`reject_reason = $${values.length}`);
    }
    if (input.extra?.['etaMinutes'] !== undefined) {
      values.push(input.extra['etaMinutes']);
      sets.push(`eta_minutes = $${values.length}`);
    }
    // REVIEW: `AND status = $3` makes the update conditional on the status the service
    // read under FOR UPDATE. If anything changed underneath, 0 rows → the service throws.
    const r = await client.query(
      `UPDATE app.orders SET ${sets.join(', ')} WHERE id = $1 AND status = $3`,
      values,
    );
    if ((r.rowCount ?? 0) === 0) {
      throw new Error(`order ${id} is no longer in status ${input.from}`);
    }
    await client.query(
      `INSERT INTO app.order_status_history (order_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, input.from, input.to, input.actor.type, input.actor.id, input.reason ?? null, input.at],
    );
  }

  async list(
    tx: Tx,
    filter: OrderListFilter,
  ): Promise<{ orders: Order[]; nextCursor: string | null }> {
    const conds: string[] = [];
    const values: unknown[] = [];
    if (filter.customerId) {
      values.push(filter.customerId);
      conds.push(`o.customer_id = $${values.length}`);
    }
    if (filter.status?.length) {
      values.push(filter.status);
      conds.push(`o.status = ANY($${values.length}::app.order_status[])`);
    }
    if (filter.since) {
      values.push(filter.since);
      conds.push(`o.created_at >= $${values.length}`);
    }
    if (filter.cursor) {
      // Cursor = "<created_at ISO>|<id>" of the last row seen; keyset pagination, no OFFSET.
      const [ts, id] = filter.cursor.split('|');
      values.push(ts, id);
      conds.push(
        `(o.created_at, o.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(filter.limit + 1);
    const r = await pgOf(tx).query<OrderRow & { created_at: Date }>(
      `${ORDER_SELECT.replace('o.version,', 'o.version, o.created_at,')}
       ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
       ORDER BY o.created_at DESC, o.id DESC LIMIT $${values.length}`,
      values,
    );
    const rows = r.rows.slice(0, filter.limit);
    const last = rows[rows.length - 1];
    const hasMore = r.rows.length > filter.limit;
    return {
      orders: rows.map(orderOf),
      nextCursor: hasMore && last ? `${last.created_at.toISOString()}|${last.id}` : null,
    };
  }

  async listExpiredAwaitingPayment(tx: Tx, now: Date, limit: number): Promise<Order[]> {
    const r = await pgOf(tx).query<OrderRow>(
      `${ORDER_SELECT} WHERE o.status = 'AWAITING_PAYMENT' AND o.payment_expires_at < $1
       ORDER BY o.payment_expires_at LIMIT $2`,
      [now, limit],
    );
    return r.rows.map(orderOf);
  }

  async countRecentByCustomer(tx: Tx, customerId: string, since: Date): Promise<number> {
    const r = await pgOf(tx).query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.orders WHERE customer_id = $1 AND created_at >= $2`,
      [customerId, since],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async countUnpaidPending(tx: Tx, customerId: string): Promise<number> {
    const r = await pgOf(tx).query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.orders WHERE customer_id = $1 AND status IN ('PLACED','AWAITING_PAYMENT')`,
      [customerId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async countToday(tx: Tx, dayStartUtc: Date): Promise<number> {
    const r = await pgOf(tx).query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.orders WHERE created_at >= $1 AND status NOT IN ('CANCELLED','EXPIRED')`,
      [dayStartUtc],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
}
