import { kobo, type Kobo } from '../../core/domain/money.js';
import type {
  Actor,
  AuditEntry,
  AuditRepository,
  IdempotencyRepository,
  PromoRecord,
  PromoRepository,
  SettingsRepository,
  Tx,
} from '../../core/ports/index.js';
import { pgOf } from '../client.js';

// ---------------------------------------------------------------------------
// Promos
// ---------------------------------------------------------------------------
interface PromoRow {
  id: string;
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
  first_order_only: boolean;
  max_uses: number | null;
  uses: number;
  max_uses_per_customer: number;
  min_order_kobo: string;
  max_discount_kobo: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  active: boolean;
}

export class PgPromoRepository implements PromoRepository {
  async findByCode(tx: Tx, code: string): Promise<PromoRecord | null> {
    const r = await pgOf(tx).query<PromoRow>(
      `SELECT id, code, kind, value, first_order_only, max_uses, uses, max_uses_per_customer,
              min_order_kobo::text, max_discount_kobo::text, starts_at, ends_at, active
       FROM app.promos WHERE code = upper($1) FOR UPDATE`,
      [code],
    );
    const p = r.rows[0];
    if (!p) return null;
    return {
      id: p.id,
      code: p.code,
      kind: p.kind,
      value: p.value,
      firstOrderOnly: p.first_order_only,
      maxUses: p.max_uses,
      uses: p.uses,
      maxUsesPerCustomer: p.max_uses_per_customer,
      minOrderKobo: kobo(p.min_order_kobo),
      maxDiscountKobo: p.max_discount_kobo === null ? null : kobo(p.max_discount_kobo),
      startsAt: p.starts_at,
      endsAt: p.ends_at,
      active: p.active,
    };
  }

  async countRedemptions(tx: Tx, promoId: string, customerId: string): Promise<number> {
    const r = await pgOf(tx).query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.promo_redemptions WHERE promo_id = $1 AND customer_id = $2`,
      [promoId, customerId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async redeem(
    tx: Tx,
    input: { promoId: string; orderId: string; customerId: string; discountKobo: Kobo },
  ): Promise<void> {
    const client = pgOf(tx);
    await client.query(
      `INSERT INTO app.promo_redemptions (promo_id, order_id, customer_id, discount_kobo) VALUES ($1, $2, $3, $4)`,
      [input.promoId, input.orderId, input.customerId, input.discountKobo],
    );
    await client.query(`UPDATE app.promos SET uses = uses + 1 WHERE id = $1`, [input.promoId]);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export class PgSettingsRepository implements SettingsRepository {
  async get(tx: Tx, key: string): Promise<unknown> {
    const r = await pgOf(tx).query<{ value: unknown }>(
      `SELECT value FROM app.settings WHERE key = $1`,
      [key],
    );
    return r.rows[0]?.value;
  }

  async getAll(tx: Tx): Promise<Record<string, unknown>> {
    const r = await pgOf(tx).query<{ key: string; value: unknown }>(
      `SELECT key, value FROM app.settings ORDER BY key`,
    );
    return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  }

  async set(tx: Tx, key: string, value: unknown, changedBy: string): Promise<{ old: unknown }> {
    const client = pgOf(tx);
    const old = await client.query<{ value: unknown }>(
      `SELECT value FROM app.settings WHERE key = $1 FOR UPDATE`,
      [key],
    );
    const json = JSON.stringify(value);
    await client.query(
      `INSERT INTO app.settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, json, changedBy],
    );
    await client.query(
      `INSERT INTO app.settings_history (key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4)`,
      [key, old.rows[0] ? JSON.stringify(old.rows[0].value) : null, json, changedBy],
    );
    return { old: old.rows[0]?.value };
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
interface AuditRow {
  id: string;
  at: Date;
  actor_type: Actor['type'];
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  request_id: string | null;
  hash: string;
}

