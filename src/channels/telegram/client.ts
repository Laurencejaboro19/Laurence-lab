/**
 * Thin Telegram Bot API client over fetch. No framework (see DR-009).
 *
 * Rate limits (Telegram's published guidance): ~30 messages/second overall and
 * ~1 message/second per chat. We enforce both with token buckets and queue
 * sends per chat so bursts never trigger 429s; when Telegram does answer 429
 * we honour `retry_after` once and surface it to the caller.
 */
export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}
export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}
export interface TgLocation {
  latitude: number;
  longitude: number;
}
export interface TgContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
}
export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: { type: string; offset: number; length: number }[];
  contact?: TgContact;
  location?: TgLocation;
  photo?: TgPhotoSize[];
  audio?: { file_id: string };
  voice?: { file_id: string };
  video?: { file_id: string };
  document?: { file_id: string; file_name?: string };
  sticker?: { file_id: string };
  forward_origin?: unknown;
  forward_date?: number;
  edit_date?: number;
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: { chat: TgChat; from: TgUser; new_chat_member: { status: string } };
}

export type InlineKeyboardButton =
  { text: string; callback_data: string } | { text: string; url: string };
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}
export interface ReplyKeyboardMarkup {
  keyboard: { text: string; request_contact?: boolean; request_location?: boolean }[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  is_persistent?: boolean;
  input_field_placeholder?: string;
}
export type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup | { remove_keyboard: true };

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`${method}: ${errorCode} ${description}`);
    this.name = 'TelegramApiError';
  }
  /** The user blocked the bot, deleted their account, or we were kicked. */
  get isUnreachable(): boolean {
    return (
      this.errorCode === 403 ||
      /bot was blocked|user is deactivated|chat not found|bot was kicked/i.test(this.description)
    );
  }
  /** Editing a message with identical content, or a message too old to edit. */
  get isBenignEditFailure(): boolean {
    return /message is not modified|message to edit not found|message can't be edited/i.test(
      this.description,
    );
  }
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
  ) {
    this.tokens = capacity;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.capacity,
        this.tokens + ((now - this.last) / 1000) * this.perSecond,
      );
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) =>
        setTimeout(r, Math.ceil(((1 - this.tokens) / this.perSecond) * 1000)),
      );
    }
  }
}

export interface TelegramClientOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Tests set these high. */
  globalPerSecond?: number;
  perChatPerSecond?: number;
}

export class TelegramClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly global: TokenBucket;
  private readonly perChat = new Map<string, TokenBucket>();
  private readonly chatQueues = new Map<string, Promise<unknown>>();
  private readonly perChatRate: number;

  constructor(opts: TelegramClientOptions) {
    this.base = `${(opts.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '')}/bot${opts.token}`;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.global = new TokenBucket(25, opts.globalPerSecond ?? 25);
    this.perChatRate = opts.perChatPerSecond ?? 1;
  }

  /** Raw call. Throws TelegramApiError on ok:false; retries once on 429 honouring retry_after (≤ 5 s). */
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { longPollSeconds?: number } = {},
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => {
          controller.abort();
        },
        this.timeoutMs + (opts.longPollSeconds ?? 0) * 1000,
      );
      try {
        const res = await this.fetchImpl(`${this.base}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: controller.signal,
        });
        const json = (await res.json()) as {
          ok: boolean;
          result?: T;
          error_code?: number;
          description?: string;
          parameters?: { retry_after?: number };
        };
        if (json.ok) return json.result as T;
        const retryAfter = json.parameters?.retry_after;
        if (
          json.error_code === 429 &&
          attempt === 0 &&
          retryAfter !== undefined &&
          retryAfter <= 5
        ) {
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        throw new TelegramApiError(
          method,
          json.error_code ?? 0,
          json.description ?? 'unknown error',
          retryAfter,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw new TelegramApiError(method, 429, 'rate limited');
  }

  /** Serialises per chat and applies both buckets; use for every send/edit to a chat. */
  async forChat<T>(chatId: string | number, fn: () => Promise<T>): Promise<T> {
    const key = String(chatId);
    const bucket = this.perChat.get(key) ?? new TokenBucket(1, this.perChatRate);
    this.perChat.set(key, bucket);
    const prev = this.chatQueues.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        await bucket.take();
        await this.global.take();
        return fn();
      });
    this.chatQueues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.chatQueues.get(key) === next) this.chatQueues.delete(key);
      if (this.perChat.size > 5000) this.perChat.clear(); // bound memory on long runs
    }
  }

  getMe(): Promise<TgUser> {
    return this.call('getMe');
  }
  getUpdates(offset: number, timeoutSeconds: number, allowed: string[]): Promise<TgUpdate[]> {
    return this.call(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: allowed },
      { longPollSeconds: timeoutSeconds },
    );
  }
  setWebhook(url: string, secretToken: string, allowed: string[]): Promise<boolean> {
    return this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: allowed,
      drop_pending_updates: false,
      max_connections: 20,
    });
  }
  deleteWebhook(): Promise<boolean> {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }
  sendMessage(p: {
    chat_id: string | number;
    text: string;
    parse_mode?: 'HTML';
    reply_markup?: ReplyMarkup;
    disable_web_page_preview?: boolean;
  }): Promise<TgMessage> {
    return this.forChat(p.chat_id, () =>
      this.call('sendMessage', { link_preview_options: { is_disabled: true }, ...p }),
    );
  }
  editMessageText(p: {
    chat_id: string | number;
    message_id: number;
    text: string;
    parse_mode?: 'HTML';
    reply_markup?: InlineKeyboardMarkup;
  }): Promise<TgMessage | true> {
    return this.forChat(p.chat_id, () =>
      this.call('editMessageText', { link_preview_options: { is_disabled: true }, ...p }),
    );
  }
  editMessageReplyMarkup(p: {
    chat_id: string | number;
    message_id: number;
    reply_markup?: InlineKeyboardMarkup;
  }): Promise<TgMessage | true> {
    return this.forChat(p.chat_id, () => this.call('editMessageReplyMarkup', p));
  }
  sendPhoto(p: {
    chat_id: string | number;
    photo: string;
    caption?: string;
    parse_mode?: 'HTML';
    reply_markup?: ReplyMarkup;
  }): Promise<TgMessage> {
    return this.forChat(p.chat_id, () => this.call('sendPhoto', p));
  }
  sendChatAction(chat_id: string | number, action = 'typing'): Promise<boolean> {
    return this.call('sendChatAction', { chat_id, action });
  }
  answerCallbackQuery(callback_query_id: string, text?: string): Promise<boolean> {
    return this.call('answerCallbackQuery', { callback_query_id, ...(text ? { text } : {}) });
  }
  setMyCommands(commands: { command: string; description: string }[]): Promise<boolean> {
    return this.call('setMyCommands', { commands });
  }
}

/** Escape for parse_mode=HTML. Only <, > and & need escaping; quotes are fine in text nodes. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
