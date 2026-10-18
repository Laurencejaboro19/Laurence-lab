/**
 * The customer conversation engine: a deterministic, button-driven state
 * machine that turns one InboundEvent into OutboundMessages. Channel-neutral —
 * the Telegram and WhatsApp adapters feed it the same events and render the
 * same messages. No AI here: free text goes through the deterministic order
 * parser and the curated FAQ; anything unclear falls back to buttons.
 *
 * Per-user ordering: the conversation row is locked FOR UPDATE for the whole
 * handling of an event, so two messages from one user are processed one after
 * the other even if they arrive together.
 *
 * Money-moving actions (checkout, cancellation) run OUTSIDE the conversation
 * transaction, through the same services the internal API uses, so a failure
 * there never leaves the chat state half-written.
 */
import type { Choice, InboundEvent, ListRow, OutboundMessage, RichText } from '../channel/types.js';
import { paginatedList } from '../channel/limits.js';
import { DomainError } from '../domain/errors.js';
import { formatNaira, type Kobo } from '../domain/money.js';
import { parseOrderText } from '../domain/order-parser.js';
import { STATUS_LABEL_EN, type OrderStatus } from '../domain/order-status.js';
import type { Core } from '../index.js';
import type {
  Actor,
  Address,
  ChannelIdentity,
  ConversationState,
  Customer,
  MenuItem,
  Order,
  Tx,
} from '../ports/index.js';

import { QUICK_REPLY_COMMANDS, t, type CopyKey, type Lang } from './copy.js';

interface Session {
  tx: Tx;
  customer: Customer;
  identity: ChannelIdentity;
  actor: Actor;
  lang: Lang;
  conv: ConversationState;
}

interface Outcome {
  messages: OutboundMessage[];
  /** Runs after the conversation transaction commits (checkout, cancel, delete). */
  after?: () => Promise<OutboundMessage[]>;
}

const text = (body: string): OutboundMessage => ({ kind: 'text', body: { text: body } });
const rich = (body: string, bold?: string[]): RichText =>
  bold ? { text: body, bold } : { text: body };

