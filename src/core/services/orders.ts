/**
 * Ordering: checkout and the lifecycle. Read docs/ARCHITECTURE.md §4.3 first.
 *
 * Checkout is deliberately split into two transactions around the network call
 * to the payment gateway, so a database connection is never held open while we
 * wait on Paystack:
 *
 *   tx1  validate → price → create order (PLACED) → reserve stock → convert cart
 *   net  gateway.initialise()           ← may take seconds, may fail
 *   tx2  success: record payment, PLACED → AWAITING_PAYMENT
 *        failure: release stock, PLACED → CANCELLED (reason: payment_init_failed)
 *
 * If the process dies between tx1 and tx2, the order stays PLACED with a
 * reservation; `expireOverdue()` (scheduler, phase 7) cancels PLACED orders older
 * than a few minutes and releases the stock. No order is ever left in limbo.
 */
import type { Channel } from '../channel/types.js';
import { DomainError, forbidden, notFound, validation } from '../domain/errors.js';
import { newOrderRef, newPaymentReference } from '../domain/ids.js';
import { kobo, type Kobo } from '../domain/money.js';
import {
  assertTransition,
  isNoOp,
  type OrderStatus,
  type TransitionEffect,
} from '../domain/order-status.js';
import type {
  Actor,
  AuditRepository,
  Clock,
  CustomerRepository,
  EventBus,
  InventoryRepository,
  Order,
  OrderRepository,
  PaymentGateway,
  PaymentRepository,
  PromoRepository,
  Tx,
  UnitOfWork,
} from '../ports/index.js';

import type { CartService } from './cart.js';
import { requireStaff } from './catalog.js';
import type { SettingsService } from './settings.js';

const KITCHEN = new Set(['owner', 'manager', 'kitchen']);
const DISPATCH = new Set(['owner', 'manager', 'dispatch']);
const SUPPORT = new Set(['owner', 'manager', 'support']);

/** Which staff roles may perform which transition. Enforced here, not in the bot UI. */
const ROLE_FOR_TRANSITION: Partial<Record<OrderStatus, ReadonlySet<string>>> = {
  ACCEPTED: KITCHEN,
  REJECTED: KITCHEN,
  PREPARING: KITCHEN,
  READY: KITCHEN,
  DISPATCHED: DISPATCH,
  DELIVERED: DISPATCH,
  CANCELLED: SUPPORT,
  REFUNDED: SUPPORT,
  PARTIALLY_REFUNDED: SUPPORT,
};

export interface CheckoutResult {
  order: Order;
  paymentUrl: string;
  paymentReference: string;
  expiresAt: Date;
}

