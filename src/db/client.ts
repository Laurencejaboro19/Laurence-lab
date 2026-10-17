/**
 * Postgres connection pool and the UnitOfWork implementation.
 *
 * Two pools exist in production (see README "Database connections"):
 *   - `createPool(DATABASE_URL)`        request-time traffic; may be the transaction pooler
 *   - `createPool(DATABASE_URL_DIRECT)` jobs/scheduler; must be session mode or direct
 *
 * A `Tx` is a thin wrapper around a checked-out client. Repositories unwrap it
 * with `pgOf(tx)`. Nothing outside src/db ever sees a pg client.
 */
import pg, { type Pool, type PoolClient, type PoolConfig } from 'pg';

import type { Tx, UnitOfWork } from '../core/ports/index.js';

// pg returns bigint (int8) as string by default to avoid precision loss. Our money
// columns are bigint; the repositories call kobo() on them, which accepts strings.
// Leave the parser alone so nothing silently becomes a float.

export interface PgTx extends Tx {
  readonly client: PoolClient;
}

export function pgOf(tx: Tx): PoolClient {
  const c = (tx as Partial<PgTx>).client;
  if (!c) throw new Error('not a Postgres transaction handle');
  return c;
}

export function createPool(
  connectionString: string,
  opts: { max?: number; pooled?: boolean } = {},
): Pool {
  const config: PoolConfig = {
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Statement timeout protects the kitchen from one runaway query during the dinner rush.
    statement_timeout: 15_000,
    application_name: 'laurence-lab-bot',
  };
  // Supabase pooler endpoints require TLS; local Postgres does not offer it.
  if (/supabase\.(co|com)/.test(connectionString)) config.ssl = { rejectUnauthorized: true };
  return new pg.Pool(config);
}

export interface TxHooks {
  /** Runs after COMMIT succeeded (e.g. flush buffered domain events). */
  onCommit?: (tx: Tx) => Promise<void>;
  /** Runs after ROLLBACK (e.g. discard buffered domain events). */
  onRollback?: (tx: Tx) => void;
}

export class PgUnitOfWork implements UnitOfWork {
  constructor(
    private readonly pool: Pool,
    private readonly hooks: TxHooks = {},
  ) {}

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: PgTx = { __tx: true, client };
    let committed = false;
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      committed = true;
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection may already be broken; the pool will discard it */
      }
      this.hooks.onRollback?.(tx);
      throw err;
    } finally {
      client.release();
      // After release so the hook can open its own connections without deadlocking a small pool.
      if (committed && this.hooks.onCommit) await this.hooks.onCommit(tx);
    }
  }
}

/** Run a one-off read outside an explicit transaction (health checks, etc.). */
export async function withClient<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const tx: PgTx = { __tx: true, client };
    return await fn(tx);
  } finally {
    client.release();
  }
}
