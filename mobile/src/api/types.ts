/** Mirrors src/http/schemas.ts on the server. Money is always kobo (₦1 = 100). */

export type Language = 'en' | 'pcm';
export type Fulfilment = 'delivery' | 'pickup';

export type OrderStatus =
  | 'PLACED'
  | 'PAID'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY'
  | 'DISPATCHED'
  | 'DELIVERED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'FAILED';

export interface AppConfig {
  brand: string;
  storeOpen: boolean;
  paymentsEnabled: boolean;
  paymentMode: 'test' | 'live';
  paystackPublicKey: string | null;
  currency: 'NGN';
}

export interface Customer {
  id: string;
  displayName: string | null;
  phoneE164: string | null;
  phoneVerifiedAt: string | null;
  language: Language;
  orderCount: number;
  blockedUntil: string | null;
  anonymisedAt: string | null;
}

export interface Session {
  token: string;
  customer: Customer;
  isNew: boolean;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface Address {
  id: string;
  customerId: string;
  label: string;
  textAddress: string | null;
  point: GeoPoint | null;
  zoneId: string | null;
  isDefault: boolean;
  zoneName?: string | null;
}

export interface Zone {
  id: string;
  name: string;
  feeKobo: number;
  minOrderKobo: number;
  etaMinutes: number;
}

export interface MenuVariant {
  id: string;
  name: string;
  priceDeltaKobo: number;
  active: boolean;
}
export interface MenuAddon {
  id: string;
  name: string;
  priceKobo: number;
  active: boolean;
}
export interface MenuItem {
  id: string;
  categoryId: string;
  slug: string;
  name: string;
  description: string | null;
  priceKobo: number;
  photoRef: string | null;
  prepMinutes: number;
  aliases: string[];
  active: boolean;
  variants: MenuVariant[];
  addons: MenuAddon[];
  /** null = not tracked (unlimited) */
  available: number | null;
}
export interface MenuCategory {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  items: MenuItem[];
}

export interface CartLine {
  id: string;
  itemId: string;
  variantId: string | null;
  addonIds: string[];
  quantity: number;
}
export interface Cart {
  id: string;
  customerId: string;
  fulfilment: Fulfilment | null;
  addressId: string | null;
  promoCode: string | null;
  note: string | null;
  lines: CartLine[];
}
export interface PricedLine {
  itemId: string;
  name: string;
  variantName?: string;
  unitPriceKobo: number;
  addons: { name: string; priceKobo: number }[];
  quantity: number;
  lineTotalKobo: number;
}
export interface Totals {
  lines: PricedLine[];
  subtotalKobo: number;
  deliveryFeeKobo: number;
  discountKobo: number;
  totalKobo: number;
}
export interface CartQuote {
  cart: Cart;
  totals: Totals | null;
  address: Address | null;
  zone: Zone | null;
  promo: { code: string; kind: 'percent' | 'fixed'; value: number } | null;
  problems: string[];
}

export interface OrderItem {
  id: string;
  itemId: string | null;
  nameSnapshot: string;
  variantSnapshot: string | null;
  addonsSnapshot: { name: string; price_kobo: number }[];
  unitPriceKobo: number;
  quantity: number;
  lineTotalKobo: number;
}
export interface Order {
  id: string;
  publicRef: string;
  customerId: string;
  channel: 'telegram' | 'whatsapp' | 'app';
  status: OrderStatus;
  fulfilment: Fulfilment;
  addressSnapshot: Record<string, unknown> | null;
  zoneId: string | null;
  subtotalKobo: number;
  deliveryFeeKobo: number;
  discountKobo: number;
  totalKobo: number;
  promoId: string | null;
  customerNote: string | null;
  etaMinutes: number | null;
  paymentExpiresAt: string | null;
  placedAt: string;
  paidAt: string | null;
  version: number;
  items: OrderItem[];
}
export interface Payment {
  id: string;
  orderId: string;
  reference: string;
  amountKobo: number;
  currency: string;
  status: 'initialised' | 'success' | 'failed' | 'abandoned' | 'late' | 'mismatch';
  paidAmountKobo: number | null;
  providerTxId: string | null;
  authorizationUrl: string | null;
  mode: 'test' | 'live';
  verifiedAt: string | null;
}
export interface OrderDetail extends Order {
  payment: Payment | null;
}
export interface CheckoutResult {
  order: Order;
  paymentUrl: string;
  paymentReference: string;
  expiresAt: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId: string };
}

/** The surface both the live client and the offline demo implement. */
export interface LaurenceApi {
  readonly mode: 'live' | 'demo';
  config(): Promise<AppConfig>;
  menu(): Promise<MenuCategory[]>;
  zones(): Promise<Zone[]>;
  session(input: {
    installId: string;
    displayName?: string;
    phone?: string;
    platform?: 'ios' | 'android' | 'web';
  }): Promise<Session>;
  me(): Promise<Customer>;
  updateMe(input: { phone?: string; language?: Language }): Promise<Customer>;
  addresses(): Promise<Address[]>;
  addAddress(input: {
    label?: string;
    textAddress?: string;
    point?: GeoPoint;
    zoneId?: string;
    makeDefault?: boolean;
  }): Promise<Address>;
  deleteAddress(id: string): Promise<void>;
  cart(): Promise<CartQuote>;
  addToCart(input: {
    itemId: string;
    quantity: number;
    variantId?: string;
    addonIds?: string[];
  }): Promise<CartQuote>;
  setLineQuantity(lineId: string, quantity: number): Promise<CartQuote>;
  clearCart(): Promise<CartQuote>;
  setFulfilment(input: {
    fulfilment: Fulfilment;
    addressId?: string;
    note?: string;
  }): Promise<CartQuote>;
  applyPromo(code: string | null): Promise<CartQuote>;
  checkout(): Promise<CheckoutResult>;
  orders(cursor?: string): Promise<Page<Order>>;
  order(id: string): Promise<OrderDetail>;
  cancelOrder(id: string, reason: string): Promise<Order>;
}
