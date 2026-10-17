/**
 * Local Paystack look-alike for development and tests. Speaks the subset of the
 * API the app uses, with the same envelope and the same webhook signature, so
 * the real PaystackGateway can point at it unchanged (PAYSTACK_BASE_URL).
 *
 *   POST /transaction/initialize     → authorization_url on this server
 *   GET  /transaction/verify/:ref    → current state of the fake transaction
 *   POST /refund                     → queued refund
 *   GET  /pay/:ref                   → a tiny checkout page with "Pay" / "Fail" buttons
 *   POST /pay/:ref/:outcome          → marks the transaction and POSTs a signed
 *                                      charge.success webhook to WEBHOOK_URL
 *
 * Run standalone:  npx tsx src/providers/payments/mock-server.ts   (port 4010)
 * It keeps everything in memory; restart to reset.
 */
import { createHmac } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

interface FakeTx {
  id: number;
  reference: string;
  amount: number;
  currency: string;
  email: string;
  status: 'ongoing' | 'success' | 'failed' | 'abandoned';
  channel: string | null;
  paid_at: string | null;
  metadata: unknown;
}

export interface MockServerOptions {
  secretKey: string;
  /** Where to POST webhooks. If unset, no webhook is sent. */
  webhookUrl?: string;
  publicBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export type MockPaystack = FastifyInstance & {
  state: Map<string, FakeTx>;
  webhooksSent: unknown[];
};

export function buildMockPaystack(opts: MockServerOptions): MockPaystack {
  const app = Fastify({ logger: false }) as unknown as MockPaystack;
  const txs = new Map<string, FakeTx>();
  const webhooksSent: unknown[] = [];
  app.state = txs;
  app.webhooksSent = webhooksSent;
  let nextId = 4_099_260_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (): string =>
    opts.publicBaseUrl ??
    `http://127.0.0.1:${String((app.server.address() as { port: number } | null)?.port ?? 4010)}`;

  const requireAuth = (auth: string | undefined): boolean => auth === `Bearer ${opts.secretKey}`;

  app.post<{
    Body: {
      amount: string | number;
      email: string;
      reference?: string;
      currency?: string;
      metadata?: string;
    };
  }>('/transaction/initialize', async (req, reply) => {
    if (!requireAuth(req.headers.authorization))
      return reply.status(401).send({ status: false, message: 'Invalid key' });
    const reference = req.body.reference ?? `ref_${Date.now()}`;
    if (txs.has(reference))
      return reply.status(400).send({ status: false, message: 'Duplicate Transaction Reference' });
    const tx: FakeTx = {
      id: nextId++,
      reference,
      amount: Number(req.body.amount),
      currency: req.body.currency ?? 'NGN',
      email: req.body.email,
      status: 'ongoing',
      channel: null,
      paid_at: null,
      metadata: req.body.metadata ? (JSON.parse(req.body.metadata) as unknown) : null,
    };
    txs.set(reference, tx);
    return {
      status: true,
      message: 'Authorization URL created',
      data: {
        authorization_url: `${base()}/pay/${reference}`,
        access_code: `ac_${reference}`,
        reference,
      },
    };
  });

  app.get<{ Params: { reference: string } }>(
    '/transaction/verify/:reference',
    async (req, reply) => {
      if (!requireAuth(req.headers.authorization))
        return reply.status(401).send({ status: false, message: 'Invalid key' });
      const tx = txs.get(req.params.reference);
      if (!tx)
        return reply
          .status(404)
          .send({ status: false, message: 'Transaction reference not found' });
      return {
        status: true,
        message: 'Verification successful',
        data: { ...tx, customer: { id: 1, email: tx.email, customer_code: 'CUS_mock' } },
      };
    },
  );

  app.post<{ Body: { transaction: string; amount?: number } }>('/refund', async (req, reply) => {
    if (!requireAuth(req.headers.authorization))
      return reply.status(401).send({ status: false, message: 'Invalid key' });
    const tx = [...txs.values()].find(
      (t) => String(t.id) === req.body.transaction || t.reference === req.body.transaction,
    );
    if (!tx) return reply.status(404).send({ status: false, message: 'Transaction not found' });
    const amount = req.body.amount ?? tx.amount;
    if (amount > tx.amount)
      return reply
        .status(400)
        .send({ status: false, message: 'Refund amount cannot exceed transaction amount' });
    return {
      status: true,
      message: 'Refund has been queued for processing',
      data: {
        id: nextId++,
        status: 'pending',
        amount,
        transaction: { id: tx.id, reference: tx.reference },
      },
    };
  });

  // --- the fake checkout page ---------------------------------------------
  app.get<{ Params: { reference: string } }>('/pay/:reference', async (req, reply) => {
    const tx = txs.get(req.params.reference);
    if (!tx) return reply.status(404).type('text/html').send('<h1>Unknown transaction</h1>');
    const naira = (tx.amount / 100).toLocaleString('en-NG');
    return reply.type('text/html')
      .send(`<!doctype html><meta name="viewport" content="width=device-width">
<title>Mock Paystack</title>
<body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<h2>Mock Paystack checkout</h2>
<p><b>Reference:</b> ${tx.reference}<br><b>Amount:</b> ₦${naira}<br><b>Status:</b> ${tx.status}</p>
${
  tx.status === 'ongoing'
    ? `
<form method="post" action="/pay/${tx.reference}/success"><button style="padding:12px 20px;font-size:16px">Pay ₦${naira} (card)</button></form>
<form method="post" action="/pay/${tx.reference}/failed" style="margin-top:8px"><button style="padding:8px 16px">Simulate failure</button></form>`
    : '<p>This transaction is closed.</p>'
}
<p style="color:#666;font-size:13px">This is the local mock. No money moves. Close this tab and return to Telegram.</p></body>`);
  });

  app.post<{ Params: { reference: string; outcome: 'success' | 'failed' } }>(
    '/pay/:reference/:outcome',
    async (req, reply) => {
      const tx = txs.get(req.params.reference);
      if (!tx) return reply.status(404).send({ status: false, message: 'Unknown transaction' });
      if (tx.status === 'ongoing') {
        tx.status = req.params.outcome === 'success' ? 'success' : 'failed';
        tx.channel = 'card';
        tx.paid_at = tx.status === 'success' ? new Date().toISOString() : null;
        if (tx.status === 'success') await sendWebhook('charge.success', tx);
      }
      return reply.redirect(`/pay/${tx.reference}`);
    },
  );

  async function sendWebhook(event: string, tx: FakeTx): Promise<void> {
    const body = JSON.stringify({
      event,
      data: {
        id: tx.id,
        status: tx.status,
        reference: tx.reference,
        amount: tx.amount,
        currency: tx.currency,
        channel: tx.channel,
        paid_at: tx.paid_at,
        metadata: tx.metadata,
        customer: { id: 1, email: tx.email, customer_code: 'CUS_mock' },
        authorization: { authorization_code: 'AUTH_mock', last4: '4081', card_type: 'visa' },
      },
    });
    webhooksSent.push(JSON.parse(body));
    if (!opts.webhookUrl) return;
    const signature = createHmac('sha512', opts.secretKey).update(body).digest('hex');
    try {
      await fetchImpl(opts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
        body,
      });
    } catch {
      // Like the real thing, a failed delivery is simply retried later — here, never. Reconciliation covers it.
    }
  }

  return app;
}

/** Sign a body the way the mock (and Paystack) do — handy in tests. */
export function signPaystack(secretKey: string, rawBody: string): string {
  return createHmac('sha512', secretKey).update(rawBody).digest('hex');
}

// Standalone entry point.
if (process.argv[1] && /mock-server\.(ts|js)$/.test(process.argv[1])) {
  const port = Number(process.env['MOCK_PAYSTACK_PORT'] ?? 4010);
  const app = buildMockPaystack({
    secretKey: process.env['PAYSTACK_SECRET_KEY'] ?? 'sk_test_mock',
    ...(process.env['MOCK_PAYSTACK_WEBHOOK_URL']
      ? { webhookUrl: process.env['MOCK_PAYSTACK_WEBHOOK_URL'] }
      : {}),
  });
  app
    .listen({ port, host: '0.0.0.0' })
    .then(() => {
      process.stdout.write(`mock paystack listening on http://127.0.0.1:${port}\n`);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
