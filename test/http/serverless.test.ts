import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/core/index.js';
import { InMemoryEventBus } from '../../src/core/events/in-memory.js';
import { createPool, PgUnitOfWork } from '../../src/db/client.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { seed } from '../../src/db/seed.js';
import { buildServer } from '../../src/http/server.js';
import { setupKey } from '../../src/http/serverless.js';
import { MockPaymentGateway } from '../../src/providers/payments/mock-gateway.js';
import { FakeClock } from '../core/setup.js';
import { resetDatabase, TEST_MIGRATE_URL, TEST_RUNTIME_URL } from '../db/helpers.js';

const run = TEST_MIGRATE_URL && TEST_RUNTIME_URL ? describe : describe.skip;
const SECRET = 'api-secret-'.padEnd(40, 'x');

/**
 * Serverless mode: background work must be finished BEFORE the webhook response
 * is sent, because the platform may freeze the process right after.
 */
run('serverless (inline background) mode', () => {
  let app: FastifyInstance;
  let core: Core;
  let gateway: MockPaymentGateway;
  let pool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    await resetDatabase();
    const c = new Client({ connectionString: TEST_RUNTIME_URL });
    await c.connect();
    await seed(c);
    await c.end();
    pool = createPool(TEST_RUNTIME_URL!, { max: 4 });
    const events = new InMemoryEventBus();
    const uow = new PgUnitOfWork(pool, {
      onCommit: (tx) => events.flush(tx),
      onRollback: (tx) => {
        events.discard(tx);
      },
    });
    gateway = new MockPaymentGateway();
    core = createCore({
      uow,
      repos: createRepositories(),
      gateway,
      events,
      clock: new FakeClock(),
    });
    app = await buildServer({
      core,
      pool,
      internalApiSecret: SECRET,
      logLevel: 'silent',
      backgroundMode: 'inline',
    });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('a Paystack webhook is fully settled by the time the 200 is returned', async () => {
    const customer = await core.uow.transaction(async (tx) => {
      const { customer } = await core.customers.identify(tx, {
        channel: 'telegram',
        externalUserId: 'sls1',
        externalChatId: 'sls1',
      });
      const actor = { type: 'customer' as const, id: customer.id };
      await core.customers.setPhone(tx, actor, customer.id, '08031112222', true);
      const items = await core.repos.menu.listItems(tx);
      await core.cart.addItem(tx, actor, customer.id, {
        itemId: items.find((i) => i.slug === 'jollof-rice')!.id,
        quantity: 2,
      });
      await core.cart.setFulfilment(tx, actor, customer.id, { fulfilment: 'pickup' });
      return { id: customer.id, actor };
    });
    const result = await core.orders.checkout(customer.actor, customer.id, 'telegram');
    gateway.willVerify(result.paymentReference, { status: 'success' });
    const body = JSON.stringify({
      event: 'charge.success',
      data: { id: 7, status: 'success', reference: result.paymentReference },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-paystack-signature': gateway.sign(body) },
    });
    expect(res.statusCode).toBe(200);
    // No waiting: the order is already PAID when the response arrives.
    const order = await core.uow.transaction((tx) =>
      core.repos.orders.findById(tx, result.order.id),
    );
    expect(order!.status).toBe('PAID');
  });

  it('derives a stable, URL-safe setup key that is not the secret itself', () => {
    const k = setupKey(SECRET);
    expect(k).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(k).toBe(setupKey(SECRET));
    expect(k).not.toContain(SECRET.slice(0, 8));
  });
});
