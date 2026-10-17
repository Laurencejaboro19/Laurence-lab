/**
 * Pure pricing maths. Given priced lines, a delivery fee and an optional promo,
 * produce the totals that go on the order. No I/O, fully unit-tested.
 */
import { DomainError } from './errors.js';
import { add, kobo, min, multiply, percentOf, subtract, ZERO, type Kobo } from './money.js';

export interface PricedAddon {
  name: string;
  priceKobo: Kobo;
}

export interface PricedLine {
  itemId: string;
  name: string;
  variantName?: string;
  unitPriceKobo: Kobo; // base price + variant delta
  addons: PricedAddon[];
  quantity: number;
}

export interface Promo {
  code: string;
  kind: 'percent' | 'fixed';
  value: number; // percent or kobo
  minOrderKobo: Kobo;
  maxDiscountKobo?: Kobo;
}

export interface LineTotal extends PricedLine {
  lineTotalKobo: Kobo;
}

export interface OrderTotals {
  lines: LineTotal[];
  subtotalKobo: Kobo;
  deliveryFeeKobo: Kobo;
  discountKobo: Kobo;
  totalKobo: Kobo;
}

export function lineTotal(line: PricedLine): Kobo {
  const addons = line.addons.reduce<Kobo>((acc, a) => add(acc, a.priceKobo), ZERO);
  return multiply(add(line.unitPriceKobo, addons), line.quantity);
}

/**
 * Discount applies to the food subtotal only, never to the delivery fee, and is
 * capped at the subtotal (a promo can make food free, never pay the customer).
 */
export function promoDiscount(subtotal: Kobo, promo: Promo | undefined): Kobo {
  if (!promo) return ZERO;
  if (subtotal < promo.minOrderKobo) {
    throw new DomainError('PROMO_INVALID', `promo ${promo.code} needs a minimum order`, {
      minOrderKobo: promo.minOrderKobo,
    });
  }
  let discount: Kobo =
    promo.kind === 'percent' ? percentOf(subtotal, promo.value) : kobo(promo.value);
  if (promo.maxDiscountKobo !== undefined) discount = min(discount, promo.maxDiscountKobo);
  return min(discount, subtotal);
}

export function computeTotals(
  lines: PricedLine[],
  deliveryFeeKobo: Kobo,
  promo?: Promo,
): OrderTotals {
  if (lines.length === 0) throw new DomainError('VALIDATION', 'order has no lines');
  const priced = lines.map((l) => ({ ...l, lineTotalKobo: lineTotal(l) }));
  const subtotalKobo = priced.reduce<Kobo>((acc, l) => add(acc, l.lineTotalKobo), ZERO);
  const discountKobo = promoDiscount(subtotalKobo, promo);
  const totalKobo = add(subtract(subtotalKobo, discountKobo), deliveryFeeKobo);
  return { lines: priced, subtotalKobo, deliveryFeeKobo, discountKobo, totalKobo };
}
