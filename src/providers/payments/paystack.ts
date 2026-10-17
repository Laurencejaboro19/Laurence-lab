/**
 * Paystack gateway (test and live mode decided by the key prefix).
 *
 * Verified against Paystack's docs on 2026-10-17:
 *   POST /transaction/initialize   amount in kobo, email, reference ([-.=A-Za-z0-9]), metadata
 *   GET  /transaction/verify/:ref  data.status, data.amount, data.currency, data.id, data.channel
 *   POST /refund                   transaction (id or reference), amount (kobo), merchant_note
 *   Webhooks: header x-paystack-signature = HMAC-SHA512(raw body, secret key), hex.
 *             Source IPs 52.31.139.75, 52.49.173.169, 52.214.14.220 (test + live).
 *             Respond 200 quickly; live retries every 3 min ×4 then hourly for 72 h.
 *
 * Every call has a timeout and one retry on network/5xx errors (never on 4xx).
 * Nothing from a response is logged except what the service stores — no card data.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { kobo, type Kobo } from '../../core/domain/money.js';
import type {
  PaymentGateway,
  PaymentInitResult,
  PaymentVerification,
} from '../../core/ports/index.js';

export const PAYSTACK_WEBHOOK_IPS: readonly string[] = [
  '52.31.139.75',
  '52.49.173.169',
  '52.214.14.220',
];

export interface PaystackOptions {
  secretKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data?: T;
}

export class PaystackError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PaystackError';
  }
}

export class PaystackGateway implements PaymentGateway {
  readonly name = 'paystack';
  readonly mode: 'test' | 'live';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PaystackOptions) {
    if (!opts.secretKey.startsWith('sk_'))
      throw new Error('PAYSTACK_SECRET_KEY must start with sk_test_ or sk_live_');
    this.mode = opts.secretKey.startsWith('sk_live_') ? 'live' : 'test';
    this.baseUrl = (opts.baseUrl ?? 'https://api.paystack.co').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async initialise(input: {
    reference: string;
    amountKobo: Kobo;
    email: string;
    metadata: Record<string, unknown>;
    callbackUrl?: string;
  }): Promise<PaymentInitResult> {
    if (!/^[-.=A-Za-z0-9]+$/.test(input.reference))
      throw new Error('reference contains characters Paystack rejects');
    const data = await this.call<{
      authorization_url: string;
      access_code: string;
      reference: string;
    }>('POST', '/transaction/initialize', {
      amount: String(input.amountKobo),
      email: input.email,
      reference: input.reference,
      currency: 'NGN',
      metadata: JSON.stringify(input.metadata),
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
    });
    return {
      authorizationUrl: data.authorization_url,
      accessCode: data.access_code,
      reference: data.reference,
    };
  }

  async verify(reference: string): Promise<PaymentVerification> {
    let data: {
      status: string;
      amount: number;
      currency: string;
      reference: string;
      id: number;
      channel: string | null;
      paid_at: string | null;
    };
    try {
      data = await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    } catch (err) {
      // Paystack answers 404 "Transaction reference not found" for unknown references.
      if (err instanceof PaystackError && err.httpStatus === 404) {
        return {
          reference,
          status: 'unknown',
          amountKobo: kobo(0),
          currency: 'NGN',
          providerTxId: null,
          channel: null,
          paidAt: null,
        };
      }
      throw err;
    }
    const status: PaymentVerification['status'] =
      data.status === 'success'
        ? 'success'
        : data.status === 'failed'
          ? 'failed'
          : data.status === 'abandoned'
            ? 'abandoned'
            : data.status === 'ongoing' ||
                data.status === 'pending' ||
                data.status === 'processing' ||
                data.status === 'queued'
              ? 'pending'
              : 'unknown';
    return {
      reference: data.reference,
      status,
      amountKobo: kobo(data.amount),
      currency: data.currency,
      providerTxId: String(data.id),
      channel: data.channel,
      paidAt: data.paid_at ? new Date(data.paid_at) : null,
    };
  }

  async refund(input: {
    providerTxId: string;
    amountKobo: Kobo;
    reason: string;
    idempotencyKey: string;
  }): Promise<{
    providerRef: string;
    status: 'pending' | 'processing' | 'success' | 'failed';
  }> {
    const data = await this.call<{ id: number; status: string }>('POST', '/refund', {
      transaction: input.providerTxId,
      amount: input.amountKobo,
      currency: 'NGN',
      merchant_note: `${input.reason} [${input.idempotencyKey}]`.slice(0, 200),
      customer_note: input.reason.slice(0, 200),
    });
    const status =
      data.status === 'processed'
        ? 'success'
        : data.status === 'failed'
          ? 'failed'
          : data.status === 'processing'
            ? 'processing'
            : 'pending';
    return { providerRef: String(data.id), status };
  }

  // REVIEW: webhook authenticity. HMAC-SHA512 over the RAW body (not a re-serialised
  // JSON object — whitespace differences would break it) compared in constant time.
  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader) return false;
    const expected = Buffer.from(
      createHmac('sha512', this.opts.secretKey).update(rawBody).digest('hex'),
      'utf8',
    );
    const given = Buffer.from(signatureHeader, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.opts.secretKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
        const text = await res.text();
        let json: PaystackEnvelope<T> | undefined;
        try {
          json = JSON.parse(text) as PaystackEnvelope<T>;
        } catch {
          json = undefined;
        }
        if (!res.ok || !json?.status) {
          const retryable = res.status >= 500 || res.status === 429;
          const err = new PaystackError(
            json?.message ?? `Paystack HTTP ${res.status}`,
            res.status,
            retryable,
          );
          if (retryable && attempt === 0) {
            lastErr = err;
            continue;
          }
          throw err;
        }
        if (json.data === undefined)
          throw new PaystackError('Paystack response had no data', res.status, false);
        return json.data;
      } catch (err) {
        if (err instanceof PaystackError) throw err;
        lastErr = err; // network error / timeout → retry once
        if (attempt === 1) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Paystack request failed');
  }
}

/** Strip anything card-like before a payload is stored or logged. */
export function redactPaystackPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return {};
  const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const data = clone['data'];
  if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>;
    delete d['authorization'];
    delete d['card'];
    delete d['log'];
    const customer = d['customer'];
    if (typeof customer === 'object' && customer !== null) {
      const c = customer as Record<string, unknown>;
      // Keep only identifiers; drop names/emails/phones.
      d['customer'] = { id: c['id'], customer_code: c['customer_code'] };
    }
  }
  return clone;
}
