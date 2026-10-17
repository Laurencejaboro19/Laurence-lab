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

run('internal API v1', () => {
  let app: FastifyInstance;
  let gateway: MockPaymentGateway;
  let events: InMemoryEventBus;
  let pool: ReturnType<typeof createPool>;
  const adapterToken = mintToken(SECRET, {
    kind: 'adapter',
    client: 'telegram-customer',
    ttlSeconds: 3600,
  });
  const ownerToken = mintToken(SECRET, {
    kind: 'staff',
    client: 'admin-bot',
    staffId: 'st-owner',
    staffRole: 'owner',
    ttlSeconds: 3600,
  });
  const kitchenToken = mintToken(SECRET, {
    kind: 'staff',
    client: 'admin-bot',
    staffId: 'st-kitchen',
    staffRole: 'kitchen',
    ttlSeconds: 3600,
  });
  const systemToken = mintToken(SECRET, { kind: 'system', client: 'test-job', ttlSeconds: 3600 });
  let keyCounter = 0;
  const idem = (): string => `test-key-${Date.now()}-${++keyCounter}`;

  const as = (token: string, customerId?: string) => ({
    authorization: `Bearer ${token}`,
    ...(customerId ? { 'x-customer-id': customerId } : {}),
  });

  beforeAll(async () => {
    await resetDatabase();
    const c = new Client({ connectionString: TEST_RUNTIME_URL });
    await c.connect();
    await seed(c);
    await c.end();
    pool = createPool(TEST_RUNTIME_URL!, { max: 8 });
    events = new InMemoryEventBus();
    const uow = new PgUnitOfWork(pool, {
      onCommit: (tx) => events.flush(tx),
      onRollback: (tx) => {
        events.discard(tx);
      },
    });
    gateway = new MockPaymentGateway();
    // Fixed clock (Tuesday 12:00 Lagos) so the opening-hours check does not depend on when CI runs.
    const core = createCore({
      uow,
      repos: createRepositories(),
      gateway,
      events,
      clock: new FakeClock(),
    });
    app = await buildServer({ core, pool, internalApiSecret: SECRET, logLevel: 'silent' });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('serves health, readiness and a truthful OpenAPI document', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true });
    const ready = (await app.inject({ method: 'GET', url: '/readyz' })).json<{
      ok: boolean;
      schemaVersion: number;
    }>();
    expect(ready.ok).toBe(true);
    expect(ready.schemaVersion).toBeGreaterThanOrEqual(7);
    const spec = (await app.inject({ method: 'GET', url: '/internal/v1/openapi.json' })).json<{
      openapi: string;
      paths: Record<string, unknown>;
    }>();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/menu',
        '/customers/identify',
        '/customers/{id}/cart/checkout',
        '/orders/{id}/transition',
        '/settings/{key}',
      ]),
    );
  });

  it('rejects missing, forged and expired tokens', async () => {
    expect((await app.inject({ method: 'GET', url: '/internal/v1/menu' })).statusCode).toBe(401);
    const forged = `${adapterToken.split('.')[0]}.AAAA`;
    expect(
      (await app.inject({ method: 'GET', url: '/internal/v1/menu', headers: as(forged) }))
        .statusCode,
    ).toBe(401);
    const expired = mintToken(SECRET, { kind: 'system', client: 'x', ttlSeconds: -10 });
    expect(
      (await app.inject({ method: 'GET', url: '/internal/v1/menu', headers: as(expired) }))
        .statusCode,
    ).toBe(401);
    const otherSecret = mintToken('another-secret-that-is-long-enough-000', {
      kind: 'system',
      client: 'x',
      ttlSeconds: 60,
    });
    expect(
      (await app.inject({ method: 'GET', url: '/internal/v1/menu', headers: as(otherSecret) }))
        .statusCode,
    ).toBe(401);
    // Adapter tokens need the customer header.
    expect(
      (await app.inject({ method: 'GET', url: '/internal/v1/menu', headers: as(adapterToken) }))
        .statusCode,
    ).toBe(400);
  });

  it('returns the uniform error shape with a request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/internal/v1/orders/00000000-0000-0000-0000-000000000000',
      headers: as(systemToken),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('requires an Idempotency-Key on state-changing requests and replays stored responses', async () => {
    const body = {
      channel: 'telegram',
      externalUserId: 'u-idem',
      externalChatId: 'u-idem',
      displayName: 'Idem',
    };
    const noKey = await app.inject({
      method: 'POST',
      url: '/internal/v1/customers/identify',
      headers: as(systemToken),
      payload: body,
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json<{ error: { message: string } }>().error.message).toMatch(/Idempotency-Key/);

    const key = idem();
    const first = await app.inject({
      method: 'POST',
      url: '/internal/v1/customers/identify',
      headers: { ...as(systemToken), 'idempotency-key': key },
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({
      method: 'POST',
      url: '/internal/v1/customers/identify',
      headers: { ...as(systemToken), 'idempotency-key': key },
      payload: body,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    const mismatch = await app.inject({
      method: 'POST',
      url: '/internal/v1/customers/identify',
      headers: { ...as(systemToken), 'idempotency-key': key },
      payload: { ...body, displayName: 'Changed' },
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('runs a customer journey end to end through the API', async () => {
    // identify
    const ident = await app.inject({
      method: 'POST',
      url: '/internal/v1/customers/identify',
      headers: {
        ...as(adapterToken, '00000000-0000-0000-0000-000000000000'),
        'idempotency-key': idem(),
      },
      payload: {
        channel: 'telegram',
        externalUserId: '777',
        externalChatId: '777',
        displayName: 'Aruya',
      },
    });
    expect(ident.statusCode).toBe(200);
    const customerId = ident.json<{ customer: { id: string }; isNew: boolean }>().customer.id;
    const me = as(adapterToken, customerId);

    // phone + address
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/internal/v1/customers/${customerId}`,
          headers: { ...me, 'idempotency-key': idem() },
          payload: { phone: '08059827250', phoneVerified: true },
        })
      ).statusCode,
    ).toBe(200);
    const addr = await app.inject({
      method: 'POST',
      url: `/internal/v1/customers/${customerId}/addresses`,
      headers: { ...me, 'idempotency-key': idem() },
      payload: {
        label: 'Hostel',
        textAddress: 'Hall 3',
        point: { latitude: 6.4, longitude: 5.61 },
      },
    });
    expect(addr.statusCode).toBe(201);
    const addressId = addr.json<{ id: string; zoneName: string }>().id;
    expect(addr.json<{ zoneName: string }>().zoneName).toMatch(/Zone A/);
    const outside = await app.inject({
      method: 'POST',
      url: `/internal/v1/customers/${customerId}/addresses`,
      headers: { ...me, 'idempotency-key': idem() },
      payload: { point: { latitude: 6.5, longitude: 3.4 } },
    });
    expect(outside.statusCode).toBe(422);
    expect(outside.json<{ error: { code: string } }>().error.code).toBe('OUTSIDE_DELIVERY_AREA');

    // menu + cart
    const menu = (await app.inject({ method: 'GET', url: '/internal/v1/menu', headers: me })).json<{
      categories: { items: { id: string; slug: string }[] }[];
    }>();
    const items = menu.categories.flatMap((c) => c.items);
    const jollof = items.find((i) => i.slug === 'jollof-rice')!;
    const chicken = items.find((i) => i.slug === 'chicken')!;
    for (const [item, qty] of [
      [jollof, 2],
      [chicken, 1],
    ] as const) {
      const r = await app.inject({
        method: 'POST',
        url: `/internal/v1/customers/${customerId}/cart/items`,
        headers: { ...me, 'idempotency-key': idem() },
        payload: { itemId: item.id, quantity: qty },
      });
      expect(r.statusCode).toBe(200);
    }
    const ful = await app.inject({
      method: 'PUT',
      url: `/internal/v1/customers/${customerId}/cart/fulfilment`,
      headers: { ...me, 'idempotency-key': idem() },
      payload: { fulfilment: 'delivery', addressId },
    });
    expect(ful.statusCode).toBe(200);
    const quote = ful.json<{
      totals: { totalKobo: number; deliveryFeeKobo: number };
      problems: string[];
    }>();
    expect(quote.problems).toEqual([]);
    expect(quote.totals.deliveryFeeKobo).toBe(50000);

    // checkout
    const co = await app.inject({
      method: 'POST',
      url: `/internal/v1/customers/${customerId}/cart/checkout`,
      headers: { ...me, 'idempotency-key': idem() },
      payload: { channel: 'telegram' },
    });
    expect(co.statusCode, co.body).toBe(201);
    const { order, paymentReference, paymentUrl } = co.json<{
      order: { id: string; status: string; totalKobo: number; publicRef: string };
      paymentReference: string;
      paymentUrl: string;
    }>();
    expect(order.status).toBe('AWAITING_PAYMENT');
    expect(paymentUrl).toMatch(/^https:/);

    // customer sees own order; another customer cannot (IDOR via API)
    expect(
      (await app.inject({ method: 'GET', url: `/internal/v1/orders/${order.id}`, headers: me }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/internal/v1/orders/${order.id}`,
          headers: as(adapterToken, '11111111-1111-1111-1111-111111111111'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/internal/v1/orders/by-ref/${order.publicRef}`,
          headers: as(adapterToken, '11111111-1111-1111-1111-111111111111'),
        })
      ).statusCode,
    ).toBe(404);

    // provider event → verify → paid
    gateway.willVerify(paymentReference, { status: 'success' });
    const ev = await app.inject({
      method: 'POST',
      url: '/internal/v1/payments/events',
      headers: { ...as(systemToken), 'idempotency-key': idem() },
      payload: {
        provider: 'paystack',
        eventType: 'charge.success',
        reference: paymentReference,
        payloadRedacted: { data: { id: 1, status: 'success' } },
      },
    });
    expect(ev.json()).toEqual({ deduped: false, outcome: 'paid' });
    // adapter token may not ingest provider events
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/v1/payments/events',
          headers: { ...me, 'idempotency-key': idem() },
          payload: { provider: 'paystack', eventType: 'x', reference: null, payloadRedacted: {} },
        })
      ).statusCode,
    ).toBe(403);

    // kitchen accepts; kitchen cannot change prices; owner can
    const acc = await app.inject({
      method: 'POST',
      url: `/internal/v1/orders/${order.id}/transition`,
      headers: { ...as(kitchenToken), 'idempotency-key': idem() },
      payload: { to: 'ACCEPTED', etaMinutes: 35 },
    });
    expect(acc.statusCode).toBe(200);
    expect(acc.json<{ order: { status: string; etaMinutes: number } }>().order).toMatchObject({
      status: 'ACCEPTED',
      etaMinutes: 35,
    });
    const price = await app.inject({
      method: 'PATCH',
      url: `/internal/v1/menu/items/${jollof.id}`,
      headers: { ...as(kitchenToken), 'idempotency-key': idem() },
      payload: { priceKobo: 160000 },
    });
    expect(price.statusCode).toBe(403);
    const soldOut = await app.inject({
      method: 'PATCH',
      url: `/internal/v1/menu/items/${jollof.id}`,
      headers: { ...as(kitchenToken), 'idempotency-key': idem() },
      payload: { active: false },
    });
    expect(soldOut.statusCode).toBe(200);
    expect(soldOut.json<{ active: boolean }>().active).toBe(false);
    const priceOk = await app.inject({
      method: 'PATCH',
      url: `/internal/v1/menu/items/${jollof.id}`,
      headers: { ...as(ownerToken), 'idempotency-key': idem() },
      payload: { priceKobo: 160000, active: true },
    });
    expect(priceOk.statusCode).toBe(200);
    expect(priceOk.json<{ priceKobo: number }>().priceKobo).toBe(160000);

    // customer may not accept orders, may cancel only in allowed states
    const bad = await app.inject({
      method: 'POST',
      url: `/internal/v1/orders/${order.id}/transition`,
      headers: { ...me, 'idempotency-key': idem() },
      payload: { to: 'PREPARING' },
    });
    expect(bad.statusCode).toBe(403);

    // settings: kitchen cannot, owner can; invalid value rejected
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/internal/v1/settings/store.open',
          headers: { ...as(kitchenToken), 'idempotency-key': idem() },
          payload: { value: false },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/internal/v1/settings/store.open',
          headers: { ...as(ownerToken), 'idempotency-key': idem() },
          payload: { value: 'yes' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/internal/v1/settings/orders.daily_cap',
          headers: { ...as(ownerToken), 'idempotency-key': idem() },
          payload: { value: 75 },
        })
      ).statusCode,
    ).toBe(200);

    // audit trail is intact and readable by managers only
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/internal/v1/audit/verify',
          headers: as(kitchenToken),
        })
      ).statusCode,
    ).toBe(403);
    const verify = await app.inject({
      method: 'GET',
      url: '/internal/v1/audit/verify',
      headers: as(ownerToken),
    });
    expect(verify.json<{ ok: boolean; checked: number }>()).toMatchObject({ ok: true });
    const audit = await app.inject({
      method: 'GET',
      url: `/internal/v1/audit?entityType=order&entityId=${order.id}`,
      headers: as(ownerToken),
    });
    expect(audit.json<{ entries: { action: string }[] }>().entries.map((e) => e.action)).toContain(
      'order.transition',
    );

    // staff order list with status filter
    const list = await app.inject({
      method: 'GET',
      url: '/internal/v1/orders?status=ACCEPTED,PREPARING&limit=5',
      headers: as(kitchenToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { id: string }[] }>().items.some((o) => o.id === order.id)).toBe(
      true,
    );
  });

  it('rate limits are enforced per actor', async () => {
    const headers = as(
      mintToken(SECRET, { kind: 'system', client: 'ratelimit-test', ttlSeconds: 60 }),
    );
    let limited = false;
    for (let i = 0; i < 320 && !limited; i++) {
      const res = await app.inject({ method: 'GET', url: '/internal/v1/menu', headers });
      if (res.statusCode === 429) {
        limited = true;
        expect(res.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
      }
    }
    expect(limited).toBe(true);
  }, 30_000);
});
