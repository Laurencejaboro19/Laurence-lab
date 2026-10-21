import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { outboundLimitViolations } from '../../src/core/channel/limits.js';
import type {
  ChannelIdentity,
  InboundEvent,
  OutboundMessage,
} from '../../src/core/channel/types.js';
import { ConversationEngine } from '../../src/core/conversation/engine.js';
import { TEST_MIGRATE_URL, TEST_RUNTIME_URL } from '../db/helpers.js';

import { createTestWorld, type TestWorld } from './setup.js';

const run = TEST_MIGRATE_URL && TEST_RUNTIME_URL ? describe : describe.skip;

/**
 * Drives the channel-neutral engine with synthetic events — exactly what the
 * Telegram and (later) WhatsApp adapters produce — and checks the replies,
 * the state, and that every message respects the cross-platform limits.
 */
run('conversation engine — customer journey', () => {
  let w: TestWorld;
  let engine: ConversationEngine;
  let seq = 1000;
  const identity: ChannelIdentity = {
    channel: 'telegram',
    externalUserId: '555001',
    externalChatId: '555001',
    displayName: 'Aruya',
  };
  const base = () => ({
    channel: 'telegram' as const,
    platformEventId: String(seq++),
    identity,
    occurredAt: new Date(),
    chatKind: 'private' as const,
  });
  const cmd = (command: string, payload?: string): InboundEvent => ({
    ...base(),
    kind: 'command',
    command,
    ...(payload ? { payload } : {}),
  });
  const tap = (actionId: string): InboundEvent => ({ ...base(), kind: 'button', actionId });
  const say = (text: string): InboundEvent => ({ ...base(), kind: 'text', text });

  function texts(msgs: OutboundMessage[]): string {
    return msgs
      .map((m) => ('body' in m ? m.body.text : m.kind === 'image' ? (m.caption?.text ?? '') : ''))
      .join('\n---\n');
  }
  function actions(msgs: OutboundMessage[]): string[] {
    const out: string[] = [];
    for (const m of msgs) {
      if (m.kind === 'buttons' || m.kind === 'quick_replies')
        out.push(...m.choices.map((c) => c.actionId));
      if (m.kind === 'list') out.push(...m.rows.map((r) => r.actionId));
      if (m.kind === 'image') out.push(...(m.choices ?? []).map((c) => c.actionId));
    }
    return out;
  }
  async function send(ev: InboundEvent): Promise<OutboundMessage[]> {
    const msgs = await engine.handle(ev);
    for (const m of msgs) expect(outboundLimitViolations(m), JSON.stringify(m)).toEqual([]);
    return msgs;
  }

  beforeAll(async () => {
    w = await createTestWorld();
    engine = new ConversationEngine(w.core, { brand: 'Laurence Lab' });
  }, 60_000);
  afterAll(async () => w.close());

  it('onboards: language → privacy note → phone → main menu', async () => {
    const welcome = await send(cmd('start'));
    expect(texts(welcome)).toContain('Welcome to Laurence Lab');
    expect(actions(welcome)).toEqual(['lang:en', 'lang:pcm']);

    const afterLang = await send(tap('lang:en'));
    expect(texts(afterLang)).toContain('/delete_my_data');
    expect(afterLang.at(-1)?.kind).toBe('contact_request');

    const typed = await send(say('not a number'));
    expect(texts(typed)).toMatch(/does not look like/);

    const saved = await send({
      ...base(),
      kind: 'contact',
      phoneE164: '2348059827250',
      isSelf: true,
    });
    expect(texts(saved)).toContain('Your number is saved');
    expect(saved.at(-1)?.kind).toBe('quick_replies');
  });

  it('declines group chats and dedupes retried updates', async () => {
    const group = await send({ ...base(), kind: 'text', text: 'hi', chatKind: 'group' });
    expect(texts(group)).toMatch(/private chat/);
    const ev = cmd('menu');
    const first = await send(ev);
    expect(first.length).toBeGreaterThan(0);
    const again = await send(ev); // same platformEventId
    expect(again).toEqual([]);
  });

  it('browses the menu by category and adds an item with buttons', async () => {
    const menu = await send(cmd('menu'));
    expect(menu[0]?.kind).toBe('list');
    const catAction = actions(menu).find((a) => a.startsWith('cat:'))!;
    const items = await send(tap(catAction));
    const itemAction = actions(items).find((a) => a.startsWith('item:'))!;
    const detail = await send(tap(itemAction));
    expect(texts(detail)).toMatch(/₦/);
    const addAction = actions(detail).find((a) => a.startsWith('add:') && a.endsWith(':2'))!;
    const cart = await send(tap(addAction));
    expect(texts(cart)).toMatch(/Added 2 ×/);
    expect(texts(cart)).toMatch(/Total: ₦/);
    expect(actions(cart)).toContain('checkout');
  });

  it('understands a typed order and asks for confirmation', async () => {
    await send(tap('cart:clear'));
    const parsed = await send(say('I want 2 jollof, 1 chicken and a bottle water'));
    expect(texts(parsed)).toMatch(/2 × Jollof Rice/);
    expect(texts(parsed)).toMatch(/1 × Chicken/);
    expect(texts(parsed)).toMatch(/1 × Bottled Water/);
    expect(actions(parsed)).toEqual(['parsed:yes', 'parsed:no']);
    const cart = await send(tap('parsed:yes'));
    expect(texts(cart)).toMatch(/2 × Jollof Rice/);
    const unknown = await send(say('do you have egusi?'));
    expect(texts(unknown)).toMatch(/couldn't find|didn't get|Menu/);
  });

  it('answers FAQ questions from curated data', async () => {
    const faq = await send(say('what time do you open'));
    expect(texts(faq)).toMatch(/9:00 AM to 9:00 PM/);
  });

  it('checks out: delivery → share location → summary → pay link, then cancels', async () => {
    const ful = await send(tap('checkout'));
    expect(actions(ful)).toEqual(['ful:delivery', 'ful:pickup']);
    const addr = await send(tap('ful:delivery'));
    expect(addr[0]?.kind).toBe('location_request');

    const outside = await send({
      ...base(),
      kind: 'location',
      point: { latitude: 6.5, longitude: 3.4 },
    });
    expect(texts(outside)).toMatch(/do not deliver to that location/);

    const summary = await send({
      ...base(),
      kind: 'location',
      point: { latitude: 6.4, longitude: 5.61 },
    });
    expect(texts(summary)).toMatch(/Zone A/);
    expect(texts(summary)).toMatch(/Order summary/);
    expect(texts(summary)).toMatch(/Delivery: ₦500/);
    expect(actions(summary)).toContain('pay:confirm');

    const pay = await send(tap('pay:confirm'));
    const link = pay.find(
      (m): m is Extract<OutboundMessage, { kind: 'url_button' }> => m.kind === 'url_button',
    );
    expect(link).toBeDefined();
    expect(link!.url.startsWith('https://')).toBe(true);
    expect(texts(pay)).toMatch(/expires in \d+ minutes/);
    const cancelAction = actions(pay).find((a) => a.startsWith('order:cancel:'))!;

    const cancelled = await send(tap(cancelAction));
    expect(texts(cancelled)).toMatch(/cancelled/);
    const again = await send(tap(cancelAction));
    expect(texts(again)).toMatch(/no longer be cancelled|cancelled/);
  });

  it('tracks orders, shows detail and reorders', async () => {
    const track = await send(cmd('track'));
    expect(track[0]?.kind).toBe('list');
    const orderAction = actions(track).find((a) => a.startsWith('order:'))!;
    const detail = await send(tap(orderAction));
    expect(texts(detail)).toMatch(/Status: Cancelled/);
    const reorderAction = actions(detail).find((a) => a.startsWith('reorder:'))!;
    const cart = await send(tap(reorderAction));
    expect(texts(cart)).toMatch(/previous order/);
    expect(texts(cart)).toMatch(/Jollof Rice/);
  });

  it('switches to Pidgin and keeps working', async () => {
    const lang = await send(cmd('language'));
    expect(actions(lang)).toContain('lang:pcm');
    const pcm = await send(tap('lang:pcm'));
    expect(texts(pcm)).toMatch(/Pidgin e be/);
    const cart = await send(cmd('cart'));
    expect(texts(cart)).toMatch(/Total: ₦/);
    await send(tap('lang:en'));
  });

  it('responds gracefully to stale buttons and unsupported media', async () => {
    const stale = await send(tap('something:from:an:old:message'));
    expect(texts(stale)).toMatch(/expired/);
    const media = await send({ ...base(), kind: 'media', mediaKind: 'audio', mediaRef: 'x' });
    expect(texts(media)).toMatch(/can't read/);
  });

  it('tells the customer when the store is closed instead of taking money', async () => {
    await send(tap('cart:clear'));
    await send(say('2 jollof'));
    await send(tap('parsed:yes'));
    await send(tap('checkout'));
    await send(tap('ful:pickup'));
    w.clock.closed();
    const closed = await send(tap('pay:confirm'));
    expect(texts(closed)).toMatch(/closed right now/);
    w.clock.reset();
    expect(w.events.ofType('order.payment_initialised').length).toBeGreaterThanOrEqual(1);
  });

  it('deletes personal data on explicit confirmation and starts fresh', async () => {
    const ask = await send(cmd('delete_my_data'));
    expect(actions(ask)).toEqual(['delete:yes', 'delete:no']);
    const done = await send(tap('delete:yes'));
    expect(texts(done)).toMatch(/removed/);
    const customer = await w.core.uow.transaction((tx) =>
      w.core.repos.customers.findIdentity(tx, 'telegram', identity.externalUserId),
    );
    // The identity was anonymised, so a new /start creates a fresh customer.
    expect(customer).toBeNull();
    const fresh = await send(cmd('start'));
    expect(actions(fresh)).toEqual(['lang:en', 'lang:pcm']);
    expect((await w.core.uow.transaction((tx) => w.core.repos.audit.verify(tx))).ok).toBe(true);
  });
});
