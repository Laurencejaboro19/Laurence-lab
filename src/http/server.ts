/**
 * Fastify app factory. `buildServer()` returns an app that tests can drive with
 * `app.inject()` and `main.ts` listens on. No business logic lives here.
 */
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { Core } from '../core/index.js';
import { withClient } from '../db/client.js';
import { pgOf } from '../db/client.js';
import { BackgroundRunner, type BackgroundMode } from '../jobs/background.js';

import {
  authPlugin,
  errorHandlerPlugin,
  genReqId,
  idempotencyPlugin,
  requestIdPlugin,
} from './plugins.js';
import { registerInternalV1 } from './routes/internal/v1/index.js';
import { registerPaystackWebhook } from './routes/webhooks/paystack.js';

export interface ServerOptions {
  core: Core;
  pool: Pool;
  internalApiSecret: string;
  logLevel?: string;
  /** Pretty logs in development only. */
  prettyLogs?: boolean;
  trustProxy?: boolean;
  /** Enforce Paystack's published webhook source IPs (production). */
  enforcePaystackIps?: boolean;
  /** 'inline' on serverless hosts: finish background work before the response is sent. */
  backgroundMode?: BackgroundMode;
  /** Serve the Swagger UI at /internal/v1/docs (default true; off on serverless hosts). */
  docsUi?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    background: BackgroundRunner;
  }
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? 'info',
      // Never log secrets or PII. Phone numbers are additionally scrubbed by the
      // serializers in observability/logger.ts (phase 8); this is the floor.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-paystack-signature"]',
          'req.headers["x-telegram-bot-api-secret-token"]',
          'req.headers["x-hub-signature-256"]',
          '*.password',
          '*.token',
          '*.secret',
        ],
        censor: '[redacted]',
      },
      ...(opts.prettyLogs
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
    genReqId,
    requestIdHeader: 'x-request-id',
    bodyLimit: 256 * 1024,
    trustProxy: opts.trustProxy ?? false,
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('core', opts.core);
  app.decorate('background', new BackgroundRunner(app.log, opts.backgroundMode ?? 'detached'));
  if (opts.backgroundMode === 'inline') {
    // Webhook handlers enqueue then reply; on serverless we must drain before replying.
    app.addHook('preSerialization', async (req, _reply, payload) => {
      if (req.url.startsWith('/webhooks/')) await app.background.settle();
      return payload;
    });
  }

  await app.register(sensible);
  await app.register(helmet, { global: true, contentSecurityPolicy: false });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Rate limit per authenticated actor where known, else per IP.
    keyGenerator: (req) => {
      const key = (req as { actorKey?: string }).actorKey;
      return key !== undefined && key !== '' ? key : req.ip;
    },
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
  });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { secret: opts.internalApiSecret });
  await app.register(idempotencyPlugin);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Laurence Lab Bot — internal API',
        description:
          'The only way anything touches business logic. Clients: Telegram/WhatsApp adapters (adapter tokens + X-Customer-Id), the admin bot (staff tokens), jobs (system tokens). State-changing requests require an Idempotency-Key header.',
        version: '1.0.0',
      },
      servers: [{ url: '/internal/v1' }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
      tags: [
        { name: 'menu' },
        { name: 'inventory' },
        { name: 'customers' },
        { name: 'cart' },
        { name: 'orders' },
        { name: 'payments' },
        { name: 'settings' },
        { name: 'audit' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  // --- health ---------------------------------------------------------------
  app.get('/healthz', { schema: { response: { 200: z.object({ ok: z.literal(true) }) } } }, () => ({
    ok: true as const,
  }));
  app.get(
    '/readyz',
    {
      schema: {
        response: {
          200: z.object({ ok: z.boolean(), schemaVersion: z.number().int().nullable() }),
          503: z.object({ ok: z.literal(false), error: z.string() }),
        },
      },
    },
    async (_req, reply) => {
      try {
        const version = await withClient(opts.pool, async (tx) => {
          const r = await pgOf(tx).query<{ v: number | null }>(
            'SELECT max(version)::int AS v FROM app.schema_migrations',
          );
          return r.rows[0]?.v ?? null;
        });
        return { ok: true, schemaVersion: version };
      } catch (err) {
        return reply.status(503).send({
          ok: false as const,
          error: err instanceof Error ? err.message : 'database unavailable',
        });
      }
    },
  );

  // --- internal API v1 -------------------------------------------------------
  await app.register(
    (v1, _opts, done) => {
      registerInternalV1(v1);
      v1.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());
      done();
    },
    { prefix: '/internal/v1' },
  );
  if (opts.docsUi ?? true) {
    // Loaded lazily: @fastify/swagger-ui pulls in @fastify/static, whose ESM-only
    // dependency (content-disposition 3) cannot be require()d on Vercel's Node 24
    // runtime. The serverless entry turns the UI off; /openapi.json stays available.
    const { default: swaggerUi } = await import('@fastify/swagger-ui');
    await app.register(swaggerUi, {
      routePrefix: '/internal/v1/docs',
      uiConfig: { docExpansion: 'list' },
    });
  }

  // --- provider webhooks -----------------------------------------------------
  registerPaystackWebhook(app, {
    background: app.background,
    enforceSourceIps: opts.enforcePaystackIps ?? false,
  });

  app.addHook('onClose', async () => {
    await app.background.drain();
  });

  return app;
}
