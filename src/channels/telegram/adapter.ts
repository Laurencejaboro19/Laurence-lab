/**
 * Telegram ChannelAdapter: Update → InboundEvent (pure) and OutboundMessage →
 * Bot API calls. Everything Telegram-specific lives in this folder; the core
 * never sees an Update.
 *
 * Rendering choices
 *   buttons        inline keyboard, one button per row (thumb-friendly); edits in place when
 *                  `replaces` is set
 *   quick_replies  persistent reply keyboard (Menu / Cart / Track / Help)
 *   list           inline keyboard rows + "‹ 2/5 ›" navigation
 *   url_button     inline keyboard with a URL button (the Paystack link)
 *   location_request / contact_request  reply keyboard with request_location / request_contact
 *   image          sendPhoto with caption + inline keyboard
 *   edit           editMessageText (buttons removed)
 *   typing         sendChatAction
 *
 * Callback data must be ≤ 64 bytes: action ids are built short by the core and
 * asserted here; anything longer is a bug and is refused loudly in development.
 */
import { CHANNEL_LIMITS } from '../../core/channel/types.js';
import type {
  ChannelAdapter,
  ChannelIdentity,
  Choice,
  InboundButton,
  InboundEvent,
  MessageRef,
  OutboundMessage,
  RichText,
  SendResult,
} from '../../core/channel/types.js';
import { normalisePhone } from '../../core/services/customers.js';

import {
  escapeHtml,
  TelegramApiError,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  type ReplyKeyboardMarkup,
  type ReplyMarkup,
  type TelegramClient,
  type TgChat,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from './client.js';

export const TELEGRAM_ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
];

const COMMAND_RE = /^\/([a-z_]{1,32})(?:@\w+)?(?:\s+(.*))?$/is;

interface InboundBase {
  channel: 'telegram';
  platformEventId: string;
  identity: ChannelIdentity;
  occurredAt: Date;
  chatKind: 'private' | 'group' | 'channel';
  edited?: boolean;
  forwarded?: boolean;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channel = 'telegram' as const;

  constructor(private readonly client: TelegramClient) {}

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  normalise(rawPayload: unknown): InboundEvent[] {
    const update = rawPayload as TgUpdate;
    if (typeof update.update_id !== 'number') return [];
    const id = String(update.update_id);

    if (update.callback_query) {
      const cq = update.callback_query;
      const chat = cq.message?.chat;
      if (!chat) return [];
      const base = this.base(id, cq.from, chat, cq.message?.date ?? Math.floor(Date.now() / 1000));
      const ref: MessageRef | undefined = cq.message
        ? {
            channel: 'telegram',
            externalChatId: String(chat.id),
            externalMessageId: String(cq.message.message_id),
          }
        : undefined;
      return [
        {
          ...base,
          kind: 'button',
          actionId: cq.data ?? 'noop',
          ...(ref ? { messageRef: ref } : {}),
          ackToken: cq.id,
        },
      ];
    }

    const msg = update.message ?? update.edited_message;
    if (!msg?.from) return [];
    const base = this.base(id, msg.from, msg.chat, msg.date);
    if (update.edited_message) base.edited = true;
    if (msg.forward_origin || msg.forward_date) base.forwarded = true;

    if (msg.contact) {
      const phone =
        normalisePhone(msg.contact.phone_number) ?? msg.contact.phone_number.replace(/\D/g, '');
      return [
        {
          ...base,
          kind: 'contact',
          phoneE164: phone,
          isSelf: msg.contact.user_id === msg.from.id,
          name: msg.contact.first_name,
        },
      ];
    }
    if (msg.location) {
      return [
        {
          ...base,
          kind: 'location',
          point: { latitude: msg.location.latitude, longitude: msg.location.longitude },
        },
      ];
    }
    if (typeof msg.text === 'string') {
      const m = COMMAND_RE.exec(msg.text.trim());
      if (m) {
        const payload = m[2]?.trim();
        return [
          {
            ...base,
            kind: 'command',
            command: (m[1] ?? '').toLowerCase(),
            ...(payload ? { payload } : {}),
          },
        ];
      }
      return [{ ...base, kind: 'text', text: msg.text }];
    }
    const media = this.mediaOf(msg);
    if (media)
      return [
        { ...base, kind: 'media', ...media, ...(msg.caption ? { caption: msg.caption } : {}) },
      ];
    return [
      {
        ...base,
        kind: 'unsupported',
        description:
          Object.keys(msg)
            .filter((k) => !['message_id', 'from', 'chat', 'date'].includes(k))
            .join(',') || 'empty',
      },
    ];
  }