export class ConversationEngine {
  constructor(
    private readonly core: Core,
    private readonly opts: { brand: string; privacyUrl?: string },
  ) {}

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  async handle(event: InboundEvent): Promise<OutboundMessage[]> {
    if (event.chatKind !== 'private') return [text(t('en', 'group_decline'))];

    let outcome: Outcome;
    let langForErrors: Lang = 'en';
    try {
      outcome = await this.core.uow.transaction(async (tx) => {
        const { customer, identity, isNew } = await this.core.customers.identify(tx, {
          channel: event.channel,
          externalUserId: event.identity.externalUserId,
          externalChatId: event.identity.externalChatId,
          ...(event.identity.displayName ? { displayName: event.identity.displayName } : {}),
          ...(event.identity.handle ? { handle: event.identity.handle } : {}),
          ...(event.identity.languageHint ? { languageHint: event.identity.languageHint } : {}),
        });
        const fresh = await this.core.repos.conversations.recordInbound(
          tx,
          `${event.channel}:customer`,
          event.platformEventId,
        );
        if (!fresh) return { messages: [] }; // retry of an update we already handled
        const conv = await this.core.repos.conversations.lock(tx, identity.id);
        await this.core.repos.conversations.touchIdentity(tx, identity.id, 'in', event.occurredAt);
        await this.core.repos.conversations.logMessage(tx, {
          identityId: identity.id,
          direction: 'in',
          kind: event.kind,
          ...(event.kind === 'text' ? { body: event.text } : {}),
          ...(event.kind === 'button' ? { body: event.actionId } : {}),
          ...(event.kind === 'command' ? { body: `/${event.command}` } : {}),
          externalMessageId: event.platformEventId,
          status: 'received',
        });
        const session: Session = {
          tx,
          customer,
          identity,
          actor: { type: 'customer', id: customer.id },
          lang: customer.language,
          conv,
        };
        langForErrors = session.lang;
        if (isNew && conv.state === 'idle') conv.state = 'new';
        const result = await this.dispatch(session, event);
        await this.core.repos.conversations.save(tx, conv);
        return result;
      });
    } catch (err) {
      return [text(this.friendlyError(err, langForErrors))];
    }

    if (!outcome.after) return outcome.messages;
    try {
      const more = await outcome.after();
      return [...outcome.messages, ...more];
    } catch (err) {
      return [...outcome.messages, text(this.friendlyError(err, langForErrors))];
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  private async dispatch(s: Session, event: InboundEvent): Promise<Outcome> {
    switch (event.kind) {
      case 'command':
        return this.onCommand(s, event.command, event.payload);
      case 'button':
        return this.onAction(s, event.actionId);
      case 'contact':
        return this.onContact(s, event.phoneE164);
      case 'location':
        return this.onLocation(s, event.point);
      case 'text':
        return this.onText(s, event.text);
      case 'media':
      case 'unsupported':
        return { messages: [text(t(s.lang, 'unsupported')), ...this.mainMenu(s)] };
      case 'delivery_status':
        return { messages: [] };
    }
  }

  private async onCommand(s: Session, command: string, payload?: string): Promise<Outcome> {
    switch (command) {
      case 'start':
        if (payload?.startsWith('promo_'))
          s.conv.context['pendingPromo'] = payload.slice(6).toUpperCase();
        if (s.conv.state === 'new') return this.askLanguage(s);
        if (!s.customer.phoneE164) return this.askPhone(s);
        s.conv.state = 'idle';
        return { messages: this.mainMenu(s, 'main_hint') };
      case 'menu':
        return this.showMenu(s);
      case 'cart':
        return this.showCart(s);
      case 'track':
      case 'orders':
        return this.showOrders(s);
      case 'help':
        return this.help(s);
      case 'language':
        return this.askLanguage(s);
      case 'privacy':
        return { messages: [text(t(s.lang, 'privacy_full'))] };
      case 'export_my_data': {
        const data = await this.core.customers.exportData(s.tx, s.actor, s.customer.id);
        return {
          messages: [
            text(t(s.lang, 'export_sent')),
            text(JSON.stringify(data, null, 1).slice(0, 3500)),
          ],
        };
      }
      case 'delete_my_data':
        s.conv.state = 'confirm_delete';
        return {
          messages: [
            this.buttons(t(s.lang, 'delete_confirm'), [
              this.choice(s, 'yes', 'delete:yes'),
              this.choice(s, 'no', 'delete:no'),
            ]),
          ],
        };
      case 'cancel':
        s.conv.state = 'idle';
        delete s.conv.context['pendingLines'];
        return { messages: this.mainMenu(s, 'cancel_flow') };
      default:
        return { messages: [text(t(s.lang, 'unknown'))] };
    }
  }

  private async onAction(s: Session, actionId: string): Promise<Outcome> {
    const [head = '', ...rest] = actionId.split(':');
    const arg = rest.join(':');
    switch (head) {
      case 'lang': {
        const lang = arg === 'pcm' ? 'pcm' : 'en';
        await this.core.customers.setLanguage(s.tx, s.actor, s.customer.id, lang);
        s.lang = lang;
        const msgs = [text(t(lang, 'language_set')), text(t(lang, 'privacy_short'))];
        if (!s.customer.phoneE164) return { messages: [...msgs, ...this.askPhone(s).messages] };
        s.conv.state = 'idle';
        return { messages: [...msgs, ...this.mainMenu(s, 'main_hint')] };
      }
      case 'menu':
        return this.showMenu(s);
      case 'cat': {
        const [categoryId, pageArg] = arg.split(':p');
        return this.showCategory(s, categoryId ?? '', pageArg ? Number(pageArg) : 1);
      }
      case 'item':
        return this.showItem(s, arg);
      case 'add': {
        const [itemId, qty] = arg.split(':');
        return this.addToCart(s, itemId ?? '', Number(qty ?? 1));
      }
      case 'cart':
        return this.cartAction(s, rest);
      case 'checkout':
        return this.startCheckout(s);
      case 'ful':
        return this.chooseFulfilment(s, arg === 'pickup' ? 'pickup' : 'delivery');
      case 'addr':
        return this.chooseAddress(s, arg);
      case 'zone':
        return this.chooseZone(s, arg);
      case 'pay':
        return this.confirmAndPay(s);
      case 'order':
        return this.orderAction(s, rest);
      case 'reorder':
        return this.reorder(s, arg);
      case 'parsed':
        return this.confirmParsed(s, arg === 'yes');
      case 'delete':
        if (arg !== 'yes') {
          s.conv.state = 'idle';
          return { messages: this.mainMenu(s, 'cancel_flow') };
        }
        s.conv.state = 'new';
        return {
          messages: [],
          after: async () => {
            await this.core.uow.transaction((tx) =>
              this.core.customers.deleteData(tx, s.actor, s.customer.id),
            );
            return [text(t(s.lang, 'deleted'))];
          },
        };
      case 'help':
        return this.help(s);
      case 'noop':
        return { messages: [] };
      default:
        return { messages: [text(t(s.lang, 'stale_button')), ...this.mainMenu(s)] };
    }
  }

  private async onContact(s: Session, phone: string): Promise<Outcome> {
    return this.savePhone(s, phone, true);
  }

  private async onText(s: Session, raw: string): Promise<Outcome> {
    const input = raw.trim();
    const quick = QUICK_REPLY_COMMANDS[input];
    if (quick) return this.onCommand(s, quick);

    switch (s.conv.state) {
      case 'new':
        return this.askLanguage(s);
      case 'await_phone':
        return this.savePhone(s, input, false);
      case 'await_phone_link':
        if (/^yes$/i.test(input)) {
          // Linking accounts across channels is an explicit, confirmed step; the merge itself
          // lands with the WhatsApp phase (where it is needed). Until then, keep accounts separate.
          s.conv.state = 'await_phone';
          return { messages: [text(t(s.lang, 'phone_invalid'))] };
        }
        return this.savePhone(s, input, false);
      case 'await_address_text':
        return this.addressTyped(s, input);
      default:
        break;
    }

    // Plain-language ordering.
    const items = await this.allItems(s.tx);
    const parsed = parseOrderText(
      input,
      items.map((i) => ({ slug: i.slug, name: i.name, aliases: i.aliases })),
    );
    if (parsed.lines.length > 0) {
      const lines = parsed.lines.map((l) => {
        const item = items.find((i) => i.slug === l.slug);
        return { itemId: item?.id ?? '', name: item?.name ?? l.slug, quantity: l.quantity };
      });
      s.conv.context['pendingLines'] = lines;
      s.conv.state = 'confirm_parsed';
      const summary = lines.map((l) => `• ${l.quantity} × ${l.name}`).join('\n');
      const msgs: OutboundMessage[] = [];
      if (parsed.unmatched.length)
        msgs.push(text(t(s.lang, 'parsed_unmatched', { items: parsed.unmatched.join(', ') })));
      msgs.push(
        this.buttons(t(s.lang, 'parsed_confirm', { lines: summary }), [
          this.choice(s, 'yes', 'parsed:yes'),
          this.choice(s, 'no', 'parsed:no'),
        ]),
      );
      return { messages: msgs };
    }

    const faq = await this.core.repos.conversations.findFaq(s.tx, s.lang, input);
    if (faq) return { messages: [text(faq.answer), ...this.mainMenu(s)] };
    return { messages: [text(t(s.lang, 'unknown')), ...this.mainMenu(s)] };
  }

  private async onLocation(
    s: Session,
    point: { latitude: number; longitude: number },
  ): Promise<Outcome> {
    try {
      const address = await this.core.customers.addAddress(s.tx, s.actor, s.customer.id, {
        label:
          s.customer.orderCount === 0 ? 'Home' : `Pin ${new Date().toISOString().slice(5, 10)}`,
        point,
        makeDefault: true,
      });
      return await this.useAddress(s, address, address.zoneName ?? '');
    } catch (err) {
      if (err instanceof DomainError && err.code === 'OUTSIDE_DELIVERY_AREA') {
        const zones = await this.core.repos.zones.listActive(s.tx);
        return {
          messages: [
            text(t(s.lang, 'outside_area', { zones: zones.map((z) => z.name).join(', ') })),
            ...(await this.askAddress(s)).messages,
          ],
        };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Onboarding
  // ---------------------------------------------------------------------------

  private askLanguage(s: Session): Outcome {
    s.conv.state = 'new';
    return {
      messages: [
        this.buttons(t('en', 'welcome', { brand: this.opts.brand }), [
          { label: t('en', 'lang_en'), actionId: 'lang:en' },
          { label: t('en', 'lang_pcm'), actionId: 'lang:pcm' },
        ]),
      ],
    };
  }

  private askPhone(s: Session): Outcome {
    s.conv.state = 'await_phone';
    return { messages: [{ kind: 'contact_request', body: rich(t(s.lang, 'ask_phone')) }] };
  }

  private async savePhone(s: Session, phone: string, verified: boolean): Promise<Outcome> {
    try {
      s.customer = await this.core.customers.setPhone(
        s.tx,
        s.actor,
        s.customer.id,
        phone,
        verified,
      );
    } catch (err) {
      if (err instanceof DomainError && err.code === 'VALIDATION')
        return { messages: [text(t(s.lang, 'phone_invalid'))] };
      if (err instanceof DomainError && err.code === 'CONFLICT') {
        s.conv.state = 'await_phone_link';
        return { messages: [text(t(s.lang, 'phone_linked_elsewhere'))] };
      }
      throw err;
    }
    s.conv.state = 'idle';
    const msgs = [text(t(s.lang, 'phone_saved'))];
    const promo = s.conv.context['pendingPromo'];
    if (typeof promo === 'string') {
      try {
        await this.core.cart.applyPromo(s.tx, s.actor, s.customer.id, promo);
      } catch {
        /* invalid deep-link promo: ignore silently */
      }
      delete s.conv.context['pendingPromo'];
    }
    return { messages: [...msgs, ...this.mainMenu(s, 'main_hint')] };
  }

  // ---------------------------------------------------------------------------
  // Menu & cart
  // ---------------------------------------------------------------------------

  private mainMenu(s: Session, hintKey: CopyKey = 'main_hint'): OutboundMessage[] {
    return [
      {
        kind: 'quick_replies',
        body: rich(t(s.lang, hintKey)),
        choices: [
          { label: t('en', 'qr_menu'), actionId: 'menu' },
          { label: t('en', 'qr_cart'), actionId: 'cart' },
          { label: t('en', 'qr_track'), actionId: 'track' },
          { label: t('en', 'qr_help'), actionId: 'help' },
        ],
      },
    ];
  }

  private async showMenu(s: Session): Promise<Outcome> {
    const { categories } = await this.core.catalog.customerMenu(s.tx);
    if (categories.length === 0) return { messages: [text(t(s.lang, 'menu_empty'))] };
    const rows: ListRow[] = categories.map((c) => ({
      title: c.name.slice(0, 24),
      description: `${c.items.length} items`,
      actionId: `cat:${c.id}`,
    }));
    return {
      messages: [
        paginatedList({
          body: rich(t(s.lang, 'menu_title')),
          openLabel: t(s.lang, 'open_list'),
          rows,
          page: 1,
          baseActionId: 'menu',
        }),
      ],
    };
  }

  private async showCategory(s: Session, categoryId: string, page: number): Promise<Outcome> {
    const { categories } = await this.core.catalog.customerMenu(s.tx);
    const category = categories.find((c) => c.id === categoryId);
    if (!category) return this.showMenu(s);
    const rows: ListRow[] = category.items.map((i) => ({
      title: i.name.slice(0, 24),
      description: `${formatNaira(i.priceKobo)}${i.description ? ' · ' + i.description : ''}`.slice(
        0,
        72,
      ),
      actionId: `item:${i.id}`,
    }));
    const list = paginatedList({
      body: rich(t(s.lang, 'category_items', { category: category.name }), [category.name]),
      openLabel: t(s.lang, 'open_list'),
      rows,
      page,
      baseActionId: `cat:${category.id}`,
    });
    return { messages: [list] };
  }

  private async showItem(s: Session, itemId: string): Promise<Outcome> {
    const item = await this.core.repos.menu.findItem(s.tx, itemId);
    if (!item?.active)
      return { messages: [text(t(s.lang, 'stale_button')), ...(await this.showMenu(s)).messages] };
    const body = t(s.lang, 'item_detail', {
      name: item.name,
      price: formatNaira(item.priceKobo),
      description: item.description ?? '',
    }).trim();
    if (item.available !== null && item.available <= 0) {
      return {
        messages: [
          this.buttons(`${body}\n\n${t(s.lang, 'item_sold_out')}`, [
            { label: t(s.lang, 'back_to_menu'), actionId: `cat:${item.categoryId}` },
          ]),
        ],
      };
    }
    const choices: Choice[] = [
      { label: t(s.lang, 'add_one'), actionId: `add:${item.id}:1` },
      { label: t(s.lang, 'add_two'), actionId: `add:${item.id}:2` },
      { label: t(s.lang, 'back_to_menu'), actionId: `cat:${item.categoryId}` },
    ];
    const msg: OutboundMessage = item.photoRef
      ? { kind: 'image', imageRef: item.photoRef, caption: rich(body, [item.name]), choices }
      : this.buttons(body, choices as [Choice, Choice, Choice], [item.name]);
    return { messages: [msg] };
  }

  private async addToCart(s: Session, itemId: string, quantity: number): Promise<Outcome> {
    try {
      await this.core.cart.addItem(s.tx, s.actor, s.customer.id, { itemId, quantity });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'OUT_OF_STOCK') {
        return { messages: [text(err.message), ...(await this.showMenu(s)).messages] };
      }
      if (err instanceof DomainError && err.code === 'NOT_FOUND') {
        return {
          messages: [text(t(s.lang, 'stale_button')), ...(await this.showMenu(s)).messages],
        };
      }
      throw err;
    }
    const item = await this.core.repos.menu.findItem(s.tx, itemId);
    return {
      messages: [
        text(t(s.lang, 'added', { qty: quantity, name: item?.name ?? '' })),
        ...(await this.showCart(s)).messages,
      ],
    };
  }

  private async showCart(s: Session): Promise<Outcome> {
    const q = await this.core.cart.quote(s.tx, s.actor, s.customer.id);
    if (q.cart.lines.length === 0)
      return { messages: [text(t(s.lang, 'cart_empty')), ...(await this.showMenu(s)).messages] };
    const lines = q.totals?.lines ?? [];
    const body: string[] = [t(s.lang, 'cart_title'), ''];
    for (const l of lines)
      body.push(
        t(s.lang, 'cart_line', {
          qty: l.quantity,
          name: l.name,
          total: formatNaira(l.lineTotalKobo),
        }),
      );
    if (q.totals) {
      body.push('', t(s.lang, 'cart_subtotal', { subtotal: formatNaira(q.totals.subtotalKobo) }));
      if (q.totals.deliveryFeeKobo > 0)
        body.push(t(s.lang, 'cart_delivery', { fee: formatNaira(q.totals.deliveryFeeKobo) }));
      if (q.totals.discountKobo > 0)
        body.push(t(s.lang, 'cart_discount', { discount: formatNaira(q.totals.discountKobo) }));
      body.push(t(s.lang, 'cart_total', { total: formatNaira(q.totals.totalKobo) }));
    }
    for (const p of q.problems) body.push(t(s.lang, 'cart_problem', { problem: p }));
    const messages: OutboundMessage[] = [];
    // One line-editor per line, within the 3-button limit: − / + / remove.
    for (const [i, line] of q.cart.lines.entries()) {
      const priced = lines.find((l) => l.itemId === line.itemId);
      const label = `${line.quantity} × ${priced?.name ?? ''}`;
      messages.push(
        this.buttons(label, [
          { label: '➖', actionId: `cart:dec:${line.id}` },
          { label: '➕', actionId: `cart:inc:${line.id}` },
          { label: '🗑', actionId: `cart:rm:${line.id}` },
        ]),
      );
      if (i >= 7) break; // keep chats short on cheap phones
    }
    messages.push(
      this.buttons(
        body.join('\n'),
        [
          { label: t(s.lang, 'checkout'), actionId: 'checkout' },
          { label: t(s.lang, 'back_to_menu'), actionId: 'menu' },
          { label: t(s.lang, 'clear_cart'), actionId: 'cart:clear' },
        ],
        [t(s.lang, 'cart_title')],
      ),
    );
    return { messages };
  }

  private async cartAction(s: Session, args: string[]): Promise<Outcome> {
    const [op, lineId] = args;
    if (op === 'clear') {
      await this.core.cart.clear(s.tx, s.actor, s.customer.id);
      return { messages: [text(t(s.lang, 'cart_cleared')), ...(await this.showMenu(s)).messages] };
    }
    if (!lineId) return this.showCart(s);
    const cart = await this.core.cart.getOrCreate(s.tx, s.actor, s.customer.id);
    const line = cart.lines.find((l) => l.id === lineId);
    if (!line)
      return { messages: [text(t(s.lang, 'stale_button')), ...(await this.showCart(s)).messages] };
    const next = op === 'inc' ? line.quantity + 1 : op === 'dec' ? line.quantity - 1 : 0;
    try {
      await this.core.cart.setLineQuantity(s.tx, s.actor, s.customer.id, lineId, next);
    } catch (err) {
      if (err instanceof DomainError)
        return { messages: [text(err.message), ...(await this.showCart(s)).messages] };
      throw err;
    }
    return this.showCart(s);
  }

  // ---------------------------------------------------------------------------
  // Checkout
  // ---------------------------------------------------------------------------

  private async startCheckout(s: Session): Promise<Outcome> {
    if (!s.customer.phoneE164) return this.askPhone(s);
    const cart = await this.core.cart.getOrCreate(s.tx, s.actor, s.customer.id);
    if (cart.lines.length === 0) return this.showCart(s);
    const pickup = await this.core.settings.get(s.tx, 'delivery.pickup_enabled');
    const delivery = await this.core.settings.get(s.tx, 'delivery.enabled');
    if (delivery && !pickup) return this.chooseFulfilment(s, 'delivery');
    if (pickup && !delivery) return this.chooseFulfilment(s, 'pickup');
    s.conv.state = 'await_fulfilment';
    return {
      messages: [
        this.buttons(t(s.lang, 'ask_fulfilment'), [
          { label: t(s.lang, 'delivery'), actionId: 'ful:delivery' },
          { label: t(s.lang, 'pickup'), actionId: 'ful:pickup' },
        ]),
      ],
    };
  }

  private async chooseFulfilment(s: Session, fulfilment: 'delivery' | 'pickup'): Promise<Outcome> {
    if (fulfilment === 'pickup') {
      await this.core.cart.setFulfilment(s.tx, s.actor, s.customer.id, { fulfilment: 'pickup' });
      return this.summary(s);
    }
    return this.askAddress(s);
  }

  private async askAddress(s: Session): Promise<Outcome> {
    s.conv.state = 'await_address';
    const saved = await this.core.customers.listAddresses(s.tx, s.actor, s.customer.id);
    const messages: OutboundMessage[] = [];
    if (saved.length > 0) {
      const rows: ListRow[] = saved.slice(0, 9).map((a) => ({
        title: a.label.slice(0, 24),
        description: (a.textAddress ?? 'pinned location').slice(0, 72),
        actionId: `addr:${a.id}`,
      }));
      rows.push({ title: t(s.lang, 'new_address').slice(0, 24), actionId: 'addr:new' });
      messages.push(
        paginatedList({
          body: rich(t(s.lang, 'ask_address')),
          openLabel: t(s.lang, 'open_list'),
          rows,
          page: 1,
          baseActionId: 'addr',
        }),
      );
    } else {
      messages.push({
        kind: 'location_request',
        body: rich(t(s.lang, 'ask_address')),
        typedAlternative: { label: t(s.lang, 'type_address'), actionId: 'addr:typed' },
      });
    }
    return { messages };
  }

  private async chooseAddress(s: Session, arg: string): Promise<Outcome> {
    if (arg === 'new') {
      return {
        messages: [
          {
            kind: 'location_request',
            body: rich(t(s.lang, 'ask_address')),
            typedAlternative: { label: t(s.lang, 'type_address'), actionId: 'addr:typed' },
          },
        ],
      };
    }
    if (arg === 'typed') {
      s.conv.state = 'await_address_text';
      return { messages: [text(t(s.lang, 'ask_address_text'))] };
    }
    const address = await this.core.repos.customers.findAddress(s.tx, s.customer.id, arg);
    if (!address)
      return {
        messages: [text(t(s.lang, 'stale_button')), ...(await this.askAddress(s)).messages],
      };
    const zone = address.zoneId ? await this.core.repos.zones.findById(s.tx, address.zoneId) : null;
    return this.useAddress(s, address, zone?.name ?? '');
  }

  private async addressTyped(s: Session, input: string): Promise<Outcome> {
    s.conv.context['pendingAddressText'] = input.slice(0, 300);
    const zones = await this.core.repos.zones.listActive(s.tx);
    const rows: ListRow[] = zones.map((z) => ({
      title: z.name.slice(0, 24),
      description: `${formatNaira(z.feeKobo)} delivery`,
      actionId: `zone:${z.id}`,
    }));
    s.conv.state = 'await_zone';
    return {
      messages: [
        paginatedList({
          body: rich(t(s.lang, 'ask_zone')),
          openLabel: t(s.lang, 'open_list'),
          rows,
          page: 1,
          baseActionId: 'zone',
        }),
      ],
    };
  }

  private async chooseZone(s: Session, zoneId: string): Promise<Outcome> {
    const textAddress = s.conv.context['pendingAddressText'];
    if (typeof textAddress !== 'string') return this.askAddress(s);
    const zone = await this.core.repos.zones.findById(s.tx, zoneId);
    if (!zone) return { messages: [text(t(s.lang, 'stale_button'))] };
    const address = await this.core.customers.addAddress(s.tx, s.actor, s.customer.id, {
      textAddress,
      zoneId: zone.id,
      makeDefault: true,
    });
    delete s.conv.context['pendingAddressText'];
    return this.useAddress(s, address, zone.name);
  }

  private async useAddress(s: Session, address: Address, zoneName: string): Promise<Outcome> {
    await this.core.cart.setFulfilment(s.tx, s.actor, s.customer.id, {
      fulfilment: 'delivery',
      addressId: address.id,
    });
    const cart = await this.core.cart.getOrCreate(s.tx, s.actor, s.customer.id);
    const saved = text(t(s.lang, 'address_saved', { label: address.label, zone: zoneName }));
    if (cart.lines.length === 0) return { messages: [saved, ...this.mainMenu(s)] };
    return { messages: [saved, ...(await this.summary(s)).messages] };
  }

  private async summary(s: Session): Promise<Outcome> {
    const q = await this.core.cart.quote(s.tx, s.actor, s.customer.id);
    if (!q.totals || q.cart.lines.length === 0) return this.showCart(s);
    if (q.problems.length)
      return {
        messages: [
          ...q.problems.map((p) => text(t(s.lang, 'cart_problem', { problem: p }))),
          ...(await this.showCart(s)).messages,
        ],
      };
    const prep = await this.core.settings.get(s.tx, 'store.default_prep_minutes');
    const eta = prep + (q.zone?.etaMinutes ?? 0);
    s.conv.state = 'confirm_order';
    const body = t(s.lang, 'confirm_order', {
      lines: q.totals.lines
        .map((l) => `• ${l.quantity} × ${l.name} — ${formatNaira(l.lineTotalKobo)}`)
        .join('\n'),
      subtotal: t(s.lang, 'cart_subtotal', { subtotal: formatNaira(q.totals.subtotalKobo) }),
      delivery:
        q.cart.fulfilment === 'delivery'
          ? t(s.lang, 'cart_delivery', { fee: formatNaira(q.totals.deliveryFeeKobo) })
          : t(s.lang, 'pickup'),
      discount:
        q.totals.discountKobo > 0
          ? `\n${t(s.lang, 'cart_discount', { discount: formatNaira(q.totals.discountKobo) })}`
          : '',
      total: t(s.lang, 'cart_total', { total: formatNaira(q.totals.totalKobo) }),
      fulfilment:
        q.cart.fulfilment === 'delivery'
          ? `📍 ${q.address?.label ?? ''}${q.address?.textAddress ? ' — ' + q.address.textAddress : ''}`
          : t(s.lang, 'pickup'),
      eta,
    });
    return {
      messages: [
        this.buttons(
          body,
          [
            {
              label: t(s.lang, 'pay_now', { total: formatNaira(q.totals.totalKobo) }).slice(0, 20),
              actionId: 'pay:confirm',
            },
            { label: t(s.lang, 'back_to_menu'), actionId: 'cart' },
          ],
          [t(s.lang, 'cart_total', { total: formatNaira(q.totals.totalKobo) })],
        ),
      ],
    };
  }

  private confirmAndPay(s: Session): Outcome {
    s.conv.state = 'idle';
    const { lang, actor, customer, identity } = s;
    const core = this.core;
    return {
      messages: [],
      after: async () => {
        const result = await core.orders.checkout(actor, customer.id, identity.channel);
        const minutes = Math.max(1, Math.round((result.expiresAt.getTime() - Date.now()) / 60_000));
        return [
          {
            kind: 'url_button',
            body: rich(t(lang, 'payment_sent', { minutes, ref: result.order.publicRef }), [
              result.order.publicRef,
            ]),
            label: t(lang, 'pay_now', { total: formatNaira(result.order.totalKobo) }).slice(0, 20),
            url: result.paymentUrl,
          },
          this.buttons(result.order.publicRef, [
            { label: t(lang, 'cancel_order'), actionId: `order:cancel:${result.order.id}` },
          ]),
        ];
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------

  private async showOrders(s: Session): Promise<Outcome> {
    const { orders } = await this.core.orders.listForCustomer(s.tx, s.actor, s.customer.id, 5);
    if (orders.length === 0)
      return { messages: [text(t(s.lang, 'track_none')), ...(await this.showMenu(s)).messages] };
    const rows: ListRow[] = orders.map((o) => ({
      title: `${o.publicRef} · ${formatNaira(o.totalKobo)}`.slice(0, 24),
      description: STATUS_LABEL_EN[o.status].slice(0, 72),
      actionId: `order:${o.id}`,
    }));
    return {
      messages: [
        paginatedList({
          body: rich(t(s.lang, 'track_title')),
          openLabel: t(s.lang, 'open_list'),
          rows,
          page: 1,
          baseActionId: 'orders',
        }),
      ],
    };
  }

  private async orderAction(s: Session, args: string[]): Promise<Outcome> {
    const [first, second] = args;
    if (first === 'cancel' && second) {
      const orderId = second;
      const { lang, actor } = s;
      const core = this.core;
      return {
        messages: [],
        after: async () => {
          try {
            const r = await core.uow.transaction((tx) =>
              core.orders.transition(tx, actor, orderId, 'CANCELLED', {
                reason: 'customer requested',
              }),
            );
            return [text(t(lang, 'order_cancelled', { ref: r.order.publicRef }))];
          } catch (err) {
            if (
              err instanceof DomainError &&
              (err.code === 'INVALID_TRANSITION' || err.code === 'FORBIDDEN')
            )
              return [text(t(lang, 'cannot_cancel'))];
            throw err;
          }
        },
      };
    }
    const order = await this.core.repos.orders.findById(s.tx, first ?? '');
    if (order?.customerId !== s.customer.id)
      return {
        messages: [text(t(s.lang, 'stale_button')), ...(await this.showOrders(s)).messages],
      };
    return { messages: [this.orderCard(s, order)] };
  }

  private orderCard(s: Session, order: Order): OutboundMessage {
    const body = t(s.lang, 'order_detail', {
      ref: order.publicRef,
      lines: order.items.map((i) => `• ${i.quantity} × ${i.nameSnapshot}`).join('\n'),
      total: formatNaira(order.totalKobo),
      status: STATUS_LABEL_EN[order.status],
      placed: order.placedAt.toLocaleString('en-NG', {
        timeZone: 'Africa/Lagos',
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    });
    const choices: Choice[] = [{ label: t(s.lang, 'reorder'), actionId: `reorder:${order.id}` }];
    if (['PLACED', 'AWAITING_PAYMENT', 'PAID'].includes(order.status))
      choices.push({ label: t(s.lang, 'cancel_order'), actionId: `order:cancel:${order.id}` });
    return this.buttons(body, choices as [Choice] | [Choice, Choice], [order.publicRef]);
  }

  private async reorder(s: Session, orderId: string): Promise<Outcome> {
    const order = await this.core.repos.orders.findById(s.tx, orderId);
    if (order?.customerId !== s.customer.id) return { messages: [text(t(s.lang, 'stale_button'))] };
    const skipped: string[] = [];
    for (const item of order.items) {
      if (!item.itemId) continue;
      try {
        await this.core.cart.addItem(s.tx, s.actor, s.customer.id, {
          itemId: item.itemId,
          quantity: item.quantity,
        });
      } catch {
        skipped.push(item.nameSnapshot);
      }
    }
    const msgs: OutboundMessage[] = [text(t(s.lang, 'reordered'))];
    if (skipped.length) msgs.push(text(t(s.lang, 'out_of_stock', { names: skipped.join(', ') })));
    return { messages: [...msgs, ...(await this.showCart(s)).messages] };
  }

  private async confirmParsed(s: Session, yes: boolean): Promise<Outcome> {
    const pending = s.conv.context['pendingLines'] as
      { itemId: string; name: string; quantity: number }[] | undefined;
    delete s.conv.context['pendingLines'];
    s.conv.state = 'idle';
    if (!yes || !pending) return { messages: this.mainMenu(s, 'cancel_flow') };
    const skipped: string[] = [];
    for (const l of pending) {
      try {
        await this.core.cart.addItem(s.tx, s.actor, s.customer.id, {
          itemId: l.itemId,
          quantity: l.quantity,
        });
      } catch {
        skipped.push(l.name);
      }
    }
    const msgs: OutboundMessage[] = [];
    if (skipped.length) msgs.push(text(t(s.lang, 'out_of_stock', { names: skipped.join(', ') })));
    return { messages: [...msgs, ...(await this.showCart(s)).messages] };
  }

  private async help(s: Session): Promise<Outcome> {
    const phone = await this.core.settings.get(s.tx, 'support.phone');
    return {
      messages: [
        text(t(s.lang, 'help', { support: phone || t(s.lang, 'support_default') })),
        ...this.mainMenu(s),
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buttons(
    body: string,
    choices: [Choice] | [Choice, Choice] | [Choice, Choice, Choice],
    bold?: string[],
  ): OutboundMessage {
    return { kind: 'buttons', body: rich(body, bold), choices };
  }

  private choice(s: Session, key: CopyKey, actionId: string): Choice {
    return { label: t(s.lang, key), actionId };
  }

  private async allItems(tx: Tx): Promise<MenuItem[]> {
    return this.core.repos.menu.listItems(tx);
  }

  private friendlyError(err: unknown, lang: Lang): string {
    if (err instanceof DomainError) {
      switch (err.code) {
        case 'STORE_CLOSED':
          return err.message.includes('busy')
            ? t(lang, 'busy')
            : err.message.includes('limit')
              ? err.message
              : t(lang, 'store_closed');
        case 'OUT_OF_STOCK':
          return t(lang, 'out_of_stock', { names: err.message.replace(/ just sold out$/, '') });
        case 'MINIMUM_ORDER':
          return t(lang, 'min_order', {
            min: formatNaira((err.details?.['minOrderKobo'] as Kobo | undefined) ?? (0 as Kobo)),
          });
        case 'CONFLICT':
          return err.details?.['code'] === 'UNPAID_PENDING'
            ? t(lang, 'unpaid_pending')
            : err.message;
        case 'RATE_LIMITED':
          return t(lang, 'rate_limited');
        case 'VALIDATION':
          return err.message.includes('phone') ? t(lang, 'need_phone_first') : err.message;
        case 'PROVIDER_UNAVAILABLE':
        case 'OUTSIDE_DELIVERY_AREA':
        case 'PROMO_INVALID':
          return err.message;
        case 'FORBIDDEN':
        case 'IDEMPOTENCY_MISMATCH':
        case 'INTERNAL':
        case 'INVALID_TRANSITION':
        case 'NOT_FOUND':
        case 'PAYMENT_MISMATCH':
        case 'UNAUTHENTICATED':
          return t(lang, 'error_generic');
      }
    }
    return t(lang, 'error_generic');
  }
}

export { STATUS_LABEL_EN };
export type { OrderStatus };
