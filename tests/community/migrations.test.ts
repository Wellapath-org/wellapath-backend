/**
 * Criterion 7: numbered up/down migrations, up -> down -> up round trip, seeded spaces and the
 * schema-level guarantees (author NOT NULL, self-declared never verified, report reasons).
 */
import { Pool } from 'pg';
import {
  appliedVersions,
  loadMigrations,
  migrateDown,
  migrateUp,
} from '../../src/community/migrate';
import { describeDb, ownerPool } from './helpers';

const EXPECTED_TABLES = [
  'account',
  'account_restrictions',
  'comments',
  'jwks',
  'moderation_actions',
  'notifications',
  'posts',
  'professional_verifications',
  'profiles',
  'reports',
  'session',
  'session_step_up',
  'spaces',
  'twoFactor',
  'user',
  'verification',
];

const tables = async (pool: Pool): Promise<string[]> =>
  (
    await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        AND tablename <> 'community_schema_migrations' ORDER BY tablename`,
    )
  ).rows.map(r => r.tablename);

describe('migration files', () => {
  it('are numbered contiguously and every up has a down', () => {
    const migrations = loadMigrations();
    expect(migrations.map(m => m.version)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const m of migrations) {
      expect(m.up.length).toBeGreaterThan(0);
      expect(m.down.length).toBeGreaterThan(0);
      expect(m.up).toMatch(/Rollback note:/);
    }
  });
});

describeDb('migrations against Postgres', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = ownerPool();
    await migrateDown(pool);
  });
  afterAll(async () => {
    await migrateUp(pool);
    await pool.end();
  });

  it('round-trips up -> down -> up', async () => {
    expect(await migrateUp(pool)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await tables(pool)).toEqual(EXPECTED_TABLES.sort());
    expect(await migrateUp(pool)).toEqual([]); // idempotent

    expect(await migrateDown(pool)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(await tables(pool)).toEqual([]);
    expect(await appliedVersions(pool)).toEqual([]);

    expect(await migrateUp(pool)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await tables(pool)).toEqual(EXPECTED_TABLES.sort());
  });

  it('steps down one migration at a time and back', async () => {
    expect(await migrateDown(pool, 1)).toEqual([6]);
    expect(await tables(pool)).not.toContain('session_step_up');
    expect(await migrateUp(pool)).toEqual([6]);
  });

  it('seeds exactly the two approved spaces', async () => {
    const { rows } = await pool.query('SELECT slug FROM spaces ORDER BY slug');
    expect(rows.map(r => r.slug)).toEqual(['general_health', 'pregnancy_maternal']);
  });

  describe('schema guarantees', () => {
    beforeAll(async () => {
      await pool.query(`INSERT INTO "user" ("id","name","email","emailVerified","updatedAt")
        VALUES ('m1','m','m1@example.test',true,now()), ('a1','a','a1@example.test',true,now())`);
    });

    it('posts.author_id is NOT NULL', async () => {
      await expect(
        pool.query(
          `INSERT INTO posts (space_slug, author_id, body) VALUES ('general_health', NULL, 'x')`,
        ),
      ).rejects.toThrow(/null value in column "author_id"/);
    });

    it('posts must belong to a seeded space', async () => {
      await expect(
        pool.query(
          `INSERT INTO posts (space_slug, author_id, body) VALUES ('mental_health', 'm1', 'x')`,
        ),
      ).rejects.toThrow(/foreign key/);
    });

    it('a profession can never be verified by its owner or without a verifier', async () => {
      await expect(
        pool.query(`INSERT INTO professional_verifications (user_id, profession, status)
          VALUES ('m1', 'Nurse', 'verified')`),
      ).rejects.toThrow(/professional_verified_requires_verifier/);
      await expect(
        pool.query(`INSERT INTO professional_verifications (user_id, profession, status, verified_by, verified_at)
          VALUES ('m1', 'Nurse', 'verified', 'm1', now())`),
      ).rejects.toThrow(/professional_verified_requires_verifier/);
      const ok = await pool.query(`INSERT INTO professional_verifications (user_id, profession)
          VALUES ('m1', 'Nurse') RETURNING status`);
      expect(ok.rows[0].status).toBe('claimed');
    });

    it('report reason is an enum', async () => {
      await expect(
        pool.query(`INSERT INTO reports (reporter_id, target_type, target_id, reason)
          VALUES ('m1', 'post', gen_random_uuid(), 'i_dislike_it')`),
      ).rejects.toThrow(/check constraint/);
    });

    it('user.role is restricted to member | moderator | admin', async () => {
      await expect(
        pool.query(`UPDATE "user" SET "role" = 'superuser' WHERE "id" = 'm1'`),
      ).rejects.toThrow(/check constraint/);
    });
  });
});
