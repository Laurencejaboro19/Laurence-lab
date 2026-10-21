import { Client } from 'pg';

import { createCore, type Core } from '../../src/core/index.js';
import { InMemoryEventBus } from '../../src/core/events/in-memory.js';
import { kobo } from '../../src/core/domain/money.js';
import type { Actor, Clock } from '../../src/core/ports/index.js';
import { createPool, PgUnitOfWork } from '../../src/db/client.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { seed } from '../../src/db/seed.js';
import { MockPaymentGateway } from '../../src/providers/payments/mock-gateway.js';
import { resetDatabase, TEST_MIGRATE_URL, TEST_RUNTIME_URL } from '../db/helpers.js';

/**
 * The next Tuesday 12:00 Lagos (11:00Z) strictly after the real "now".
 *
 * Why the future: the services take time from the Clock, but the database stamps
 * `created_at` with its own now(). Sweeps such as "payments initialised more than
 * N minutes ago" compare the two, so the fake clock must never sit *behind* the
 * real one — a fixed past date silently broke those tests the day after it.
 * Why Tuesday noon: the seeded opening hours are open then, and the "closed"
 * cases add 12h30 to land on 00:30 Lagos.
 */
export function nextOpenTuesday(from = new Date()): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 11));
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== 2 || d.getTime() <= from.getTime());
  return d;
}

export class FakeClock implements Clock {
  readonly base: Date;
  current: Date;
  constructor(base: Date = nextOpenTuesday()) {
    this.base = base;
    this.current = new Date(base);
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  /** Back to the open Tuesday noon. */
  reset(): void {
    this.current = new Date(this.base);
  }
  /** 00:30 Lagos the following night — outside opening hours. */
  closed(): void {
    this.current = new Date(this.base.getTime() + 12.5 * 3_600_000);
  }
}

export interface TestWorld {
  core: Core;
  gateway: MockPaymentGateway;
  events: InMemoryEventBus;
  clock: FakeClock;
  close(): Promise<void>;
  /** Creates a customer with a verified phone and a default in-zone address. */
  newCustomer(suffix?: string): Promise<{ id: string; actor: Actor; addressId: string }>;
  itemBySlug(slug: string): Promise<{ id: string; priceKobo: number }>;
  /** Fills the cart and checks out; returns the order and the Paystack reference. */
  placeOrder(
    customerId: string,
    actor: Actor,
    lines: { slug: string; qty: number }[],
  ): Promise<{ orderId: string; reference: string }>;
}

export const SYSTEM: Actor = { type: 'system', id: 'test' };
export const OWNER: Actor = { type: 'staff', id: 'staff-owner', role: 'owner' };
export const KITCHEN: Actor = { type: 'staff', id: 'staff-kitchen', role: 'kitchen' };
export const DISPATCH: Actor = { type: 'staff', id: 'staff-dispatch', role: 'dispatch' };
export const SUPPORT: Actor = { type: 'staff', id: 'staff-support', role: 'support' };

export async function createTestWorld(): Promise<TestWorld> {
  if (!TEST_MIGRATE_URL || !TEST_RUNTIME_URL) throw new Error('DATABASE_URL_TEST* not set');
  await resetDatabase();
  const seedClient = new Client({ connectionString: TEST_RUNTIME_URL });
  await seedClient.connect();
  await seed(seedClient);
  await seedClient.end();

  const pool = createPool(TEST_RUNTIME_URL, { max: 10 });
  const events = new InMemoryEventBus();
  const uow = new PgUnitOfWork(pool, {
    onCommit: (tx) => events.flush(tx),
    onRollback: (tx) => {
      events.discard(tx);
    },
  });
  const gateway = new MockPaymentGateway();
  const clock = new FakeClock();
  const core = createCore({ uow, repos: createRepositories(), gateway, events, clock });

  let n = 0;
  const world: TestWorld = {
    core,
    gateway,
    events,
    clock,
    close: () => pool.end(),
    async newCustomer(suffix = String(++n)) {
      const phone = `0805900${String(++n).padStart(4, '0')}`;
      return uow.transaction(async (tx) => {
        const { customer } = await core.customers.identify(tx, {
          channel: 'telegram',
          externalUserId: `tg-${suffix}`,
          externalChatId: `tg-${suffix}`,
          displayName: `Tester ${suffix}`,
        });
        const actor: Actor = { type: 'customer', id: customer.id };
        await core.customers.setPhone(tx, actor, customer.id, phone, true);
        // Inside Zone A (Ugbowo) from the seed polygon.
        const address = await core.customers.addAddress(tx, actor, customer.id, {
          label: 'Hostel',
          textAddress: 'Hall 3, UNIBEN',
          point: { latitude: 6.4, longitude: 5.61 },
        });
        return { id: customer.id, actor, addressId: address.id };
      });
    },
    async itemBySlug(slug) {
      return uow.transaction(async (tx) => {
        const items = await core.repos.menu.listItems(tx, { includeInactive: true });
        const item = items.find((i) => i.slug === slug);
        if (!item) throw new Error(`no seed item ${slug}`);
        return { id: item.id, priceKobo: item.priceKobo };
      });
    },
    async placeOrder(customerId, actor, lines) {
      await uow.transaction(async (tx) => {
        for (const l of lines) {
          const item = await world.itemBySlug(l.slug);
          await core.cart.addItem(tx, actor, customerId, { itemId: item.id, quantity: l.qty });
        }
        const addresses = await core.customers.listAddresses(tx, actor, customerId);
        await core.cart.setFulfilment(tx, actor, customerId, {
          fulfilment: 'delivery',
          addressId: addresses[0]!.id,
        });
      });
      const result = await core.orders.checkout(actor, customerId, 'telegram');
      return { orderId: result.order.id, reference: result.paymentReference };
    },
  };
  return world;
}

export const naira = (n: number) => kobo(n * 100);
