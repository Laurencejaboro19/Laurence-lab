import { notFound } from '../../core/domain/errors.js';
import { kobo, type Kobo } from '../../core/domain/money.js';
import type { Payment, PaymentRepository, Refund, Tx } from '../../core/ports/index.js';
import { pgOf } from '../client.js';

interface PaymentRow {
  id: string;
  order_id: string;
  reference: string;
  amount_kobo: string;
  currency: string;
  status: Payment['status'];
  paid_amount_kobo: string | null;
  provider_tx_id: string | null;
  authorization_url: string | null;
  mode: 'test' | 'live';
  verified_at: Date | null;
}

interface RefundRow {
  id: string;
  order_id: string;
  payment_id: string;
  amount_kobo: string;
  reason: string;
  status: Refund['status'];
  provider_ref: string | null;
  idempotency_key: string;
}

const paymentOf = (r: PaymentRow): Payment => ({
  id: r.id,
  orderId: r.order_id,
  reference: r.reference,
  amountKobo: kobo(r.amount_kobo),
  currency: r.currency,
  status: r.status,
  paidAmountKobo: r.paid_amount_kobo === null ? null : kobo(r.paid_amount_kobo),
  providerTxId: r.provider_tx_id,
  authorizationUrl: r.authorization_url,
  mode: r.mode,
  verifiedAt: r.verified_at,
});

const refundOf = (r: RefundRow): Refund => ({
  id: r.id,
  orderId: r.order_id,
  paymentId: r.payment_id,
  amountKobo: kobo(r.amount_kobo),
  reason: r.reason,
  status: r.status,
  providerRef: r.provider_ref,
  idempotencyKey: r.idempotency_key,
});

const PAYMENT_COLS =
  'id, order_id, reference, amount_kobo::text, currency, status, paid_amount_kobo::text, provider_tx_id, authorization_url, mode, verified_at';
const REFUND_COLS =
  'id, order_id, payment_id, amount_kobo::text, reason, status, provider_ref, idempotency_key';

export class PgPaymentRepository implements PaymentRepository {
  async create(
    tx: Tx,
    input: Omit<Payment, 'id' | 'status' | 'paidAmountKobo' | 'providerTxId' | 'verifiedAt'> & {
      accessCode?: string;
      expiresAt?: Date;
    },
  ): Promise<Payment> {
    const r = await pgOf(tx).query<PaymentRow>(
      `INSERT INTO app.payments (order_id, reference, amount_kobo, currency, authorization_url, access_code, mode, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PAYMENT_COLS}`,
      [
        input.orderId,
        input.reference,
        input.amountKobo,
        input.currency,
        input.authorizationUrl,
        input.accessCode ?? null,
        input.mode,
        input.expiresAt ?? null,
      ],
    );
    return paymentOf(r.rows[0]!);
  }

  async findById(tx: Tx, id: string): Promise<Payment | null> {
    const r = await pgOf(tx).query<PaymentRow>(
      `SELECT ${PAYMENT_COLS} FROM app.payments WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? paymentOf(r.rows[0]) : null;
  }

  async findByReference(tx: Tx, reference: string): Promise<Payment | null> {
    const r = await pgOf(tx).query<PaymentRow>(
      `SELECT ${PAYMENT_COLS} FROM app.payments WHERE reference = $1 FOR UPDATE`,
      [reference],
    );
    return r.rows[0] ? paymentOf(r.rows[0]) : null;
  }

  async findLatestForOrder(tx: Tx, orderId: string): Promise<Payment | null> {
    const r = await pgOf(tx).query<PaymentRow>(
      `SELECT ${PAYMENT_COLS} FROM app.payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    );
    return r.rows[0] ? paymentOf(r.rows[0]) : null;
  }

  async findSuccessfulForOrder(tx: Tx, orderId: string): Promise<Payment | null> {
    const r = await pgOf(tx).query<PaymentRow>(
      `SELECT ${PAYMENT_COLS} FROM app.payments WHERE order_id = $1 AND status = 'success' ORDER BY verified_at DESC LIMIT 1`,
      [orderId],
    );
    return r.rows[0] ? paymentOf(r.rows[0]) : null;
  }

