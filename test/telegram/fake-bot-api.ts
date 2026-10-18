/**
 * A fake Telegram Bot API for tests: records every call, returns plausible
 * results, and can be told to fail (403 blocked, 429 retry_after).
 */
import Fastify, { type FastifyInstance } from 'fastify';

export interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

export interface FakeBotApi {
  app: FastifyInstance;
  url: string;
  calls: RecordedCall[];
  /** chat ids that "blocked" the bot → sendMessage answers 403 */
  blocked: Set<string>;
  /** next N calls answer 429 with retry_after=1 */
  rateLimitNext: number;
  close(): Promise<void>;
  callsTo(method: string): RecordedCall[];
  texts(chatId?: string): string[];
}

export async function startFakeBotApi(): Promise<FakeBotApi> {
  const app = Fastify({ logger: false });
  const calls: RecordedCall[] = [];
  const blocked = new Set<string>();
  const state = { rateLimitNext: 0, msgId: 100 };

  app.post<{ Params: { token: string; method: string }; Body: Record<string, unknown> }>(
    '/bot:token/:method',
    async (req, reply) => {
      const { method } = req.params;
      const params = req.body;
      calls.push({ method, params });
      if (state.rateLimitNext > 0 && method !== 'getUpdates') {
        state.rateLimitNext--;
        return reply.status(429).send({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 1',
          parameters: { retry_after: 1 },
        });
      }
      switch (method) {
        case 'getMe':
          return {
            ok: true,
            result: { id: 1, is_bot: true, first_name: 'Laurence Lab', username: 'LaurenceLabBot' },
          };
        case 'getUpdates':
          return { ok: true, result: [] };
        case 'setWebhook':
        case 'deleteWebhook':
        case 'setMyCommands':
        case 'answerCallbackQuery':
        case 'sendChatAction':
          return { ok: true, result: true };
        case 'sendMessage':
        case 'sendPhoto': {
          const chatId = String(params['chat_id']);
          if (blocked.has(chatId)) {
            return reply.status(403).send({
              ok: false,
              error_code: 403,
              description: 'Forbidden: bot was blocked by the user',
            });
          }
          return {
            ok: true,
            result: {
              message_id: ++state.msgId,
              chat: { id: Number(chatId), type: 'private' },
              date: Math.floor(Date.now() / 1000),
              text: params['text'],
            },
          };
        }
        case 'editMessageText':
        case 'editMessageReplyMarkup':
          return {
            ok: true,
            result: {
              message_id: params['message_id'],
              chat: { id: Number(params['chat_id']), type: 'private' },
              date: 0,
            },
          };
        default:
          return reply.status(404).send({ ok: false, error_code: 404, description: 'Not Found' });
      }
    },
  );

  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${String((app.server.address() as { port: number }).port)}`;
  const api: FakeBotApi = {
    app,
    url,
    calls,
    blocked,
    get rateLimitNext() {
      return state.rateLimitNext;
    },
    set rateLimitNext(n: number) {
      state.rateLimitNext = n;
    },
    close: () => app.close(),
    callsTo: (method) => calls.filter((c) => c.method === method),
    texts: (chatId) =>
      calls
        .filter(
          (c) =>
            (c.method === 'sendMessage' || c.method === 'editMessageText') &&
            (!chatId || String(c.params['chat_id']) === chatId),
        )
        .map((c) => String(c.params['text'])),
  };
  return api;
}

/** Builders for realistic Update payloads. */
export const tg = {
  user: (id: number) => ({
    id,
    is_bot: false,
    first_name: 'Aruya',
    last_name: 'E.O',
    username: `user${id}`,
    language_code: 'en',
  }),
  text: (updateId: number, userId: number, text: string, chatType = 'private') => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: tg.user(userId),
      chat: { id: userId, type: chatType },
      date: 1_700_000_000,
      text,
    },
  }),
  contact: (updateId: number, userId: number, phone: string) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: tg.user(userId),
      chat: { id: userId, type: 'private' },
      date: 1_700_000_000,
      contact: { phone_number: phone, first_name: 'Aruya', user_id: userId },
    },
  }),
  location: (updateId: number, userId: number, latitude: number, longitude: number) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: tg.user(userId),
      chat: { id: userId, type: 'private' },
      date: 1_700_000_000,
      location: { latitude, longitude },
    },
  }),
  callback: (updateId: number, userId: number, data: string, messageId = 55) => ({
    update_id: updateId,
    callback_query: {
      id: `cq${updateId}`,
      from: tg.user(userId),
      data,
      message: {
        message_id: messageId,
        chat: { id: userId, type: 'private' },
        date: 1_700_000_000,
      },
    },
  }),
  photo: (updateId: number, userId: number) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: tg.user(userId),
      chat: { id: userId, type: 'private' },
      date: 1_700_000_000,
      photo: [
        { file_id: 'small', width: 1, height: 1 },
        { file_id: 'big', width: 2, height: 2 },
      ],
      caption: 'look',
    },
  }),
};
