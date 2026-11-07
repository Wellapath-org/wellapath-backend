/**
 * Criterion 8: the moderation log is append-only at the database level, for the runtime role
 * (no privilege) and for the table owner (trigger), and created_at is server time.
 */
import { Pool } from 'pg';
import { appPool, describeDb, ownerPool, resetDatabase } from './helpers';

describeDb('moderation_actions is append-only', () => {
  let owner: Pool;
  let app: Pool;
  let id: string;

  beforeAll(async () => {
    await resetDatabase();
    owner = ownerPool();
    app = appPool();
    await owner.query(`INSERT INTO "user" ("id","name","email","emailVerified","updatedAt")
      VALUES ('mod1','m','mod1@example.test',true,now())`);
    const { rows } = await app.query(
      `INSERT INTO moderation_actions (actor_id, action, target_type, target_id, reason, created_at)
       VALUES ('mod1', 'hide_content', 'post', 'p1', 'spam', '2001-01-01T00:00:00Z') RETURNING *`,
    );
    id = rows[0].id;
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('records actor_id, action, target_type, target_id, reason, created_at', async () => {
    const { rows } = await owner.query('SELECT * FROM moderation_actions WHERE id = $1', [id]);
    expect(Object.keys(rows[0])).toEqual(
      expect.arrayContaining([
        'actor_id',
        'action',
        'target_type',
        'target_id',
        'reason',
        'created_at',
      ]),
    );
    expect(rows[0]).toMatchObject({
      actor_id: 'mod1',
      action: 'hide_content',
      target_type: 'post',
    });
  });

  it('forces created_at to server time (a caller cannot backdate)', async () => {
    const { rows } = await owner.query('SELECT created_at FROM moderation_actions WHERE id = $1', [
      id,
    ]);
    expect(new Date(rows[0].created_at).getUTCFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it('runtime role: UPDATE is refused', async () => {
    await expect(
      app.query(`UPDATE moderation_actions SET reason = 'x' WHERE id = $1`, [id]),
    ).rejects.toThrow(/permission denied/);
  });

  it('runtime role: DELETE is refused', async () => {
    await expect(app.query('DELETE FROM moderation_actions WHERE id = $1', [id])).rejects.toThrow(
      /permission denied/,
    );
  });

  it('runtime role: TRUNCATE is refused', async () => {
    await expect(app.query('TRUNCATE moderation_actions')).rejects.toThrow(
      /permission denied|append-only/,
    );
  });

  it('table owner: UPDATE, DELETE and TRUNCATE are refused by trigger', async () => {
    await expect(
      owner.query(`UPDATE moderation_actions SET reason = 'x' WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only \(UPDATE rejected\)/);
    await expect(owner.query('DELETE FROM moderation_actions WHERE id = $1', [id])).rejects.toThrow(
      /append-only \(DELETE rejected\)/,
    );
    await expect(owner.query('TRUNCATE moderation_actions')).rejects.toThrow(
      /append-only \(TRUNCATE rejected\)/,
    );
  });

  it('the row is unchanged after every attempt', async () => {
    const { rows } = await owner.query('SELECT reason FROM moderation_actions WHERE id = $1', [id]);
    expect(rows[0].reason).toBe('spam');
  });

  it('runtime role has no DDL: it cannot drop the trigger or the table', async () => {
    await expect(
      app.query('DROP TRIGGER moderation_actions_no_update_delete ON moderation_actions'),
    ).rejects.toThrow(/must be owner/);
    await expect(app.query('DROP TABLE moderation_actions')).rejects.toThrow(/must be owner/);
  });
});
