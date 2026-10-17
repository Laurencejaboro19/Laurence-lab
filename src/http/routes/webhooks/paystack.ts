/**
 * POST /webhooks/paystack
 *
 * 1. verify   x-paystack-signature over the RAW body (constant time); optional source-IP check
 * 2. dedupe   PaymentService.ingestProviderEvent → payment_events UNIQUE (provider, event id)
 * 3. enqueue  BackgroundRunner → verify-with-Paystack → settle
 * 4. 200      within milliseconds; Paystack retries on anything else
 *
 * The body is kept as a Buffer by a scoped content-type parser so the signature
 * is computed over exactly the bytes Paystack signed.
 */
import type { FastifyInstance } from 'fastify';

import {
  PAYSTACK_WEBHOOK_IPS,
  redactPaystackPayload,
} from '../../../providers/payments/paystack.js';
import type { BackgroundRunner } from '../../../jobs/background.js';

export interface PaystackWebhookOptions {
  background: BackgroundRunner;
  /** Enforce Paystack's published source IPs. Off in development (the local mock). */
  enforceSourceIps: boolean;
}

export function registerPaystackWebhook(app: FastifyInstance, opts: PaystackWebhookOptions): void {
  app.register(
    (scope, _o, done) => {
      scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, cb) => {
        cb(null, body);
      });
      scope.post<{ Body: Buffer }>(
        '/paystack',
        { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
        async (req, reply) => {
          const raw = req.body;
          const signature = req.headers['x-paystack-signature'];
          // REVIEW: authenticity. Wrong/missing signature → 401 before any parsing.
          if (
            !app.core.gateway.verifyWebhookSignature(
              raw,
              typeof signature === 'string' ? signature : undefined,
            )
          ) {
            req.log.warn({ ip: req.ip }, 'paystack webhook: bad signature');
            return reply.status(401).send({ ok: false });
          }
          if (opts.enforceSourceIps && !PAYSTACK_WEBHOOK_IPS.includes(req.ip)) {
            req.log.warn({ ip: req.ip }, 'paystack webhook: unexpected source ip');
            return reply.status(403).send({ ok: false });
          }
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          } catch {
            return reply.status(400).send({ ok: false });
          }
          const data = (payload['data'] ?? {}) as Record<string, unknown>;
          const event = {
            provider: 'paystack' as const,
            eventType: typeof payload['event'] === 'string' ? payload['event'] : 'unknown',
            reference: typeof data['reference'] === 'string' ? data['reference'] : null,
            payloadRedacted: redactPaystackPayload(payload),
          };
          const { deduped, externalEventId } = await app.core.payments.ingestProviderEvent(event);
          if (!deduped) {
            opts.background.run(`paystack:${event.eventType}:${externalEventId}`, () =>
              app.core.payments.processRecordedEvent(externalEventId, event),
            );
          }
          return reply.status(200).send({ ok: true, deduped });
        },
      );
      done();
    },
    { prefix: '/webhooks' },
  );
}
