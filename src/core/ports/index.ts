/**
 * Ports: the interfaces the core depends on. Implementations live outside the
 * core (src/db/repositories, src/providers). Tests supply in-memory or mock
 * implementations. Nothing in here imports pg, fastify or any SDK.
 */
import type { Channel, GeoPoint } from '../channel/types.js';
import type { GeoJsonPolygon } from '../domain/geo.js';
import type { Kobo } from '../domain/money.js';
import type { ActorType, OrderStatus } from '../domain/order-status.js';

// ---------------------------------------------------------------------------
// Unit of work
// ---------------------------------------------------------------------------

/** A handle to run queries inside one transaction. Repositories accept it. */
export interface Tx {
  readonly __tx: true;
}

export interface UnitOfWork {
  /** Run `fn` in a transaction; commit on resolve, roll back on throw. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export interface Actor {
  type: ActorType;
  /** customer id, staff id, job name or provider name */
  id: string;
  /** For staff: the role, used by services to authorise. */
  role?: StaffRole;
  requestId?: string;
}

export type StaffRole = 'owner' | 'manager' | 'kitchen' | 'dispatch' | 'support';

// ---------------------------------------------------------------------------
// Entities (as the core sees them — repositories map rows to these)
// ---------------------------------------------------------------------------

export interface Customer {
  id: string;
  displayName: string | null;
  phoneE164: string | null;
  phoneVerifiedAt: Date | null;
  language: 'en' | 'pcm';
  orderCount: number;
  blockedUntil: Date | null;
  anonymisedAt: Date | null;
}

export interface ChannelIdentity {
  id: string;
  customerId: string;
  channel: Channel;
  externalUserId: string;
  externalChatId: string;
  handle: string | null;
  unreachableAt: Date | null;
}

export interface Address {
  id: string;
  customerId: string;
  label: string;
  textAddress: string | null;
  point: GeoPoint | null;
  zoneId: string | null;
  isDefault: boolean;
}

export interface DeliveryZone {
  id: string;
  name: string;
  feeKobo: Kobo;
  minOrderKobo: Kobo;
  etaMinutes: number;
  polygon: GeoJsonPolygon;
  active: boolean;
}

