/**
 * Menu and inventory use-cases. Customer-facing reads hide inactive items;
 * staff writes are role-checked and audited.
 */
import { forbidden, notFound, validation } from '../domain/errors.js';
import type { Kobo } from '../domain/money.js';
import type {
  Actor,
  AuditRepository,
  EventBus,
  InventoryRepository,
  MenuCategory,
  MenuItem,
  MenuRepository,
  Tx,
} from '../ports/index.js';

const PRICE_ROLES = new Set(['owner', 'manager']);
const STOCK_ROLES = new Set(['owner', 'manager', 'kitchen']);

export function requireStaff(actor: Actor, roles: ReadonlySet<string>, what: string): void {
  if (actor.type === 'system') return;
  if (actor.type !== 'staff' || !actor.role || !roles.has(actor.role)) {
    throw forbidden(`${what} requires one of: ${[...roles].join(', ')}`);
  }
}

export class CatalogService {
  constructor(
    private readonly menu: MenuRepository,
    private readonly inventory: InventoryRepository,
    private readonly audit: AuditRepository,
    private readonly events: EventBus,
  ) {}

  async customerMenu(tx: Tx): Promise<{ categories: (MenuCategory & { items: MenuItem[] })[] }> {
    const categories = await this.menu.listCategories(tx);
    const items = await this.menu.listItems(tx);
    return {
      categories: categories
        .map((c) => ({
          ...c,
          items: items.filter(
            (i) => i.categoryId === c.id && (i.available === null || i.available > 0),
          ),
        }))
        .filter((c) => c.items.length > 0),
    };
  }

  async staffMenu(
    tx: Tx,
    actor: Actor,
  ): Promise<{ categories: (MenuCategory & { items: MenuItem[] })[] }> {
    requireStaff(
      actor,
      new Set(['owner', 'manager', 'kitchen', 'dispatch', 'support']),
      'viewing the full menu',
    );
    const categories = await this.menu.listCategories(tx, { includeInactive: true });
    const items = await this.menu.listItems(tx, { includeInactive: true });
    return {
      categories: categories.map((c) => ({
        ...c,
        items: items.filter((i) => i.categoryId === c.id),
      })),
    };
  }

  async getItem(tx: Tx, id: string): Promise<MenuItem> {
    const item = await this.menu.findItem(tx, id);
    if (!item) throw notFound('menu item', id);
    return item;
  }

  /** Kitchen "sold out" toggle: any kitchen staff, instantly, audited. */
  async setAvailability(tx: Tx, actor: Actor, itemId: string, active: boolean): Promise<MenuItem> {
    requireStaff(actor, STOCK_ROLES, 'changing availability');
    const before = await this.getItem(tx, itemId);
    const after = await this.menu.updateItem(tx, itemId, { active });
    await this.audit.append(tx, {
      actor,
      action: 'menu_item.availability',
      entityType: 'menu_item',
      entityId: itemId,
      before: { active: before.active },
      after: { active },
    });
    return after;
  }

  /** Price change: owner/manager only; the admin bot additionally demands a one-time code. */
  async setPrice(tx: Tx, actor: Actor, itemId: string, priceKobo: Kobo): Promise<MenuItem> {
    requireStaff(actor, PRICE_ROLES, 'changing prices');
    if (priceKobo > 10_000_000_00) throw validation('price is implausibly high');
    const before = await this.getItem(tx, itemId);
    const after = await this.menu.updateItem(tx, itemId, { priceKobo });
    await this.audit.append(tx, {
      actor,
      action: 'menu_item.price',
      entityType: 'menu_item',
      entityId: itemId,
      before: { priceKobo: before.priceKobo },
      after: { priceKobo },
    });
    return after;
  }

  async updateDetails(
    tx: Tx,
    actor: Actor,
    itemId: string,
    patch: {
      name?: string;
      description?: string | null;
      prepMinutes?: number;
      photoRef?: string | null;
    },
  ): Promise<MenuItem> {
    requireStaff(actor, PRICE_ROLES, 'editing menu items');
    const before = await this.getItem(tx, itemId);
    const after = await this.menu.updateItem(tx, itemId, patch);
    await this.audit.append(tx, {
      actor,
      action: 'menu_item.update',
      entityType: 'menu_item',
      entityId: itemId,
      before: {
        name: before.name,
        description: before.description,
        prepMinutes: before.prepMinutes,
      },
      after: patch,
    });
    return after;
  }

  /** Receive / adjust / waste. Positive delta adds stock, negative removes. */
  async adjustStock(
    tx: Tx,
    actor: Actor,
    input: {
      itemId: string;
      delta: number;
      kind: 'receive' | 'adjust' | 'waste' | 'import';
      note?: string;
    },
  ): Promise<{ onHand: number; reserved: number; available: number }> {
    requireStaff(actor, STOCK_ROLES, 'adjusting stock');
    if (!Number.isInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > 10_000) {
      throw validation('delta must be a non-zero integer');
    }
    if (input.kind === 'receive' && input.delta < 0) throw validation('receive must be positive');
    if (input.kind === 'waste' && input.delta > 0) throw validation('waste must be negative');
    const item = await this.getItem(tx, input.itemId);
    const result = await this.inventory.adjust(tx, {
      itemId: input.itemId,
      deltaOnHand: input.delta,
      kind: input.kind,
      actor,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    await this.audit.append(tx, {
      actor,
      action: `inventory.${input.kind}`,
      entityType: 'menu_item',
      entityId: input.itemId,
      after: { delta: input.delta, onHand: result.onHand, note: input.note ?? null },
    });
    const available = result.onHand - result.reserved;
    await this.maybeLowStock(tx, item, available);
    return { ...result, available };
  }

  async setLowStockThreshold(
    tx: Tx,
    actor: Actor,
    itemId: string,
    threshold: number,
  ): Promise<void> {
    requireStaff(actor, STOCK_ROLES, 'setting thresholds');
    if (!Number.isInteger(threshold) || threshold < 0)
      throw validation('threshold must be a non-negative integer');
    await this.getItem(tx, itemId);
    await this.inventory.setThreshold(tx, itemId, threshold);
    await this.audit.append(tx, {
      actor,
      action: 'inventory.threshold',
      entityType: 'menu_item',
      entityId: itemId,
      after: { threshold },
    });
  }

  async lowStock(
    tx: Tx,
    actor: Actor,
  ): Promise<{ itemId: string; name: string; available: number; threshold: number }[]> {
    requireStaff(actor, STOCK_ROLES, 'viewing stock');
    return this.inventory.lowStock(tx);
  }

  private async maybeLowStock(tx: Tx, item: MenuItem, available: number): Promise<void> {
    const low = (await this.inventory.lowStock(tx)).find((l) => l.itemId === item.id);
    if (low)
      await this.events.publish(tx, {
        type: 'inventory.low_stock',
        itemId: item.id,
        name: item.name,
        available,
      });
  }
}
