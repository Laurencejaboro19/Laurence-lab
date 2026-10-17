/**
 * Process entry point.
 *
 *   npm run dev              HTTP server + Telegram (polling locally) + background work, one process
 *   npm run dev -- --http    HTTP only (no Telegram poller)
 *   npm run dev -- --worker  jobs only (same code, different flag) — phase 7
 *
 * Wiring happens here and nowhere else: environment → pools → repositories →
 * core → engine/adapters → server. Graceful shutdown stops the poller, closes
 * the server (stop accepting), drains background work, then closes the pool.
 */
import { TelegramAdapter } from './channels/telegram/adapter.js';
import { TelegramClient } from './channels/telegram/client.js';
import {
  installWebhook,
  registerTelegramWebhook,
  TelegramPoller,
} from './channels/telegram/runner.js';
import { ChannelDispatcher } from './channels/dispatcher.js';
import { CustomerNotifier } from './channels/notifications.js';
import { loadEnv } from './config/env.js';
import { ConversationEngine } from './core/conversation/engine.js';
import { createCore } from './core/index.js';
import { InMemoryEventBus } from './core/events/in-memory.js';
import { createPool, PgUnitOfWork } from './db/client.js';
import { createRepositories } from './db/repositories/index.js';
import { buildServer } from './http/server.js';
import { MockPaymentGateway } from './providers/payments/mock-gateway.js';
import { PaystackGateway } from './providers/payments/paystack.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const args = new Set(process.argv.slice(2));
  const runHttp = args.has('--http') || !args.has('--worker');
  const runTelegram =
    !args.has('--http') && !args.has('--worker') && env.TELEGRAM_CUSTOMER_BOT_TOKEN !== '';

  const pool = createPool(env.DATABASE_URL, { max: 10, pooled: env.DATABASE_POOLED });
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
    prettyLogs: env.NODE_ENV === 'development',
    trustProxy: env.NODE_ENV === 'production',
    enforcePaystackIps: env.NODE_ENV === 'production',
  });

  // --- channels ---------------------------------------------------------------
  const brand = await core.uow.transaction((tx) => core.settings.get(tx, 'brand.name'));
  const engine = new ConversationEngine(core, { brand });
  const dispatcher = new ChannelDispatcher(core, engine, app.log);
  const notifier = new CustomerNotifier(core, dispatcher, app.log);
  events.subscribe((event) => {
    app.log.info({ type: event.type }, 'domain event');
    return notifier.onEvent(event);
  });

  let poller: TelegramPoller | null = null;
  let telegram: TelegramClient | null = null;
  if (env.TELEGRAM_CUSTOMER_BOT_TOKEN) {
    telegram = new TelegramClient({
      token: env.TELEGRAM_CUSTOMER_BOT_TOKEN,
      baseUrl: env.TELEGRAM_API_BASE_URL,
    });
    dispatcher.register(new TelegramAdapter(telegram));
    if (env.TELEGRAM_MODE === 'webhook') {
      if (!env.TELEGRAM_WEBHOOK_SECRET)
        throw new Error('TELEGRAM_WEBHOOK_SECRET is required in webhook mode');
      const path = registerTelegramWebhook(app, {
        label: 'customer',
        botToken: env.TELEGRAM_CUSTOMER_BOT_TOKEN,
        secret: env.INTERNAL_API_SECRET,
        webhookSecretToken: env.TELEGRAM_WEBHOOK_SECRET,
        dispatcher,
      });
      if (runTelegram) {
        await installWebhook(telegram, env.PUBLIC_BASE_URL, path, env.TELEGRAM_WEBHOOK_SECRET);
        app.log.info({ path }, 'telegram customer webhook installed');
      }
    } else if (runTelegram) {
      poller = new TelegramPoller(telegram, dispatcher, app.log);
    }
  } else {
    app.log.warn(
      'TELEGRAM_CUSTOMER_BOT_TOKEN not set — the customer bot is off; the API still works',
    );
  }

  // --- lifecycle ---------------------------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      if (poller) await poller.stop();
      await app.close(); // also drains background work (onClose hook)
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (runHttp) {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`internal API docs: ${env.PUBLIC_BASE_URL}/internal/v1/docs`);
  }
  if (poller && telegram) {
    const me = await telegram.getMe();
    await poller.start();
    app.log.info(
      { username: me.username },
      `telegram customer bot polling — https://t.me/${me.username ?? ''}`,
    );
  }
  // Finish anything a previous process left half-done.
  const replayed = await core.payments.replayUnprocessedEvents();
  if (replayed > 0) app.log.info({ replayed }, 'replayed unprocessed payment events');
  if (args.has('--worker')) {
    app.log.warn('worker mode: job consumers arrive in phase 7; nothing to run yet');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
