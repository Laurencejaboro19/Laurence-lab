import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/core/index.js';
import { InMemoryEventBus } from '../../src/core/events/in-memory.js';
import type { Actor } from '../../src/core/ports/index.js';
import { createPool, PgUnitOfWork } from '../../src/db/client.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { seed } from '../../src/db/seed.js';
import { buildServer } from '../../src/http/server.js';
import {
  buildMockPaystack,
  signPaystack,
  type MockPaystack,
} from '../../src/providers/payments/mock-server.js';
import { PaystackGateway, redactPaystackPayload } from '../../src/providers/payments/paystack.js';
import { FakeClock } from '../core/setup.js';
import { resetDatabase, TEST_MIGRATE_URL, TEST_RUNTIME_URL } from '../db/helpers.js';

const run = TEST_MIGRATE_URL && TEST_RUNTIME_URL ? describe : describe.skip;
const SECRET_KEY = 'sk_test_' + 'a'.repeat(32);
const API_SECRET = 'api-secret-'.padEnd(40, 'x');

/**
 * End-to-end through the REAL PaystackGateway, pointed at the local mock server:
 * checkout → authorization_url on the mock → customer "pays" on the mock page →
 * mock POSTs a signed charge.success webhook to our app → we verify with the
 * mock → order PAID. Also: bad signature, duplicate delivery, replay sweep.
 */