  private base(id: string, from: TgUser, chat: TgChat, date: number): InboundBase {
    const identity: ChannelIdentity = {
      channel: 'telegram',
      externalUserId: String(from.id),
      externalChatId: String(chat.id),
      displayName: [from.first_name, from.last_name].filter(Boolean).join(' '),
      ...(from.username ? { handle: from.username } : {}),
      ...(from.language_code ? { languageHint: from.language_code } : {}),
    };
    return {
      channel: 'telegram',
      platformEventId: id,
      identity,
      occurredAt: new Date(date * 1000),
      chatKind: chat.type === 'private' ? 'private' : chat.type === 'channel' ? 'channel' : 'group',
    };
  }

  private mediaOf(
    msg: TgMessage,
  ): { mediaKind: 'image' | 'audio' | 'video' | 'document' | 'sticker'; mediaRef: string } | null {
    if (msg.photo?.length)
      return { mediaKind: 'image', mediaRef: msg.photo[msg.photo.length - 1]!.file_id };
    if (msg.voice) return { mediaKind: 'audio', mediaRef: msg.voice.file_id };
    if (msg.audio) return { mediaKind: 'audio', mediaRef: msg.audio.file_id };
    if (msg.video) return { mediaKind: 'video', mediaRef: msg.video.file_id };
    if (msg.document) return { mediaKind: 'document', mediaRef: msg.document.file_id };
    if (msg.sticker) return { mediaKind: 'sticker', mediaRef: msg.sticker.file_id };
    return null;
  }

