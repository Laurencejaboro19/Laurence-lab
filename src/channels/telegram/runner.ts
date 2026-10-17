/**
 * How updates reach us.
 *
 *   polling  (development, Termux, anywhere without a public URL)
 *            long-poll getUpdates; sequential by nature; offset = last update_id + 1
 *   webhook  (production) Telegram POSTs to an unguessable path; we verify the
 *            X-Telegram-Bot-Api-Secret-Token header in constant time, dedupe on
 *            update_id, hand off to the dispatcher and return 200 at once.
 *
 * Both paths call dispatcher.processInbound with the raw Update. Dedupe happens
 * inside the engine (inbound_events UNIQUE), so a retried webhook or an
 * overlapping poll never double-handles a message.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { Logger } from '../../jobs/background.js';
import type { ChannelDispatcher } from '../dispatcher.js';

import { TELEGRAM_ALLOWED_UPDATES } from './adapter.js';
import type { TelegramClient, TgUpdate } from './client.js';

export const CUSTOMER_COMMANDS = [
  { command: 'start', description: 'Start / main menu' },
  { command: 'menu', description: 'Browse the menu' },
  { command: 'cart', description: 'View your cart' },
  { command: 'track', description: 'Track your orders' },
  { command: 'orders', description: 'Order history' },
  { command: 'help', description: 'Help and support' },
  { command: 'language', description: 'English / Pidgin' },
  { command: 'privacy', description: 'Your data and privacy' },
  { command: 'delete_my_data', description: 'Delete your personal data' },
];

export class TelegramPoller {
  private running = false;
  private offset = 0;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly client: TelegramClient,
    private readonly dispatcher: ChannelDispatcher,
    private readonly log: Logger,
    private readonly pollTimeoutSeconds = 25,
  ) {}

  async start(): Promise<void> {
    // A bot cannot poll while a webhook is set.
    await this.client.deleteWebhook();
    await this.client.setMyCommands(CUSTOMER_COMMANDS).catch(() => undefined);
    this.running = true;
    this.loop = this.run();
  }

  private isRunning(): boolean {
    return this.running;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    let backoffMs = 1000;
    while (this.running) {
      try {
        const updates = await this.client.getUpdates(
          this.offset,
          this.pollTimeoutSeconds,
          TELEGRAM_ALLOWED_UPDATES,
        );
        backoffMs = 1000;
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.dispatcher.processInbound('telegram', update);
        }
      } catch (err) {
        if (!this.isRunning()) break;
        this.log.warn({ err, backoffMs }, 'telegram polling error; backing off');
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }
}

/** Unguessable webhook path derived from the bot token; never the token itself. */
export function webhookPath(botToken: string, secret: string, label: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${label}:${botToken}`)
    .digest('base64url')
    .slice(0, 32);
  return `/webhooks/telegram/${label}/${digest}`;
}

export interface TelegramWebhookOptions {
  label: 'customer' | 'admin';
  botToken: string;
  secret: string; // INTERNAL_API_SECRET; path and secret_token derive from it
  webhookSecretToken: string;
  dispatcher: ChannelDispatcher;
}

export function registerTelegramWebhook(
  app: FastifyInstance,
  opts: TelegramWebhookOptions,
): string {
  const path = webhookPath(opts.botToken, opts.secret, opts.label);
  app.post<{ Body: TgUpdate }>(
    path,
    { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } },
    async (req, reply) => {
      // REVIEW: webhook authenticity. Constant-time compare of the secret token header.
      const given = req.headers['x-telegram-bot-api-secret-token'];
      const a = Buffer.from(typeof given === 'string' ? given : '', 'utf8');
      const b = Buffer.from(opts.webhookSecretToken, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        req.log.warn({ ip: req.ip }, 'telegram webhook: bad secret token');
        return reply.status(401).send({ ok: false });
      }
      const update = req.body;
      if (typeof update.update_id !== 'number') return reply.status(400).send({ ok: false });
      // Return immediately; processing continues in the background (dedupe inside the engine).
      app.background.run(`telegram:${opts.label}:${String(update.update_id)}`, () =>
        opts.dispatcher.processInbound('telegram', update),
      );
      return reply.status(200).send({ ok: true });
    },
  );
  return path;
}

export async function installWebhook(
  client: TelegramClient,
  publicBaseUrl: string,
  path: string,
  secretToken: string,
): Promise<void> {
  await client.setWebhook(
    `${publicBaseUrl.replace(/\/$/, '')}${path}`,
    secretToken,
    TELEGRAM_ALLOWED_UPDATES,
  );
  await client.setMyCommands(CUSTOMER_COMMANDS).catch(() => undefined);
}
