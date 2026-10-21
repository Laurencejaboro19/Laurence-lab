/**
 * Serverless entry (Vercel). See docs/DECISION_RECORD.md DR-012 for why this
 * exists and what it costs.
 *
 * Differences from main.ts, all forced by "no always-on process":
 *   - Telegram is webhook-only (polling needs a process that stays up).
 *   - Background work runs INLINE before the response is sent, because a
 *     serverless function may be frozen the moment it responds. Telegram and
 *     Paystack both tolerate a few seconds.
 *   - Scheduled jobs (expire unpaid orders, reconcile payments, replay events)
 *     piggyback on incoming requests, throttled to once per minute via a row in
 *     app.settings, plus a daily cron hitting /jobs/daily (Hobby plan limit).
 *   - A tiny `/setup/*` surface, protected by a derived key, lets the owner run
 *     migrations/seed and install the Telegram webhook from a browser — no
 *     local tooling required.
 *
 * The app is built once per warm instance and reused across invocations.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { z } from 'zod';

import { TelegramAdapter } from '../channels/telegram/adapter.js';
import { TelegramClient } from '../channels/telegram/client.js';
import { installWebhook, registerTelegramWebhook } from '../channels/telegram/runner.js';
import { ChannelDispatcher } from '../channels/dispatcher.js';
import { CustomerNotifier } from '../channels/notifications.js';
import { loadEnv, type Env } from '../config/env.js';
import { ConversationEngine } from '../core/conversation/engine.js';
import { kobo } from '../core/domain/money.js';
import { customerEmail } from '../core/services/orders.js';
import { createCore, type Core } from '../core/index.js';
import { InMemoryEventBus } from '../core/events/in-memory.js';
import { createPool, PgUnitOfWork, sslFor } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { seed } from '../db/seed.js';
import { MockPaymentGateway } from '../providers/payments/mock-gateway.js';
import { PaystackGateway } from '../providers/payments/paystack.js';

import { buildServer } from './server.js';

/** Derived, URL-safe key for the setup routes. Printed by `npm run setup-key`. */
export function setupKey(internalApiSecret: string): string {
  return createHash('sha256').update(`setup:${internalApiSecret}`).digest('base64url').slice(0, 32);
}

const MAINTENANCE_KEY = 'ops.last_maintenance_at';

async function maintenance(
  core: Core,
  log: { info: (o: object, m: string) => void },
): Promise<Record<string, unknown>> {
  const expired = await core.uow.transaction((tx) => core.orders.expireOverdue(tx, 50));
  const reconciled = await core.payments.reconcilePending(2, 25);
  const replayed = await core.payments.replayUnprocessedEvents(30, 25);
  const refunds = await core.uow.transaction((tx) =>
    core.repos.payments.listRefunds(tx, { status: ['pending'], limit: 10 }),
  );
  let refundsSent = 0;
  for (const r of refunds) {
    await core.payments.executeRefund(r.id, { type: 'system', id: 'maintenance' });
    refundsSent++;
  }
  const result = { expired, reconciled, replayed, refundsSent };
  log.info(result, 'maintenance sweep');
  return result;
}

/** Run the sweep at most once a minute, triggered by whatever request arrives. */
async function maybeMaintenance(
  core: Core,
  log: { info: (o: object, m: string) => void },
): Promise<void> {
  const due = await core.uow.transaction(async (tx) => {
    const last = await core.repos.settings.get(tx, MAINTENANCE_KEY);
    const lastMs = typeof last === 'number' ? last : 0;
    if (Date.now() - lastMs < 60_000) return false;
    await core.repos.settings.set(tx, MAINTENANCE_KEY, Date.now(), 'system:maintenance');
    return true;
  });
  if (due) await maintenance(core, log);
}

