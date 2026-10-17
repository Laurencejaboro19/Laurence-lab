import { createHmac, timingSafeEqual } from 'node:crypto';

import { kobo, type Kobo } from '../../core/domain/money.js';
import type {
  PaymentGateway,
  PaymentInitResult,
  PaymentVerification,
} from '../../core/ports/index.js';

/**
 * In-memory stand-in for Paystack. Tests script what `verify` returns per
 * reference; the local mock HTTP server (phase 4) wraps the same behaviour.
 * Signature verification mirrors Paystack's scheme (HMAC-SHA512 of the raw body
 * with the secret key, hex, compared in constant time).
 */
export class MockPaymentGateway implements PaymentGateway {
  readonly name = 'paystack-mock';
  readonly mode = 'test' as const;
  readonly initialised: {
    reference: string;
    amountKobo: Kobo;
    email: string;
    metadata: Record<string, unknown>;
  }[] = [];
  readonly refunds: { providerTxId: string; amountKobo: Kobo; idempotencyKey: string }[] = [];
  private readonly verifications = new Map<string, PaymentVerification>();
  failInitialise = false;
  failRefund = false;
  refundStatus: 'pending' | 'processing' | 'success' | 'failed' = 'success';

  constructor(private readonly secret = 'sk_test_mock') {}

  async initialise(input: {
    reference: string;
    amountKobo: Kobo;
    email: string;
    metadata: Record<string, unknown>;
  }): Promise<PaymentInitResult> {
    if (this.failInitialise) throw new Error('mock gateway down');
    this.initialised.push(input);
    return Promise.resolve({
      authorizationUrl: `https://checkout.paystack.mock/${input.reference}`,
      accessCode: `ac_${input.reference}`,
      reference: input.reference,
    });
  }

  /** Script the next verify() answer for a reference. */
  willVerify(
    reference: string,
    v: Partial<PaymentVerification> & { status: PaymentVerification['status'] },
  ): void {
    const init = this.initialised.find((i) => i.reference === reference);
    this.verifications.set(reference, {
      reference,
      status: v.status,
      amountKobo: v.amountKobo ?? init?.amountKobo ?? kobo(0),
      currency: v.currency ?? 'NGN',
      providerTxId: v.providerTxId ?? `tx_${reference}`,
      channel: v.channel ?? 'card',
      paidAt: v.paidAt ?? new Date(),
    });
  }

  async verify(reference: string): Promise<PaymentVerification> {
    const v = this.verifications.get(reference);
    if (v) return Promise.resolve(v);
    const init = this.initialised.find((i) => i.reference === reference);
    return Promise.resolve({
      reference,
      status: init ? 'pending' : 'unknown',
      amountKobo: init?.amountKobo ?? kobo(0),
      currency: 'NGN',
      providerTxId: null,
      channel: null,
      paidAt: null,
    });
  }

  async refund(input: {
    providerTxId: string;
    amountKobo: Kobo;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ providerRef: string; status: 'pending' | 'processing' | 'success' | 'failed' }> {
    if (this.failRefund) throw new Error('mock refund failed');
    this.refunds.push(input);
    return Promise.resolve({
      providerRef: `rf_${input.idempotencyKey}`,
      status: this.refundStatus,
    });
  }

  sign(rawBody: string | Buffer): string {
    return createHmac('sha512', this.secret).update(rawBody).digest('hex');
  }

  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader) return false;
    const expected = Buffer.from(this.sign(rawBody), 'utf8');
    const given = Buffer.from(signatureHeader, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
