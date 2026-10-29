/**
 * Mobile app API v1 (`/app/v1`). The native iOS/Android app is an untrusted
 * client, so unlike `/internal/v1` it never holds a shared secret:
 *
 *   1. POST /session  — the app sends its per-install id (a UUID it generated on
 *      first launch and keeps in secure storage). We find-or-create the customer
 *      on channel 'app' and mint an adapter token *pinned to that customer*
 *      (auth.ts: `customerId` claim). The token is what the app presents on
 *      every later request; the IDOR guard in the core scopes everything to it.
 *   2. Everything else is the customer-facing subset of the internal API,
 *      addressed as `/me/...` (the customer id comes from the token).
 *
 * Validation and shapes reuse the shared schemas so the two APIs cannot drift.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { mintToken } from '../../../auth.js';
import { requireKinds } from '../../../plugins.js';
import * as S from '../../../schemas.js';

/** One year: the install id is the real credential; the token just caches it. */
const SESSION_TTL_SECONDS = 365 * 24 * 3600;
const APP_CLIENT = 'mobile-app';

export interface AppV1Options {
  internalApiSecret: string;
  /** Used to build the Paystack return page URL. */
  publicBaseUrl: string;
  paystackPublicKey?: string;
}

const Zone = z.object({
  id: S.uuid,
  name: z.string(),
  feeKobo: S.koboInt,
  minOrderKobo: S.koboInt,
  etaMinutes: z.number().int(),
});

