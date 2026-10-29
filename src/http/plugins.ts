/**
 * Cross-cutting HTTP plugins: request ids, uniform errors, authentication,
 * idempotency keys. Each is small on purpose; read them top to bottom.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

import type { Core } from '../core/index.js';
import { DomainError } from '../core/domain/errors.js';
import type { Actor } from '../core/ports/index.js';

import { actorFrom, verifyToken, type TokenClaims } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    claims: TokenClaims;
    actor: Actor;
    /** "<kind>:<client>:<actor id>" — the idempotency namespace. */
    actorKey: string;
  }
  interface FastifyInstance {
    core: Core;
  }
}

// ---------------------------------------------------------------------------
// Errors: one shape for everything. Never leak stack traces or SQL to clients.
// ---------------------------------------------------------------------------
export const errorHandlerPlugin = fp((app: FastifyInstance, _opts, done) => {
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = req.id;
    if (err instanceof DomainError) {
      return reply.status(err.status).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          requestId,
        },
      });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'request failed validation',
          details: {
            issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
          },
          requestId,
        },
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'request failed validation',
          details: { issues: err.issues.map((i) => i.message) },
          requestId,
        },
      });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err, requestId }, 'response did not match its schema');
      return reply
        .status(500)
        .send({ error: { code: 'INTERNAL', message: 'internal error', requestId } });
    }
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status === 429) {
      return reply
        .status(429)
        .send({ error: { code: 'RATE_LIMITED', message: 'too many requests', requestId } });
    }
    if (status >= 500) {
      req.log.error({ err, requestId }, 'unhandled error');
      return reply
        .status(500)
        .send({ error: { code: 'INTERNAL', message: 'internal error', requestId } });
    }
    const message = err instanceof Error ? err.message : 'request error';
    return reply
      .status(status)
      .send({ error: { code: status === 404 ? 'NOT_FOUND' : 'VALIDATION', message, requestId } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `route ${req.method} ${req.url} not found`,
        requestId: req.id,
      },
    }),
  );
  done();
});

// ---------------------------------------------------------------------------
// Auth: bearer token → claims → actor. Applied to everything under /internal.
// ---------------------------------------------------------------------------
const APP_PUBLIC = /^\/app\/v1\/(session|menu|zones|config)(\?|$)/;

export const authPlugin = fp((app: FastifyInstance, opts: { secret: string }, done) => {
  app.decorateRequest('claims');
  app.decorateRequest('actor');
  app.decorateRequest('actorKey', '');
  app.addHook('onRequest', (req, reply, next) => {
    const isInternal = req.url.startsWith('/internal/');
    const isApp = req.url.startsWith('/app/v1/');
    if (!isInternal && !isApp) {
      next();
      return;
    }
    // Mobile app: a few routes are public (session bootstrap, menu, zones, config).
    if (isApp && APP_PUBLIC.test(req.url)) {
      next();
      return;
    }
    // The OpenAPI document and docs are readable without a token in non-production.
    if (
      /^\/internal\/v1\/(openapi\.json|docs)/.test(req.url) &&
      process.env['NODE_ENV'] !== 'production'
    ) {
      next();
      return;
    }
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const claims = token ? verifyToken(opts.secret, token) : null;
    if (!claims) {
      void reply.status(401).send({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'missing or invalid token',
          requestId: req.id,
        },
      });
      return;
    }
    const customerHeader = req.headers['x-customer-id'];
    const actor = actorFrom(
      claims,
      typeof customerHeader === 'string' ? customerHeader : undefined,
      req.id,
    );
    if (!actor) {
      void reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'X-Customer-Id header required for adapter tokens',
          requestId: req.id,
        },
      });
      return;
    }
    req.claims = claims;
    req.actor = actor;
    req.actorKey = `${claims.kind}:${claims.client}:${actor.id}`;
    next();
  });
  done();
});

/** Route-level role guard for staff-only endpoints (service layer re-checks). */
export function requireRoles(...roles: string[]) {
  return (req: FastifyRequest, reply: FastifyReply, next: (err?: Error) => void): void => {
    const a = req.actor;
    const ok =
      a.type === 'system' || (a.type === 'staff' && a.role !== undefined && roles.includes(a.role));
    if (!ok) {
      void reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: `requires role: ${roles.join(', ')}`,
          requestId: req.id,
        },
      });
      return;
    }
    next();
  };
}

export function requireKinds(...kinds: TokenClaims['kind'][]) {
  return (req: FastifyRequest, reply: FastifyReply, next: (err?: Error) => void): void => {
    if (!kinds.includes(req.claims.kind)) {
      void reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: `requires token kind: ${kinds.join(', ')}`,
          requestId: req.id,
        },
      });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Idempotency: every state-changing call under /internal needs Idempotency-Key.
// Replaying the same key + same body returns the stored response; same key with a
// different body is rejected; a key whose first request is still running is 409.
// ---------------------------------------------------------------------------
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const idempotencyPlugin = fp((app: FastifyInstance, _opts, done) => {
  app.addHook('preHandler', async (req, reply) => {
    if (!MUTATING.has(req.method) || !req.url.startsWith('/internal/')) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'Idempotency-Key header (8–128 chars) is required on state-changing requests',
          requestId: req.id,
        },
      });
    }
    const requestHash = createHash('sha256')
      .update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`)
      .digest('hex');
    const result = await app.core.uow.transaction((tx) =>
      app.core.repos.idempotency.claim(tx, { actorKey: req.actorKey, key, requestHash }),
    );
    switch (result.state) {
      case 'new':
        (req as FastifyRequest & { idemKey?: string }).idemKey = key;
        return;
      case 'replay':
        reply.header('Idempotent-Replayed', 'true');
        return reply.status(result.statusCode).send(result.body);
      case 'mismatch':
        return reply.status(422).send({
          error: {
            code: 'IDEMPOTENCY_MISMATCH',
            message: 'this Idempotency-Key was used with a different request',
            requestId: req.id,
          },
        });
      case 'in_progress':
        return reply.status(409).send({
          error: {
            code: 'CONFLICT',
            message: 'a request with this Idempotency-Key is still being processed',
            requestId: req.id,
          },
        });
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const key = (req as FastifyRequest & { idemKey?: string }).idemKey;
    if (!key) return payload;
    let body: unknown = null;
    if (typeof payload === 'string' && payload.length > 0) {
      try {
        body = JSON.parse(payload);
      } catch {
        body = payload;
      }
    }
    // Store 5xx responses too? No — a transient failure should be retryable with the same key.
    if (reply.statusCode < 500) {
      await app.core.uow.transaction((tx) =>
        app.core.repos.idempotency.complete(tx, req.actorKey, key, reply.statusCode, body),
      );
    } else {
      // Release the claim so the client can retry after a server-side failure.
      await app.core.uow.transaction((tx) =>
        app.core.repos.idempotency.release(tx, req.actorKey, key),
      );
    }
    return payload;
  });
  done();
});

export const requestIdPlugin = fp((app: FastifyInstance, _opts, done) => {
  app.addHook('onRequest', (req, reply, next) => {
    reply.header('X-Request-Id', req.id);
    next();
  });
  done();
});

export const genReqId = (): string => randomUUID();
