import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ChannelDispatcher } from '../../src/channels/dispatcher.js';
import { CustomerNotifier } from '../../src/channels/notifications.js';
import { TelegramAdapter } from '../../src/channels/telegram/adapter.js';
import { TelegramClient } from '../../src/channels/telegram/client.js';
import { registerTelegramWebhook, webhookPath } from '../../src/channels/telegram/runner.js';
import { ConversationEngine } from '../../src/core/conversation/engine.js';
import { createCore, type Core } from '../../src/core/index.js';
import { InMemoryEventBus } from '../../src/core/events/in-memory.js';
import { createPool, PgUnitOfWork } from '../../src/db/client.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { seed } from '../../src/db/seed.js';
import { buildServer } from '../../src/http/server.js';
import { MockPaymentGateway } from '../../src/providers/payments/mock-gateway.js';
import { FakeClock, KITCHEN, SYSTEM } from '../core/setup.js';
import { resetDatabase, TEST_MIGRATE_URL, TEST_RUNTIME_URL } from '../db/helpers.js';

import { startFakeBotApi, tg, type FakeBotApi } from './fake-bot-api.js';

const run = TEST_MIGRATE_URL && TEST_RUNTIME_URL ? describe : describe.skip;
const SECRET = 'api-secret-'.padEnd(40, 'x');
const WEBHOOK_TOKEN = 'webhook-secret-token-0123456789';

/**
 * The whole Telegram customer path with a fake Bot API: real Update payloads in,
 * real Bot API calls out, real database in between. Covers the webhook route
 * (secret header, dedupe, fast 200), the polling-equivalent dispatcher path,
 * payment confirmation push, kitchen status pushes, and blocked users.
 */
