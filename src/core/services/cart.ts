import { DomainError, forbidden, notFound, validation } from '../domain/errors.js';
import { add, kobo, ZERO, type Kobo } from '../domain/money.js';
import { computeTotals, type OrderTotals, type PricedLine, type Promo } from '../domain/pricing.js';
import type {
  Actor,
  Address,
  Cart,
  CartRepository,
  CustomerRepository,
  DeliveryZone,
  MenuItem,
  MenuRepository,
  PromoRecord,
  PromoRepository,
  Tx,
  ZoneRepository,
} from '../ports/index.js';

import type { SettingsService } from './settings.js';

export interface CartQuote {
  cart: Cart;
  totals: OrderTotals | null;
  address: Address | null;
  zone: DeliveryZone | null;
  promo: PromoRecord | null;
  /** Lines whose item is no longer available; the UI should remove or warn. */
  problems: string[];
}

export function assertOwnCustomer(actor: Actor, customerId: string): void {
  if (actor.type === 'customer' && actor.id !== customerId) throw forbidden('not your cart');
}

/** Price one cart line from the current menu (used both for quotes and at checkout). */
export function priceLine(
  item: MenuItem,
  line: { variantId: string | null; addonIds: string[]; quantity: number },
): PricedLine {
  let unit: Kobo = item.priceKobo;
  let variantName: string | undefined;
  if (line.variantId) {
    const v = item.variants.find((x) => x.id === line.variantId && x.active);
    if (!v) throw validation(`variant not available for ${item.name}`);
    unit = kobo(unit + v.priceDeltaKobo);
    variantName = v.name;
  }
  const addons = line.addonIds.map((id) => {
    const a = item.addons.find((x) => x.id === id && x.active);
    if (!a) throw validation(`add-on not available for ${item.name}`);
    return { name: a.name, priceKobo: a.priceKobo };
  });
  return {
    itemId: item.id,
    name: item.name,
    ...(variantName !== undefined ? { variantName } : {}),
    unitPriceKobo: unit,
    addons,
    quantity: line.quantity,
  };
}

export class CartService {
  constructor(
    private readonly carts: CartRepository,
    private readonly menu: MenuRepository,
    private readonly customers: CustomerRepository,
    private readonly zones: ZoneRepository,
    private readonly promos: PromoRepository,
    private readonly settings: SettingsService,
  ) {}

  async getOrCreate(tx: Tx, actor: Actor, customerId: string): Promise<Cart> {
    assertOwnCustomer(actor, customerId);
    return (
      (await this.carts.findActive(tx, customerId)) ?? (await this.carts.create(tx, customerId))
    );
  }

