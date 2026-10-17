/**
 * Proactive customer notifications on every order status change. Subscribes to
 * domain events (in-process bus now; pg-boss in phase 7 — same handler) and
 * sends through whichever channel the customer used, skipping identities that
 * blocked us.
 */
import type { OutboundMessage } from '../core/channel/types.js';
import { t, type CopyKey } from '../core/conversation/copy.js';
import { formatNaira } from '../core/domain/money.js';
import type { Core } from '../core/index.js';
import type { DomainEvent, Order } from '../core/ports/index.js';
import type { Logger } from '../jobs/background.js';

import type { ChannelDispatcher } from './dispatcher.js';

export class CustomerNotifier {
  constructor(
    private readonly core: Core,
    private readonly dispatcher: ChannelDispatcher,
    private readonly log: Logger,
  ) {}

  /** Wire this to the event bus. */
  async onEvent(event: DomainEvent): Promise<void> {
    try {
      if (event.type === 'order.transitioned')
        await this.onTransition(event.orderId, event.to, event.reason);
    } catch (err) {
      this.log.error({ err, event }, 'notification failed');
    }
  }

  private async onTransition(orderId: string, to: Order['status'], reason?: string): Promise<void> {
    const data = await this.core.uow.transaction(async (tx) => {
      const order = await this.core.repos.orders.findById(tx, orderId);
      if (!order) return null;
      const customer = await this.core.repos.customers.findById(tx, order.customerId);
      const identities = await this.core.repos.customers.identitiesOf(tx, order.customerId);
      const refunded = ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(to)
        ? await this.core.repos.payments.sumRefundedKobo(tx, orderId)
        : null;
      return {
        order,
        lang: customer?.language ?? ('en' as const),
        identities: identities.filter((i) => !i.unreachableAt),
        refunded,
      };
    });
    if (!data) return;
    const { order, lang } = data;
    const vars = {
      ref: order.publicRef,
      eta: order.etaMinutes ?? 30,
      reason: reason ?? '',
      amount: data.refunded !== null ? formatNaira(data.refunded) : '',
    };
    let key: CopyKey | null = null;
    switch (to) {
      case 'PAID':
        key = 'paid';
        break;
      case 'ACCEPTED':
        key = 'accepted';
        break;
      case 'PREPARING':
        key = 'preparing';
        break;
      case 'READY':
        key = order.fulfilment === 'pickup' ? 'ready_pickup' : 'ready';
        break;
      case 'DISPATCHED':
        key = 'dispatched';
        break;
      case 'DELIVERED':
        key = 'delivered';
        break;
      case 'REJECTED':
        key = 'rejected';
        break;
      case 'EXPIRED':
        key = 'expired';
        break;
      case 'REFUNDED':
        key = 'refunded';
        break;
      case 'PARTIALLY_REFUNDED':
        key = 'partially_refunded';
        break;
      case 'CANCELLED':
        // Customer-initiated cancellations are confirmed inline by the engine; staff ones notify here.
        if (reason === 'customer requested' || reason === 'payment_init_failed') return;
        key = 'cancelled_notice';
        break;
      case 'PLACED':
      case 'AWAITING_PAYMENT':
        return;
    }
    const body = t(lang, key, {
      ...vars,
      refund: order.paidAt
        ? t(lang, 'refunded', { amount: formatNaira(order.totalKobo), ref: order.publicRef })
        : '',
    });
    const message: OutboundMessage = {
      kind: 'text',
      body: { text: body, bold: [order.publicRef] },
    };
    for (const identity of data.identities) {
      const adapter = this.dispatcher.adapterFor(identity.channel);
      if (!adapter) continue;
      await this.dispatcher.deliver(
        adapter,
        {
          channel: identity.channel,
          externalUserId: identity.externalUserId,
          externalChatId: identity.externalChatId,
          ...(identity.handle ? { handle: identity.handle } : {}),
        },
        [message],
      );
    }
  }
}