run('telegram customer bot — end to end', () => {
  let api: FakeBotApi;
  let core: Core;
  let dispatcher: ChannelDispatcher;
  let pool: ReturnType<typeof createPool>;
  let gateway: MockPaymentGateway;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let path: string;
  const USER = 900001;
  let upd = 1;
  const next = () => upd++;

  const deliver = (update: unknown) => dispatcher.processInbound('telegram', update);
  const lastTexts = (n: number) => api.texts(String(USER)).slice(-n);

  beforeAll(async () => {
    await resetDatabase();
    const c = new Client({ connectionString: TEST_RUNTIME_URL });
    await c.connect();
    await seed(c);
    await c.end();
    api = await startFakeBotApi();
    pool = createPool(TEST_RUNTIME_URL!, { max: 8 });
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
    app = await buildServer({ core, pool, internalApiSecret: SECRET, logLevel: 'silent' });
    const engine = new ConversationEngine(core, { brand: 'Laurence Lab' });
    dispatcher = new ChannelDispatcher(core, engine, app.log);
    dispatcher.register(
      new TelegramAdapter(
        new TelegramClient({
          token: 'T',
          baseUrl: api.url,
          globalPerSecond: 1000,
          perChatPerSecond: 1000,
        }),
      ),
    );
    const notifier = new CustomerNotifier(core, dispatcher, app.log);
    events.subscribe((e) => notifier.onEvent(e));
    path = registerTelegramWebhook(app, {
      label: 'customer',
      botToken: 'T',
      secret: SECRET,
      webhookSecretToken: WEBHOOK_TOKEN,
      dispatcher,
    });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await api.close();
    await pool.end();
  });

  it('webhook: unguessable path, secret header checked in constant time, 200 before processing, dedupe', async () => {
    expect(path).toBe(webhookPath('T', SECRET, 'customer'));
    expect(path).toMatch(/^\/webhooks\/telegram\/customer\/[A-Za-z0-9_-]{32}$/);
    expect(path).not.toContain('T:');
    const update = tg.text(next(), USER, '/start');
    const noHeader = await app.inject({ method: 'POST', url: path, payload: update });
    expect(noHeader.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'POST',
      url: path,
      payload: update,
      headers: { 'x-telegram-bot-api-secret-token': 'nope' },
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: path,
      payload: update,
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_TOKEN },
    });
    expect(ok.statusCode).toBe(200);
    const retry = await app.inject({
      method: 'POST',
      url: path,
      payload: update,
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_TOKEN },
    });
    expect(retry.statusCode).toBe(200);
    await app.background.drain();
    // One welcome only, despite the retried delivery.
    expect(api.texts(String(USER)).filter((t) => t.includes('Welcome to'))).toHaveLength(1);
  });

  it('onboarding through real Update payloads', async () => {
    await deliver(tg.callback(next(), USER, 'lang:en'));
    expect(api.callsTo('answerCallbackQuery').length).toBeGreaterThan(0);
    expect(lastTexts(1)[0]).toMatch(/phone number/);
    await deliver(tg.contact(next(), USER, '+2348059827250'));
    expect(lastTexts(2).join('\n')).toMatch(/saved/);
    const kb = api.callsTo('sendMessage').at(-1)!.params['reply_markup'] as {
      keyboard?: unknown[];
    };
    expect(kb.keyboard).toBeDefined(); // persistent shortcuts
  });

  it('types an order, confirms, goes to delivery, shares a pin, gets a Paystack button', async () => {
    await deliver(tg.text(next(), USER, '2 jollof and 1 chicken'));
    expect(lastTexts(1)[0]).toMatch(/Add these to your cart/);
    await deliver(tg.callback(next(), USER, 'parsed:yes'));
    expect(lastTexts(1)[0]).toMatch(/Total: ₦/);
    await deliver(tg.callback(next(), USER, 'checkout'));
    await deliver(tg.callback(next(), USER, 'ful:delivery'));
    const locReq = api
      .callsTo('sendMessage')
      .filter(
        (c) =>
          (
            c.params['reply_markup'] as
              { keyboard?: { request_location?: boolean }[][] } | undefined
          )?.keyboard?.[0]?.[0]?.request_location,
      );
    expect(locReq.length).toBeGreaterThan(0);
    await deliver(tg.location(next(), USER, 6.4, 5.61));
    expect(lastTexts(1)[0]).toMatch(/Order summary/);
    await deliver(tg.callback(next(), USER, 'pay:confirm'));
    const urlMsg = api
      .callsTo('sendMessage')
      .find((c) => JSON.stringify(c.params['reply_markup'] ?? {}).includes('"url"'));
    expect(urlMsg).toBeDefined();
    expect(String(urlMsg!.params['text'])).toMatch(/expires in \d+ minutes/);
  });

  it('pushes a message when payment is confirmed and on each kitchen step', async () => {
    const order = (await core.uow.transaction((tx) => core.repos.orders.list(tx, { limit: 1 })))
      .orders[0]!;
    const payment = await core.uow.transaction((tx) =>
      core.repos.payments.findLatestForOrder(tx, order.id),
    );
    gateway.willVerify(payment!.reference, { status: 'success' });
    await core.payments.verifyAndSettle(payment!.reference, SYSTEM);
    await new Promise((r) => setTimeout(r, 50));
    expect(lastTexts(1)[0]).toMatch(/Payment received/);
    expect(lastTexts(1)[0]).toContain(`<b>${order.publicRef}</b>`);

    for (const [to, pattern] of [
      ['ACCEPTED', /accepted/],
      ['PREPARING', /being prepared/],
      ['READY', /ready/],
    ] as const) {
      await core.uow.transaction((tx) =>
        core.orders.transition(tx, KITCHEN, order.id, to, { etaMinutes: 40 }),
      );
      await new Promise((r) => setTimeout(r, 30));
      expect(lastTexts(1)[0]).toMatch(pattern);
    }
    // Tracking shows the live status.
    await deliver(tg.text(next(), USER, '/track'));
    expect(lastTexts(1)[0]).toMatch(/recent orders/);
    await deliver(tg.callback(next(), USER, `order:${order.id}`));
    expect(lastTexts(1)[0]).toMatch(/Status: Ready/);
  });

  it('stops messaging a user who blocked the bot and marks the identity unreachable', async () => {
    api.blocked.add(String(USER));
    const before = api.callsTo('sendMessage').length;
    await deliver(tg.text(next(), USER, '/help'));
    // One attempt (help text), then we stop — not three messages of hammering.
    expect(api.callsTo('sendMessage').length - before).toBeLessThanOrEqual(2);
    const identity = await core.uow.transaction((tx) =>
      core.repos.customers.findIdentity(tx, 'telegram', String(USER)),
    );
    expect(identity!.unreachableAt).not.toBeNull();
    api.blocked.delete(String(USER));
    // They come back: the next inbound clears the flag.
    await deliver(tg.text(next(), USER, '/menu'));
    const again = await core.uow.transaction((tx) =>
      core.repos.customers.findIdentity(tx, 'telegram', String(USER)),
    );
    expect(again!.unreachableAt).toBeNull();
  });

  it('declines group chats and ignores updates without a sender', async () => {
    await deliver(tg.text(next(), USER, 'hello', 'group'));
    expect(lastTexts(1)[0]).toMatch(/private chat/);
    await deliver({
      update_id: next(),
      message: { message_id: 1, chat: { id: 5, type: 'channel' }, date: 1, text: 'x' },
    });
  });
});