  async addItem(
    tx: Tx,
    actor: Actor,
    customerId: string,
    input: { itemId: string; quantity: number; variantId?: string; addonIds?: string[] },
  ): Promise<Cart> {
    const cart = await this.getOrCreate(tx, actor, customerId);
    const maxQty = await this.settings.get(tx, 'orders.max_quantity_per_line');
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > maxQty) {
      throw validation(`quantity must be between 1 and ${maxQty}`);
    }
    const item = await this.menu.findItem(tx, input.itemId);
    if (!item?.active) throw notFound('menu item', input.itemId);
    if (item.available !== null && item.available < input.quantity) {
      throw new DomainError('OUT_OF_STOCK', `only ${item.available} ${item.name} left`, {
        itemId: item.id,
        available: item.available,
      });
    }
    // Validate variant/add-ons belong to the item before storing ids.
    priceLine(item, {
      variantId: input.variantId ?? null,
      addonIds: input.addonIds ?? [],
      quantity: input.quantity,
    });
    await this.carts.addLine(tx, cart.id, {
      itemId: item.id,
      variantId: input.variantId ?? null,
      addonIds: input.addonIds ?? [],
      quantity: input.quantity,
    });
    return this.getOrCreate(tx, actor, customerId);
  }

  async setLineQuantity(
    tx: Tx,
    actor: Actor,
    customerId: string,
    lineId: string,
    quantity: number,
  ): Promise<Cart> {
    const cart = await this.getOrCreate(tx, actor, customerId);
    if (quantity <= 0) {
      await this.carts.removeLine(tx, cart.id, lineId);
    } else {
      const maxQty = await this.settings.get(tx, 'orders.max_quantity_per_line');
      if (!Number.isInteger(quantity) || quantity > maxQty)
        throw validation(`quantity must be between 1 and ${maxQty}`);
      const ok = await this.carts.updateLine(tx, cart.id, lineId, quantity);
      if (!ok) throw notFound('cart line', lineId);
    }
    return this.getOrCreate(tx, actor, customerId);
  }

  async clear(tx: Tx, actor: Actor, customerId: string): Promise<Cart> {
    const cart = await this.getOrCreate(tx, actor, customerId);
    await this.carts.clearLines(tx, cart.id);
    return this.carts.update(tx, cart.id, { promoCode: null, note: null });
  }

  async setFulfilment(
    tx: Tx,
    actor: Actor,
    customerId: string,
    input: { fulfilment: 'delivery' | 'pickup'; addressId?: string; note?: string },
  ): Promise<Cart> {
    const cart = await this.getOrCreate(tx, actor, customerId);
    if (
      input.fulfilment === 'pickup' &&
      !(await this.settings.get(tx, 'delivery.pickup_enabled'))
    ) {
      throw validation('pickup is not available right now');
    }
    if (input.fulfilment === 'delivery' && !(await this.settings.get(tx, 'delivery.enabled'))) {
      throw validation('delivery is not available right now');
    }
    let addressId: string | null = null;
    if (input.fulfilment === 'delivery') {
      if (!input.addressId) throw validation('choose a delivery address');
      const address = await this.customers.findAddress(tx, customerId, input.addressId);
      if (!address) throw notFound('address', input.addressId);
      if (!address.zoneId)
        throw new DomainError('OUTSIDE_DELIVERY_AREA', 'that address has no delivery zone');
      addressId = address.id;
    }
    return this.carts.update(tx, cart.id, {
      fulfilment: input.fulfilment,
      addressId,
      ...(input.note !== undefined ? { note: input.note.slice(0, 300) } : {}),
    });
  }

  async applyPromo(
    tx: Tx,
    actor: Actor,
    customerId: string,
    code: string | null,
  ): Promise<CartQuote> {
    const cart = await this.getOrCreate(tx, actor, customerId);
    if (code === null) {
      await this.carts.update(tx, cart.id, { promoCode: null });
      return this.quote(tx, actor, customerId);
    }
    const promo = await this.promos.findByCode(tx, code.trim());
    await this.validatePromo(tx, promo, customerId);
    await this.carts.update(tx, cart.id, { promoCode: code.trim().toUpperCase() });
    return this.quote(tx, actor, customerId);
  }

  /** Current totals for display; never mutates stock. */
  async quote(tx: Tx, actor: Actor, customerId: string): Promise<CartQuote> {
    const cart = await this.getOrCreate(tx, actor, customerId);
    const problems: string[] = [];
    const items = await this.menu.findItemsByIds(
      tx,
      cart.lines.map((l) => l.itemId),
    );
    const priced: PricedLine[] = [];
    for (const line of cart.lines) {
      const item = items.find((i) => i.id === line.itemId);
      if (!item?.active) {
        problems.push(`${item?.name ?? 'an item'} is no longer available`);
        continue;
      }
      if (item.available !== null && item.available < line.quantity) {
        problems.push(`only ${item.available} ${item.name} left`);
      }
      try {
        priced.push(priceLine(item, line));
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    let address: Address | null = null;
    let zone: DeliveryZone | null = null;
    let fee: Kobo = ZERO;
    if (cart.fulfilment === 'delivery' && cart.addressId) {
      address = await this.customers.findAddress(tx, customerId, cart.addressId);
      zone = address?.zoneId ? await this.zones.findById(tx, address.zoneId) : null;
      if (zone) fee = zone.feeKobo;
      else problems.push('delivery address is outside our zones');
    }
    let promo: PromoRecord | null = null;
    let promoForPricing: Promo | undefined;
    if (cart.promoCode) {
      promo = await this.promos.findByCode(tx, cart.promoCode);
      try {
        await this.validatePromo(tx, promo, customerId);
        promoForPricing = promo ? toPromo(promo) : undefined;
      } catch (err) {
        problems.push(err instanceof Error ? err.message : 'promo no longer valid');
        promo = null;
      }
    }
    let totals: OrderTotals | null = null;
    if (priced.length > 0) {
      try {
        totals = computeTotals(priced, fee, promoForPricing);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : 'could not price cart');
      }
    }
    return { cart, totals, address, zone, promo, problems };
  }

  /** Shared promo rules. Throws PROMO_INVALID with a customer-friendly message. */
  async validatePromo(tx: Tx, promo: PromoRecord | null, customerId: string): Promise<void> {
    const bad = (m: string): DomainError => new DomainError('PROMO_INVALID', m);
    if (!promo?.active) throw bad('that promo code is not valid');
    const now = Date.now();
    if (promo.startsAt && promo.startsAt.getTime() > now)
      throw bad('that promo has not started yet');
    if (promo.endsAt && promo.endsAt.getTime() < now) throw bad('that promo has expired');
    if (promo.maxUses !== null && promo.uses >= promo.maxUses)
      throw bad('that promo has been fully used');
    if (promo.firstOrderOnly) {
      const c = await this.customers.findById(tx, customerId);
      if (c && c.orderCount > 0) throw bad('that promo is for first orders only');
    }
    const used = await this.promos.countRedemptions(tx, promo.id, customerId);
    if (used >= promo.maxUsesPerCustomer) throw bad('you have already used that promo');
  }
}

export function toPromo(p: PromoRecord): Promo {
  return {
    code: p.code,
    kind: p.kind,
    value: p.value,
    minOrderKobo: p.minOrderKobo,
    ...(p.maxDiscountKobo !== null ? { maxDiscountKobo: p.maxDiscountKobo } : {}),
  };
}

export const sumQuantities = (lines: { quantity: number }[]): number =>
  lines.reduce((n, l) => n + l.quantity, 0);

export { add as addKobo };
