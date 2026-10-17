import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertCallback, html, TelegramAdapter } from '../../src/channels/telegram/adapter.js';
import { TelegramClient } from '../../src/channels/telegram/client.js';
import { paginatedList } from '../../src/core/channel/limits.js';
import type { ChannelIdentity } from '../../src/core/channel/types.js';

import { startFakeBotApi, tg, type FakeBotApi } from './fake-bot-api.js';

describe('telegram adapter — normalise (pure)', () => {
  const adapter = new TelegramAdapter(
    new TelegramClient({ token: 'x', baseUrl: 'http://127.0.0.1:1' }),
  );

  it('maps text, commands with payloads, contacts, locations, callbacks and media', () => {
    expect(adapter.normalise(tg.text(1, 42, 'hello'))[0]).toMatchObject({
      kind: 'text',
      text: 'hello',
      chatKind: 'private',
      platformEventId: '1',
    });
    expect(adapter.normalise(tg.text(2, 42, '/start promo_WELCOME10'))[0]).toMatchObject({
      kind: 'command',
      command: 'start',
      payload: 'promo_WELCOME10',
    });
    expect(adapter.normalise(tg.text(3, 42, '/Menu@LaurenceLabBot'))[0]).toMatchObject({
      kind: 'command',
      command: 'menu',
    });
    expect(adapter.normalise(tg.contact(4, 42, '+234 805 982 7250'))[0]).toMatchObject({
      kind: 'contact',
      phoneE164: '2348059827250',
      isSelf: true,
    });
    expect(adapter.normalise(tg.location(5, 42, 6.4, 5.61))[0]).toMatchObject({
      kind: 'location',
      point: { latitude: 6.4, longitude: 5.61 },
    });
    expect(adapter.normalise(tg.callback(6, 42, 'add:abc:2', 77))[0]).toMatchObject({
      kind: 'button',
      actionId: 'add:abc:2',
      ackToken: 'cq6',
      messageRef: { externalChatId: '42', externalMessageId: '77' },
    });
    expect(adapter.normalise(tg.photo(7, 42))[0]).toMatchObject({
      kind: 'media',
      mediaKind: 'image',
      mediaRef: 'big',
      caption: 'look',
    });
  });

  it('flags group chats, edits and forwards; ignores updates it does not understand', () => {
    expect(adapter.normalise(tg.text(8, 42, 'hi', 'supergroup'))[0]?.chatKind).toBe('group');
    const edited = { update_id: 9, edited_message: tg.text(9, 42, 'changed').message };
    expect(adapter.normalise(edited)[0]).toMatchObject({ kind: 'text', edited: true });
    const forwarded = tg.text(10, 42, 'fwd');
    (forwarded.message as { forward_date?: number }).forward_date = 1;
    expect(adapter.normalise(forwarded)[0]?.forwarded).toBe(true);
    expect(adapter.normalise({ update_id: 11, my_chat_member: {} })).toEqual([]);
    expect(adapter.normalise({ nope: true })).toEqual([]);
  });

  it('carries the Telegram identity (id, chat, name, handle, language hint)', () => {
    const ev = adapter.normalise(tg.text(12, 42, 'x'))[0]!;
    expect(ev.identity).toEqual({
      channel: 'telegram',
      externalUserId: '42',
      externalChatId: '42',
      displayName: 'Aruya E.O',
      handle: 'user42',
      languageHint: 'en',
    });
  });
});

describe('telegram adapter — rendering', () => {
  it('escapes HTML and bolds spans after escaping', () => {
    expect(html({ text: 'Fish & <chips> for ₦1,000', bold: ['₦1,000'] })).toBe(
      'Fish &amp; &lt;chips&gt; for <b>₦1,000</b>',
    );
    expect(html({ text: 'a < b', bold: ['<'] })).toBe('a <b>&lt;</b> b');
  });

  it('refuses callback data over 64 bytes', () => {
    expect(assertCallback('add:' + 'a'.repeat(36) + ':12')).toBeTruthy();
    expect(() => assertCallback('x'.repeat(65))).toThrow(/64 bytes/);
    // Every action id the engine builds fits: uuid-based ids are the longest.
    expect(Buffer.byteLength(`order:cancel:${'0'.repeat(36)}`)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(`cat:${'0'.repeat(36)}:p99`)).toBeLessThanOrEqual(64);
  });
});

