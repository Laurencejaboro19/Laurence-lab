import type { ConversationRepository, ConversationState, Tx } from '../../core/ports/index.js';
import { pgOf } from '../client.js';

export class PgConversationRepository implements ConversationRepository {
  async lock(tx: Tx, identityId: string): Promise<ConversationState> {
    const client = pgOf(tx);
    await client.query(
      `INSERT INTO app.conversations (channel_identity_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [identityId],
    );
    const r = await client.query<{
      state: string;
      context: Record<string, unknown>;
      last_event_at: Date | null;
    }>(
      `SELECT state, context, last_event_at FROM app.conversations WHERE channel_identity_id = $1 FOR UPDATE`,
      [identityId],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`conversation ${identityId} vanished`);
    return { identityId, state: row.state, context: row.context, lastEventAt: row.last_event_at };
  }

  async save(tx: Tx, state: ConversationState): Promise<void> {
    await pgOf(tx).query(
      `UPDATE app.conversations SET state = $2, context = $3, last_event_at = now() WHERE channel_identity_id = $1`,
      [state.identityId, state.state, JSON.stringify(state.context)],
    );
  }

  async recordInbound(tx: Tx, source: string, externalId: string): Promise<boolean> {
    const r = await pgOf(tx).query(
      `INSERT INTO app.inbound_events (source, external_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [source, externalId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async touchIdentity(
    tx: Tx,
    identityId: string,
    direction: 'in' | 'out',
    at: Date,
  ): Promise<void> {
    const col = direction === 'in' ? 'last_inbound_at' : 'last_outbound_at';
    await pgOf(tx).query(
      `UPDATE app.channel_identities SET ${col} = $2${direction === 'in' ? ', unreachable_at = NULL' : ''} WHERE id = $1`,
      [identityId, at],
    );
  }

  async markUnreachable(tx: Tx, identityId: string, at: Date | null): Promise<void> {
    await pgOf(tx).query(`UPDATE app.channel_identities SET unreachable_at = $2 WHERE id = $1`, [
      identityId,
      at,
    ]);
  }

  async logMessage(
    tx: Tx,
    input: {
      identityId: string;
      direction: 'in' | 'out';
      kind: string;
      body?: string;
      payload?: unknown;
      externalMessageId?: string;
      status?: string;
      category?: 'service' | 'utility' | 'marketing' | 'authentication';
    },
  ): Promise<string> {
    const r = await pgOf(tx).query<{ id: string }>(
      `INSERT INTO app.messages (channel_identity_id, direction, kind, body, payload, external_message_id, status, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.identityId,
        input.direction,
        input.kind,
        input.body ?? null,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        input.externalMessageId ?? null,
        input.status ?? (input.direction === 'in' ? 'received' : 'queued'),
        input.category ?? 'service',
      ],
    );
    return r.rows[0]!.id;
  }

  async updateMessageStatus(
    tx: Tx,
    messageId: string,
    status: string,
    error?: { code?: string; detail?: string },
  ): Promise<void> {
    await pgOf(tx).query(
      `UPDATE app.messages SET status = $2, error_code = $3, error_detail = $4 WHERE id = $1`,
      [messageId, status, error?.code ?? null, error?.detail ?? null],
    );
  }

  /** Simple keyword overlap against curated FAQ rows; no AI. */
  async findFaq(
    tx: Tx,
    language: 'en' | 'pcm',
    text: string,
  ): Promise<{ question: string; answer: string } | null> {
    const words = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
    if (words.length === 0) return null;
    const r = await pgOf(tx).query<{ question: string; answer: string; hits: string }>(
      `SELECT question, answer,
              (SELECT count(*) FROM unnest(keywords) k WHERE k = ANY($2::text[])) AS hits
       FROM app.faq_entries WHERE active AND language = $1
       ORDER BY hits DESC, sort_order LIMIT 1`,
      [language, words],
    );
    const row = r.rows[0];
    return row && Number(row.hits) > 0 ? { question: row.question, answer: row.answer } : null;
  }
}
