import { expect, it } from 'vitest';

import { describeWithDb } from './helpers.js';

/**
 * Proves the Supabase lockdown from migration 0007: every table in `app` has RLS
 * enabled with a policy only for app_runtime, and the Data API roles have no
 * privileges whatsoever. The anon/authenticated roles do not exist on a plain
 * local Postgres, so the test creates them (NOLOGIN) to make the privilege check
 * meaningful; on Supabase they already exist.
 */
describeWithDb('database lockdown', (ctx) => {
  it('has RLS enabled and forced on every table in schema app (except the migration ledger)', async () => {
    const res = await ctx.migrate.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY 1`);
    expect(res.rows.length).toBeGreaterThan(30);
    for (const row of res.rows) {
      expect(row.relrowsecurity, `${row.relname} RLS enabled`).toBe(true);
      if (row.relname !== 'schema_migrations') {
        expect(row.relforcerowsecurity, `${row.relname} RLS forced`).toBe(true);
      }
    }
  });

  it('has exactly one policy per table and it is for app_runtime only', async () => {
    const res = await ctx.migrate.query<{ tablename: string; roles: string[]; count: string }>(
      `SELECT tablename, array_agg(roles::text) AS roles, count(*)::text AS count
       FROM pg_policies WHERE schemaname = 'app' GROUP BY tablename`,
    );
    const tables = await ctx.migrate.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'app'`,
    );
    expect(res.rows).toHaveLength(tables.rows.length);
    for (const row of res.rows) {
      expect(row.count).toBe('1');
      expect(row.roles).toEqual(['{app_runtime}']);
    }
  });

  it('gives the Data API roles (anon, authenticated, service_role) no table privileges', async () => {
    const roles = await ctx.migrate.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`,
    );
    // On Supabase these roles always exist; locally src/db/setup/local-dev.sql creates them.
    expect(
      roles.rows.length,
      'anon/authenticated/service_role roles missing — run src/db/setup/local-dev.sql',
    ).toBe(3);
    const res = await ctx.migrate.query<{ role: string; tablename: string; priv: string }>(
      `SELECT r.rolname AS role, t.tablename, p.priv
       FROM pg_tables t
       CROSS JOIN pg_roles r
       CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS p(priv)
       WHERE t.schemaname = 'app'
         AND r.rolname IN ('anon','authenticated','service_role')
         AND has_table_privilege(r.rolname, format('app.%I', t.tablename), p.priv)`,
    );
    expect(res.rows).toEqual([]);
    const schema = await ctx.migrate.query<{ ok: boolean }>(
      `SELECT bool_or(has_schema_privilege(rolname, 'app', 'USAGE')) AS ok
       FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`,
    );
    expect(schema.rows[0]!.ok).toBe(false);
  });

  it('lets app_runtime read and write business tables but not alter them', async () => {
    await ctx.runtime.query(`INSERT INTO app.settings (key, value) VALUES ('t', '1')`);
    const r = await ctx.runtime.query(`SELECT value FROM app.settings WHERE key = 't'`);
    expect(r.rowCount).toBe(1);
    await expect(ctx.runtime.query(`ALTER TABLE app.settings ADD COLUMN x int`)).rejects.toThrow(
      /must be owner/,
    );
    await expect(ctx.runtime.query(`DROP TABLE app.settings`)).rejects.toThrow(/must be owner/);
  });

  it('keeps append-only tables append-only for the runtime role', async () => {
    await ctx.runtime.query(`INSERT INTO app.settings_history (key, new_value) VALUES ('t', '2')`);
    await expect(
      ctx.runtime.query(`UPDATE app.settings_history SET new_value = '3'`),
    ).rejects.toThrow(/permission denied/);
    await expect(ctx.runtime.query(`DELETE FROM app.settings_history`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
