import { expect, it } from 'vitest';

import { describeWithDb } from './helpers.js';

describeWithDb('audit log hash chain', (ctx) => {
  it('chains each row to the previous one and verifies clean', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.runtime.query(
        `INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id, after)
         VALUES ('system', 'test', 'test.action', 'thing', $1, $2)`,
        [String(i), JSON.stringify({ i })],
      );
    }
    const rows = await ctx.runtime.query<{ id: string; prev_hash: string; hash: string }>(
      `SELECT id, prev_hash, hash FROM app.audit_log ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows[0]!.prev_hash).toBe('0'.repeat(64));
    for (let i = 1; i < rows.rows.length; i++) {
      expect(rows.rows[i]!.prev_hash).toBe(rows.rows[i - 1]!.hash);
    }
    const verify = await ctx.runtime.query<{ ok: boolean; checked: string; first_bad_id: null }>(
      `SELECT * FROM app.audit_verify()`,
    );
    expect(verify.rows[0]).toMatchObject({ ok: true, checked: '5', first_bad_id: null });
  });

  it('ignores any hash the application tries to supply', async () => {
    await ctx.runtime.query(
      `INSERT INTO app.audit_log (actor_type, action, entity_type, prev_hash, hash)
       VALUES ('system', 'forged', 'thing', repeat('f', 64), repeat('f', 64))`,
    );
    const last = await ctx.runtime.query<{ hash: string }>(
      `SELECT hash FROM app.audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(last.rows[0]!.hash).not.toBe('f'.repeat(64));
    const verify = await ctx.runtime.query<{ ok: boolean }>(`SELECT * FROM app.audit_verify()`);
    expect(verify.rows[0]!.ok).toBe(true);
  });

  it('refuses UPDATE and DELETE from the runtime role', async () => {
    await expect(
      ctx.runtime.query(`UPDATE app.audit_log SET action = 'x' WHERE id = 1`),
    ).rejects.toThrow(/permission denied/);
    await expect(ctx.runtime.query(`DELETE FROM app.audit_log WHERE id = 1`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('refuses UPDATE and DELETE even from the owner role via the trigger', async () => {
    // The owner is subject to FORCE RLS with no policy, so it sees no rows at all.
    // Lift that temporarily to reach the trigger — the trigger must still refuse.
    await ctx.migrate.query(`ALTER TABLE app.audit_log NO FORCE ROW LEVEL SECURITY`);
    try {
      await expect(
        ctx.migrate.query(`UPDATE app.audit_log SET action = 'x' WHERE id = 1`),
      ).rejects.toThrow(/append-only/);
      await expect(ctx.migrate.query(`DELETE FROM app.audit_log WHERE id = 1`)).rejects.toThrow(
        /append-only/,
      );
    } finally {
      await ctx.migrate.query(`ALTER TABLE app.audit_log FORCE ROW LEVEL SECURITY`);
    }
  });

  it('detects tampering when someone with DDL rights disables the guard and edits history', async () => {
    const client = await ctx.migrate.connect();
    try {
      await client.query(`ALTER TABLE app.audit_log NO FORCE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE app.audit_log DISABLE TRIGGER audit_log_append_only`);
      await client.query(`UPDATE app.audit_log SET after = '{"i":999}' WHERE id = 2`);
      await client.query(`ALTER TABLE app.audit_log ENABLE TRIGGER audit_log_append_only`);
      await client.query(`ALTER TABLE app.audit_log FORCE ROW LEVEL SECURITY`);
    } finally {
      client.release();
    }
    const verify = await ctx.runtime.query<{ ok: boolean; first_bad_id: string }>(
      `SELECT * FROM app.audit_verify()`,
    );
    expect(verify.rows[0]!.ok).toBe(false);
    expect(verify.rows[0]!.first_bad_id).toBe('2');
  });
});
