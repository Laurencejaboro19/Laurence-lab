import { Client } from 'pg';
import { expect, it } from 'vitest';

import { listMigrationFiles, runMigrations } from '../../src/db/migrate.js';

import { describeWithDb, TEST_MIGRATE_URL } from './helpers.js';

describeWithDb('migration runner', () => {
  it('is idempotent: a second run applies nothing', async () => {
    const client = new Client({ connectionString: TEST_MIGRATE_URL });
    await client.connect();
    try {
      const files = await listMigrationFiles();
      const result = await runMigrations(client, files);
      expect(result.applied).toEqual([]);
      expect(result.skipped).toBe(files.length);
    } finally {
      await client.end();
    }
  });

  it('refuses to run when an applied migration has been edited', async () => {
    const client = new Client({ connectionString: TEST_MIGRATE_URL });
    await client.connect();
    try {
      const files = await listMigrationFiles();
      const edited = files.map((f, i) =>
        i === 0 ? { ...f, sql: `${f.sql}\n-- edited`, checksum: 'deadbeef' } : f,
      );
      await expect(runMigrations(client, edited)).rejects.toThrow(/edited after being applied/);
    } finally {
      await client.end();
    }
  });

  it('refuses to run when an applied migration is missing from disk', async () => {
    const client = new Client({ connectionString: TEST_MIGRATE_URL });
    await client.connect();
    try {
      const files = await listMigrationFiles();
      await expect(runMigrations(client, files.slice(1))).rejects.toThrow(/missing on disk/);
    } finally {
      await client.end();
    }
  });

  it('names migrations with unique, zero-padded versions', async () => {
    const files = await listMigrationFiles();
    const versions = files.map((f) => f.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });
});