export class PgAuditRepository implements AuditRepository {
  async append(tx: Tx, entry: AuditEntry): Promise<void> {
    await pgOf(tx).query(
      `INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id, before, after, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.actor.type,
        entry.actor.id,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.actor.requestId ?? null,
      ],
    );
  }

  async list(
    tx: Tx,
    filter: {
      entityType?: string;
      entityId?: string;
      actorId?: string;
      limit: number;
      beforeId?: number;
    },
  ): Promise<{
    entries: (AuditEntry & { id: number; at: Date; hash: string })[];
    nextBeforeId: number | null;
  }> {
    const conds: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, v: unknown): void => {
      values.push(v);
      conds.push(sql.replace('?', `$${values.length}`));
    };
    if (filter.entityType) add('entity_type = ?', filter.entityType);
    if (filter.entityId) add('entity_id = ?', filter.entityId);
    if (filter.actorId) add('actor_id = ?', filter.actorId);
    if (filter.beforeId !== undefined) add('id < ?', filter.beforeId);
    values.push(filter.limit + 1);
    const r = await pgOf(tx).query<AuditRow>(
      `SELECT id::text, at, actor_type, actor_id, action, entity_type, entity_id, before, after, request_id, hash
       FROM app.audit_log ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${values.length}`,
      values,
    );
    const rows = r.rows.slice(0, filter.limit);
    const entries = rows.map((x) => ({
      id: Number(x.id),
      at: x.at,
      hash: x.hash,
      actor: {
        type: x.actor_type,
        id: x.actor_id ?? '',
        ...(x.request_id ? { requestId: x.request_id } : {}),
      },
      action: x.action,
      entityType: x.entity_type,
      ...(x.entity_id ? { entityId: x.entity_id } : {}),
      before: x.before,
      after: x.after,
    }));
    const last = rows[rows.length - 1];
    return { entries, nextBeforeId: r.rows.length > filter.limit && last ? Number(last.id) : null };
  }

  async verify(tx: Tx): Promise<{ ok: boolean; checked: number; firstBadId: number | null }> {
    const r = await pgOf(tx).query<{ ok: boolean; checked: string; first_bad_id: string | null }>(
      `SELECT ok, checked::text, first_bad_id::text FROM app.audit_verify()`,
    );
    const row = r.rows[0];
    if (!row) return { ok: true, checked: 0, firstBadId: null };
    return {
      ok: row.ok,
      checked: Number(row.checked),
      firstBadId: row.first_bad_id === null ? null : Number(row.first_bad_id),
    };
  }
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------
export class PgIdempotencyRepository implements IdempotencyRepository {
  async claim(
    tx: Tx,
    input: { actorKey: string; key: string; requestHash: string },
  ): Promise<
    | { state: 'new' }
    | { state: 'replay'; statusCode: number; body: unknown }
    | { state: 'mismatch' }
    | { state: 'in_progress' }
  > {
    const client = pgOf(tx);
    const ins = await client.query(
      `INSERT INTO app.idempotency_keys (actor_key, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [input.actorKey, input.key, input.requestHash],
    );
    if ((ins.rowCount ?? 0) > 0) return { state: 'new' };
    const r = await client.query<{
      request_hash: string;
      status_code: number | null;
      response_body: unknown;
    }>(
      `SELECT request_hash, status_code, response_body FROM app.idempotency_keys WHERE actor_key = $1 AND key = $2`,
      [input.actorKey, input.key],
    );
    const row = r.rows[0];
    if (!row) return { state: 'new' };
    if (row.request_hash !== input.requestHash) return { state: 'mismatch' };
    if (row.status_code === null) return { state: 'in_progress' };
    return { state: 'replay', statusCode: row.status_code, body: row.response_body };
  }

  async release(tx: Tx, actorKey: string, key: string): Promise<void> {
    await pgOf(tx).query(`DELETE FROM app.idempotency_keys WHERE actor_key = $1 AND key = $2`, [
      actorKey,
      key,
    ]);
  }

  async complete(
    tx: Tx,
    actorKey: string,
    key: string,
    statusCode: number,
    body: unknown,
  ): Promise<void> {
    await pgOf(tx).query(
      `UPDATE app.idempotency_keys SET status_code = $3, response_body = $4 WHERE actor_key = $1 AND key = $2`,
      [actorKey, key, statusCode, JSON.stringify(body ?? null)],
    );
  }
}
