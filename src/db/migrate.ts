/**
 * Migration runner.
 *
 * Usage:  npm run migrate            apply all pending migrations
 *         npm run migrate -- status  show applied / pending
 *
 * Design (read this before adding a migration):
 * - Migrations are plain SQL files in src/db/migrations named NNNN_description.sql.
 *   They are applied in filename order, each inside its own transaction.
 * - The runner records a SHA-256 checksum of every applied file. If a file that has
 *   already been applied is later edited, the runner refuses to continue — history
 *   is immutable; write a new migration instead.
 * - A Postgres advisory lock makes concurrent runners (two deploys, a human and CI)
 *   wait for each other instead of racing.
 * - Connect with DATABASE_URL_MIGRATE (the app_migrate role) over a DIRECT or
 *   SESSION connection. Transaction-mode poolers break advisory locks.
 * - No framework: the owner can read this whole file in five minutes.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_KEY = 7_372_161; // arbitrary constant; must be the same for every runner

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: Date;
}

export async function listMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const files: MigrationFile[] = [];
  for (const filename of entries) {
    const sql = await readFile(path.join(dir, filename), 'utf8');
    const match = /^(\d{4})_(.+)\.sql$/.exec(filename);
    if (!match) continue;
    files.push({
      version: Number(match[1]),
      name: match[2] ?? '',
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  // Guard against two files sharing a version number (a merge accident).
  const seen = new Set<number>();
  for (const f of files) {
    if (seen.has(f.version)) throw new Error(`Duplicate migration version ${f.version}`);
    seen.add(f.version);
  }
  return files;
}

async function ensureLedger(client: Client): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS app');
  await client.query(`
    CREATE TABLE IF NOT EXISTS app.schema_migrations (
      version    integer PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

async function readApplied(client: Client): Promise<AppliedMigration[]> {
  const res = await client.query<AppliedMigration>(
    'SELECT version, name, checksum, applied_at FROM app.schema_migrations ORDER BY version',
  );
  return res.rows;
}

export interface MigrateResult {
  applied: string[];
  skipped: number;
}

/**
 * Applies pending migrations using an already-connected client. Exported so tests
 * can run it against a scratch database.
 */
export async function runMigrations(
  client: Client,
  files?: MigrationFile[],
  log: (line: string) => void = () => undefined,
): Promise<MigrateResult> {
  const all = files ?? (await listMigrationFiles());
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await ensureLedger(client);
    const applied = await readApplied(client);
    const appliedByVersion = new Map(applied.map((a) => [a.version, a]));

    for (const a of applied) {
      const file = all.find((f) => f.version === a.version);
      if (!file) {
        throw new Error(
          `Migration ${a.version} (${a.name}) is applied in the database but missing on disk. ` +
            'Never delete applied migrations.',
        );
      }
      if (file.checksum !== a.checksum) {
        throw new Error(
          `Migration ${file.filename} was edited after being applied (checksum mismatch). ` +
            'Applied migrations are immutable — add a new migration instead.',
        );
      }
    }

    const result: MigrateResult = { applied: [], skipped: 0 };
    for (const file of all) {
      if (appliedByVersion.has(file.version)) {
        result.skipped += 1;
        continue;
      }
      log(`applying ${file.filename}`);
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          'INSERT INTO app.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [file.version, file.name, file.checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file.filename} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
      result.applied.push(file.filename);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

export async function migrationStatus(
  client: Client,
): Promise<{ applied: AppliedMigration[]; pending: MigrationFile[] }> {
  await ensureLedger(client);
  const applied = await readApplied(client);
  const files = await listMigrationFiles();
  const appliedVersions = new Set(applied.map((a) => a.version));
  return { applied, pending: files.filter((f) => !appliedVersions.has(f.version)) };
}

async function main(): Promise<void> {
  const { loadEnv } = await import('../config/env.js');
  const env = loadEnv();
  const url = env.DATABASE_URL_MIGRATE ?? env.DATABASE_URL_DIRECT;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const command = process.argv[2] ?? 'up';
    if (command === 'status') {
      const s = await migrationStatus(client);
      for (const a of s.applied) {
        process.stdout.write(`applied  ${String(a.version).padStart(4, '0')} ${a.name}\n`);
      }
      for (const p of s.pending) process.stdout.write(`pending  ${p.filename}\n`);
      return;
    }
    const result = await runMigrations(client, undefined, (l) => process.stdout.write(`${l}\n`));
    process.stdout.write(
      `migrations: ${result.applied.length} applied, ${result.skipped} already up to date\n`,
    );
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
