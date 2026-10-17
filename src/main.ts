/**
 * Process entry point.
 *
 *   npm run dev              HTTP server + (from phase 7) job consumers, one process
 *   npm run dev -- --http    HTTP only
 *   npm run dev -- --worker  jobs only (same code, different flag) — phase 7
 *
 * Wiring happens here and nowhere else: environment → pools → repositories →
 * core → server. Graceful shutdown closes the server first (stop accepting),
 * then the pools, so in-flight requests finish and no connection is leaked.
 */
import { loadEnv } from './config/env.js';
import { createCore } from './core/index.js';
import { InMemoryEventBus } from './core/events/in-memory.js';
import { createPool, PgUnitOfWork } from './db/client.js';
import { createRepositories } from './db/repositories/index.js';
import { buildServer } from './http/server.js';
import { MockPaymentGateway } from './providers/payments/mock-gateway.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const args = new Set(process.argv.slice(2));
  const runHttp = args.has('--http') || !args.has('--worker');

  const pool = createPool(env.DATABASE_URL, { max: 10, pooled: env.DATABASE_POOLED });
  // In-process event bus until phase 7 wires pg-boss. Handlers log for now.
  const events = new InMemoryEventBus();
  const uow = new PgUnitOfWork(pool, {
    onCommit: (tx) => events.flush(tx),
    onRollback: (tx) => {
      events.discard(tx);
    },
  });
  // Phase 4 swaps in the real Paystack client (test keys) and the local mock server.
  const gateway = new MockPaymentGateway(env.PAYSTACK_SECRET_KEY || undefined);
  const core = createCore({ uow, repos: createRepositories(), gateway, events });

  const app = await buildServer({
    core,
    pool,
    internalApiSecret: env.INTERNAL_API_SECRET,
    logLevel: env.LOG_LEVEL,
    prettyLogs: env.NODE_ENV === 'development',
    trustProxy: env.NODE_ENV === 'production',
  });
  events.subscribe((event) => {
    app.log.info({ event }, 'domain event');
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (runHttp) {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`internal API docs: ${env.PUBLIC_BASE_URL}/internal/v1/docs`);
  }
  if (args.has('--worker')) {
    app.log.warn('worker mode: job consumers arrive in phase 7; nothing to run yet');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
