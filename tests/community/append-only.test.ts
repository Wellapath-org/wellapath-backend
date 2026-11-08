/**
 * The moderation log and the security audit log (`auth_events`) are append-only at the database
 * level: for the runtime role (no privilege) and for the table owner (trigger). `created_at` is
 * server time. The reason CHECK makes a moderator reason mandatory (10–500 chars).
 */
import { Pool } from 'pg';
import { appPool, describeDb, ownerPool, resetDatabase } from './helpers';

const TABLES = [
  {
    table: 'moderation_actions',
    insert: `INSERT INTO moderation_actions
               (actor_account_id, action, target_type, target_id, reason, created_at)
             VALUES ('mod1', 'hide_content', 'post', 'p1', 'spam spam spam', '2001-01-01T00:00:00Z')
             RETURNING id`,
    columns: ['actor_account_id', 'action', 'target_type', 'target_id', 'reason', 'created_at'],
    update: `UPDATE moderation_actions SET reason = 'changed reason' WHERE id = $1`,
  },
  {
    table: 'auth_events',
    insert: `INSERT INTO auth_events (event, account_id, created_at)
             VALUES ('logout', 'mod1', '2001-01-01T00:00:00Z') RETURNING id`,
    columns: ['event', 'account_id', 'family_id', 'email_hmac', 'ip_hash', 'detail', 'created_at'],
    update: `UPDATE auth_events SET event = 'sign_in_failed' WHERE id = $1`,
  },
] as const;

describeDb('append-only audit tables', () => {
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    await resetDatabase();
    owner = ownerPool();
    app = appPool();
    await owner.query(`INSERT INTO "user" ("id","name","email","emailVerified","updatedAt")
      VALUES ('mod1','m','mod1@example.test',true,now())`);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  describe.each(TABLES)('$table', ({ table, insert, columns, update }) => {
    let id: string;
    beforeAll(async () => {
      id = (await app.query(insert)).rows[0].id;
    });

    it('has the audit columns and forces created_at to server time', async () => {
      const { rows } = await owner.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      expect(Object.keys(rows[0])).toEqual(expect.arrayContaining([...columns]));
      expect(new Date(rows[0].created_at).getUTCFullYear()).toBeGreaterThanOrEqual(2026);
    });

    it('runtime role: UPDATE, DELETE and TRUNCATE are refused (no privilege)', async () => {
      await expect(app.query(update, [id])).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM ${table} WHERE id = $1`, [id])).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query(`TRUNCATE ${table}`)).rejects.toThrow(/permission denied/);
    });

    it('table owner: UPDATE, DELETE and TRUNCATE are refused by trigger', async () => {
      await expect(owner.query(update, [id])).rejects.toThrow(/append-only/);
      await expect(owner.query(`DELETE FROM ${table} WHERE id = $1`, [id])).rejects.toThrow(
        /append-only/,
      );
      await expect(owner.query(`TRUNCATE ${table}`)).rejects.toThrow(/append-only/);
      const { rows } = await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, [
        id,
      ]);
      expect(rows[0].n).toBe(1);
    });

    it('runtime role cannot drop the protection', async () => {
      await expect(
        app.query(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_no_update_delete`),
      ).rejects.toThrow(/must be owner|permission denied/);
      await expect(app.query(`DROP TABLE ${table}`)).rejects.toThrow(
        /must be owner|permission denied/,
      );
    });
  });

  it('a moderator reason is mandatory: 10–500 chars (system rows use fixed reasons)', async () => {
    await expect(
      app.query(`INSERT INTO moderation_actions (actor_account_id, action, target_type, target_id, reason)
                 VALUES ('mod1', 'hide_content', 'post', 'p1', 'short')`),
    ).rejects.toThrow(/check constraint/);
    await expect(
      app.query(
        `INSERT INTO moderation_actions (actor_account_id, action, target_type, target_id, reason)
                 VALUES ('mod1', 'hide_content', 'post', 'p1', $1)`,
        ['x'.repeat(501)],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      app.query(`INSERT INTO moderation_actions (actor_account_id, action, target_type, target_id, reason)
                 VALUES ('mod1', 'withdraw_professional', 'professional_verification', 'v1', 'withdrawn')`),
    ).resolves.toBeDefined();
  });

  it('action and target_type are the contract enums (§13)', async () => {
    for (const [action, target] of [
      ['grant_role', 'account'],
      ['unsuspend_account', 'account'],
      ['hide_content', 'user'],
    ]) {
      await expect(
        app.query(
          `INSERT INTO moderation_actions (actor_account_id, action, target_type, target_id, reason)
           VALUES ('mod1', $1, $2, 'x', 'a valid reason')`,
          [action, target],
        ),
      ).rejects.toThrow(/check constraint/);
    }
  });
});
