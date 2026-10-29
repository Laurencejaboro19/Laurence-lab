/**
 * Offline demo implementation of the API. Used automatically when the server is
 * unreachable (or has not been migrated yet), so the app can be shown end to end
 * — including a simulated kitchen that moves orders through their lifecycle.
 * Nothing here talks to the network or charges anyone.
 */
import type {
  Address,
  AppConfig,
  CartLine,
  CartQuote,
  CheckoutResult,
  Customer,
  LaurenceApi,
  MenuCategory,
  MenuItem,
  Order,
  OrderDetail,
  OrderStatus,
  Page,
  PricedLine,
  Session,
  Totals,
  Zone,
} from '@/api/types';

import MENU from './menu.json';

const uid = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

const ZONES: Zone[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Zone A — Ugbowo, Ekosodin, Uselu',
    feeKobo: 50_000,
    minOrderKobo: 200_000,
    etaMinutes: 30,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Zone B — GRA, Ring Road, Sapele Road',
    feeKobo: 100_000,
    minOrderKobo: 200_000,
    etaMinutes: 45,
  },
];

const PROMOS: Record<string, { kind: 'percent' | 'fixed'; value: number }> = {
  WELCOME10: { kind: 'percent', value: 10 },
  LAB500: { kind: 'fixed', value: 50_000 },
};

const FLOW: OrderStatus[] = ['PAID', 'ACCEPTED', 'PREPARING', 'READY', 'DISPATCHED', 'DELIVERED'];

const menu = MENU as unknown as MenuCategory[];
const items = new Map<string, MenuItem>();
for (const c of menu) for (const it of c.items) items.set(it.id, it);

interface State {
  customer: Customer;
  addresses: Address[];
  cart: { lines: CartLine[]; fulfilment: 'delivery' | 'pickup' | null; addressId: string | null; note: string | null; promoCode: string | null };
  orders: OrderDetail[];
}

let state: State | null = null;
const timers: ReturnType<typeof setTimeout>[] = [];

function ensure(): State {
  if (!state) {
    state = {
      customer: {
        id: uid(),
        displayName: 'Guest',
        phoneE164: null,
        phoneVerifiedAt: null,
        language: 'en',
        orderCount: 0,
        blockedUntil: null,
        anonymisedAt: null,
      },
      addresses: [],
      cart: { lines: [], fulfilment: null, addressId: null, note: null, promoCode: null },
      orders: [],
    };
  }
  return state;
}

function price(line: CartLine): PricedLine | null {
  const item = items.get(line.itemId);
  if (!item) return null;
  const variant = item.variants.find((v) => v.id === line.variantId);
  const addons = item.addons.filter((a) => line.addonIds.includes(a.id));
  const unit =
    item.priceKobo +
    (variant?.priceDeltaKobo ?? 0) +
    addons.reduce((s, a) => s + a.priceKobo, 0);
  return {
    itemId: item.id,
    name: item.name,
    ...(variant ? { variantName: variant.name } : {}),
    unitPriceKobo: unit,
    addons: addons.map((a) => ({ name: a.name, priceKobo: a.priceKobo })),
    quantity: line.quantity,
    lineTotalKobo: unit * line.quantity,
  };
}

function quote(): CartQuote {
  const s = ensure();
  const lines = s.cart.lines.map(price).filter((l): l is PricedLine => l !== null);
  const address = s.addresses.find((a) => a.id === s.cart.addressId) ?? null;
  const zone = ZONES.find((z) => z.id === address?.zoneId) ?? null;
  const subtotal = lines.reduce((t, l) => t + l.lineTotalKobo, 0);
  const fee = s.cart.fulfilment === 'delivery' && zone ? zone.feeKobo : 0;
  const promo = s.cart.promoCode ? PROMOS[s.cart.promoCode] : undefined;
  const discount = promo
    ? promo.kind === 'percent'
      ? Math.round((subtotal * promo.value) / 100)
      : Math.min(promo.value, subtotal)
    : 0;
  const totals: Totals | null = lines.length
    ? { lines, subtotalKobo: subtotal, deliveryFeeKobo: fee, discountKobo: discount, totalKobo: subtotal + fee - discount }
    : null;
  const problems: string[] = [];
  if (lines.length === 0) problems.push('your cart is empty');
  if (s.cart.fulfilment === null) problems.push('choose delivery or pickup');
  if (s.cart.fulfilment === 'delivery' && !address) problems.push('choose a delivery address');
  if (zone && subtotal < zone.minOrderKobo) problems.push(`minimum order for this area is ₦${zone.minOrderKobo / 100}`);
  return {
    cart: {
      id: 'demo-cart',
      customerId: s.customer.id,
      fulfilment: s.cart.fulfilment,
      addressId: s.cart.addressId,
      promoCode: s.cart.promoCode,
      note: s.cart.note,
      lines: s.cart.lines,
    },
    totals,
    address,
    zone,
    promo: s.cart.promoCode && promo ? { code: s.cart.promoCode, ...promo } : null,
    problems,
  };
}