export interface MenuCategory {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface MenuVariant {
  id: string;
  name: string;
  /** Signed integer kobo: a "Small" variant may be cheaper than the base price. */
  priceDeltaKobo: number;
  active: boolean;
}

export interface MenuAddon {
  id: string;
  name: string;
  priceKobo: Kobo;
  active: boolean;
}

export interface MenuItem {
  id: string;
  categoryId: string;
  slug: string;
  name: string;
  description: string | null;
  priceKobo: Kobo;
  photoRef: string | null;
  prepMinutes: number;
  aliases: string[];
  active: boolean;
  variants: MenuVariant[];
  addons: MenuAddon[];
  /** null when not tracked (unlimited); otherwise on_hand - reserved */
  available: number | null;
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
  fulfilment: 'delivery' | 'pickup' | null;
  addressId: string | null;
  promoCode: string | null;
  note: string | null;
  lines: CartLine[];
}

export interface OrderItem {
  id: string;
  itemId: string | null;
  nameSnapshot: string;
  variantSnapshot: string | null;
  addonsSnapshot: { name: string; price_kobo: number }[];
  unitPriceKobo: Kobo;
  quantity: number;
  lineTotalKobo: Kobo;
}

export interface Order {
  id: string;
  publicRef: string;
  customerId: string;
  channel: Channel;
  status: OrderStatus;
  fulfilment: 'delivery' | 'pickup';
  addressSnapshot: Record<string, unknown> | null;
  zoneId: string | null;
  subtotalKobo: Kobo;
  deliveryFeeKobo: Kobo;
  discountKobo: Kobo;
  totalKobo: Kobo;
  promoId: string | null;
  customerNote: string | null;
  etaMinutes: number | null;
  paymentExpiresAt: Date | null;
  placedAt: Date;
  paidAt: Date | null;
  version: number;
  items: OrderItem[];
}

export interface Payment {
  id: string;
  orderId: string;
  reference: string;
  amountKobo: Kobo;
  currency: string;
  status: 'initialised' | 'success' | 'failed' | 'abandoned' | 'late' | 'mismatch';
  paidAmountKobo: Kobo | null;
  providerTxId: string | null;
  authorizationUrl: string | null;
  mode: 'test' | 'live';
  verifiedAt: Date | null;
}

export interface Refund {
  id: string;
  orderId: string;
  paymentId: string;
  amountKobo: Kobo;
  reason: string;
  status: 'pending' | 'approved' | 'processing' | 'success' | 'failed';
  providerRef: string | null;
  idempotencyKey: string;
}

export interface PromoRecord {
  id: string;
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
  firstOrderOnly: boolean;
  maxUses: number | null;
  uses: number;
  maxUsesPerCustomer: number;
  minOrderKobo: Kobo;
  maxDiscountKobo: Kobo | null;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
}

export interface AuditEntry {
  actor: Actor;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface CustomerRepository {
  findById(tx: Tx, id: string): Promise<Customer | null>;
  findByPhone(tx: Tx, phoneE164: string): Promise<Customer | null>;
  findIdentity(tx: Tx, channel: Channel, externalUserId: string): Promise<ChannelIdentity | null>;
  createWithIdentity(
    tx: Tx,
    input: {
      displayName?: string;
      language?: 'en' | 'pcm';
      identity: Omit<ChannelIdentity, 'id' | 'customerId' | 'unreachableAt'>;
    },
  ): Promise<{ customer: Customer; identity: ChannelIdentity }>;
  update(
    tx: Tx,
    id: string,
    patch: Partial<
      Pick<Customer, 'displayName' | 'phoneE164' | 'phoneVerifiedAt' | 'language' | 'blockedUntil'>
    >,
  ): Promise<Customer>;
  incrementOrderCount(tx: Tx, id: string, at: Date): Promise<void>;
  anonymise(tx: Tx, id: string): Promise<void>;
  listAddresses(tx: Tx, customerId: string): Promise<Address[]>;
  findAddress(tx: Tx, customerId: string, addressId: string): Promise<Address | null>;
  addAddress(tx: Tx, input: Omit<Address, 'id'>): Promise<Address>;
  deleteAddress(tx: Tx, customerId: string, addressId: string): Promise<boolean>;
  identitiesOf(tx: Tx, customerId: string): Promise<ChannelIdentity[]>;
}

export interface ZoneRepository {
  listActive(tx: Tx): Promise<DeliveryZone[]>;
  findById(tx: Tx, id: string): Promise<DeliveryZone | null>;
}

export interface MenuRepository {
  listCategories(tx: Tx, opts?: { includeInactive?: boolean }): Promise<MenuCategory[]>;
  listItems(tx: Tx, opts?: { categoryId?: string; includeInactive?: boolean }): Promise<MenuItem[]>;
  findItem(tx: Tx, id: string): Promise<MenuItem | null>;
  findItemsByIds(tx: Tx, ids: string[]): Promise<MenuItem[]>;
  updateItem(
    tx: Tx,
    id: string,
    patch: Partial<
      Pick<MenuItem, 'name' | 'description' | 'priceKobo' | 'active' | 'prepMinutes' | 'photoRef'>
    >,
  ): Promise<MenuItem>;
}

export interface StockMovement {
  itemId: string;
  quantity: number;
}

export interface InventoryRepository {
  /** Atomically reserve all lines or none. Returns the item ids that could not be reserved (empty = success). */
  reserve(tx: Tx, orderId: string, lines: StockMovement[]): Promise<string[]>;
  commit(tx: Tx, orderId: string, lines: StockMovement[]): Promise<void>;
  release(tx: Tx, orderId: string, lines: StockMovement[]): Promise<void>;
  adjust(
    tx: Tx,
    input: {
      itemId: string;
      deltaOnHand: number;
      kind: 'receive' | 'adjust' | 'waste' | 'import';
      actor: Actor;
      note?: string;
    },
  ): Promise<{ onHand: number; reserved: number }>;
  setThreshold(tx: Tx, itemId: string, threshold: number): Promise<void>;
  lowStock(
    tx: Tx,
  ): Promise<{ itemId: string; name: string; available: number; threshold: number }[]>;
}

export interface CartRepository {
  findActive(tx: Tx, customerId: string): Promise<Cart | null>;
  create(tx: Tx, customerId: string): Promise<Cart>;
  addLine(tx: Tx, cartId: string, line: Omit<CartLine, 'id'>): Promise<CartLine>;
  updateLine(tx: Tx, cartId: string, lineId: string, quantity: number): Promise<boolean>;
  removeLine(tx: Tx, cartId: string, lineId: string): Promise<boolean>;
  clearLines(tx: Tx, cartId: string): Promise<void>;
  update(
    tx: Tx,
    cartId: string,
    patch: Partial<Pick<Cart, 'fulfilment' | 'addressId' | 'promoCode' | 'note'>>,
  ): Promise<Cart>;
  markConverted(tx: Tx, cartId: string): Promise<void>;
}

export interface OrderListFilter {
  customerId?: string;
  status?: OrderStatus[];
  since?: Date;
  limit: number;
  cursor?: string;
}

export interface OrderRepository {
  create(
    tx: Tx,
    input: Omit<Order, 'id' | 'placedAt' | 'paidAt' | 'version' | 'items' | 'status'> & {
      items: Omit<OrderItem, 'id'>[];
    },
  ): Promise<Order>;
  findById(tx: Tx, id: string): Promise<Order | null>;
  findByRef(tx: Tx, publicRef: string): Promise<Order | null>;
  /** SELECT … FOR UPDATE so concurrent transitions serialise on the row. */
  lockForUpdate(tx: Tx, id: string): Promise<Order | null>;
  setStatus(
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
  ): Promise<void>;
  list(tx: Tx, filter: OrderListFilter): Promise<{ orders: Order[]; nextCursor: string | null }>;
  listExpiredAwaitingPayment(tx: Tx, now: Date, limit: number): Promise<Order[]>;
  countRecentByCustomer(tx: Tx, customerId: string, since: Date): Promise<number>;
  countUnpaidPending(tx: Tx, customerId: string): Promise<number>;
  countToday(tx: Tx, dayStartUtc: Date): Promise<number>;
}

export interface PaymentRepository {
  create(
    tx: Tx,
    input: Omit<Payment, 'id' | 'status' | 'paidAmountKobo' | 'providerTxId' | 'verifiedAt'> & {
      accessCode?: string;
      expiresAt?: Date;
    },
  ): Promise<Payment>;
  findById(tx: Tx, id: string): Promise<Payment | null>;
  findByReference(tx: Tx, reference: string): Promise<Payment | null>;
  findLatestForOrder(tx: Tx, orderId: string): Promise<Payment | null>;
  findSuccessfulForOrder(tx: Tx, orderId: string): Promise<Payment | null>;
  update(
    tx: Tx,
    id: string,
    patch: Partial<Pick<Payment, 'status' | 'paidAmountKobo' | 'providerTxId' | 'verifiedAt'>> & {
      providerStatus?: string;
      providerChannel?: string;
      paidCurrency?: string;
    },
  ): Promise<Payment>;
  /** Insert-or-ignore; false means this provider event was already recorded. */
  recordEvent(
    tx: Tx,
    input: {
      provider: string;
      externalEventId: string;
      eventType: string;
      reference?: string;
      payloadRedacted?: unknown;
    },
  ): Promise<boolean>;
  markEventProcessed(
    tx: Tx,
    provider: string,
    externalEventId: string,
    outcome: string,
  ): Promise<void>;
  flag(
    tx: Tx,
    input: {
      orderId?: string;
      paymentId?: string;
      kind: 'underpaid' | 'overpaid' | 'duplicate' | 'late' | 'currency' | 'reference_unknown';
      details: Record<string, unknown>;
    },
  ): Promise<void>;
  createRefund(
    tx: Tx,
    input: {
      orderId: string;
      paymentId: string;
      amountKobo: Kobo;
      reason: string;
      requestedBy: string;
      idempotencyKey: string;
    },
  ): Promise<Refund | null>;
  findRefundByKey(tx: Tx, idempotencyKey: string): Promise<Refund | null>;
  findRefundById(tx: Tx, id: string): Promise<Refund | null>;
  listRefunds(tx: Tx, filter: { status?: Refund['status'][]; limit: number }): Promise<Refund[]>;
  updateRefund(
    tx: Tx,
    id: string,
    patch: Partial<Pick<Refund, 'status' | 'providerRef'>> & {
      failureReason?: string;
      approvedBy?: string;
    },
  ): Promise<Refund>;
  sumRefundedKobo(tx: Tx, orderId: string): Promise<Kobo>;
  listPendingInitialised(tx: Tx, olderThan: Date, limit: number): Promise<Payment[]>;
}

export interface PromoRepository {
  findByCode(tx: Tx, code: string): Promise<PromoRecord | null>;
  countRedemptions(tx: Tx, promoId: string, customerId: string): Promise<number>;
  redeem(
    tx: Tx,
    input: { promoId: string; orderId: string; customerId: string; discountKobo: Kobo },
  ): Promise<void>;
}

export interface SettingsRepository {
  get(tx: Tx, key: string): Promise<unknown>;
  getAll(tx: Tx): Promise<Record<string, unknown>>;
  set(tx: Tx, key: string, value: unknown, changedBy: string): Promise<{ old: unknown }>;
}

export interface AuditRepository {
  append(tx: Tx, entry: AuditEntry): Promise<void>;
  list(
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
  }>;
  verify(tx: Tx): Promise<{ ok: boolean; checked: number; firstBadId: number | null }>;
}

export interface IdempotencyRepository {
  /** Returns the stored response if this key was seen; otherwise claims it. */
  claim(
    tx: Tx,
    input: { actorKey: string; key: string; requestHash: string },
  ): Promise<
    | { state: 'new' }
    | { state: 'replay'; statusCode: number; body: unknown }
    | { state: 'mismatch' }
    | { state: 'in_progress' }
  >;
  complete(tx: Tx, actorKey: string, key: string, statusCode: number, body: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// External providers
// ---------------------------------------------------------------------------

export interface PaymentInitResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface PaymentVerification {
  reference: string;
  status: 'success' | 'failed' | 'abandoned' | 'pending' | 'unknown';
  amountKobo: Kobo;
  currency: string;
  providerTxId: string | null;
  channel: string | null;
  paidAt: Date | null;
}

export interface PaymentGateway {
  readonly name: string;
  readonly mode: 'test' | 'live';
  initialise(input: {
    reference: string;
    amountKobo: Kobo;
    email: string;
    metadata: Record<string, unknown>;
    callbackUrl?: string;
  }): Promise<PaymentInitResult>;
  verify(reference: string): Promise<PaymentVerification>;
  refund(input: {
    providerTxId: string;
    amountKobo: Kobo;
    reason: string;
    idempotencyKey: string;
  }): Promise<{
    providerRef: string;
    status: 'pending' | 'processing' | 'success' | 'failed';
  }>;
  /** Verify a webhook signature over the RAW body. Constant-time inside. */
  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined): boolean;
}

export interface DeliveryQuote {
  feeKobo: Kobo;
  etaMinutes: number;
  quoteRef?: string;
}

export interface DeliveryProvider {
  readonly name: 'manual' | 'kwik' | 'mock';
  quote(input: {
    pickup: GeoPoint;
    dropoff: GeoPoint | null;
    addressText: string | null;
  }): Promise<DeliveryQuote>;
  createTask(input: {
    orderId: string;
    orderRef: string;
    dropoff: GeoPoint | null;
    addressText: string | null;
    customerName: string;
    customerPhone: string;
    quoteRef?: string;
  }): Promise<{
    externalId: string;
    status: 'requested' | 'assigned' | 'no_rider';
    trackingUrl?: string;
  }>;
  cancelTask(externalId: string, reason: string): Promise<void>;
  getStatus(externalId: string): Promise<{
    status:
      | 'requested'
      | 'no_rider'
      | 'assigned'
      | 'picked_up'
      | 'in_transit'
      | 'delivered'
      | 'failed'
      | 'cancelled';
    riderName?: string;
    riderPhone?: string;
    trackingUrl?: string;
    chargedKobo?: Kobo;
  }>;
}

export interface Geocoder {
  readonly name: 'none' | 'google' | 'nominatim';
  geocode(text: string): Promise<{ point: GeoPoint; formatted: string } | null>;
}

/** Domain events the core publishes. Phase 7 moves the bus onto pg-boss. */
export type DomainEvent =
  | {
      type: 'order.transitioned';
      orderId: string;
      from: OrderStatus;
      to: OrderStatus;
      actor: Actor;
      reason?: string;
    }
  | {
      type: 'order.payment_initialised';
      orderId: string;
      paymentId: string;
      authorizationUrl: string;
      expiresAt: Date;
    }
  | { type: 'refund.requested'; refundId: string; orderId: string; amountKobo: Kobo }
  | { type: 'payment.flagged'; orderId?: string; kind: string; details: Record<string, unknown> }
  | { type: 'inventory.low_stock'; itemId: string; name: string; available: number }
  | { type: 'delivery.requested'; orderId: string };

export interface EventBus {
  /** Called inside the unit of work; implementations must be transactional or outbox-based. */
  publish(tx: Tx, event: DomainEvent): Promise<void>;
}
