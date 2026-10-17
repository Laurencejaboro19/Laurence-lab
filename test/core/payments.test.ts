import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { kobo } from '../../src/core/domain/money.js';
import { TEST_MIGRATE_URL, TEST_RUNTIME_URL } from '../db/helpers.js';

import { createTestWorld, KITCHEN, SUPPORT, SYSTEM, type TestWorld } from './setup.js';

const run = TEST_MIGRATE_URL && TEST_RUNTIME_URL ? describe : describe.skip;

run('payment settlement edge cases', () => {
  let w: TestWorld;
  beforeAll(async () => {
    w = await createTestWorld();
  }, 60_000);
  afterAll(async () => w.close());

  async function status(orderId: string) {
    return (await w.core.uow.transaction((tx) => w.core.repos.orders.findById(tx, orderId)))!
      .status;
  }
  async function flags(orderId: string) {
    return w.core.uow.transaction(async (tx) => {
      const r = await (
        tx as unknown as {
          client: { query: (q: string, v: unknown[]) => Promise<{ rows: { kind: string }[] }> };
        }
      ).client.query(`SELECT kind FROM app.payment_flags WHERE order_id = $1 ORDER BY created_at`, [
        orderId,
      ]);
      return r.rows.map((x) => x.kind);
    });
  }

  it('duplicate webhooks are deduped; the second delivery does nothing', async () => {
    const c = await w.newCustomer();
    const { orderId, reference } = await w.placeOrder(c.id, c.actor, [
      { slug: 'jollof-rice', qty: 2 },
    ]);
    w.gateway.willVerify(reference, { status: 'success' });
    const event = {
      provider: 'paystack' as const,
      eventType: 'charge.success',
      reference,
      payloadRedacted: {
        event: 'charge.success',
        data: { id: 1001, status: 'success', reference },
      },
    };
    const first = await w.core.payments.processProviderEvent(event);
    expect(first).toEqual({ deduped: false, outcome: 'paid' });
    const second = await w.core.payments.processProviderEvent(event);
    expect(second).toEqual({ deduped: true });
    expect(await status(orderId)).toBe('PAID');
    expect(
      w.events.ofType('order.transitioned').filter((e) => e.orderId === orderId && e.to === 'PAID'),
    ).toHaveLength(1);
  });

  it('a webhook claiming success is not trusted — verify says pending, order stays unpaid', async () => {
    const c = await w.newCustomer();
    const { orderId, reference } = await w.placeOrder(c.id, c.actor, [
      { slug: 'jollof-rice', qty: 2 },
    ]);
    // No willVerify → mock answers "pending" like a real verify would for an unpaid link.
    const r = await w.core.payments.processProviderEvent({
      provider: 'paystack',
      eventType: 'charge.success',
      reference,
      payloadRedacted: { data: { id: 2, status: 'success' } },
    });
    expect(r.outcome).toBe('not_successful');
    expect(await status(orderId)).toBe('AWAITING_PAYMENT');
  });

  it('underpayment flags and does not mark PAID; overpayment marks PAID and flags', async () => {
    const c = await w.newCustomer();
    const under = await w.placeOrder(c.id, c.actor, [{ slug: 'jollof-rice', qty: 2 }]);
    w.gateway.willVerify(under.reference, { status: 'success', amountKobo: kobo(100) });
    expect(await w.core.payments.verifyAndSettle(under.reference, SYSTEM)).toBe('underpaid');
    expect(await status(under.orderId)).toBe('AWAITING_PAYMENT');
    expect(await flags(under.orderId)).toEqual(['underpaid']);

    const over = await w.placeOrder(c.id, c.actor, [{ slug: 'jollof-rice', qty: 2 }]);
    const init = w.gateway.initialised.find((i) => i.reference === over.reference)!;
    w.gateway.willVerify(over.reference, {
      status: 'success',
      amountKobo: kobo(init.amountKobo + 500),
    });
    expect(await w.core.payments.verifyAndSettle(over.reference, SYSTEM)).toBe('paid');
    expect(await status(over.orderId)).toBe('PAID');
    expect(await flags(over.orderId)).toEqual(['overpaid']);
  });

  it('wrong currency is never accepted', async () => {
    const c = await w.newCustomer();
    const { orderId, reference } = await w.placeOrder(c.id, c.actor, [
      { slug: 'jollof-rice', qty: 2 },
    ]);
    w.gateway.willVerify(reference, { status: 'success', currency: 'USD' });
    expect(await w.core.payments.verifyAndSettle(reference, SYSTEM)).toBe('currency_mismatch');
    expect(await status(orderId)).toBe('AWAITING_PAYMENT');
    expect(await flags(orderId)).toEqual(['currency']);
  });

  it('payment arriving after expiry is recorded as late and flagged; the order is not revived', async () => {
    const c = await w.newCustomer();
    const { orderId, reference } = await w.placeOrder(c.id, c.actor, [
      { slug: 'jollof-rice', qty: 2 },
    ]);
    w.clock.advance(20 * 60_000);
    await w.core.uow.transaction((tx) => w.core.orders.expireOverdue(tx));
    expect(await status(orderId)).toBe('EXPIRED');
    w.gateway.willVerify(reference, { status: 'success' });
    expect(await w.core.payments.verifyAndSettle(reference, SYSTEM)).toBe('late');
    expect(await status(orderId)).toBe('EXPIRED');
    expect(await flags(orderId)).toEqual(['late']);
    const payment = await w.core.uow.transaction((tx) =>
      w.core.repos.payments.findByReference(tx, reference),
    );
    expect(payment!.status).toBe('late');
    expect(
      w.events.ofType('payment.flagged').some((e) => e.orderId === orderId && e.kind === 'late'),
    ).toBe(true);
    w.clock.current = new Date('2026-10-20T11:00:00Z');
  });

  it('unknown references are flagged, not ignored', async () => {
    w.gateway.willVerify('LL-NOPE-1-ZZZZZZ', { status: 'success', amountKobo: kobo(5000) });
    expect(await w.core.payments.verifyAndSettle('LL-NOPE-1-ZZZZZZ', SYSTEM)).toBe(
      'unknown_reference',
    );
  });

  it('reconciliation heals a missed webhook', async () => {
    const c = await w.newCustomer();
    const { orderId, reference } = await w.placeOrder(c.id, c.actor, [
      { slug: 'jollof-rice', qty: 2 },
    ]);
    w.gateway.willVerify(reference, { status: 'success' });
    w.clock.advance(3 * 60_000);
    const r = await w.core.payments.reconcilePending(2);
    expect(r.outcomes['paid']).toBeGreaterThanOrEqual(1);
    expect(await status(orderId)).toBe('PAID');
    w.clock.current = new Date('2026-10-20T11:00:00Z');
  });

  it('rejecting a paid order queues exactly one full refund, then the gateway is called once', async () => {
    const c = await w.newCustomer();
    const { orderId, reference } = await w.placeOrder(c.id, c.actor, [
      { slug: 'jollof-rice', qty: 2 },
    ]);
    w.gateway.willVerify(reference, { status: 'success' });
    await w.core.payments.verifyAndSettle(reference, SYSTEM);

    const r = await w.core.uow.transaction((tx) =>
      w.core.orders.transition(tx, KITCHEN, orderId, 'REJECTED', { reason: 'out of jollof' }),
    );
    expect(r.order.status).toBe('REJECTED');
    const requested = w.events.ofType('refund.requested').filter((e) => e.orderId === orderId);
    expect(requested).toHaveLength(1);
    expect(requested[0]!.amountKobo).toBe(r.order.totalKobo);

    const refund = await w.core.payments.executeRefund(requested[0]!.refundId, SUPPORT);
    expect(refund.status).toBe('success');
    const again = await w.core.payments.executeRefund(requested[0]!.refundId, SUPPORT);
    expect(again.status).toBe('success');
    expect(
      w.gateway.refunds.filter((x) => x.idempotencyKey === refund.idempotencyKey),
    ).toHaveLength(1);
  });

  it('partial refunds are bounded by what was paid minus what was already refunded', async () => {
    const c = await w.newCustomer();
    const { orderId, reference } = await w.placeOrder(c.id, c.actor, [
      { slug: 'jollof-rice', qty: 2 },
    ]);
    w.gateway.willVerify(reference, { status: 'success' });
    await w.core.payments.verifyAndSettle(reference, SYSTEM);
    const order = (await w.core.uow.transaction((tx) =>
      w.core.repos.orders.findById(tx, orderId),
    ))!;

    await expect(
      w.core.uow.transaction((tx) =>
        w.core.orders.transition(tx, SUPPORT, orderId, 'PARTIALLY_REFUNDED', {
          reason: 'missing plantain',
          refundAmountKobo: kobo(order.totalKobo + 1),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const half = kobo(Math.floor(order.totalKobo / 2));
    const r1 = await w.core.uow.transaction((tx) =>
      w.core.orders.transition(tx, SUPPORT, orderId, 'PARTIALLY_REFUNDED', {
        reason: 'missing plantain',
        refundAmountKobo: half,
        idempotencyKey: 'pr-1',
      }),
    );
    expect(r1.order.status).toBe('PARTIALLY_REFUNDED');
    // Then a full refund of the remainder.
    const r2 = await w.core.uow.transaction((tx) =>
      w.core.orders.transition(tx, SUPPORT, orderId, 'REFUNDED', {
        reason: 'customer unhappy',
        idempotencyKey: 'fr-1',
      }),
    );
    expect(r2.order.status).toBe('REFUNDED');
    const total = await w.core.uow.transaction((tx) =>
      w.core.repos.payments.sumRefundedKobo(tx, orderId),
    );
    expect(total).toBe(order.totalKobo);
  });

  it('a second successful charge for the same order is flagged duplicate and auto-refund is queued', async () => {
    const c = await w.newCustomer();
    const { orderId, reference } = await w.placeOrder(c.id, c.actor, [
      { slug: 'jollof-rice', qty: 2 },
    ]);
    w.gateway.willVerify(reference, { status: 'success' });
    await w.core.payments.verifyAndSettle(reference, SYSTEM);
    // Simulate a second payment attempt record for the same order (e.g. customer re-opened an old link).
    const second = await w.core.uow.transaction((tx) =>
      w.core.repos.payments.create(tx, {
        orderId,
        reference: `${reference}-again`,
        amountKobo: kobo(w.gateway.initialised.find((i) => i.reference === reference)!.amountKobo),
        currency: 'NGN',
        authorizationUrl: null,
        mode: 'test',
      }),
    );
    w.gateway.initialised.push({
      reference: second.reference,
      amountKobo: second.amountKobo,
      email: '',
      metadata: {},
    });
    w.gateway.willVerify(second.reference, { status: 'success' });
    expect(await w.core.payments.verifyAndSettle(second.reference, SYSTEM)).toBe('duplicate');
    expect(await flags(orderId)).toEqual(['duplicate']);
    const pending = await w.core.uow.transaction((tx) =>
      w.core.repos.payments.listRefunds(tx, { status: ['pending'], limit: 10 }),
    );
    expect(pending.some((r) => r.orderId === orderId && r.reason === 'duplicate payment')).toBe(
      true,
    );
  });
});