const delay = <T,>(v: T, ms = 250): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

function advance(orderId: string, step: number): void {
  const s = ensure();
  const o = s.orders.find((x) => x.id === orderId);
  if (!o || ['CANCELLED', 'REJECTED'].includes(o.status)) return;
  const next = FLOW[step];
  if (!next) return;
  if (o.fulfilment === 'pickup' && next === 'DISPATCHED') {
    advance(orderId, step + 1);
    return;
  }
  o.status = next;
  o.version += 1;
  if (next === 'PAID') {
    o.paidAt = new Date().toISOString();
    if (o.payment) {
      o.payment.status = 'success';
      o.payment.paidAmountKobo = o.totalKobo;
      o.payment.verifiedAt = o.paidAt;
    }
  }
  timers.push(setTimeout(() => advance(orderId, step + 1), 12_000 + Math.random() * 8_000));
}

export const demoApi: LaurenceApi = {
  mode: 'demo',
  config: (): Promise<AppConfig> =>
    delay({ brand: 'Laurence Lab', storeOpen: true, paymentsEnabled: true, paymentMode: 'test', paystackPublicKey: null, currency: 'NGN' }, 100),
  menu: () => delay(menu),
  zones: () => delay(ZONES),
  session: ({ displayName, phone }): Promise<Session> => {
    const s = ensure();
    if (displayName) s.customer.displayName = displayName;
    if (phone) s.customer.phoneE164 = phone;
    return delay({ token: 'demo-token', customer: { ...s.customer }, isNew: s.orders.length === 0 });
  },
  me: () => delay({ ...ensure().customer }),
  updateMe: ({ phone, language }) => {
    const s = ensure();
    if (phone !== undefined) s.customer.phoneE164 = phone;
    if (language !== undefined) s.customer.language = language;
    return delay({ ...s.customer });
  },
  addresses: () => delay([...ensure().addresses]),
  addAddress: (input) => {
    const s = ensure();
    const zone = input.zoneId
      ? ZONES.find((z) => z.id === input.zoneId)
      : input.point
        ? ZONES[input.point.latitude >= 6.375 ? 0 : 1]
        : undefined;
    const a: Address = {
      id: uid(),
      customerId: s.customer.id,
      label: input.label?.trim() || `Address ${s.addresses.length + 1}`,
      textAddress: input.textAddress?.trim() || null,
      point: input.point ?? null,
      zoneId: zone?.id ?? null,
      isDefault: input.makeDefault ?? s.addresses.length === 0,
      zoneName: zone?.name ?? null,
    };
    if (a.isDefault) for (const x of s.addresses) x.isDefault = false;
    s.addresses.push(a);
    return delay(a);
  },
  deleteAddress: (id) => {
    const s = ensure();
    s.addresses = s.addresses.filter((a) => a.id !== id);
    if (s.cart.addressId === id) s.cart.addressId = null;
    return delay(undefined);
  },
  cart: () => delay(quote(), 100),
  addToCart: ({ itemId, quantity, variantId, addonIds }) => {
    const s = ensure();
    const same = s.cart.lines.find(
      (l) => l.itemId === itemId && l.variantId === (variantId ?? null) && l.addonIds.join() === (addonIds ?? []).join(),
    );
    if (same) same.quantity = Math.min(50, same.quantity + quantity);
    else s.cart.lines.push({ id: uid(), itemId, variantId: variantId ?? null, addonIds: addonIds ?? [], quantity });
    return delay(quote());
  },
  setLineQuantity: (lineId, quantity) => {
    const s = ensure();
    if (quantity <= 0) s.cart.lines = s.cart.lines.filter((l) => l.id !== lineId);
    else {
      const l = s.cart.lines.find((x) => x.id === lineId);
      if (l) l.quantity = quantity;
    }
    return delay(quote());
  },
  clearCart: () => {
    const s = ensure();
    s.cart = { lines: [], fulfilment: null, addressId: null, note: null, promoCode: null };
    return delay(quote());
  },
  setFulfilment: ({ fulfilment, addressId, note }) => {
    const s = ensure();
    s.cart.fulfilment = fulfilment;
    s.cart.addressId = fulfilment === 'delivery' ? (addressId ?? s.cart.addressId) : null;
    if (note !== undefined) s.cart.note = note || null;
    return delay(quote());
  },
  applyPromo: (code) => {
    const s = ensure();
    if (code === null) s.cart.promoCode = null;
    else if (PROMOS[code.toUpperCase()]) s.cart.promoCode = code.toUpperCase();
    else return Promise.reject(Object.assign(new Error('that code is not valid'), { code: 'INVALID_PROMO', status: 400 }));
    return delay(quote());
  },
  checkout: (): Promise<CheckoutResult> => {
    const s = ensure();
    const q = quote();
    if (q.problems.length || !q.totals)
      return Promise.reject(Object.assign(new Error(q.problems[0] ?? 'cart not ready'), { code: 'CART_NOT_READY', status: 409 }));
    const now = new Date();
    const ref = `LL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const address = q.address;
    const order: OrderDetail = {
      id: uid(),
      publicRef: ref,
      customerId: s.customer.id,
      channel: 'app',
      status: 'PLACED',
      fulfilment: s.cart.fulfilment ?? 'pickup',
      addressSnapshot: address ? { label: address.label, text: address.textAddress, zone: q.zone?.name } : null,
      zoneId: q.zone?.id ?? null,
      subtotalKobo: q.totals.subtotalKobo,
      deliveryFeeKobo: q.totals.deliveryFeeKobo,
      discountKobo: q.totals.discountKobo,
      totalKobo: q.totals.totalKobo,
      promoId: null,
      customerNote: s.cart.note,
      etaMinutes: q.zone?.etaMinutes ?? 20,
      paymentExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      placedAt: now.toISOString(),
      paidAt: null,
      version: 1,
      items: q.totals.lines.map((l) => ({
        id: uid(),
        itemId: l.itemId,
        nameSnapshot: l.name,
        variantSnapshot: l.variantName ?? null,
        addonsSnapshot: l.addons.map((a) => ({ name: a.name, price_kobo: a.priceKobo })),
        unitPriceKobo: l.unitPriceKobo,
        quantity: l.quantity,
        lineTotalKobo: l.lineTotalKobo,
      })),
      payment: {
        id: uid(),
        orderId: '',
        reference: `${ref}-1`,
        amountKobo: q.totals.totalKobo,
        currency: 'NGN',
        status: 'initialised',
        paidAmountKobo: null,
        providerTxId: null,
        authorizationUrl: null,
        mode: 'test',
        verifiedAt: null,
      },
    };
    order.payment!.orderId = order.id;
    s.orders.unshift(order);
    s.customer.orderCount += 1;
    s.cart = { lines: [], fulfilment: null, addressId: null, note: null, promoCode: null };
    // Simulated payment: "paid" a few seconds after the sheet is opened, then the kitchen takes over.
    timers.push(setTimeout(() => advance(order.id, 0), 6_000));
    return delay({ order, paymentUrl: 'demo://paystack', paymentReference: order.payment!.reference, expiresAt: order.paymentExpiresAt! }, 600);
  },
  orders: (): Promise<Page<Order>> => delay({ items: ensure().orders.map(({ payment: _p, ...o }) => o), nextCursor: null }),
  order: (id) => {
    const o = ensure().orders.find((x) => x.id === id);
    return o ? delay({ ...o }, 120) : Promise.reject(Object.assign(new Error('order not found'), { code: 'NOT_FOUND', status: 404 }));
  },
  cancelOrder: (id) => {
    const o = ensure().orders.find((x) => x.id === id);
    if (!o) return Promise.reject(Object.assign(new Error('order not found'), { code: 'NOT_FOUND', status: 404 }));
    if (!['PLACED', 'PAID', 'ACCEPTED'].includes(o.status))
      return Promise.reject(Object.assign(new Error('this order can no longer be cancelled — it is already being prepared'), { code: 'INVALID_TRANSITION', status: 409 }));
    o.status = 'CANCELLED';
    o.version += 1;
    const { payment: _p, ...plain } = o;
    return delay(plain);
  },
};
