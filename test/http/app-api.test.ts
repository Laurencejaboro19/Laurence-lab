/**
 * Mobile app API (`/app/v1`): the per-install session, customer pinning, and the
 * order journey the app drives (menu → cart → checkout → track → cancel).
 */
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCore } from '../../src/core/index.js';
import { InMemoryEventBus } from '../../src/core/events/in-memory.js';
import { createPool, PgUnitOfWork } from '../../src/db/client.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { seed } from '../../src/db/seed.js';
import { mintToken } from '../../src/http/auth.js';
import { buildServer } from '../../src/http/server.js';
import { MockPaymentGateway } from '../../src/providers/payments/mock-gateway.js';
import { resetDatabase, TEST_MIGRATE_URL, TEST_RUNTIME_URL } from '../db/helpers.js';
import { FakeClock } from '../core/setup.js';

const run = TEST_MIGRATE_URL && TEST_RUNTIME_URL ? describe : describe.skip;
const SECRET = 'test-secret-'.padEnd(40, 'x');

interface Session {
  token: string;
  customer: { id: string; displayName: string | null; phoneE164: string | null };
  isNew: boolean;
}

run('mobile app API v1', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  const installId = randomUUID();

  const session = async (
    body: Record<string, unknown> = { installId, displayName: 'Ada', platform: 'android' },
  ): Promise<Session> => {
    const res = await app.inject({ method: 'POST', url: '/app/v1/session', payload: body });
    expect(res.statusCode).toBe(200);
    return res.json<Session>();
  };
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await resetDatabase();
    const c = new Client({ connectionString: TEST_RUNTIME_URL });
    await c.connect();
    await seed(c);
    await c.end();
    pool = createPool(TEST_RUNTIME_URL!, { max: 8 });
    const events = new InMemoryEventBus();
    const uow = new PgUnitOfWork(pool, {
      onCommit: (tx) => events.flush(tx),
      onRollback: (tx) => {
        events.discard(tx);
      },
    });
    const core = createCore({
      uow,
      repos: createRepositories(),
      gateway: new MockPaymentGateway(),
      events,
      clock: new FakeClock(),
    });
    app = await buildServer({
      core,
      pool,
      internalApiSecret: SECRET,
      logLevel: 'silent',
      docsUi: false,
      mobileApp: { publicBaseUrl: 'https://example.test', paystackPublicKey: 'pk_test_x' },
    });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('serves config, menu and zones without a token, with CORS headers', async () => {
    const cfg = await app.inject({
      method: 'GET',
      url: '/app/v1/config',
      headers: { origin: 'https://demo.example' },
    });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.headers['access-control-allow-origin']).toBe('https://demo.example');
    expect(cfg.json()).toMatchObject({
      brand: 'Laurence Lab',
      storeOpen: true,
      paymentMode: 'test',
      paystackPublicKey: 'pk_test_x',
    });
    const menu = await app.inject({ method: 'GET', url: '/app/v1/menu' });
    expect(menu.statusCode).toBe(200);
    expect(menu.json<{ categories: unknown[] }>().categories.length).toBeGreaterThan(0);
    const zones = await app.inject({ method: 'GET', url: '/app/v1/zones' });
    expect(zones.statusCode).toBe(200);
    expect(zones.json<unknown[]>().length).toBe(2);
  });

  it('rejects /me without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a customer on channel app, then reuses it for the same install id', async () => {
    const first = await session();
    expect(first.isNew).toBe(true);
    expect(first.customer.displayName).toBe('Ada');
    const second = await session({ installId, displayName: 'Someone Else' });
    expect(second.isNew).toBe(false);
    expect(second.customer.id).toBe(first.customer.id);
    const me = await app.inject({ method: 'GET', url: '/app/v1/me', headers: auth(second.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ id: string }>().id).toBe(first.customer.id);
  });

  it('pins the token to its customer: X-Customer-Id cannot redirect it', async () => {
    const a = await session();
    const b = await session({ installId: randomUUID(), displayName: 'Bola' });
    const res = await app.inject({
      method: 'GET',
      url: '/app/v1/me',
      headers: { ...auth(a.token), 'x-customer-id': b.customer.id },
    });
    expect(res.json<{ id: string }>().id).toBe(a.customer.id);
    // A plain adapter token (Telegram style) is not an app session.
    const generic = mintToken(SECRET, {
      kind: 'adapter',
      client: 'telegram-customer',
      ttlSeconds: 60,
    });
    const denied = await app.inject({
      method: 'GET',
      url: '/app/v1/me',
      headers: { ...auth(generic), 'x-customer-id': a.customer.id },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('runs the order journey: cart → address → checkout → track → cancel', async () => {
    const s = await session({ installId: randomUUID(), displayName: 'Chi', phone: '08012345678' });
    const h = auth(s.token);
    const menu = (await app.inject({ method: 'GET', url: '/app/v1/menu' })).json<{
      categories: { items: { id: string; variants: { id: string }[] }[] }[];
    }>();
    const item = menu.categories[0]!.items[0]!;

    let res = await app.inject({
      method: 'POST',
      url: '/app/v1/me/cart/items',
      headers: h,
      payload: { itemId: item.id, quantity: 2, variantId: item.variants[0]?.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ cart: { lines: unknown[] } }>().cart.lines).toHaveLength(1);

    const zones = (await app.inject({ method: 'GET', url: '/app/v1/zones' })).json<
      { id: string }[]
    >();
    res = await app.inject({
      method: 'POST',
      url: '/app/v1/me/addresses',
      headers: h,
      payload: { label: 'Hostel', textAddress: 'Hall 3, UNIBEN, Ugbowo', zoneId: zones[0]!.id },
    });
    expect(res.statusCode).toBe(201);
    const address = res.json<{ id: string; zoneName: string | null }>();
    expect(address.zoneName).toContain('Zone A');

    res = await app.inject({
      method: 'PUT',
      url: '/app/v1/me/cart/fulfilment',
      headers: h,
      payload: { fulfilment: 'delivery', addressId: address.id, note: 'Call at the gate' },
    });
    expect(res.statusCode).toBe(200);
    const quote = res.json<{ totals: { deliveryFeeKobo: number }; problems: string[] }>();
    expect(quote.problems).toEqual([]);
    expect(quote.totals.deliveryFeeKobo).toBe(50_000);

    res = await app.inject({
      method: 'POST',
      url: '/app/v1/me/cart/checkout',
      headers: { ...h, 'idempotency-key': `chk-${Date.now()}` },
    });
    expect(res.statusCode).toBe(201);
    const placed = res.json<{ order: { id: string; channel: string }; paymentUrl: string }>();
    expect(placed.order.channel).toBe('app');
    expect(placed.paymentUrl).toMatch(/^https?:\/\//);

    res = await app.inject({ method: 'GET', url: '/app/v1/me/orders', headers: h });
    expect(res.json<{ items: { id: string }[] }>().items[0]!.id).toBe(placed.order.id);

    res = await app.inject({
      method: 'GET',
      url: `/app/v1/me/orders/${placed.order.id}`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ payment: { status: string } }>().payment.status).toBe('initialised');

    res = await app.inject({
      method: 'POST',
      url: `/app/v1/me/orders/${placed.order.id}/cancel`,
      headers: { ...h, 'idempotency-key': `cancel-${Date.now()}` },
      payload: { reason: 'changed my mind' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ order: { status: string } }>().order.status).toBe('CANCELLED');

    // Another install cannot read this order.
    const other = await session({ installId: randomUUID() });
    res = await app.inject({
      method: 'GET',
      url: `/app/v1/me/orders/${placed.order.id}`,
      headers: auth(other.token),
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('serves the Paystack return page', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/pay/return?reference=x' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('laurencelab://orders');
  });
});