async function build(env: Env): Promise<FastifyInstance> {
  const pool = createPool(env.DATABASE_URL, { max: 2, pooled: env.DATABASE_POOLED });
  const events = new InMemoryEventBus();
  const uow = new PgUnitOfWork(pool, {
    onCommit: (tx) => events.flush(tx),
    onRollback: (tx) => {
      events.discard(tx);
    },
  });
  const gateway = env.PAYSTACK_SECRET_KEY.startsWith('sk_')
    ? new PaystackGateway({ secretKey: env.PAYSTACK_SECRET_KEY, baseUrl: env.PAYSTACK_BASE_URL })
    : new MockPaymentGateway();
  const core = createCore({ uow, repos: createRepositories(), gateway, events });

  const app = await buildServer({
    core,
    pool,
    internalApiSecret: env.INTERNAL_API_SECRET,
    logLevel: env.LOG_LEVEL,
    trustProxy: true,
    enforcePaystackIps: env.NODE_ENV === 'production',
    backgroundMode: 'inline',
    docsUi: false, // see server.ts: @fastify/static cannot load on Vercel's Node 24
  });

  const brand = await core.uow
    .transaction((tx) => core.settings.get(tx, 'brand.name'))
    .catch(() => 'Laurence Lab');
  const engine = new ConversationEngine(core, { brand });
  const dispatcher = new ChannelDispatcher(core, engine, app.log);
  const notifier = new CustomerNotifier(core, dispatcher, app.log);
  events.subscribe((event) => notifier.onEvent(event));

  let telegram: TelegramClient | null = null;
  let telegramPath: string | null = null;
  if (env.TELEGRAM_CUSTOMER_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET) {
    telegram = new TelegramClient({
      token: env.TELEGRAM_CUSTOMER_BOT_TOKEN,
      baseUrl: env.TELEGRAM_API_BASE_URL,
    });
    dispatcher.register(new TelegramAdapter(telegram));
    telegramPath = registerTelegramWebhook(app, {
      label: 'customer',
      botToken: env.TELEGRAM_CUSTOMER_BOT_TOKEN,
      secret: env.INTERNAL_API_SECRET,
      webhookSecretToken: env.TELEGRAM_WEBHOOK_SECRET,
      dispatcher,
    });
  }

  // Piggyback maintenance after each webhook, inline (see file header).
  app.addHook('onResponse', (req, _reply, done) => {
    if (req.url.startsWith('/webhooks/')) {
      maybeMaintenance(core, app.log).catch((err: unknown) => {
        app.log.warn({ err }, 'maintenance failed');
      });
    }
    done();
  });

  // --- owner setup surface ----------------------------------------------------
  const key = setupKey(env.INTERNAL_API_SECRET);
  const guard = (q: unknown): boolean => {
    const parsed = z.object({ key: z.string() }).safeParse(q);
    return parsed.success && parsed.data.key === key;
  };

  app.get('/', () => ({
    service: 'laurence-lab-bot',
    status: 'ok',
    telegram: telegram
      ? 'configured'
      : 'missing TELEGRAM_CUSTOMER_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET',
    payments: gateway.name,
    openapi: '/internal/v1/openapi.json',
  }));

  app.get('/setup', async (req, reply) => {
    if (!guard(req.query)) return reply.status(401).send({ error: 'bad key' });
    const dbOk = await core.uow
      .transaction(async (tx) => (await core.repos.settings.get(tx, 'brand.name')) !== undefined)
      .then(() => true)
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    return {
      database: dbOk === true ? 'reachable' : `error: ${String(dbOk)}`,
      telegram: telegram ? 'configured' : 'not configured',
      paystack: gateway.name,
      steps: ['/setup/migrate', '/setup/seed', '/setup/telegram'].map((p) => `${p}?key=…`),
    };
  });

  app.get('/setup/migrate', async (req, reply) => {
    if (!guard(req.query)) return reply.status(401).send({ error: 'bad key' });
    const url = env.DATABASE_URL_MIGRATE ?? env.DATABASE_URL_DIRECT;
    const client = new Client({
      connectionString: url,
      ssl: sslFor(url),
    });
    await client.connect();
    try {
      const applied: string[] = [];
      const result = await runMigrations(client, undefined, (l) => applied.push(l));
      return { applied: result.applied, alreadyUpToDate: result.skipped };
    } finally {
      await client.end();
    }
  });

  app.get('/setup/seed', async (req, reply) => {
    if (!guard(req.query)) return reply.status(401).send({ error: 'bad key' });
    const url = env.DATABASE_URL_DIRECT;
    const client = new Client({
      connectionString: url,
      ssl: sslFor(url),
    });
    await client.connect();
    try {
      const lines: string[] = [];
      await seed(client, (l) => lines.push(l));
      return { seeded: lines };
    } finally {
      await client.end();
    }
  });

  app.get('/setup/telegram', async (req, reply) => {
    if (!guard(req.query)) return reply.status(401).send({ error: 'bad key' });
    if (!telegram || !telegramPath)
      return reply.status(400).send({ error: 'telegram not configured' });
    await installWebhook(telegram, env.PUBLIC_BASE_URL, telegramPath, env.TELEGRAM_WEBHOOK_SECRET);
    const me = await telegram.getMe();
    return { webhook: 'installed', bot: `https://t.me/${me.username ?? ''}` };
  });

  // Asks Paystack to create a ₦100 checkout the same way a real order does and shows the
  // raw answer. Nothing is charged unless someone pays on the returned page.
  app.get('/setup/paystack', async (req, reply) => {
    if (!guard(req.query)) return reply.status(401).send({ error: 'bad key' });
    const domain = await core.uow.transaction((tx) =>
      core.settings.get(tx, 'payments.customer_email_domain'),
    );
    const email = customerEmail('setup-check', '+2340000000000', domain);
    try {
      const init = await gateway.initialise({
        reference: `SETUP-${Date.now()}`,
        amountKobo: kobo(10_000),
        email,
        metadata: { purpose: 'setup-check' },
      });
      return { paystack: gateway.name, email, ok: true, checkoutPage: init.authorizationUrl };
    } catch (err) {
      return reply.status(502).send({
        paystack: gateway.name,
        email,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/jobs/daily', async (req, reply) => {
    // Vercel cron sends Authorization: Bearer $CRON_SECRET when CRON_SECRET is set.
    const auth = req.headers.authorization;
    const cron = process.env['CRON_SECRET'];
    if (cron && auth !== `Bearer ${cron}` && !guard(req.query))
      return reply.status(401).send({ error: 'unauthorised' });
    return maintenance(core, app.log);
  });

  await app.ready();
  return app;
}

let appPromise: Promise<FastifyInstance> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  appPromise ??= build(loadEnv()).catch((err: unknown) => {
    appPromise = null; // allow a retry on the next invocation
    throw err;
  });
  const app = await appPromise;
  app.server.emit('request', req, res);
}
