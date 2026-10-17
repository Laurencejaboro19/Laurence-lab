/**
 * Payment settlement, reconciliation and refunds.
 *
 * The rule that protects the money: an order becomes PAID only after WE call the
 * gateway's verify endpoint and the answer matches what we asked for — status
 * success, same amount in kobo, currency NGN, same reference. A webhook is only a
 * hint that we should verify now. Anything that does not match becomes a
 * payment_flag for a human instead of a silent PAID.
 *
 * Cases handled (each has a test in test/core/payments.test.ts):
 *   duplicate webhook          → payment_events dedupe, second call is a no-op
 *   out-of-order / late verify → state machine refuses re-paying a PAID order
 *   underpayment / overpayment → flag, order stays AWAITING_PAYMENT (under) or is PAID + flagged (over)
 *   wrong currency             → flag, not PAID
 *   payment after expiry       → payment recorded as `late`, flag, admin decides (refund or fulfil)
 *   double payment (2 refs)    → second success recorded, flagged `duplicate`, auto-refund queued
 *   unknown reference          → flag `reference_unknown`
 *   missed webhook             → reconcilePending() verifies initialised payments older than N minutes
 */
import { createHash } from 'node:crypto';

import { DomainError, notFound } from '../domain/errors.js';
import { kobo, type Kobo } from '../domain/money.js';
import type {
  Actor,
  AuditRepository,
  Clock,
  EventBus,
  OrderRepository,
  Payment,
  PaymentGateway,
  PaymentRepository,
  PaymentVerification,
  Refund,
  Tx,
  UnitOfWork,
} from '../ports/index.js';

import type { OrderService } from './orders.js';

export type SettleOutcome =
  | 'paid'
  | 'already_paid'
  | 'not_successful'
  | 'underpaid'
  | 'currency_mismatch'
  | 'late'
  | 'duplicate'
  | 'unknown_reference'
  | 'order_not_payable';

export interface ProviderEvent {
  provider: 'paystack';
  eventType: string; // charge.success, refund.processed, …
  reference: string | null;
  /** Already redacted by the webhook route: no authorization/card objects. */
  payloadRedacted: Record<string, unknown>;
}

