/**
 * Connects platform adapters to the conversation engine and the outbound side.
 *
 *   raw update ─► adapter.normalise ─► engine.handle ─► adapter.send (per message, in order)
 *
 * Per-user ordering across concurrently arriving updates is enforced here with
 * an in-memory promise chain per chat (fast path) and in the engine with the
 * conversation row lock (correctness path, also across processes).
 */
import type {
  ChannelAdapter,
  ChannelIdentity,
  InboundEvent,
  OutboundMessage,
} from '../core/channel/types.js';
import type { ConversationEngine } from '../core/conversation/engine.js';
import type { Core } from '../core/index.js';
import type { Logger } from '../jobs/background.js';

export class ChannelDispatcher {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly core: Core,
    private readonly engine: ConversationEngine,
    private readonly log: Logger,
  ) {}

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  adapterFor(channel: string): ChannelAdapter | undefined {
    return this.adapters.get(channel);
  }

  /** Entry point for webhooks and the poller. Never throws; failures are logged. */
  async processInbound(channel: 'telegram' | 'whatsapp', rawPayload: unknown): Promise<void> {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      this.log.warn({ channel }, 'no adapter registered');
      return;
    }
    let events: InboundEvent[];
    try {
      events = adapter.normalise(rawPayload);
    } catch (err) {
      this.log.error({ err, channel }, 'failed to normalise inbound payload');
      return;
    }
    for (const event of events) {
      const key = `${channel}:${event.identity.externalChatId}`;
      const prev = this.chains.get(key) ?? Promise.resolve();
      const next = prev.catch(() => undefined).then(() => this.handleOne(adapter, event));
      this.chains.set(key, next);
      await next;
      if (this.chains.get(key) === next) this.chains.delete(key);
    }
  }

  private async handleOne(adapter: ChannelAdapter, event: InboundEvent): Promise<void> {
    const started = Date.now();
    if (event.kind === 'button' && adapter.acknowledgeButton) void adapter.acknowledgeButton(event);
    if (event.kind === 'text' || event.kind === 'command')
      void adapter.send(event.identity, { kind: 'typing' });
    let messages: OutboundMessage[];
    try {
      messages = await this.engine.handle(event);
    } catch (err) {
      this.log.error(
        { err, event: { kind: event.kind, id: event.platformEventId } },
        'engine failed',
      );
      return;
    }
    await this.deliver(adapter, event.identity, messages);
    this.log.info(
      {
        channel: event.channel,
        kind: event.kind,
        replies: messages.length,
        ms: Date.now() - started,
      },
      'inbound handled',
    );
  }

  /** Sends messages in order, logs them, and marks identities unreachable when the platform says so. */
  async deliver(
    adapter: ChannelAdapter,
    identity: ChannelIdentity,
    messages: OutboundMessage[],
  ): Promise<void> {
    for (const message of messages) {
      const result = await adapter.send(identity, message);
      if (message.kind === 'typing') continue;
      try {
        await this.core.uow.transaction(async (tx) => {
          const stored = await this.core.repos.customers.findIdentity(
            tx,
            identity.channel,
            identity.externalUserId,
          );
          if (!stored) return;
          await this.core.repos.conversations.logMessage(tx, {
            identityId: stored.id,
            direction: 'out',
            kind: message.kind,
            ...('body' in message ? { body: message.body.text } : {}),
            ...(result.messageRef
              ? { externalMessageId: result.messageRef.externalMessageId }
              : {}),
            status: result.ok ? 'sent' : 'failed',
          });
          if (result.ok)
            await this.core.repos.conversations.touchIdentity(tx, stored.id, 'out', new Date());
          if (result.unreachable)
            await this.core.repos.conversations.markUnreachable(tx, stored.id, new Date());
        });
      } catch (err) {
        this.log.warn({ err }, 'could not log outbound message');
      }
      if (!result.ok) {
        this.log.warn(
          { channel: identity.channel, error: result.error, unreachable: result.unreachable },
          'send failed',
        );
        if (result.unreachable) return; // stop hammering a user who blocked us
      }
    }
  }
}