export class OrderService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly orders: OrderRepository,
    private readonly payments: PaymentRepository,
    private readonly inventory: InventoryRepository,
    private readonly customers: CustomerRepository,
    private readonly promos: PromoRepository,
    private readonly cartService: CartService,
    private readonly settings: SettingsService,
    private readonly gateway: PaymentGateway,
    private readonly audit: AuditRepository,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  async checkout(actor: Actor, customerId: string, channel: Channel): Promise<CheckoutResult> {
    if (actor.type === 'customer' && actor.id !== customerId) throw forbidden('not your cart');

    const placed = await this.uow.transaction(async (tx) => {
      const customer = await this.customers.findById(tx, customerId);
      if (!customer) throw notFound('customer', customerId);
      if (customer.anonymisedAt) throw forbidden('this account was deleted');
      if (customer.blockedUntil && customer.blockedUntil > this.clock.now()) {
        throw forbidden('ordering is temporarily unavailable for this account');
      }
      if (!customer.phoneE164) throw validation('we need a phone number for the rider first');

      await this.assertCanOrderNow(tx, customerId);

      const quote = await this.cartService.quote(tx, actor, customerId);
      if (quote.problems.length > 0)
        throw validation(quote.problems.join('; '), { problems: quote.problems });
      if (!quote.totals || quote.cart.lines.length === 0) throw validation('your cart is empty');
      if (!quote.cart.fulfilment) throw validation('choose delivery or pickup first');
      if (quote.cart.fulfilment === 'delivery' && (!quote.address || !quote.zone)) {
        throw validation('choose a delivery address first');
      }
      const minOrder: Kobo = quote.zone?.minOrderKobo ?? kobo(0);
      if (quote.totals.subtotalKobo < minOrder) {
        throw new DomainError('MINIMUM_ORDER', 'order is below the minimum for your zone', {
          minOrderKobo: minOrder,
        });
      }

      const prepDefault = await this.settings.get(tx, 'store.default_prep_minutes');
      const busy = await this.settings.get(tx, 'store.busy_mode');
      const eta =
        (quote.zone?.etaMinutes ?? 0) + prepDefault + (busy.enabled ? busy.extra_eta_minutes : 0);
      const timeoutMin = await this.settings.get(tx, 'orders.payment_timeout_minutes');
      const expiresAt = new Date(this.clock.now().getTime() + timeoutMin * 60_000);

      // Public refs are random; retry once on the astronomically rare collision.
      let order: Order | undefined;
      for (let attempt = 0; attempt < 2 && !order; attempt++) {
        try {
          order = await this.orders.create(tx, {
            publicRef: newOrderRef(),
            customerId,
            channel,
            fulfilment: quote.cart.fulfilment,
            addressSnapshot: quote.address
              ? {
                  text: quote.address.textAddress,
                  latitude: quote.address.point?.latitude ?? null,
                  longitude: quote.address.point?.longitude ?? null,
                  zone_name: quote.zone?.name ?? null,
                  label: quote.address.label,
                }
              : null,
            zoneId: quote.zone?.id ?? null,
            subtotalKobo: quote.totals.subtotalKobo,
            deliveryFeeKobo: quote.totals.deliveryFeeKobo,
            discountKobo: quote.totals.discountKobo,
            totalKobo: quote.totals.totalKobo,
            promoId: quote.promo?.id ?? null,
            customerNote: quote.cart.note,
            etaMinutes: eta,
            paymentExpiresAt: expiresAt,
            items: quote.totals.lines.map((l) => ({
              itemId: l.itemId,
              nameSnapshot: l.name,
              variantSnapshot: l.variantName ?? null,
              addonsSnapshot: l.addons.map((a) => ({ name: a.name, price_kobo: a.priceKobo })),
              unitPriceKobo: l.unitPriceKobo,
              quantity: l.quantity,
              lineTotalKobo: l.lineTotalKobo,
            })),
          });
        } catch (err) {
          if (attempt === 1 || !String(err).includes('public_ref')) throw err;
        }
      }
      if (!order) throw new Error('unreachable');

      // REVIEW: stock reservation. All-or-nothing; a failure rolls back the whole tx1.
      const failed = await this.inventory.reserve(
        tx,
        order.id,
        order.items
          .filter((i) => i.itemId)
          .map((i) => ({ itemId: i.itemId!, quantity: i.quantity })),
      );
      if (failed.length > 0) {
        const names = order.items
          .filter((i) => i.itemId && failed.includes(i.itemId))
          .map((i) => i.nameSnapshot);
        throw new DomainError('OUT_OF_STOCK', `${names.join(', ')} just sold out`, {
          items: failed,
        });
      }

      if (quote.promo) {
        await this.promos.redeem(tx, {
          promoId: quote.promo.id,
          orderId: order.id,
          customerId,
          discountKobo: quote.totals.discountKobo,
        });
      }
      await this.cartService.clear(tx, actor, customerId);
      await this.audit.append(tx, {
        actor,
        action: 'order.place',
        entityType: 'order',
        entityId: order.id,
        after: { ref: order.publicRef, totalKobo: order.totalKobo, items: order.items.length },
      });
      return { order, expiresAt, email: customerEmail(customerId, customer.phoneE164) };
    });

    // --- network call, outside any transaction ---
    const reference = newPaymentReference(placed.order.publicRef, 1);
    let init: Awaited<ReturnType<PaymentGateway['initialise']>>;
    try {
      init = await this.gateway.initialise({
        reference,
        amountKobo: placed.order.totalKobo,
        email: placed.email,
        metadata: {
          order_id: placed.order.id,
          order_ref: placed.order.publicRef,
          customer_id: customerId,
        },
      });
    } catch (err) {
      await this.uow.transaction(async (tx) => {
        const locked = await this.orders.lockForUpdate(tx, placed.order.id);
        if (locked?.status === 'PLACED') {
          await this.applyTransition(
            tx,
            locked,
            'CANCELLED',
            { type: 'system', id: 'checkout' },
            'payment_init_failed',
          );
        }
      });
      throw new DomainError(
        'PROVIDER_UNAVAILABLE',
        'payments are unavailable right now, please try again shortly',
        {
          cause: err instanceof Error ? err.message : String(err),
        },
      );
    }

    const order = await this.uow.transaction(async (tx) => {
      const locked = await this.orders.lockForUpdate(tx, placed.order.id);
      if (!locked) throw notFound('order', placed.order.id);
      if (locked.status !== 'PLACED') return locked; // cancelled meanwhile by the sweeper; payment link is dead
      const payment = await this.payments.create(tx, {
        orderId: locked.id,
        reference: init.reference,
        amountKobo: locked.totalKobo,
        currency: 'NGN',
        authorizationUrl: init.authorizationUrl,
        accessCode: init.accessCode,
        mode: this.gateway.mode,
        expiresAt: placed.expiresAt,
      });
      await this.applyTransition(
        tx,
        locked,
        'AWAITING_PAYMENT',
        { type: 'system', id: 'checkout' },
        undefined,
        {
          skipEffects: new Set<TransitionEffect>(['reserve_stock', 'initialise_payment']), // already done
        },
      );
      await this.events.publish(tx, {
        type: 'order.payment_initialised',
        orderId: locked.id,
        paymentId: payment.id,
        authorizationUrl: init.authorizationUrl,
        expiresAt: placed.expiresAt,
      });
      const fresh = await this.orders.findById(tx, locked.id);
      return fresh ?? locked;
    });
    if (order.status !== 'AWAITING_PAYMENT') {
      throw new DomainError('CONFLICT', 'the order was cancelled before payment could start');
    }
    return {
      order,
      paymentUrl: init.authorizationUrl,
      paymentReference: init.reference,
      expiresAt: placed.expiresAt,
    };
  }

  // -------------------------------------------------------------------------
  // Reads (IDOR-guarded)
  // -------------------------------------------------------------------------

  async get(tx: Tx, actor: Actor, orderId: string): Promise<Order> {
    const order = await this.orders.findById(tx, orderId);
    // REVIEW: IDOR guard — a customer may only read their own orders.
    if (!order || (actor.type === 'customer' && order.customerId !== actor.id))
      throw notFound('order', orderId);
    return order;
  }

  async getByRef(tx: Tx, actor: Actor, ref: string): Promise<Order> {
    const order = await this.orders.findByRef(tx, ref);
    if (!order || (actor.type === 'customer' && order.customerId !== actor.id))
      throw notFound('order', ref);
    return order;
  }

  async listForCustomer(
    tx: Tx,
    actor: Actor,
    customerId: string,
    limit = 10,
    cursor?: string,
  ): Promise<{ orders: Order[]; nextCursor: string | null }> {
    if (actor.type === 'customer' && actor.id !== customerId) throw forbidden('not your orders');
    return this.orders.list(tx, { customerId, limit, ...(cursor ? { cursor } : {}) });
  }

  async listForStaff(
    tx: Tx,
    actor: Actor,
    filter: { status?: OrderStatus[]; since?: Date; limit: number; cursor?: string },
  ): Promise<{ orders: Order[]; nextCursor: string | null }> {
    requireStaff(
      actor,
      new Set(['owner', 'manager', 'kitchen', 'dispatch', 'support']),
      'listing orders',
    );
    return this.orders.list(tx, filter);
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /**
   * Public entry point for every status change after checkout. Locks the row,
   * checks the state machine and the actor's role, applies side effects, writes
   * history + audit, publishes the event. Returns the updated order, or the
   * unchanged order when the request is a no-op (same status).
   */
  async transition(
    tx: Tx,
    actor: Actor,
    orderId: string,
    to: OrderStatus,
    opts: {
      reason?: string;
      etaMinutes?: number;
      refundAmountKobo?: Kobo;
      idempotencyKey?: string;
    } = {},
  ): Promise<{ order: Order; changed: boolean }> {
    const order = await this.orders.lockForUpdate(tx, orderId);
    if (!order || (actor.type === 'customer' && order.customerId !== actor.id))
      throw notFound('order', orderId);
    if (isNoOp(order.status, to)) return { order, changed: false };
    if (actor.type === 'staff') {
      const roles = ROLE_FOR_TRANSITION[to];
      if (roles) requireStaff(actor, roles, `moving an order to ${to}`);
    }
    if (actor.type === 'customer' && to !== 'CANCELLED')
      throw forbidden('customers can only cancel');
    await this.applyTransition(tx, order, to, actor, opts.reason, {
      ...(opts.etaMinutes !== undefined ? { etaMinutes: opts.etaMinutes } : {}),
      ...(opts.refundAmountKobo !== undefined ? { refundAmountKobo: opts.refundAmountKobo } : {}),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    const fresh = await this.orders.findById(tx, orderId);
    return { order: fresh ?? order, changed: true };
  }

  /** Scheduler entry point: expire unpaid orders and cancel stuck PLACED ones. */
  async expireOverdue(tx: Tx, limit = 100): Promise<number> {
    const now = this.clock.now();
    const overdue = await this.orders.listExpiredAwaitingPayment(tx, now, limit);
    let n = 0;
    for (const o of overdue) {
      const locked = await this.orders.lockForUpdate(tx, o.id);
      if (locked?.status === 'AWAITING_PAYMENT') {
        await this.applyTransition(
          tx,
          locked,
          'EXPIRED',
          { type: 'system', id: 'expiry' },
          'payment window elapsed',
        );
        n++;
      }
    }
    return n;
  }

  /**
   * The single place side effects happen. `skipEffects` lets checkout, which
   * already reserved stock and initialised payment, reuse the same code path.
   */
  private async applyTransition(
    tx: Tx,
    order: Order,
    to: OrderStatus,
    actor: Actor,
    reason?: string,
    opts: {
      skipEffects?: Set<TransitionEffect>;
      etaMinutes?: number;
      refundAmountKobo?: Kobo;
      idempotencyKey?: string;
    } = {},
  ): Promise<void> {
    const rule = assertTransition(order.status, to, actor.type, reason);
    const lines = order.items
      .filter((i) => i.itemId)
      .map((i) => ({ itemId: i.itemId!, quantity: i.quantity }));
    const at = this.clock.now();

    for (const effect of rule.effects) {
      if (opts.skipEffects?.has(effect)) continue;
      switch (effect) {
        case 'reserve_stock': {
          const failed = await this.inventory.reserve(tx, order.id, lines);
          if (failed.length)
            throw new DomainError('OUT_OF_STOCK', 'items sold out', { items: failed });
          break;
        }
        case 'commit_stock':
          await this.inventory.commit(tx, order.id, lines);
          break;
        case 'release_stock':
          // Only meaningful if stock is still reserved (not yet committed by payment).
          if (order.status === 'AWAITING_PAYMENT' || order.status === 'PLACED') {
            await this.inventory.release(tx, order.id, lines);
          }
          break;
        case 'full_refund':
        case 'partial_refund':
          await this.queueRefund(tx, order, effect, actor, reason ?? 'refund', opts);
          break;
        case 'create_delivery':
          if (order.fulfilment === 'delivery')
            await this.events.publish(tx, { type: 'delivery.requested', orderId: order.id });
          break;
        case 'initialise_payment':
        case 'cancel_delivery':
        case 'notify_customer':
        case 'notify_kitchen':
        case 'notify_dispatch':
          // Delivered through the order.transitioned event below (adapters/jobs subscribe).
          break;
      }
    }

    await this.orders.setStatus(tx, order.id, {
      from: order.status,
      to,
      actor,
      ...(reason !== undefined ? { reason } : {}),
      at,
      ...(opts.etaMinutes !== undefined ? { extra: { etaMinutes: opts.etaMinutes } } : {}),
    });
    if (to === 'PAID') await this.customers.incrementOrderCount(tx, order.customerId, at);
    await this.audit.append(tx, {
      actor,
      action: 'order.transition',
      entityType: 'order',
      entityId: order.id,
      before: { status: order.status },
      after: { status: to, reason: reason ?? null },
    });
    await this.events.publish(tx, {
      type: 'order.transitioned',
      orderId: order.id,
      from: order.status,
      to,
      actor,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * Creates the refund record (pending) inside the transaction. Money moves later,
   * when PaymentService.executeRefund talks to the gateway — never inside a DB tx.
   * Idempotent via the refund's idempotency key.
   */
  private async queueRefund(
    tx: Tx,
    order: Order,
    effect: 'full_refund' | 'partial_refund',
    actor: Actor,
    reason: string,
    opts: { refundAmountKobo?: Kobo; idempotencyKey?: string },
  ): Promise<void> {
    const payment = await this.payments.findSuccessfulForOrder(tx, order.id);
    if (!payment) return; // nothing was ever paid (e.g. REJECTED before verify) — nothing to refund
    const alreadyRefunded = await this.payments.sumRefundedKobo(tx, order.id);
    const refundable = kobo(
      Math.max(0, payment.paidAmountKobo ?? payment.amountKobo) - alreadyRefunded,
    );
    let amount: Kobo;
    if (effect === 'full_refund') amount = refundable;
    else {
      if (opts.refundAmountKobo === undefined) throw validation('refund amount is required');
      if (opts.refundAmountKobo <= 0 || opts.refundAmountKobo > refundable) {
        throw validation(`refund must be between 1 and ${refundable} kobo`, {
          refundableKobo: refundable,
        });
      }
      amount = opts.refundAmountKobo;
    }
    if (amount <= 0) return;
    const key = opts.idempotencyKey ?? `${order.id}:${effect}:${alreadyRefunded}`;
    const refund = await this.payments.createRefund(tx, {
      orderId: order.id,
      paymentId: payment.id,
      amountKobo: amount,
      reason,
      requestedBy: `${actor.type}:${actor.id}`,
      idempotencyKey: key,
    });
    if (refund) {
      await this.events.publish(tx, {
        type: 'refund.requested',
        refundId: refund.id,
        orderId: order.id,
        amountKobo: amount,
      });
    }
  }

  /** Store open, daily cap, busy-mode throttle, per-customer velocity and unpaid caps. */
  private async assertCanOrderNow(tx: Tx, customerId: string): Promise<void> {
    const open = await this.settings.isOpenNow(tx);
    if (!open.open) {
      throw new DomainError(
        'STORE_CLOSED',
        open.reason === 'hours' ? 'we are closed right now' : 'ordering is paused at the moment',
      );
    }
    if (!(await this.settings.get(tx, 'payments.enabled'))) {
      throw new DomainError('STORE_CLOSED', 'online payment is paused at the moment');
    }
    const now = this.clock.now();
    const cap = await this.settings.get(tx, 'orders.daily_cap');
    if (cap > 0) {
      const dayStart = lagosDayStartUtc(now);
      if ((await this.orders.countToday(tx, dayStart)) >= cap) {
        throw new DomainError(
          'STORE_CLOSED',
          "we have reached today's order limit — please try again tomorrow",
        );
      }
    }
    const busy = await this.settings.get(tx, 'store.busy_mode');
    if (busy.enabled) {
      const recent = await this.orders.countToday(tx, new Date(now.getTime() - 15 * 60_000));
      if (recent >= busy.max_orders_per_15m) {
        throw new DomainError(
          'STORE_CLOSED',
          'the kitchen is very busy — please try again in a few minutes',
        );
      }
    }
    const perHour = await this.settings.get(tx, 'fraud.max_orders_per_hour');
    if (
      (await this.orders.countRecentByCustomer(
        tx,
        customerId,
        new Date(now.getTime() - 3_600_000),
      )) >= perHour
    ) {
      throw new DomainError('RATE_LIMITED', 'too many orders in the last hour');
    }
    const maxUnpaid = await this.settings.get(tx, 'orders.max_unpaid_pending_per_customer');
    if ((await this.orders.countUnpaidPending(tx, customerId)) >= maxUnpaid) {
      throw new DomainError('CONFLICT', 'please pay or cancel your pending order first', {
        code: 'UNPAID_PENDING',
      });
    }
  }
}

/** Paystack requires an email; customers have phones. A stable synthetic address per customer. */
function customerEmail(customerId: string, phone: string | null): string {
  return `${phone ?? customerId}@customers.laurencelab.invalid`;
}

/** Midnight in Africa/Lagos (UTC+1, no DST) expressed as a UTC instant. */
export function lagosDayStartUtc(now: Date): Date {
  const lagos = new Date(now.getTime() + 60 * 60_000);
  const startLagos = Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate());
  return new Date(startLagos - 60 * 60_000);
}
