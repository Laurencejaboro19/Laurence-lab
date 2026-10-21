import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_MIGRATE_URL, TEST_RUNTIME_URL } from '../db/helpers.js';

import { createTestWorld, KITCHEN, OWNER, SYSTEM, naira, type TestWorld } from './setup.js';

const run = TEST_MIGRATE_URL && TEST_RUNTIME_URL ? describe : describe.skip;

run('checkout and the money path', () => {
  let w: TestWorld;
  beforeAll(async () => {
    w = await createTestWorld();
  }, 60_000);
  afterAll(async () => w.close());

  it('prices the cart from the menu and zone, creates the order, reserves stock, starts payment', async () => {
    const c = await w.newCustomer();
    const jollof = await w.itemBySlug('jollof-rice');
    const chicken = await w.itemBySlug('chicken');

    const quote = await w.core.uow.transaction(async (tx) => {
      await w.core.cart.addItem(tx, c.actor, c.id, { itemId: jollof.id, quantity: 2 });
      await w.core.cart.addItem(tx, c.actor, c.id, { itemId: chicken.id, quantity: 1 });
      await w.core.cart.setFulfilment(tx, c.actor, c.id, {
        fulfilment: 'delivery',
        addressId: c.addressId,
      });
      return w.core.cart.quote(tx, c.actor, c.id);
    });
    expect(quote.problems).toEqual([]);
    expect(quote.totals!.subtotalKobo).toBe(2 * jollof.priceKobo + chicken.priceKobo);
    expect(quote.totals!.deliveryFeeKobo).toBe(naira(500)); // Zone A
    expect(quote.totals!.totalKobo).toBe(quote.totals!.subtotalKobo + naira(500));

    const result = await w.core.orders.checkout(c.actor, c.id, 'telegram');
    expect(result.order.status).toBe('AWAITING_PAYMENT');
    expect(result.order.publicRef).toMatch(/^LL-/);
    expect(result.paymentUrl).toContain(result.paymentReference);
    expect(result.order.items).toHaveLength(2);
    expect(result.order.items[0]!.nameSnapshot).toBe('Jollof Rice');

    // Stock reserved, not consumed.
    const stock = await w.core.uow.transaction((tx) => w.core.repos.menu.findItem(tx, jollof.id));
    expect(stock!.available).toBe(60 - 2);

    // Paystack was asked for exactly the order total, in kobo, with our reference.
    const init = w.gateway.initialised.at(-1)!;
    expect(init.amountKobo).toBe(result.order.totalKobo);
    expect(init.metadata['order_ref']).toBe(result.order.publicRef);

    // Cart is empty again and an event went out after commit.
    const cart = await w.core.uow.transaction((tx) => w.core.cart.getOrCreate(tx, c.actor, c.id));
    expect(cart.lines).toEqual([]);
    expect(w.events.ofType('order.payment_initialised').at(-1)?.orderId).toBe(result.order.id);
    expect(w.events.ofType('order.transitioned').map((e) => e.to)).toContain('AWAITING_PAYMENT');
  });

  it('refuses checkout when an item is out of stock and leaves no reservation behind', async () => {
    const c = await w.newCustomer();
    const turkey = await w.itemBySlug('turkey'); // seeded with 20
    await w.core.uow.transaction(async (tx) => {
      await w.core.catalog.adjustStock(tx, OWNER, {
        itemId: turkey.id,
        delta: -19,
        kind: 'adjust',
        note: 'test',
      });
      await w.core.cart.addItem(tx, c.actor, c.id, { itemId: turkey.id, quantity: 1 });
      await w.core.cart.setFulfilment(tx, c.actor, c.id, {
        fulfilment: 'delivery',
        addressId: c.addressId,
      });
    });
    // The last portion is wasted between quote and checkout.
    await w.core.uow.transaction((tx) =>
      w.core.catalog.adjustStock(tx, OWNER, {
        itemId: turkey.id,
        delta: -1,
        kind: 'waste',
        note: 'dropped',
      }),
    );
    await expect(w.core.orders.checkout(c.actor, c.id, 'telegram')).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const item = await w.core.uow.transaction((tx) => w.core.repos.menu.findItem(tx, turkey.id));
    expect(item!.available).toBe(0);
    expect(w.gateway.initialised.find((i) => i.metadata['customer_id'] === c.id)).toBeUndefined();
  });

  it('cancels the order and releases stock when the payment provider is down', async () => {
    const c = await w.newCustomer();
    const fish = await w.itemBySlug('fish');
    await w.core.uow.transaction(async (tx) => {
      await w.core.cart.addItem(tx, c.actor, c.id, { itemId: fish.id, quantity: 3 });
      await w.core.cart.setFulfilment(tx, c.actor, c.id, { fulfilment: 'pickup' });
    });
    w.gateway.failInitialise = true;
    try {
      await expect(w.core.orders.checkout(c.actor, c.id, 'telegram')).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });
    } finally {
      w.gateway.failInitialise = false;
    }
    const orders = await w.core.uow.transaction((tx) =>
      w.core.orders.listForCustomer(tx, c.actor, c.id),
    );
    expect(orders.orders[0]!.status).toBe('CANCELLED');
    const item = await w.core.uow.transaction((tx) => w.core.repos.menu.findItem(tx, fish.id));
    expect(item!.available).toBe(30);
  });

  it('enforces the zone minimum order, the phone requirement and opening hours', async () => {
    const c = await w.newCustomer();
    const water = await w.itemBySlug('bottled-water');
    await w.core.uow.transaction(async (tx) => {
      await w.core.cart.addItem(tx, c.actor, c.id, { itemId: water.id, quantity: 1 });
      await w.core.cart.setFulfilment(tx, c.actor, c.id, {
        fulfilment: 'delivery',
        addressId: c.addressId,
      });
    });
    await expect(w.core.orders.checkout(c.actor, c.id, 'telegram')).rejects.toMatchObject({
      code: 'MINIMUM_ORDER',
    });

    w.clock.closed();
    await expect(w.core.orders.checkout(c.actor, c.id, 'telegram')).rejects.toMatchObject({
      code: 'STORE_CLOSED',
    });
    w.clock.reset();

    await w.core.uow.transaction((tx) => w.core.settings.set(tx, 'store.open', false, OWNER));
    await expect(w.core.orders.checkout(c.actor, c.id, 'telegram')).rejects.toMatchObject({
      code: 'STORE_CLOSED',
    });
    await w.core.uow.transaction((tx) => w.core.settings.set(tx, 'store.open', true, OWNER));
  });

  it('caps unpaid pending orders per customer', async () => {
    const c = await w.newCustomer();
    await w.placeOrder(c.id, c.actor, [{ slug: 'jollof-rice', qty: 2 }]);
    await w.placeOrder(c.id, c.actor, [{ slug: 'jollof-rice', qty: 2 }]);
    await expect(
      w.placeOrder(c.id, c.actor, [{ slug: 'jollof-rice', qty: 2 }]),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('runs the kitchen lifecycle with role checks and commits stock on payment', async () => {
    const c = await w.newCustomer();
    const jollof = await w.itemBySlug('jollof-rice');
    const before = (await w.core.uow.transaction((tx) =>
      w.core.repos.menu.findItem(tx, jollof.id),
    ))!;
    const { orderId, reference } = await w.placeOrder(c.id, c.actor, [
      { slug: 'jollof-rice', qty: 3 },
    ]);

    // Kitchen cannot accept an unpaid order.
    await expect(
      w.core.uow.transaction((tx) => w.core.orders.transition(tx, KITCHEN, orderId, 'ACCEPTED')),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    w.gateway.willVerify(reference, { status: 'success' });
    expect(await w.core.payments.verifyAndSettle(reference, SYSTEM)).toBe('paid');

    const after = await w.core.uow.transaction((tx) => w.core.repos.menu.findItem(tx, jollof.id));
    expect(after!.available).toBe(before.available! - 3);
    const raw = await w.core.uow.transaction((tx) => w.core.repos.orders.findById(tx, orderId));
    expect(raw!.status).toBe('PAID');
    expect(raw!.paidAt).not.toBeNull();

    // Dispatch may not accept; kitchen may.
    const dispatch = { type: 'staff' as const, id: 'd', role: 'dispatch' as const };
    await expect(
      w.core.uow.transaction((tx) => w.core.orders.transition(tx, dispatch, orderId, 'ACCEPTED')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const to of ['ACCEPTED', 'PREPARING', 'READY'] as const) {
      const r = await w.core.uow.transaction((tx) =>
        w.core.orders.transition(tx, KITCHEN, orderId, to),
      );
      expect(r.order.status).toBe(to);
    }
    expect(w.events.ofType('delivery.requested').some((e) => e.orderId === orderId)).toBe(true);
    const r = await w.core.uow.transaction((tx) =>
      w.core.orders.transition(tx, dispatch, orderId, 'DISPATCHED'),
    );
    expect(r.order.status).toBe('DISPATCHED');
    // Same status again is a no-op, not an error.
    const again = await w.core.uow.transaction((tx) =>
      w.core.orders.transition(tx, dispatch, orderId, 'DISPATCHED'),
    );
    expect(again.changed).toBe(false);
    const done = await w.core.uow.transaction((tx) =>
      w.core.orders.transition(tx, dispatch, orderId, 'DELIVERED'),
    );
    expect(done.order.status).toBe('DELIVERED');

    const history = await w.core.uow.transaction((tx) =>
      w.core.repos.audit.list(tx, { entityType: 'order', entityId: orderId, limit: 20 }),
    );
    expect(history.entries.map((e) => e.action)).toContain('order.transition');
    expect((await w.core.uow.transaction((tx) => w.core.repos.audit.verify(tx))).ok).toBe(true);
  });

  it('expires unpaid orders and releases their stock', async () => {
    const c = await w.newCustomer();
    const moi = await w.itemBySlug('moi-moi');
    const before = (await w.core.uow.transaction((tx) => w.core.repos.menu.findItem(tx, moi.id)))!;
    const { orderId } = await w.placeOrder(c.id, c.actor, [{ slug: 'moi-moi', qty: 4 }]);
    const during = await w.core.uow.transaction((tx) => w.core.repos.menu.findItem(tx, moi.id));
    expect(during!.available).toBe(before.available! - 4);

    w.clock.advance(16 * 60_000);
    const n = await w.core.uow.transaction((tx) => w.core.orders.expireOverdue(tx));
    expect(n).toBeGreaterThanOrEqual(1);
    const order = await w.core.uow.transaction((tx) => w.core.repos.orders.findById(tx, orderId));
    expect(order!.status).toBe('EXPIRED');
    const after = await w.core.uow.transaction((tx) => w.core.repos.menu.findItem(tx, moi.id));
    expect(after!.available).toBe(before.available);
    w.clock.reset();
  });
});