run('paystack: real gateway against the local mock, webhook route', () => {
  let app: FastifyInstance;
  let mock: MockPaystack;
  let core: Core;
  let pool: ReturnType<typeof createPool>;
  let appUrl: string;
  let mockUrl: string;

  async function waitFor(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out waiting');
  }

  async function newCustomerWithCart(): Promise<{ id: string; actor: Actor }> {
    return core.uow.transaction(async (tx) => {
      const n = Math.floor(Math.random() * 1e9);
      const { customer } = await core.customers.identify(tx, {
        channel: 'telegram',
        externalUserId: `u${n}`,
        externalChatId: `u${n}`,
      });
      const actor: Actor = { type: 'customer', id: customer.id };
      await core.customers.setPhone(
        tx,
        actor,
        customer.id,
        `0803${String(n).padStart(7, '0').slice(0, 7)}`,
        true,
      );
      const items = await core.repos.menu.listItems(tx);
      const jollof = items.find((i) => i.slug === 'jollof-rice')!;
      await core.cart.addItem(tx, actor, customer.id, { itemId: jollof.id, quantity: 2 });
      await core.cart.setFulfilment(tx, actor, customer.id, { fulfilment: 'pickup' });
      return { id: customer.id, actor };
    });
  }

  beforeAll(async () => {
    await resetDatabase();
    const c = new Client({ connectionString: TEST_RUNTIME_URL });
    await c.connect();
    await seed(c);
    await c.end();

    // The app first so the mock knows where to deliver webhooks.
    pool = createPool(TEST_RUNTIME_URL!, { max: 8 });
    const events = new InMemoryEventBus();
    const uow = new PgUnitOfWork(pool, {
      onCommit: (tx) => events.flush(tx),
      onRollback: (tx) => {
        events.discard(tx);
      },
    });
    // Gateway base URL is filled in once the mock is listening; PaystackGateway reads it lazily per call.
    const holder: { url: string } = { url: 'http://127.0.0.1:1' };
    const gateway = new PaystackGateway({
      secretKey: SECRET_KEY,
      baseUrl: 'http://placeholder',
      fetchImpl: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(url.replace('http://placeholder', holder.url), init);
      },
    });
    core = createCore({
      uow,
      repos: createRepositories(),
      gateway,
      events,
      clock: new FakeClock(),
    });
    app = await buildServer({ core, pool, internalApiSecret: API_SECRET, logLevel: 'silent' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    appUrl = `http://127.0.0.1:${String((app.server.address() as { port: number }).port)}`;

    mock = buildMockPaystack({ secretKey: SECRET_KEY, webhookUrl: `${appUrl}/webhooks/paystack` });
    await mock.listen({ port: 0, host: '127.0.0.1' });
    mockUrl = `http://127.0.0.1:${String((mock.server.address() as { port: number }).port)}`;
    holder.url = mockUrl;
  }, 60_000);

  afterAll(async () => {
    await mock.close();
    await app.close();
    await pool.end();
  });

  it('completes checkout → mock checkout page → signed webhook → verify → PAID', async () => {
    const c = await newCustomerWithCart();
    const result = await core.orders.checkout(c.actor, c.id, 'telegram');
    expect(result.paymentUrl.startsWith(`${mockUrl}/pay/`)).toBe(true);
    expect(mock.state.get(result.paymentReference)?.amount).toBe(result.order.totalKobo);

    // The customer taps "Pay" on the checkout page.
    const pay = await fetch(`${mockUrl}/pay/${result.paymentReference}/success`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(pay.status).toBe(302);
    expect(mock.webhooksSent).toHaveLength(1);

    await waitFor(
      async () =>
        (await core.uow.transaction((tx) => core.repos.orders.findById(tx, result.order.id)))!
          .status === 'PAID',
    );
    const payment = await core.uow.transaction((tx) =>
      core.repos.payments.findByReference(tx, result.paymentReference),
    );
    expect(payment!.status).toBe('success');
    expect(payment!.providerTxId).toMatch(/^\d+$/);
  });

  it('rejects a tampered or unsigned webhook before touching the database', async () => {
    const body = JSON.stringify({
      event: 'charge.success',
      data: { reference: 'LL-FAKE-1-AAAAAA', status: 'success', amount: 1 },
    });
    const unsigned = await fetch(`${appUrl}/webhooks/paystack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(unsigned.status).toBe(401);
    const tampered = await fetch(`${appUrl}/webhooks/paystack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-paystack-signature': signPaystack(SECRET_KEY, body + ' '),
      },
      body,
    });
    expect(tampered.status).toBe(401);
    const wrongKey = await fetch(`${appUrl}/webhooks/paystack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-paystack-signature': signPaystack('sk_test_other', body),
      },
      body,
    });
    expect(wrongKey.status).toBe(401);
    const events = await core.uow.transaction((tx) =>
      core.repos.payments.listUnprocessedEvents(tx, new Date(Date.now() + 60_000), 100),
    );
    expect(events.find((e) => e.reference === 'LL-FAKE-1-AAAAAA')).toBeUndefined();
  });

  it('acknowledges a duplicate delivery as deduped and does not process it twice', async () => {
    const c = await newCustomerWithCart();
    const result = await core.orders.checkout(c.actor, c.id, 'telegram');
    const tx = mock.state.get(result.paymentReference)!;
    tx.status = 'success';
    tx.paid_at = new Date().toISOString();
    tx.channel = 'bank_transfer';
    const body = JSON.stringify({
      event: 'charge.success',
      data: {
        id: tx.id,
        status: 'success',
        reference: tx.reference,
        amount: tx.amount,
        currency: 'NGN',
        authorization: { last4: '1234' },
      },
    });
    const headers = {
      'content-type': 'application/json',
      'x-paystack-signature': signPaystack(SECRET_KEY, body),
    };
    const first = await fetch(`${appUrl}/webhooks/paystack`, { method: 'POST', headers, body });
    expect(await first.json()).toEqual({ ok: true, deduped: false });
    const second = await fetch(`${appUrl}/webhooks/paystack`, { method: 'POST', headers, body });
    expect(await second.json()).toEqual({ ok: true, deduped: true });
    await waitFor(
      async () =>
        (await core.uow.transaction((t) => core.repos.orders.findById(t, result.order.id)))!
          .status === 'PAID',
    );
    const transitions = await core.uow.transaction((t) =>
      core.repos.audit.list(t, { entityType: 'order', entityId: result.order.id, limit: 20 }),
    );
    expect(
      transitions.entries.filter(
        (e) => (e.after as { status?: string } | undefined)?.status === 'PAID',
      ),
    ).toHaveLength(1);
  });

  it('the replay sweep finishes an event that was recorded but never processed', async () => {
    const c = await newCustomerWithCart();
    const result = await core.orders.checkout(c.actor, c.id, 'telegram');
    const tx = mock.state.get(result.paymentReference)!;
    tx.status = 'success';
    tx.paid_at = new Date().toISOString();
    // Record only (simulates a crash right after the 200).
    const { deduped } = await core.payments.ingestProviderEvent({
      provider: 'paystack',
      eventType: 'charge.success',
      reference: tx.reference,
      payloadRedacted: {
        event: 'charge.success',
        data: { id: tx.id, status: 'success', reference: tx.reference },
      },
    });
    expect(deduped).toBe(false);
    expect(
      (await core.uow.transaction((t) => core.repos.orders.findById(t, result.order.id)))!.status,
    ).toBe('AWAITING_PAYMENT');
    const replayed = await core.payments.replayUnprocessedEvents(0);
    expect(replayed).toBeGreaterThanOrEqual(1);
    expect(
      (await core.uow.transaction((t) => core.repos.orders.findById(t, result.order.id)))!.status,
    ).toBe('PAID');
  });

  it('redacts card and customer PII from stored payloads', () => {
    const redacted = redactPaystackPayload({
      event: 'charge.success',
      data: {
        reference: 'r',
        authorization: { last4: '4081', bin: '408408' },
        customer: { id: 1, email: 'a@b.c', phone: '0803' },
        log: {},
      },
    });
    expect(redacted).toEqual({
      event: 'charge.success',
      data: { reference: 'r', customer: { id: 1 } },
    });
  });

  it('the real gateway maps an unknown reference to status unknown instead of throwing', async () => {
    const v = await core.gateway.verify('LL-NOPE-9-ZZZZZZ');
    expect(v.status).toBe('unknown');
  });
});