  async acknowledgeButton(event: InboundButton): Promise<void> {
    const id = event.ackToken;
    if (!id) return;
    try {
      await this.client.answerCallbackQuery(id);
    } catch {
      /* stale callback ids (>~15 s old) are rejected by Telegram; harmless */
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async send(identity: ChannelIdentity, message: OutboundMessage): Promise<SendResult> {
    const chat_id = identity.externalChatId;
    try {
      switch (message.kind) {
        case 'typing':
          await this.client.sendChatAction(chat_id, 'typing');
          return { ok: true };
        case 'text':
          return this.ok(
            await this.client.sendMessage({
              chat_id,
              text: html(message.body),
              parse_mode: 'HTML',
            }),
          );
        case 'buttons': {
          const markup = inline(message.choices.map((c) => [callback(c)]));
          if (message.replaces)
            return await this.edit(message.replaces, html(message.body), markup);
          return this.ok(
            await this.client.sendMessage({
              chat_id,
              text: html(message.body),
              parse_mode: 'HTML',
              reply_markup: markup,
            }),
          );
        }
        case 'quick_replies': {
          const markup: ReplyKeyboardMarkup = {
            keyboard: chunk(
              message.choices.map((c) => ({ text: c.label })),
              2,
            ),
            resize_keyboard: true,
            is_persistent: true,
          };
          return this.ok(
            await this.client.sendMessage({
              chat_id,
              text: html(message.body),
              parse_mode: 'HTML',
              reply_markup: markup,
            }),
          );
        }
        case 'list': {
          const rows: InlineKeyboardButton[][] = message.rows.map((r) => [
            {
              text: r.description ? `${r.title} · ${r.description}`.slice(0, 60) : r.title,
              callback_data: assertCallback(r.actionId),
            },
          ]);
          const nav: InlineKeyboardButton[] = [];
          if (message.prevActionId)
            nav.push({ text: '‹', callback_data: assertCallback(message.prevActionId) });
          if (message.pageCount > 1)
            nav.push({ text: `${message.page}/${message.pageCount}`, callback_data: 'noop' });
          if (message.nextActionId)
            nav.push({ text: '›', callback_data: assertCallback(message.nextActionId) });
          if (nav.length) rows.push(nav);
          const markup = inline(rows);
          if (message.replaces)
            return await this.edit(message.replaces, html(message.body), markup);
          return this.ok(
            await this.client.sendMessage({
              chat_id,
              text: html(message.body),
              parse_mode: 'HTML',
              reply_markup: markup,
            }),
          );
        }
        case 'url_button':
          return this.ok(
            await this.client.sendMessage({
              chat_id,
              text: html(message.body),
              parse_mode: 'HTML',
              reply_markup: inline([[{ text: message.label, url: message.url }]]),
            }),
          );
        case 'location_request': {
          const keyboard: ReplyKeyboardMarkup['keyboard'] = [
            [{ text: '📍 Share my location', request_location: true }],
          ];
          const markup: ReplyKeyboardMarkup = {
            keyboard,
            resize_keyboard: true,
            one_time_keyboard: true,
          };
          const sent = await this.client.sendMessage({
            chat_id,
            text: html(message.body),
            parse_mode: 'HTML',
            reply_markup: markup,
          });
          if (message.typedAlternative) {
            await this.client.sendMessage({
              chat_id,
              text: '…',
              reply_markup: inline([[callback(message.typedAlternative)]]),
            });
          }
          return this.ok(sent);
        }
        case 'contact_request': {
          const markup: ReplyKeyboardMarkup = {
            keyboard: [[{ text: '📱 Share my number', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          };
          return this.ok(
            await this.client.sendMessage({
              chat_id,
              text: html(message.body),
              parse_mode: 'HTML',
              reply_markup: markup,
            }),
          );
        }
        case 'image': {
          const markup = message.choices?.length
            ? inline(message.choices.map((c) => [callback(c)]))
            : undefined;
          return this.ok(
            await this.client.sendPhoto({
              chat_id,
              photo: message.imageRef,
              ...(message.caption
                ? { caption: html(message.caption), parse_mode: 'HTML' as const }
                : {}),
              ...(markup ? { reply_markup: markup } : {}),
            }),
          );
        }
        case 'edit':
          return await this.edit(message.target, html(message.body));
      }
    } catch (err) {
      return this.failure(err);
    }
  }

  private async edit(
    target: MessageRef,
    text: string,
    markup?: InlineKeyboardMarkup,
  ): Promise<SendResult> {
    try {
      await this.client.editMessageText({
        chat_id: target.externalChatId,
        message_id: Number(target.externalMessageId),
        text,
        parse_mode: 'HTML',
        ...(markup ? { reply_markup: markup } : {}),
      });
      return { ok: true, messageRef: target };
    } catch (err) {
      if (err instanceof TelegramApiError && err.isBenignEditFailure) {
        // Fall back to a fresh message so the user is never left without buttons.
        const sent = await this.client.sendMessage({
          chat_id: target.externalChatId,
          text,
          parse_mode: 'HTML',
          ...(markup ? { reply_markup: markup } : {}),
        });
        return this.ok(sent);
      }
      throw err;
    }
  }

  private ok(msg: TgMessage): SendResult {
    return {
      ok: true,
      messageRef: {
        channel: 'telegram',
        externalChatId: String(msg.chat.id),
        externalMessageId: String(msg.message_id),
      },
    };
  }

  private failure(err: unknown): SendResult {
    if (err instanceof TelegramApiError) {
      return {
        ok: false,
        error: err.message,
        ...(err.isUnreachable ? { unreachable: true } : {}),
        ...(err.retryAfterSeconds !== undefined
          ? { retryAfterMs: err.retryAfterSeconds * 1000 }
          : {}),
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** RichText → HTML with bold spans. Everything is escaped first; bold wraps the escaped span. */
export function html(body: RichText): string {
  let out = escapeHtml(body.text);
  for (const span of body.bold ?? []) {
    const esc = escapeHtml(span);
    if (esc.length > 0) out = out.split(esc).join(`<b>${esc}</b>`);
  }
  return out;
}

function callback(c: Choice): InlineKeyboardButton {
  return { text: c.label, callback_data: assertCallback(c.actionId) };
}

export function assertCallback(actionId: string): string {
  if (Buffer.byteLength(actionId, 'utf8') > CHANNEL_LIMITS.telegramCallbackDataBytes) {
    throw new Error(`callback data exceeds 64 bytes: ${actionId}`);
  }
  return actionId;
}

const inline = (rows: InlineKeyboardButton[][]): InlineKeyboardMarkup => ({
  inline_keyboard: rows,
});

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type { ReplyMarkup };
