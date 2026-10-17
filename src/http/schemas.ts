/**
 * Zod schemas shared by the internal API routes. They validate requests and
 * document responses in the generated OpenAPI file. Keep them in one place so
 * the OpenAPI document stays truthful.
 */
import { z } from 'zod';

import { ORDER_STATUSES } from '../core/domain/order-status.js';

export const uuid = z.uuid();
export const koboInt = z.number().int().min(0).describe('Amount in kobo (₦1 = 100)');

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
});

export const Channel = z.enum(['telegram', 'whatsapp']);
export const Language = z.enum(['en', 'pcm']);
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export const StaffRole = z.enum(['owner', 'manager', 'kitchen', 'dispatch', 'support']);

export const Customer = z.object({
  id: uuid,
  displayName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  phoneVerifiedAt: z.coerce.date().nullable(),
  language: Language,
  orderCount: z.number().int(),
  blockedUntil: z.coerce.date().nullable(),
  anonymisedAt: z.coerce.date().nullable(),
});

export const ChannelIdentity = z.object({
  id: uuid,
  customerId: uuid,
  channel: Channel,
  externalUserId: z.string(),
  externalChatId: z.string(),
  handle: z.string().nullable(),
  unreachableAt: z.coerce.date().nullable(),
});

export const GeoPoint = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const Address = z.object({
  id: uuid,
  customerId: uuid,
  label: z.string(),
  textAddress: z.string().nullable(),
  point: GeoPoint.nullable(),
  zoneId: uuid.nullable(),
  isDefault: z.boolean(),
});

export const MenuVariant = z.object({
  id: uuid,
  name: z.string(),
  priceDeltaKobo: z.number().int(),
  active: z.boolean(),
});
export const MenuAddon = z.object({
  id: uuid,
  name: z.string(),
  priceKobo: koboInt,
  active: z.boolean(),
});
export const MenuItem = z.object({
  id: uuid,
  categoryId: uuid,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priceKobo: koboInt,
  photoRef: z.string().nullable(),
  prepMinutes: z.number().int(),
  aliases: z.array(z.string()),
  active: z.boolean(),
  variants: z.array(MenuVariant),
  addons: z.array(MenuAddon),
  available: z.number().int().nullable().describe('null = not tracked (unlimited)'),
});
export const MenuCategory = z.object({
  id: uuid,
  name: z.string(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  items: z.array(MenuItem),
});

export const CartLine = z.object({
  id: uuid,
  itemId: uuid,
  variantId: uuid.nullable(),
  addonIds: z.array(uuid),
  quantity: z.number().int(),
});
export const Cart = z.object({
  id: uuid,
  customerId: uuid,
  fulfilment: z.enum(['delivery', 'pickup']).nullable(),
  addressId: uuid.nullable(),
  promoCode: z.string().nullable(),
  note: z.string().nullable(),
  lines: z.array(CartLine),
});

export const PricedLine = z.object({
  itemId: z.string(),
  name: z.string(),
  variantName: z.string().optional(),
  unitPriceKobo: koboInt,
  addons: z.array(z.object({ name: z.string(), priceKobo: koboInt })),
  quantity: z.number().int(),
  lineTotalKobo: koboInt,
});
export const Totals = z.object({
  lines: z.array(PricedLine),
  subtotalKobo: koboInt,
  deliveryFeeKobo: koboInt,
  discountKobo: koboInt,
  totalKobo: koboInt,
});
export const CartQuote = z.object({
  cart: Cart,
  totals: Totals.nullable(),
  address: Address.nullable(),
  zone: z
    .object({
      id: uuid,
      name: z.string(),
      feeKobo: koboInt,
      minOrderKobo: koboInt,
      etaMinutes: z.number().int(),
    })
    .nullable(),
  promo: z
    .object({ code: z.string(), kind: z.enum(['percent', 'fixed']), value: z.number() })
    .nullable(),
  problems: z.array(z.string()),
});

export const OrderItem = z.object({
  id: uuid,
  itemId: uuid.nullable(),
  nameSnapshot: z.string(),
  variantSnapshot: z.string().nullable(),
  addonsSnapshot: z.array(z.object({ name: z.string(), price_kobo: z.number().int() })),
  unitPriceKobo: koboInt,
  quantity: z.number().int(),
  lineTotalKobo: koboInt,
});
export const Order = z.object({
  id: uuid,
  publicRef: z.string(),
  customerId: uuid,
  channel: Channel,
  status: OrderStatusSchema,
  fulfilment: z.enum(['delivery', 'pickup']),
  addressSnapshot: z.record(z.string(), z.unknown()).nullable(),
  zoneId: uuid.nullable(),
  subtotalKobo: koboInt,
  deliveryFeeKobo: koboInt,
  discountKobo: koboInt,
  totalKobo: koboInt,
  promoId: uuid.nullable(),
  customerNote: z.string().nullable(),
  etaMinutes: z.number().int().nullable(),
  paymentExpiresAt: z.coerce.date().nullable(),
  placedAt: z.coerce.date(),
  paidAt: z.coerce.date().nullable(),
  version: z.number().int(),
  items: z.array(OrderItem),
});

export const Payment = z.object({
  id: uuid,
  orderId: uuid,
  reference: z.string(),
  amountKobo: koboInt,
  currency: z.string(),
  status: z.enum(['initialised', 'success', 'failed', 'abandoned', 'late', 'mismatch']),
  paidAmountKobo: koboInt.nullable(),
  providerTxId: z.string().nullable(),
  authorizationUrl: z.string().nullable(),
  mode: z.enum(['test', 'live']),
  verifiedAt: z.coerce.date().nullable(),
});

export const Refund = z.object({
  id: uuid,
  orderId: uuid,
  paymentId: uuid,
  amountKobo: koboInt,
  reason: z.string(),
  status: z.enum(['pending', 'approved', 'processing', 'success', 'failed']),
  providerRef: z.string().nullable(),
  idempotencyKey: z.string(),
});

export const Paginated = <T extends z.ZodType>(
  item: T,
): z.ZodObject<{ items: z.ZodArray<T>; nextCursor: z.ZodNullable<z.ZodString> }> =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const AuditEntry = z.object({
  id: z.number().int(),
  at: z.coerce.date(),
  hash: z.string(),
  actor: z.object({ type: z.string(), id: z.string(), requestId: z.string().optional() }),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

/**
 * Zod marks optional fields as `T | undefined`; the core's input types use exact
 * optional properties. Dropping undefined keys bridges the two without casts.
 */
export function compact<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

export const IdParam = z.object({ id: uuid });
export const CustomerIdParam = z.object({ id: uuid });