describe('telegram adapter — send through a fake Bot API', () => {
  let api: FakeBotApi;
  let adapter: TelegramAdapter;
  const identity: ChannelIdentity = {
    channel: 'telegram',
    externalUserId: '42',
    externalChatId: '42',
  };

  beforeAll(async () => {
    api = await startFakeBotApi();
    adapter = new TelegramAdapter(
      new TelegramClient({
        token: 'T',
        baseUrl: api.url,
        globalPerSecond: 1000,
        perChatPerSecond: 1000,
      }),
    );
  });
  afterAll(async () => api.close());

  it('renders buttons, lists with paging, quick replies, url buttons and requests', async () => {
    await adapter.send(identity, {
      kind: 'buttons',
      body: { text: 'Pick' },
      choices: [
        { label: 'A', actionId: 'a' },
        { label: 'B', actionId: 'b' },
      ],
    });
    const list = paginatedList({
      body: { text: 'Menu' },
      openLabel: 'Open',
      rows: Array.from({ length: 23 }, (_, i) => ({
        title: `Item ${i}`,
        description: 'desc',
        actionId: `item:${i}`,
      })),
      page: 2,
      baseActionId: 'cat:x',
    });
    await adapter.send(identity, list);
    await adapter.send(identity, {
      kind: 'quick_replies',
      body: { text: 'Hi' },
      choices: [
        { label: '🍽 Menu', actionId: 'menu' },
        { label: '🛒 Cart', actionId: 'cart' },
        { label: '📦 Track', actionId: 'track' },
        { label: '❓ Help', actionId: 'help' },
      ],
    });
    await adapter.send(identity, {
      kind: 'url_button',
      body: { text: 'Pay' },
      label: 'Pay ₦2,500',
      url: 'https://checkout.paystack.com/x',
    });
    await adapter.send(identity, {
      kind: 'location_request',
      body: { text: 'Where?' },
      typedAlternative: { label: 'Type', actionId: 'addr:typed' },
    });
    await adapter.send(identity, { kind: 'contact_request', body: { text: 'Phone?' } });

    const sends = api.callsTo('sendMessage').map((c) => c.params);
    expect((sends[0]!['reply_markup'] as { inline_keyboard: unknown[][] }).inline_keyboard).toEqual(
      [[{ text: 'A', callback_data: 'a' }], [{ text: 'B', callback_data: 'b' }]],
    );
    const listRows = (
      sends[1]!['reply_markup'] as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard;
    expect(listRows).toHaveLength(11); // 10 rows + nav
    expect(listRows[10]!.map((b) => b.text)).toEqual(['‹', '2/3', '›']);
    expect(listRows[10]![0]!.callback_data).toBe('cat:x:p1');
    expect(listRows[10]![2]!.callback_data).toBe('cat:x:p3');
    expect(
      (sends[2]!['reply_markup'] as { keyboard: { text: string }[][]; is_persistent: boolean })
        .keyboard,
    ).toEqual([
      [{ text: '🍽 Menu' }, { text: '🛒 Cart' }],
      [{ text: '📦 Track' }, { text: '❓ Help' }],
    ]);
    expect(
      (sends[3]!['reply_markup'] as { inline_keyboard: { url: string }[][] })
        .inline_keyboard[0]![0]!.url,
    ).toBe('https://checkout.paystack.com/x');
    expect(
      (sends[4]!['reply_markup'] as { keyboard: { request_location: boolean }[][] })
        .keyboard[0]![0]!.request_location,
    ).toBe(true);
    expect(
      (sends[6]!['reply_markup'] as { keyboard: { request_contact: boolean }[][] }).keyboard[0]![0]!
        .request_contact,
    ).toBe(true);
    expect(sends.every((s) => s['parse_mode'] === 'HTML' || s['text'] === '…')).toBe(true);
  });

  it('edits in place when a message ref is supplied', async () => {
    const r = await adapter.send(identity, {
      kind: 'buttons',
      body: { text: 'Updated' },
      choices: [{ label: 'X', actionId: 'x' }],
      replaces: { channel: 'telegram', externalChatId: '42', externalMessageId: '55' },
    });
    expect(r.ok).toBe(true);
    expect(api.callsTo('editMessageText').at(-1)?.params).toMatchObject({
      chat_id: '42',
      message_id: 55,
      text: 'Updated',
    });
  });

  it('reports blocked users as unreachable and honours 429 retry_after once', async () => {
    api.blocked.add('42');
    const r = await adapter.send(identity, { kind: 'text', body: { text: 'hello' } });
    expect(r).toMatchObject({ ok: false, unreachable: true });
    api.blocked.delete('42');
    api.rateLimitNext = 1;
    const before = api.callsTo('sendMessage').length;
    const r2 = await adapter.send(identity, { kind: 'text', body: { text: 'again' } });
    expect(r2.ok).toBe(true);
    expect(api.callsTo('sendMessage').length).toBe(before + 2); // retried once after retry_after
  }, 10_000);

  it('answers callback queries', async () => {
    await adapter.acknowledgeButton({
      kind: 'button',
      actionId: 'a',
      ackToken: 'cq1',
      channel: 'telegram',
      platformEventId: '1',
      identity,
      occurredAt: new Date(),
      chatKind: 'private',
    });
    expect(api.callsTo('answerCallbackQuery').at(-1)?.params).toMatchObject({
      callback_query_id: 'cq1',
    });
  });
});
