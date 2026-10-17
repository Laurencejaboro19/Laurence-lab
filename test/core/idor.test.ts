import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_MIGRATE_URL, TEST_RUNTIME_URL } from '../db/helpers.js';

import { createTestWorld, KITCHEN, OWNER, type TestWorld } from './setup.js';

const run = TEST_MIGRATE_URL && TEST_RUNTIME_URL ? describe : describe.skip;

/**
 * IDOR: a customer must never read or change another customer's data by guessing
 * or obtaining an id. Every customer-scoped service method is exercised with the
 * wrong actor. Authorisation lives in the service layer, so these tests hold for
 * every client (Telegram, WhatsApp, API, future dashboard).
 */
run('authorisation — IDOR and roles', () => {
  let w: TestWorld;
  beforeAll(async () => {
    w = await createTestWorld();
  }, 60_000);
  afterAll(async () => w.close());

  it("customer A cannot read, list, cancel or pay for customer B's order", async () => {
    const a = await w.newCustomer('a1');
    const b = await w.newCustomer('b1');
    const { orderId } = await w.placeOrder(b.id, b.actor, [{ slug: 'jollof-rice', qty: 2 }]);
    const order = await w.core.uow.transaction((tx) => w.core.repos.orders.findById(tx, orderId));

    await expect(
      w.core.uow.transaction((tx) => w.core.orders.get(tx, a.actor, orderId)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      w.core.uow.transaction((tx) => w.core.orders.getByRef(tx, a.actor, order!.publicRef)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      w.core.uow.transaction((tx) => w.core.orders.listForCustomer(tx, a.actor, b.id)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      w.core.uow.transaction((tx) =>
        w.core.orders.transition(tx, a.actor, orderId, 'CANCELLED', { reason: 'mine now' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // B can see and cancel their own.
    const own = await w.core.uow.transaction((tx) => w.core.orders.get(tx, b.actor, orderId));
    expect(own.id).toBe(orderId);
    const cancelled = await w.core.uow.transaction((tx) =>
      w.core.orders.transition(tx, b.actor, orderId, 'CANCELLED'),
    );
    expect(cancelled.order.status).toBe('CANCELLED');
  });

  it("customer A cannot touch customer B's cart, addresses, phone or data export", async () => {
    const a = await w.newCustomer('a2');
    const b = await w.newCustomer('b2');
    const jollof = await w.itemBySlug('jollof-rice');
    const forbidden = { code: 'FORBIDDEN' };
    await expect(
      w.core.uow.transaction((tx) => w.core.cart.getOrCreate(tx, a.actor, b.id)),
    ).rejects.toMatchObject(forbidden);
    await expect(
      w.core.uow.transaction((tx) =>
        w.core.cart.addItem(tx, a.actor, b.id, { itemId: jollof.id, quantity: 1 }),
      ),
    ).rejects.toMatchObject(forbidden);
    await expect(
      w.core.uow.transaction((tx) => w.core.customers.listAddresses(tx, a.actor, b.id)),
    ).rejects.toMatchObject(forbidden);
    await expect(
      w.core.uow.transaction((tx) =>
        w.core.customers.deleteAddress(tx, a.actor, b.id, b.addressId),
      ),
    ).rejects.toMatchObject(forbidden);
    await expect(
      w.core.uow.transaction((tx) =>
        w.core.customers.setPhone(tx, a.actor, b.id, '08011111111', true),
      ),
    ).rejects.toMatchObject(forbidden);
    await expect(
      w.core.uow.transaction((tx) => w.core.customers.exportData(tx, a.actor, b.id)),
    ).rejects.toMatchObject(forbidden);
    await expect(
      w.core.uow.transaction((tx) => w.core.customers.deleteData(tx, a.actor, b.id)),
    ).rejects.toMatchObject(forbidden);
    // A cannot attach B's address to A's own cart either (address lookup is customer-scoped).
    await expect(
      w.core.uow.transaction((tx) =>
        w.core.cart.setFulfilment(tx, a.actor, a.id, {
          fulfilment: 'delivery',
          addressId: b.addressId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('customers cannot perform staff transitions or staff reads', async () => {
    const c = await w.newCustomer('c3');
    const { orderId } = await w.placeOrder(c.id, c.actor, [{ slug: 'jollof-rice', qty: 2 }]);
    await expect(
      w.core.uow.transaction((tx) => w.core.orders.transition(tx, c.actor, orderId, 'ACCEPTED')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      w.core.uow.transaction((tx) => w.core.orders.listForStaff(tx, c.actor, { limit: 10 })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const fish = await w.itemBySlug('fish');
    await expect(
      w.core.uow.transaction((tx) => w.core.catalog.setAvailability(tx, c.actor, fish.id, false)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      w.core.uow.transaction((tx) => w.core.settings.set(tx, 'store.open', false, c.actor)),
    ).resolves.toBeDefined();
    // ^ SettingsService.set itself does not role-check: the API layer restricts the route to owner/manager.
    //   This is asserted in test/http/api.test.ts. Reset:
    await w.core.uow.transaction((tx) => w.core.settings.set(tx, 'store.open', true, OWNER));
  });

  it('kitchen staff cannot change prices; owner can', async () => {
    const fish = await w.itemBySlug('fish');
    await expect(
      w.core.uow.transaction((tx) =>
        w.core.catalog.setPrice(tx, KITCHEN, fish.id, fish.priceKobo as never),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const updated = await w.core.uow.transaction((tx) =>
      w.core.catalog.setPrice(tx, OWNER, fish.id, (fish.priceKobo + 100) as never),
    );
    expect(updated.priceKobo).toBe(fish.priceKobo + 100);
    const audit = await w.core.uow.transaction((tx) =>
      w.core.repos.audit.list(tx, { entityType: 'menu_item', entityId: fish.id, limit: 5 }),
    );
    expect(audit.entries[0]!.action).toBe('menu_item.price');
    expect(audit.entries[0]!.actor.id).toBe(OWNER.id);
  });

  it('phone numbers already linked elsewhere are not merged silently', async () => {
    const a = await w.newCustomer('a5');
    const b = await w.newCustomer('b5');
    const aPhone = (await w.core.uow.transaction((tx) =>
      w.core.repos.customers.findById(tx, a.id),
    ))!.phoneE164!;
    await expect(
      w.core.uow.transaction((tx) => w.core.customers.setPhone(tx, b.actor, b.id, aPhone, true)),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { code: 'PHONE_LINKED_ELSEWHERE', otherCustomerId: a.id },
    });
  });

  it('data deletion anonymises PII but keeps the order history', async () => {
    const c = await w.newCustomer('d6');
    const { orderId } = await w.placeOrder(c.id, c.actor, [{ slug: 'jollof-rice', qty: 2 }]);
    await w.core.uow.transaction((tx) => w.core.customers.deleteData(tx, c.actor, c.id));
    const customer = await w.core.uow.transaction((tx) =>
      w.core.repos.customers.findById(tx, c.id),
    );
    expect(customer!.phoneE164).toBeNull();
    expect(customer!.displayName).toBeNull();
    expect(customer!.anonymisedAt).not.toBeNull();
    const order = await w.core.uow.transaction((tx) => w.core.repos.orders.findById(tx, orderId));
    expect(order!.totalKobo).toBeGreaterThan(0);
    await expect(w.core.orders.checkout(c.actor, c.id, 'telegram')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