export class PaymentService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly payments: PaymentRepository,
    private readonly orders: OrderRepository,
    private readonly orderService: OrderService,
    private readonly gateway: PaymentGateway,
    private readonly audit: AuditRepository,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  /** Stable id for providers (like Paystack) whose webhooks carry no event id. */
  static eventId(event: ProviderEvent): string {
    const data = event.payloadRedacted['data'] as Record<string, unknown> | undefined;
    const scalar = (v: unknown): string =>
      typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    const material = [
      event.eventType,
      event.reference ?? '',
      scalar(data?.['id']),
      scalar(data?.['status']),
    ].join('|');
    return createHash('sha256').update(material).digest('hex').slice(0, 32);
  }

  /**
   * Called by the worker for every webhook. Dedupes, then for charge.success
   * verifies and settles. Other event types are recorded for the audit trail.
   * Returns the outcome so the job can log it; never throws for business cases.
   */
  async processProviderEvent(
    event: ProviderEvent,
  ): Promise<{ deduped: boolean; outcome?: SettleOutcome }> {
    const externalEventId = PaymentService.eventId(event);
    const fresh = await this.uow.transaction((tx) =>
      this.payments.recordEvent(tx, {
        provider: event.provider,
        externalEventId,
        eventType: event.eventType,
        ...(event.reference ? { reference: event.reference } : {}),
        payloadRedacted: event.payloadRedacted,
      }),
    );
    if (!fresh) return { deduped: true };

    let outcome: SettleOutcome | undefined;
    if (event.eventType === 'charge.success' && event.reference) {
      outcome = await this.verifyAndSettle(event.reference, { type: 'provider', id: 'paystack' });
    }
    await this.uow.transaction((tx) =>
      this.payments.markEventProcessed(tx, event.provider, externalEventId, outcome ?? 'recorded'),
    );
    return { deduped: false, ...(outcome ? { outcome } : {}) };
  }

  /**
   * Verify with the gateway (network, outside tx), then settle inside one
   * transaction with the payment and order rows locked.
   */
  async verifyAndSettle(reference: string, actor: Actor): Promise<SettleOutcome> {
    const verification = await this.gateway.verify(reference);
    return this.settle(verification, actor);
  }

  /** Pure DB part of settlement; exported for tests that feed a verification directly. */
  async settle(v: PaymentVerification, actor: Actor): Promise<SettleOutcome> {
    return this.uow.transaction(async (tx) => {
      const payment = await this.payments.findByReference(tx, v.reference);
      if (!payment) {
        await this.payments.flag(tx, {
          kind: 'reference_unknown',
          details: { reference: v.reference, amountKobo: v.amountKobo },
        });
        await this.events.publish(tx, {
          type: 'payment.flagged',
          kind: 'reference_unknown',
          details: { reference: v.reference },
        });
        return 'unknown_reference';
      }
      if (payment.status === 'success') return 'already_paid';

      if (v.status !== 'success') {
        if (v.status === 'failed' || v.status === 'abandoned') {
          await this.payments.update(tx, payment.id, {
            status: v.status,
            providerStatus: v.status,
          });
        }
        return 'not_successful';
      }

      const order = await this.orders.lockForUpdate(tx, payment.orderId);
      if (!order) throw notFound('order', payment.orderId);

      // REVIEW: the amount/currency checks. Never mark PAID on a mismatch.
      if (v.currency !== payment.currency) {
        await this.payments.update(tx, payment.id, {
          status: 'mismatch',
          paidAmountKobo: v.amountKobo,
          providerTxId: v.providerTxId,
          paidCurrency: v.currency,
          providerStatus: v.status,
        });
        await this.flagAndNotify(tx, order.id, payment.id, 'currency', {
          expected: payment.currency,
          got: v.currency,
        });
        return 'currency_mismatch';
      }
      if (v.amountKobo < payment.amountKobo) {
        await this.payments.update(tx, payment.id, {
          status: 'mismatch',
          paidAmountKobo: v.amountKobo,
          providerTxId: v.providerTxId,
          providerStatus: v.status,
        });
        await this.flagAndNotify(tx, order.id, payment.id, 'underpaid', {
          expectedKobo: payment.amountKobo,
          paidKobo: v.amountKobo,
        });
        return 'underpaid';
      }

      const alreadyPaid = await this.payments.findSuccessfulForOrder(tx, order.id);
      if (alreadyPaid && alreadyPaid.id !== payment.id) {
        // A second successful charge for the same order (customer paid twice). Record it,
        // flag it, and queue an automatic refund of the duplicate.
        await this.payments.update(tx, payment.id, {
          status: 'success',
          paidAmountKobo: v.amountKobo,
          providerTxId: v.providerTxId,
          verifiedAt: this.clock.now(),
          providerStatus: v.status,
          ...(v.channel ? { providerChannel: v.channel } : {}),
        });
        await this.flagAndNotify(tx, order.id, payment.id, 'duplicate', {
          firstPaymentId: alreadyPaid.id,
          amountKobo: v.amountKobo,
        });
        await this.payments.createRefund(tx, {
          orderId: order.id,
          paymentId: payment.id,
          amountKobo: v.amountKobo,
          reason: 'duplicate payment',
          requestedBy: 'system:payments',
          idempotencyKey: `dup:${payment.id}`,
        });
        return 'duplicate';
      }

      if (order.status !== 'AWAITING_PAYMENT') {
        // Money arrived for an order that already expired/was cancelled. Keep the money
        // visible, never resurrect the order automatically.
        await this.payments.update(tx, payment.id, {
          status: 'late',
          paidAmountKobo: v.amountKobo,
          providerTxId: v.providerTxId,
          verifiedAt: this.clock.now(),
          providerStatus: v.status,
          ...(v.channel ? { providerChannel: v.channel } : {}),
        });
        await this.flagAndNotify(tx, order.id, payment.id, 'late', {
          orderStatus: order.status,
          amountKobo: v.amountKobo,
        });
        return order.status === 'EXPIRED' || order.status === 'CANCELLED'
          ? 'late'
          : 'order_not_payable';
      }

      await this.payments.update(tx, payment.id, {
        status: 'success',
        paidAmountKobo: v.amountKobo,
        providerTxId: v.providerTxId,
        verifiedAt: this.clock.now(),
        providerStatus: v.status,
        ...(v.channel ? { providerChannel: v.channel } : {}),
      });
      await this.orderService.transition(
        tx,
        { type: 'system', id: `payment:${actor.id}` },
        order.id,
        'PAID',
      );
      if (v.amountKobo > payment.amountKobo) {
        await this.flagAndNotify(tx, order.id, payment.id, 'overpaid', {
          expectedKobo: payment.amountKobo,
          paidKobo: v.amountKobo,
        });
      }
      return 'paid';
    });
  }

  /** Scheduler: heal missed webhooks by verifying payments still `initialised`. */
  async reconcilePending(
    olderThanMinutes = 2,
    limit = 50,
  ): Promise<{ checked: number; outcomes: Record<string, number> }> {
    const cutoff = new Date(this.clock.now().getTime() - olderThanMinutes * 60_000);
    const pending = await this.uow.transaction((tx) =>
      this.payments.listPendingInitialised(tx, cutoff, limit),
    );
    const outcomes: Record<string, number> = {};
    for (const p of pending) {
      let outcome: string;
      try {
        outcome = await this.verifyAndSettle(p.reference, { type: 'system', id: 'reconcile' });
      } catch (err) {
        outcome = `error:${err instanceof Error ? err.message : 'unknown'}`;
      }
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    return { checked: pending.length, outcomes };
  }

  /**
   * Executes a pending refund against the gateway. Called by the refund job
   * (phase 7) and by the admin "retry refund" action. Idempotent: a refund that
   * already left `pending` is not sent again.
   */
  async executeRefund(refundId: string, actor: Actor): Promise<Refund> {
    const claimed = await this.uow.transaction(async (tx) => {
      const refund = await this.findRefund(tx, refundId);
      if (refund.status !== 'pending' && refund.status !== 'failed')
        return { refund, send: false as const };
      const payment = await this.payments.findById(tx, refund.paymentId);
      if (!payment?.providerTxId)
        throw new DomainError('PAYMENT_MISMATCH', 'payment has no provider transaction id');
      const updated = await this.payments.updateRefund(tx, refund.id, {
        status: 'processing',
        approvedBy: `${actor.type}:${actor.id}`,
      });
      return { refund: updated, send: true as const, providerTxId: payment.providerTxId };
    });
    if (!claimed.send) return claimed.refund;

    let result: Awaited<ReturnType<PaymentGateway['refund']>>;
    try {
      result = await this.gateway.refund({
        providerTxId: claimed.providerTxId,
        amountKobo: claimed.refund.amountKobo,
        reason: claimed.refund.reason,
        idempotencyKey: claimed.refund.idempotencyKey,
      });
    } catch (err) {
      return this.uow.transaction((tx) =>
        this.payments.updateRefund(tx, refundId, {
          status: 'failed',
          failureReason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return this.uow.transaction(async (tx) => {
      const updated = await this.payments.updateRefund(tx, refundId, {
        status:
          result.status === 'failed'
            ? 'failed'
            : result.status === 'success'
              ? 'success'
              : 'processing',
        providerRef: result.providerRef,
      });
      await this.audit.append(tx, {
        actor,
        action: 'refund.execute',
        entityType: 'order',
        entityId: updated.orderId,
        after: {
          refundId,
          amountKobo: updated.amountKobo,
          status: updated.status,
          providerRef: result.providerRef,
        },
      });
      return updated;
    });
  }

  async getPaymentForOrder(tx: Tx, orderId: string): Promise<Payment | null> {
    return this.payments.findLatestForOrder(tx, orderId);
  }

  private async findRefund(tx: Tx, refundId: string): Promise<Refund> {
    const r = await this.payments.findRefundById(tx, refundId);
    if (!r) throw notFound('refund', refundId);
    return r;
  }

  private async flagAndNotify(
    tx: Tx,
    orderId: string,
    paymentId: string,
    kind: 'underpaid' | 'overpaid' | 'duplicate' | 'late' | 'currency',
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.payments.flag(tx, { orderId, paymentId, kind, details });
    await this.events.publish(tx, { type: 'payment.flagged', orderId, kind, details });
  }
}

export const refundable = (paid: Kobo, refunded: Kobo): Kobo => kobo(Math.max(0, paid - refunded));