export function registerAppV1(app: FastifyInstance, opts: AppV1Options): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const core = app.core;
  const customerId = (req: { actor: { id: string } }): string => req.actor.id;

  /** Every authenticated app route must carry an app-pinned adapter token. */
  const requireApp = (
    req: Parameters<ReturnType<typeof requireKinds>>[0],
    reply: Parameters<ReturnType<typeof requireKinds>>[1],
    next: Parameters<ReturnType<typeof requireKinds>>[2],
  ): void => {
    if (req.claims.client !== APP_CLIENT || !req.claims.customerId) {
      void reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'app session required', requestId: req.id },
      });
      return;
    }
    requireKinds('adapter')(req, reply, next);
  };

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------
  r.get(
    '/config',
    {
      schema: {
        tags: ['app'],
        summary: 'Brand, opening state and payment mode for the app shell',
        response: {
          200: z.object({
            brand: z.string(),
            storeOpen: z.boolean(),
            paymentsEnabled: z.boolean(),
            paymentMode: z.enum(['test', 'live']),
            paystackPublicKey: z.string().nullable(),
            currency: z.literal('NGN'),
          }),
        },
      },
    },
    async () =>
      core.uow.transaction(async (tx) => ({
        brand: await core.settings.get(tx, 'brand.name'),
        storeOpen: await core.settings.get(tx, 'store.open'),
        paymentsEnabled: await core.settings.get(tx, 'payments.enabled'),
        paymentMode: core.gateway.mode,
        paystackPublicKey: opts.paystackPublicKey ?? null,
        currency: 'NGN' as const,
      })),
  );

  r.get(
    '/menu',
    {
      schema: {
        tags: ['app'],
        summary: 'Customer-facing menu (active items with availability)',
        response: { 200: z.object({ categories: z.array(S.MenuCategory) }) },
      },
    },
    async () => core.uow.transaction((tx) => core.catalog.customerMenu(tx)),
  );

  r.get(
    '/zones',
    {
      schema: {
        tags: ['app'],
        summary: 'Active delivery zones (for typed addresses without a GPS pin)',
        response: { 200: z.array(Zone) },
      },
    },
    async () =>
      core.uow.transaction(async (tx) =>
        (await core.repos.zones.listActive(tx)).map((zn) => ({
          id: zn.id,
          name: zn.name,
          feeKobo: zn.feeKobo,
          minOrderKobo: zn.minOrderKobo,
          etaMinutes: zn.etaMinutes,
        })),
      ),
  );

  r.post(
    '/session',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['app'],
        summary: 'Exchange the per-install id for a customer-pinned session token',
        body: z.object({
          installId: z.uuid(),
          displayName: z.string().min(1).max(120).optional(),
          phone: z.string().min(7).max(20).optional(),
          languageHint: S.Language.optional(),
          platform: z.enum(['ios', 'android', 'web']).optional(),
        }),
        response: {
          200: z.object({ token: z.string(), customer: S.Customer, isNew: z.boolean() }),
        },
      },
    },
    async (req) => {
      const { installId, displayName, phone, languageHint } = req.body;
      return core.uow.transaction(async (tx) => {
        const identified = await core.customers.identify(tx, {
          channel: 'app',
          externalUserId: installId,
          externalChatId: installId,
          ...(displayName !== undefined ? { displayName } : {}),
          ...(languageHint !== undefined ? { languageHint } : {}),
        });
        let customer = identified.customer;
        const actor = { type: 'customer' as const, id: customer.id, requestId: req.id };
        if (phone !== undefined && customer.phoneE164 === null)
          customer = await core.customers.setPhone(tx, actor, customer.id, phone, false);
        const token = mintToken(opts.internalApiSecret, {
          kind: 'adapter',
          client: APP_CLIENT,
          customerId: customer.id,
          ttlSeconds: SESSION_TTL_SECONDS,
        });
        return { token, customer, isNew: identified.isNew };
      });
    },
  );

  // -------------------------------------------------------------------------
  // Me
  // -------------------------------------------------------------------------
  r.get(
    '/me',
    { preHandler: requireApp, schema: { tags: ['app'], response: { 200: S.Customer } } },
    async (req) => core.uow.transaction((tx) => core.customers.get(tx, req.actor, customerId(req))),
  );

  r.patch(
    '/me',
    {
      preHandler: requireApp,
      schema: {
        tags: ['app'],
        body: z.object({
          phone: z.string().min(7).max(20).optional(),
          language: S.Language.optional(),
        }),
        response: { 200: S.Customer },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        const id = customerId(req);
        let c = await core.customers.get(tx, req.actor, id);
        if (req.body.phone !== undefined)
          c = await core.customers.setPhone(tx, req.actor, id, req.body.phone, false);
        if (req.body.language !== undefined)
          c = await core.customers.setLanguage(tx, req.actor, id, req.body.language);
        return c;
      }),
  );

  r.get(
    '/me/addresses',
    {
      preHandler: requireApp,
      schema: { tags: ['app'], response: { 200: z.array(S.Address) } },
    },
    async (req) =>
      core.uow.transaction((tx) => core.customers.listAddresses(tx, req.actor, customerId(req))),
  );

  r.post(
    '/me/addresses',
    {
      preHandler: requireApp,
      schema: {
        tags: ['app'],
        summary: 'Add an address: GPS pin (zone resolved) or typed text + chosen zone',
        body: z.object({
          label: z.string().max(40).optional(),
          textAddress: z.string().max(300).optional(),
          point: S.GeoPoint.optional(),
          zoneId: S.uuid.optional(),
          makeDefault: z.boolean().optional(),
        }),
        response: { 201: S.Address.extend({ zoneName: z.string().nullable() }) },
      },
    },
    async (req, reply) => {
      const a = await core.uow.transaction((tx) =>
        core.customers.addAddress(tx, req.actor, customerId(req), S.compact(req.body)),
      );
      return reply.status(201).send(a);
    },
  );

  r.delete(
    '/me/addresses/:addressId',
    {
      preHandler: requireApp,
      schema: {
        tags: ['app'],
        params: z.object({ addressId: S.uuid }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await core.uow.transaction((tx) =>
        core.customers.deleteAddress(tx, req.actor, customerId(req), req.params.addressId),
      );
      return reply.status(204).send(null);
    },
  );

  // -------------------------------------------------------------------------
  // Cart & checkout
  // -------------------------------------------------------------------------
  r.get(
    '/me/cart',
    { preHandler: requireApp, schema: { tags: ['app'], response: { 200: S.CartQuote } } },
    async (req) => core.uow.transaction((tx) => core.cart.quote(tx, req.actor, customerId(req))),
  );

  r.post(
    '/me/cart/items',
    {
      preHandler: requireApp,
      schema: {
        tags: ['app'],
        body: z.object({
          itemId: S.uuid,
          quantity: z.number().int().min(1).max(50),
          variantId: S.uuid.optional(),
          addonIds: z.array(S.uuid).max(10).optional(),
        }),
        response: { 200: S.CartQuote },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        await core.cart.addItem(tx, req.actor, customerId(req), S.compact(req.body));
        return core.cart.quote(tx, req.actor, customerId(req));
      }),
  );

  r.patch(
    '/me/cart/items/:lineId',
    {
      preHandler: requireApp,
      schema: {
        tags: ['app'],
        params: z.object({ lineId: S.uuid }),
        body: z.object({ quantity: z.number().int().min(0).max(50) }),
        response: { 200: S.CartQuote },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        await core.cart.setLineQuantity(
          tx,
          req.actor,
          customerId(req),
          req.params.lineId,
          req.body.quantity,
        );
        return core.cart.quote(tx, req.actor, customerId(req));
      }),
  );

  r.delete(
    '/me/cart',
    { preHandler: requireApp, schema: { tags: ['app'], response: { 200: S.CartQuote } } },
    async (req) =>
      core.uow.transaction(async (tx) => {
        await core.cart.clear(tx, req.actor, customerId(req));
        return core.cart.quote(tx, req.actor, customerId(req));
      }),
  );

  r.put(
    '/me/cart/fulfilment',
    {
      preHandler: requireApp,
      schema: {
        tags: ['app'],
        body: z.object({
          fulfilment: z.enum(['delivery', 'pickup']),
          addressId: S.uuid.optional(),
          note: z.string().max(300).optional(),
        }),
        response: { 200: S.CartQuote },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        await core.cart.setFulfilment(tx, req.actor, customerId(req), S.compact(req.body));
        return core.cart.quote(tx, req.actor, customerId(req));
      }),
  );

  r.put(
    '/me/cart/promo',
    {
      preHandler: requireApp,
      schema: {
        tags: ['app'],
        body: z.object({ code: z.string().min(2).max(32).nullable() }),
        response: { 200: S.CartQuote },
      },
    },
    async (req) =>
      core.uow.transaction((tx) =>
        core.cart.applyPromo(tx, req.actor, customerId(req), req.body.code),
      ),
  );

  r.post(
    '/me/cart/checkout',
    {
      preHandler: requireApp,
      schema: {
        tags: ['app'],
        summary: 'Place the order and start a Paystack payment; open paymentUrl in the app',
        response: {
          201: z.object({
            order: S.Order,
            paymentUrl: z.string(),
            paymentReference: z.string(),
            expiresAt: z.coerce.date(),
          }),
        },
      },
    },
    async (req, reply) => {
      const result = await core.orders.checkout(req.actor, customerId(req), 'app', {
        callbackUrl: `${opts.publicBaseUrl}/app/pay/return`,
      });
      return reply.status(201).send(result);
    },
  );

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------
  r.get(
    '/me/orders',
    {
      preHandler: requireApp,
      schema: {
        tags: ['app'],
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().optional(),
        }),
        response: { 200: S.Paginated(S.Order) },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        const page = await core.orders.listForCustomer(
          tx,
          req.actor,
          customerId(req),
          req.query.limit,
          req.query.cursor,
        );
        return { items: page.orders, nextCursor: page.nextCursor };
      }),
  );

  r.get(
    '/me/orders/:id',
    {
      preHandler: requireApp,
      schema: {
        tags: ['app'],
        params: S.IdParam,
        response: { 200: S.Order.extend({ payment: S.Payment.nullable() }) },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        const order = await core.orders.get(tx, req.actor, req.params.id);
        const payment = await core.payments.getPaymentForOrder(tx, order.id);
        return { ...order, payment };
      }),
  );

  r.post(
    '/me/orders/:id/cancel',
    {
      preHandler: requireApp,
      schema: {
        tags: ['app'],
        summary: 'Customer cancellation (allowed only while the state machine permits it)',
        params: S.IdParam,
        body: z.object({ reason: z.string().min(1).max(300).default('customer_cancelled') }),
        response: { 200: z.object({ order: S.Order, changed: z.boolean() }) },
      },
    },
    async (req) =>
      core.uow.transaction((tx) =>
        core.orders.transition(tx, req.actor, req.params.id, 'CANCELLED', {
          reason: req.body.reason,
          idempotencyKey: `${req.actorKey}:cancel:${req.params.id}`,
        }),
      ),
  );
}

/** Tiny HTML page Paystack returns to after a successful card payment. */
export function paystackReturnPage(deepLinkScheme: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment received</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0d0a;color:#f6efe4;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center}
main{padding:32px}h1{font-size:22px;margin:0 0 8px}p{opacity:.8;margin:0 0 20px}a{display:inline-block;background:#f2a341;color:#1a1308;padding:12px 20px;border-radius:12px;text-decoration:none;font-weight:600}</style></head>
<body><main><h1>Payment received</h1><p>You can close this page and go back to the Laurence Lab app — your order is being confirmed.</p>
<a href="${deepLinkScheme}://orders">Back to the app</a></main>
<script>setTimeout(function(){location.href="${deepLinkScheme}://orders"},800)</script></body></html>`;
}
