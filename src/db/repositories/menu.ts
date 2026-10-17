import { notFound } from '../../core/domain/errors.js';
import type { GeoJsonPolygon } from '../../core/domain/geo.js';
import { kobo } from '../../core/domain/money.js';
import type {
  DeliveryZone,
  MenuCategory,
  MenuItem,
  MenuRepository,
  Tx,
  ZoneRepository,
} from '../../core/ports/index.js';
import { pgOf } from '../client.js';

interface ZoneRow {
  id: string;
  name: string;
  fee_kobo: string;
  min_order_kobo: string;
  eta_minutes: number;
  polygon: GeoJsonPolygon;
  active: boolean;
}

const zoneOf = (r: ZoneRow): DeliveryZone => ({
  id: r.id,
  name: r.name,
  feeKobo: kobo(r.fee_kobo),
  minOrderKobo: kobo(r.min_order_kobo),
  etaMinutes: r.eta_minutes,
  polygon: r.polygon,
  active: r.active,
});

export class PgZoneRepository implements ZoneRepository {
  async listActive(tx: Tx): Promise<DeliveryZone[]> {
    const r = await pgOf(tx).query<ZoneRow>(
      `SELECT id, name, fee_kobo, min_order_kobo, eta_minutes, polygon, active
       FROM app.delivery_zones WHERE active ORDER BY sort_order, name`,
    );
    return r.rows.map(zoneOf);
  }
  async findById(tx: Tx, id: string): Promise<DeliveryZone | null> {
    const r = await pgOf(tx).query<ZoneRow>(
      `SELECT id, name, fee_kobo, min_order_kobo, eta_minutes, polygon, active
       FROM app.delivery_zones WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? zoneOf(r.rows[0]) : null;
  }
}

interface CategoryRow {
  id: string;
  name: string;
  sort_order: number;
  active: boolean;
}

interface ItemRow {
  id: string;
  category_id: string;
  slug: string;
  name: string;
  description: string | null;
  price_kobo: string;
  photo_ref: string | null;
  prep_minutes: number;
  aliases: string[];
  active: boolean;
  available: number | null;
  variants: { id: string; name: string; price_delta_kobo: string; active: boolean }[] | null;
  addons: { id: string; name: string; price_kobo: string; active: boolean }[] | null;
}

function signedInt(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`not an integer: ${v}`);
  return n;
}

const itemOf = (r: ItemRow): MenuItem => ({
  id: r.id,
  categoryId: r.category_id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  priceKobo: kobo(r.price_kobo),
  photoRef: r.photo_ref,
  prepMinutes: r.prep_minutes,
  aliases: r.aliases,
  active: r.active,
  available: r.available,
  variants: (r.variants ?? []).map((v) => ({
    id: v.id,
    name: v.name,
    priceDeltaKobo: signedInt(v.price_delta_kobo),
    active: v.active,
  })),
  addons: (r.addons ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    priceKobo: kobo(a.price_kobo),
    active: a.active,
  })),
});

// One query, variants and add-ons aggregated as JSON, availability computed from inventory.
const ITEM_SELECT = `
  SELECT i.id, i.category_id, i.slug, i.name, i.description, i.price_kobo, i.photo_ref,
         i.prep_minutes, i.aliases, i.active,
         CASE WHEN inv.track THEN inv.on_hand - inv.reserved ELSE NULL END AS available,
         (SELECT json_agg(json_build_object('id', v.id, 'name', v.name, 'price_delta_kobo', v.price_delta_kobo::text, 'active', v.active) ORDER BY v.sort_order)
            FROM app.menu_variants v WHERE v.item_id = i.id) AS variants,
         (SELECT json_agg(json_build_object('id', a.id, 'name', a.name, 'price_kobo', a.price_kobo::text, 'active', a.active) ORDER BY a.sort_order)
            FROM app.menu_addons a WHERE a.item_id = i.id) AS addons
  FROM app.menu_items i
  LEFT JOIN app.inventory inv ON inv.item_id = i.id
  WHERE i.deleted_at IS NULL`;

export class PgMenuRepository implements MenuRepository {
  async listCategories(tx: Tx, opts: { includeInactive?: boolean } = {}): Promise<MenuCategory[]> {
    const r = await pgOf(tx).query<CategoryRow>(
      `SELECT id, name, sort_order, active FROM app.menu_categories
       ${opts.includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, name`,
    );
    return r.rows.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sort_order,
      active: c.active,
    }));
  }

  async listItems(
    tx: Tx,
    opts: { categoryId?: string; includeInactive?: boolean } = {},
  ): Promise<MenuItem[]> {
    const conds: string[] = [];
    const values: unknown[] = [];
    if (opts.categoryId) {
      values.push(opts.categoryId);
      conds.push(`i.category_id = $${values.length}`);
    }
    if (!opts.includeInactive) conds.push('i.active');
    const r = await pgOf(tx).query<ItemRow>(
      `${ITEM_SELECT} ${conds.length ? `AND ${conds.join(' AND ')}` : ''} ORDER BY i.sort_order, i.name`,
      values,
    );
    return r.rows.map(itemOf);
  }

  async findItem(tx: Tx, id: string): Promise<MenuItem | null> {
    const r = await pgOf(tx).query<ItemRow>(`${ITEM_SELECT} AND i.id = $1`, [id]);
    return r.rows[0] ? itemOf(r.rows[0]) : null;
  }

  async findItemsByIds(tx: Tx, ids: string[]): Promise<MenuItem[]> {
    if (ids.length === 0) return [];
    const r = await pgOf(tx).query<ItemRow>(`${ITEM_SELECT} AND i.id = ANY($1::uuid[])`, [ids]);
    return r.rows.map(itemOf);
  }

  async updateItem(
    tx: Tx,
    id: string,
    patch: Partial<
      Pick<MenuItem, 'name' | 'description' | 'priceKobo' | 'active' | 'prepMinutes' | 'photoRef'>
    >,
  ): Promise<MenuItem> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, v: unknown): void => {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.priceKobo !== undefined) push('price_kobo', patch.priceKobo);
    if (patch.active !== undefined) push('active', patch.active);
    if (patch.prepMinutes !== undefined) push('prep_minutes', patch.prepMinutes);
    if (patch.photoRef !== undefined) push('photo_ref', patch.photoRef);
    if (sets.length > 0) {
      values.push(id);
      const r = await pgOf(tx).query(
        `UPDATE app.menu_items SET ${sets.join(', ')} WHERE id = $${values.length} AND deleted_at IS NULL`,
        values,
      );
      if ((r.rowCount ?? 0) === 0) throw notFound('menu item', id);
    }
    const item = await this.findItem(tx, id);
    if (!item) throw notFound('menu item', id);
    return item;
  }
}