  async update(
    tx: Tx,
    id: string,
    patch: Partial<Pick<Payment, 'status' | 'paidAmountKobo' | 'providerTxId' | 'verifiedAt'>> & {
      providerStatus?: string;
      providerChannel?: string;
      paidCurrency?: string;
    },
  ): Promise<Payment> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, v: unknown): void => {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.paidAmountKobo !== undefined) push('paid_amount_kobo', patch.paidAmountKobo);
    if (patch.providerTxId !== undefined) push('provider_tx_id', patch.providerTxId);
    if (patch.verifiedAt !== undefined) push('verified_at', patch.verifiedAt);
    if (patch.providerStatus !== undefined) push('provider_status', patch.providerStatus);
    if (patch.providerChannel !== undefined) push('provider_channel', patch.providerChannel);
    if (patch.paidCurrency !== undefined) push('paid_currency', patch.paidCurrency);
    values.push(id);
    const r = await pgOf(tx).query<PaymentRow>(
      `UPDATE app.payments SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${PAYMENT_COLS}`,
      values,
    );
    if (!r.rows[0]) throw notFound('payment', id);
    return paymentOf(r.rows[0]);
  }

  async recordEvent(
    tx: Tx,
    input: {
      provider: string;
      externalEventId: string;
      eventType: string;
      reference?: string;
      payloadRedacted?: unknown;
    },
  ): Promise<boolean> {
    const r = await pgOf(tx).query(
      `INSERT INTO app.payment_events (provider, external_event_id, event_type, reference, payload_redacted)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (provider, external_event_id) DO NOTHING`,
      [
        input.provider,
        input.externalEventId,
        input.eventType,
        input.reference ?? null,
        input.payloadRedacted === undefined ? null : JSON.stringify(input.payloadRedacted),
      ],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async markEventProcessed(
    tx: Tx,
    provider: string,
    externalEventId: string,
    outcome: string,
  ): Promise<void> {
    await pgOf(tx).query(
      `UPDATE app.payment_events SET processed_at = now(), outcome = $3 WHERE provider = $1 AND external_event_id = $2`,
      [provider, externalEventId, outcome],
    );
  }

  async flag(
    tx: Tx,
    input: {
      orderId?: string;
      paymentId?: string;
      kind: 'underpaid' | 'overpaid' | 'duplicate' | 'late' | 'currency' | 'reference_unknown';
      details: Record<string, unknown>;
    },
  ): Promise<void> {
    await pgOf(tx).query(
      `INSERT INTO app.payment_flags (order_id, payment_id, kind, details) VALUES ($1, $2, $3, $4)`,
      [input.orderId ?? null, input.paymentId ?? null, input.kind, JSON.stringify(input.details)],
    );
  }

  async createRefund(
    tx: Tx,
    input: {
      orderId: string;
      paymentId: string;
      amountKobo: Kobo;
      reason: string;
      requestedBy: string;
      idempotencyKey: string;
    },
  ): Promise<Refund | null> {
    // REVIEW: the UNIQUE(idempotency_key) + ON CONFLICT DO NOTHING is what makes a
    // double-tapped Refund button, or a retried job, issue exactly one refund.
    const r = await pgOf(tx).query<RefundRow>(
      `INSERT INTO app.refunds (order_id, payment_id, amount_kobo, reason, requested_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${REFUND_COLS}`,
      [
        input.orderId,
        input.paymentId,
        input.amountKobo,
        input.reason,
        input.requestedBy,
        input.idempotencyKey,
      ],
    );
    return r.rows[0] ? refundOf(r.rows[0]) : null;
  }

  async findRefundByKey(tx: Tx, idempotencyKey: string): Promise<Refund | null> {
    const r = await pgOf(tx).query<RefundRow>(
      `SELECT ${REFUND_COLS} FROM app.refunds WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return r.rows[0] ? refundOf(r.rows[0]) : null;
  }

  async findRefundById(tx: Tx, id: string): Promise<Refund | null> {
    const r = await pgOf(tx).query<RefundRow>(
      `SELECT ${REFUND_COLS} FROM app.refunds WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return r.rows[0] ? refundOf(r.rows[0]) : null;
  }

  async listRefunds(
    tx: Tx,
    filter: { status?: Refund['status'][]; limit: number },
  ): Promise<Refund[]> {
    const values: unknown[] = [];
    let where = '';
    if (filter.status?.length) {
      values.push(filter.status);
      where = `WHERE status = ANY($1::app.refund_status[])`;
    }
    values.push(filter.limit);
    const r = await pgOf(tx).query<RefundRow>(
      `SELECT ${REFUND_COLS} FROM app.refunds ${where} ORDER BY created_at LIMIT $${values.length}`,
      values,
    );
    return r.rows.map(refundOf);
  }

  async updateRefund(
    tx: Tx,
    id: string,
    patch: Partial<Pick<Refund, 'status' | 'providerRef'>> & {
      failureReason?: string;
      approvedBy?: string;
    },
  ): Promise<Refund> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, v: unknown): void => {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.status !== undefined) {
      push('status', patch.status);
      if (patch.status === 'success' || patch.status === 'failed')
        sets.push('completed_at = now()');
    }
    if (patch.providerRef !== undefined) push('provider_ref', patch.providerRef);
    if (patch.failureReason !== undefined) push('failure_reason', patch.failureReason);
    if (patch.approvedBy !== undefined) push('approved_by', patch.approvedBy);
    values.push(id);
    const r = await pgOf(tx).query<RefundRow>(
      `UPDATE app.refunds SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${REFUND_COLS}`,
      values,
    );
    if (!r.rows[0]) throw notFound('refund', id);
    return refundOf(r.rows[0]);
  }

  async sumRefundedKobo(tx: Tx, orderId: string): Promise<Kobo> {
    const r = await pgOf(tx).query<{ total: string }>(
      `SELECT coalesce(sum(amount_kobo), 0)::text AS total FROM app.refunds
       WHERE order_id = $1 AND status IN ('pending','approved','processing','success')`,
      [orderId],
    );
    return kobo(r.rows[0]?.total ?? '0');
  }

  async listPendingInitialised(tx: Tx, olderThan: Date, limit: number): Promise<Payment[]> {
    const r = await pgOf(tx).query<PaymentRow>(
      `SELECT ${PAYMENT_COLS} FROM app.payments WHERE status = 'initialised' AND created_at < $1
       ORDER BY created_at LIMIT $2`,
      [olderThan, limit],
    );
    return r.rows.map(paymentOf);
  }
}
