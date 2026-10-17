/**
 * Internal API v1. Routes validate, authenticate and call the core — nothing else.
 * Every route declares Zod schemas, which also generate the OpenAPI document.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { kobo } from '../../../../core/domain/money.js';
import { ORDER_STATUSES } from '../../../../core/domain/order-status.js';
import { SETTING_KEYS } from '../../../../core/services/settings.js';
import { requireKinds, requireRoles } from '../../../plugins.js';
import * as S from '../../../schemas.js';

const ALL_STAFF = ['owner', 'manager', 'kitchen', 'dispatch', 'support'];
const MANAGERS = ['owner', 'manager'];
const STOCK = ['owner', 'manager', 'kitchen'];

export function registerInternalV1(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const core = app.core;

  // -------------------------------------------------------------------------
  // Menu & inventory
  // -------------------------------------------------------------------------
  r.get(
    '/menu',
    {
      schema: {
        tags: ['menu'],
        summary: 'Customer-facing menu (active items with availability)',
        response: { 200: z.object({ categories: z.array(S.MenuCategory) }) },
      },
    },
    async () => core.uow.transaction((tx) => core.catalog.customerMenu(tx)),
  );

  r.get(
    '/menu/all',
    {
      preHandler: requireRoles(...ALL_STAFF),
      schema: {
        tags: ['menu'],
        summary: 'Full menu including inactive items (staff)',
        response: { 200: z.object({ categories: z.array(S.MenuCategory) }) },
      },
    },
    async (req) => core.uow.transaction((tx) => core.catalog.staffMenu(tx, req.actor)),
  );

  r.patch(
    '/menu/items/:id',
    {
      preHandler: requireRoles(...STOCK),
      schema: {
        tags: ['menu'],
        summary: 'Update a menu item (availability: kitchen+; price/details: owner, manager)',
        params: S.IdParam,
        body: z.object({
          active: z.boolean().optional(),
          priceKobo: S.koboInt.optional(),
          name: z.string().min(1).max(80).optional(),
          description: z.string().max(300).nullable().optional(),
          prepMinutes: z.number().int().min(0).max(180).optional(),
          photoRef: z.string().max(300).nullable().optional(),
        }),
        response: { 200: S.MenuItem },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        const { active, priceKobo, ...details } = req.body;
        let item = await core.catalog.getItem(tx, req.params.id);
        if (active !== undefined)
          item = await core.catalog.setAvailability(tx, req.actor, item.id, active);
        if (priceKobo !== undefined)
          item = await core.catalog.setPrice(tx, req.actor, item.id, kobo(priceKobo));
        const patch = S.compact(details);
        if (Object.keys(patch).length > 0)
          item = await core.catalog.updateDetails(tx, req.actor, item.id, patch);
        return item;
      }),
  );

  r.post(
    '/inventory/:id/adjust',
    {
      preHandler: requireRoles(...STOCK),
      schema: {
        tags: ['inventory'],
        summary: 'Receive, adjust, waste or import stock for an item',
        params: S.IdParam,
        body: z.object({
          delta: z.number().int(),
          kind: z.enum(['receive', 'adjust', 'waste', 'import']),
          note: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({
            onHand: z.number().int(),
            reserved: z.number().int(),
            available: z.number().int(),
          }),
        },
      },
    },
    async (req) =>
      core.uow.transaction((tx) =>
        core.catalog.adjustStock(tx, req.actor, { itemId: req.params.id, ...S.compact(req.body) }),
      ),
  );

  r.get(
    '/inventory/low-stock',
    {
      preHandler: requireRoles(...STOCK),
      schema: {
        tags: ['inventory'],
        summary: 'Items at or below their low-stock threshold',
        response: {
          200: z.array(
            z.object({
              itemId: S.uuid,
              name: z.string(),
              available: z.number().int(),
              threshold: z.number().int(),
            }),
          ),
        },
      },
    },
    async (req) => core.uow.transaction((tx) => core.catalog.lowStock(tx, req.actor)),
  );

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------
  r.post(
    '/customers/identify',
    {
      preHandler: requireKinds('adapter', 'system'),
      schema: {
        tags: ['customers'],
        summary: 'Find or create the customer behind a chat identity (idempotent)',
        body: z.object({
          channel: S.Channel,
          externalUserId: z.string().min(1).max(64),
          externalChatId: z.string().min(1).max(64),
          displayName: z.string().max(120).optional(),
          handle: z.string().max(64).optional(),
          languageHint: z.string().max(8).optional(),
        }),
        response: {
          200: z.object({ customer: S.Customer, identity: S.ChannelIdentity, isNew: z.boolean() }),
        },
      },
    },
    async (req) => core.uow.transaction((tx) => core.customers.identify(tx, S.compact(req.body))),
  );

  r.get(
    '/customers/:id',
    {
      schema: { tags: ['customers'], params: S.CustomerIdParam, response: { 200: S.Customer } },
    },
    async (req) => core.uow.transaction((tx) => core.customers.get(tx, req.actor, req.params.id)),
  );

  r.patch(
    '/customers/:id',
    {
      schema: {
        tags: ['customers'],
        summary: 'Set phone (from contact share or typed) and/or language',
        params: S.CustomerIdParam,
        body: z.object({
          phone: z.string().min(7).max(20).optional(),
          phoneVerified: z.boolean().optional(),
          language: S.Language.optional(),
        }),
        response: { 200: S.Customer },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        let c = await core.customers.get(tx, req.actor, req.params.id);
        if (req.body.phone !== undefined)
          c = await core.customers.setPhone(
            tx,
            req.actor,
            c.id,
            req.body.phone,
            req.body.phoneVerified ?? false,
          );
        if (req.body.language !== undefined)
          c = await core.customers.setLanguage(tx, req.actor, c.id, req.body.language);
        return c;
      }),
  );

  r.get(
    '/customers/:id/addresses',
    {
      schema: {
        tags: ['customers'],
        params: S.CustomerIdParam,
        response: { 200: z.array(S.Address) },
      },
    },
    async (req) =>
      core.uow.transaction((tx) => core.customers.listAddresses(tx, req.actor, req.params.id)),
  );

  r.post(
    '/customers/:id/addresses',
    {
      schema: {
        tags: ['customers'],
        summary: 'Add an address from a shared pin and/or text; resolves the delivery zone',
        params: S.CustomerIdParam,
        body: z.object({
          label: z.string().max(40).optional(),
          textAddress: z.string().max(300).optional(),
          point: S.GeoPoint.optional(),
          makeDefault: z.boolean().optional(),
        }),
        response: { 201: S.Address.extend({ zoneName: z.string().nullable() }) },
      },
    },
    async (req, reply) => {
      const a = await core.uow.transaction((tx) =>
        core.customers.addAddress(tx, req.actor, req.params.id, S.compact(req.body)),
      );
      return reply.status(201).send(a);
    },
  );

  r.delete(
    '/customers/:id/addresses/:addressId',
    {
      schema: {
        tags: ['customers'],
        params: S.CustomerIdParam.extend({ addressId: S.uuid }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await core.uow.transaction((tx) =>
        core.customers.deleteAddress(tx, req.actor, req.params.id, req.params.addressId),
      );
      return reply.status(204).send(null);
    },
  );

  r.get(
    '/customers/:id/export',
    {
      schema: {
        tags: ['customers'],
        summary: 'NDPA data export',
        params: S.CustomerIdParam,
        response: { 200: z.record(z.string(), z.unknown()) },
      },
    },
    async (req) =>
      core.uow.transaction((tx) => core.customers.exportData(tx, req.actor, req.params.id)),
  );

  r.delete(
    '/customers/:id/data',
    {
      schema: {
        tags: ['customers'],
        summary: 'NDPA deletion: anonymise PII, keep financial records',
        params: S.CustomerIdParam,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await core.uow.transaction((tx) => core.customers.deleteData(tx, req.actor, req.params.id));
      return reply.status(204).send(null);
    },
  );

  // -------------------------------------------------------------------------
  // Cart & checkout
  // -------------------------------------------------------------------------
  r.get(
    '/customers/:id/cart',
    {
      schema: {
        tags: ['cart'],
        summary: 'Current cart with live totals',
        params: S.CustomerIdParam,
        response: { 200: S.CartQuote },
      },
    },
    async (req) => core.uow.transaction((tx) => core.cart.quote(tx, req.actor, req.params.id)),
  );

  r.post(
    '/customers/:id/cart/items',
    {
      schema: {
        tags: ['cart'],
        params: S.CustomerIdParam,
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
        await core.cart.addItem(tx, req.actor, req.params.id, S.compact(req.body));
        return core.cart.quote(tx, req.actor, req.params.id);
      }),
  );

  r.patch(
    '/customers/:id/cart/items/:lineId',
    {
      schema: {
        tags: ['cart'],
        summary: 'Set a line quantity (0 removes it)',
        params: S.CustomerIdParam.extend({ lineId: S.uuid }),
        body: z.object({ quantity: z.number().int().min(0).max(50) }),
        response: { 200: S.CartQuote },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        await core.cart.setLineQuantity(
          tx,
          req.actor,
          req.params.id,
          req.params.lineId,
          req.body.quantity,
        );
        return core.cart.quote(tx, req.actor, req.params.id);
      }),
  );

  r.delete(
    '/customers/:id/cart',
    {
      schema: {
        tags: ['cart'],
        summary: 'Empty the cart',
        params: S.CustomerIdParam,
        response: { 200: S.CartQuote },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        await core.cart.clear(tx, req.actor, req.params.id);
        return core.cart.quote(tx, req.actor, req.params.id);
      }),
  );

  r.put(
    '/customers/:id/cart/fulfilment',
    {
      schema: {
        tags: ['cart'],
        params: S.CustomerIdParam,
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
        await core.cart.setFulfilment(tx, req.actor, req.params.id, S.compact(req.body));
        return core.cart.quote(tx, req.actor, req.params.id);
      }),
  );

  r.put(
    '/customers/:id/cart/promo',
    {
      schema: {
        tags: ['cart'],
        summary: 'Apply (or clear with null) a promo code',
        params: S.CustomerIdParam,
        body: z.object({ code: z.string().min(2).max(32).nullable() }),
        response: { 200: S.CartQuote },
      },
    },
    async (req) =>
      core.uow.transaction((tx) =>
        core.cart.applyPromo(tx, req.actor, req.params.id, req.body.code),
      ),
  );

  r.post(
    '/customers/:id/cart/checkout',
    {
      schema: {
        tags: ['cart'],
        summary: 'Convert the cart into an order, reserve stock and start a Paystack payment',
        params: S.CustomerIdParam,
        body: z.object({ channel: S.Channel }),
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
      const result = await core.orders.checkout(req.actor, req.params.id, req.body.channel);
      return reply.status(201).send(result);
    },
  );

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------
  r.get(
    '/customers/:id/orders',
    {
      schema: {
        tags: ['orders'],
        params: S.CustomerIdParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(10),
          cursor: z.string().optional(),
        }),
        response: { 200: S.Paginated(S.Order) },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        const r2 = await core.orders.listForCustomer(
          tx,
          req.actor,
          req.params.id,
          req.query.limit,
          req.query.cursor,
        );
        return { items: r2.orders, nextCursor: r2.nextCursor };
      }),
  );

  r.get(
    '/orders',
    {
      preHandler: requireRoles(...ALL_STAFF),
      schema: {
        tags: ['orders'],
        summary: 'Staff order list (newest first, keyset pagination)',
        querystring: z.object({
          status: z.string().optional().describe('comma-separated statuses'),
          sinceHours: z.coerce
            .number()
            .int()
            .min(1)
            .max(24 * 90)
            .optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().optional(),
        }),
        response: { 200: S.Paginated(S.Order) },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => {
        const statuses = req.query.status
          ?.split(',')
          .filter((s): s is (typeof ORDER_STATUSES)[number] =>
            (ORDER_STATUSES as readonly string[]).includes(s),
          );
        const r2 = await core.orders.listForStaff(tx, req.actor, {
          ...(statuses?.length ? { status: statuses } : {}),
          ...(req.query.sinceHours
            ? { since: new Date(Date.now() - req.query.sinceHours * 3_600_000) }
            : {}),
          limit: req.query.limit,
          ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
        });
        return { items: r2.orders, nextCursor: r2.nextCursor };
      }),
  );

  r.get(
    '/orders/:id',
    {
      schema: {
        tags: ['orders'],
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

  r.get(
    '/orders/by-ref/:ref',
    {
      schema: {
        tags: ['orders'],
        params: z.object({ ref: z.string().min(5).max(16) }),
        response: { 200: S.Order },
      },
    },
    async (req) =>
      core.uow.transaction((tx) => core.orders.getByRef(tx, req.actor, req.params.ref)),
  );

  r.post(
    '/orders/:id/transition',
    {
      schema: {
        tags: ['orders'],
        summary: 'Move an order through its lifecycle (role-checked; customers may only cancel)',
        params: S.IdParam,
        body: z.object({
          to: S.OrderStatusSchema,
          reason: z.string().max(300).optional(),
          etaMinutes: z.number().int().min(0).max(240).optional(),
          refundAmountKobo: S.koboInt.optional(),
        }),
        response: { 200: z.object({ order: S.Order, changed: z.boolean() }) },
      },
    },
    async (req) =>
      core.uow.transaction((tx) =>
        core.orders.transition(tx, req.actor, req.params.id, req.body.to, {
          ...(req.body.reason !== undefined ? { reason: req.body.reason } : {}),
          ...(req.body.etaMinutes !== undefined ? { etaMinutes: req.body.etaMinutes } : {}),
          ...(req.body.refundAmountKobo !== undefined
            ? { refundAmountKobo: kobo(req.body.refundAmountKobo) }
            : {}),
          idempotencyKey: `${req.actorKey}:${String(req.headers['idempotency-key'])}`,
        }),
      ),
  );

  // -------------------------------------------------------------------------
  // Payments & refunds
  // -------------------------------------------------------------------------
  r.post(
    '/payments/events',
    {
      preHandler: requireKinds('system'),
      schema: {
        tags: ['payments'],
        summary:
          'Ingest an already signature-verified provider event (deduped, then verified against the provider)',
        body: z.object({
          provider: z.literal('paystack'),
          eventType: z.string().max(64),
          reference: z.string().max(128).nullable(),
          payloadRedacted: z.record(z.string(), z.unknown()),
        }),
        response: { 200: z.object({ deduped: z.boolean(), outcome: z.string().optional() }) },
      },
    },
    async (req) => core.payments.processProviderEvent(req.body),
  );

  r.post(
    '/payments/:reference/verify',
    {
      preHandler: requireRoles(...MANAGERS),
      schema: {
        tags: ['payments'],
        summary: 'Force a verify-and-settle for a reference (support tool / reconciliation)',
        params: z.object({ reference: z.string().max(128) }),
        response: { 200: z.object({ outcome: z.string() }) },
      },
    },
    async (req) => ({
      outcome: await core.payments.verifyAndSettle(req.params.reference, req.actor),
    }),
  );

  r.post(
    '/refunds/:id/execute',
    {
      preHandler: requireRoles(...MANAGERS),
      schema: {
        tags: ['payments'],
        summary: 'Send a pending/failed refund to the provider (idempotent)',
        params: S.IdParam,
        response: { 200: S.Refund },
      },
    },
    async (req) => core.payments.executeRefund(req.params.id, req.actor),
  );

  r.get(
    '/refunds',
    {
      preHandler: requireRoles(...MANAGERS),
      schema: {
        tags: ['payments'],
        querystring: z.object({
          status: z.enum(['pending', 'approved', 'processing', 'success', 'failed']).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: { 200: z.array(S.Refund) },
      },
    },
    async (req) =>
      core.uow.transaction((tx) =>
        core.repos.payments.listRefunds(tx, {
          ...(req.query.status ? { status: [req.query.status] } : {}),
          limit: req.query.limit,
        }),
      ),
  );

  // -------------------------------------------------------------------------
  // Settings & audit
  // -------------------------------------------------------------------------
  r.get(
    '/settings',
    {
      preHandler: requireRoles(...ALL_STAFF),
      schema: { tags: ['settings'], response: { 200: z.record(z.string(), z.unknown()) } },
    },
    async () => core.uow.transaction((tx) => core.settings.getAll(tx)),
  );

  r.put(
    '/settings/:key',
    {
      preHandler: requireRoles(...MANAGERS),
      schema: {
        tags: ['settings'],
        summary: 'Change a business setting (validated per key, audited)',
        params: z.object({ key: z.enum(SETTING_KEYS as [string, ...string[]]) }),
        body: z.object({ value: z.unknown() }),
        response: { 200: z.object({ key: z.string(), value: z.unknown() }) },
      },
    },
    async (req) =>
      core.uow.transaction(async (tx) => ({
        key: req.params.key,
        value: await core.settings.set(
          tx,
          req.params.key as (typeof SETTING_KEYS)[number],
          req.body.value,
          req.actor,
        ),
      })),
  );

  r.get(
    '/audit',
    {
      preHandler: requireRoles(...MANAGERS),
      schema: {
        tags: ['audit'],
        querystring: z.object({
          entityType: z.string().optional(),
          entityId: z.string().optional(),
          actorId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          beforeId: z.coerce.number().int().optional(),
        }),
        response: {
          200: z.object({
            entries: z.array(S.AuditEntry),
            nextBeforeId: z.number().int().nullable(),
          }),
        },
      },
    },
    async (req) => core.uow.transaction((tx) => core.repos.audit.list(tx, S.compact(req.query))),
  );

  r.get(
    '/audit/verify',
    {
      preHandler: requireRoles(...MANAGERS),
      schema: {
        tags: ['audit'],
        summary: 'Walk the audit hash chain',
        response: {
          200: z.object({
            ok: z.boolean(),
            checked: z.number().int(),
            firstBadId: z.number().int().nullable(),
          }),
        },
      },
    },
    async () => core.uow.transaction((tx) => core.repos.audit.verify(tx)),
  );
}
