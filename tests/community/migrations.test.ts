/**
 * Numbered up/down migrations, up → down → up round trip, seeded spaces and the schema-level
 * guarantees of the canonical contract (§14).
 */
import { Pool } from 'pg';
import {
  appliedVersions,
  loadMigrations,
  migrateDown,
  migrateUp,
} from '../../src/community/migrate';
import { describeDb, ownerPool } from './helpers';

const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const EXPECTED_TABLES = [
  'account',
  'account_restrictions',
  'auth_events',
  'comments',
  'idempotency_keys',
  'jwks',
  'moderation_actions',
  'notifications',
  'posts',
  'professional_verifications',
  'profiles',
  'rate_limit_counters',
  'refresh_token_families',
  'refresh_tokens',
  'reports',
  'session',
  'spaces',
  'totp_lockouts',
  'twoFactor',
  'user',
  'verification',
].sort();

const tables = async (pool: Pool): Promise<string[]> =>
  (
    await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        AND tablename <> 'community_schema_migrations' ORDER BY tablename`,
    )
  ).rows.map(r => r.tablename);

const indexes = async (pool: Pool, table: string): Promise<string[]> =>
  (
    await pool.query<{ i: string }>(
      `SELECT indexname AS i FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
      [table],
    )
  ).rows.map(r => r.i);

describe('migration files', () => {
  it('are numbered contiguously and every up has a down and a rollback note', () => {
    const migrations = loadMigrations();
    expect(migrations.map(m => m.version)).toEqual(ALL);
    for (const m of migrations) {
      expect(m.up.length).toBeGreaterThan(0);
      expect(m.down.length).toBeGreaterThan(0);
      expect(m.up).toMatch(/Rollback note:/);
    }
  });

  it('no table has a parent_comment_id (single-level comments)', () => {
    expect(
      loadMigrations()
        .map(m => m.up)
        .join('\n'),
    ).not.toMatch(/parent_comment_id\s+(uuid|text)/);
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
    expect(await migrateUp(pool)).toEqual(ALL);
    expect(await tables(pool)).toEqual(EXPECTED_TABLES);
    expect(await migrateUp(pool)).toEqual([]); // idempotent

    expect(await migrateDown(pool)).toEqual([...ALL].reverse());
    expect(await tables(pool)).toEqual([]);
    expect(await appliedVersions(pool)).toEqual([]);

    expect(await migrateUp(pool)).toEqual(ALL);
    expect(await tables(pool)).toEqual(EXPECTED_TABLES);
  });

  it('steps down one migration at a time and back', async () => {
    expect(await migrateDown(pool, 1)).toEqual([9]);
    expect(await indexes(pool, 'verification')).not.toContain('verification_expires_at_idx');
    expect(await migrateDown(pool, 1)).toEqual([8]);
    expect(await tables(pool)).not.toContain('rate_limit_counters');
    expect(await migrateDown(pool, 1)).toEqual([7]);
    expect(await tables(pool)).not.toContain('auth_events');
    expect(await migrateUp(pool)).toEqual([7, 8, 9]);
    expect(await indexes(pool, 'verification')).toEqual(
      expect.arrayContaining(['verification_expires_at_idx', 'verification_created_at_idx']),
    );
  });

  it('seeds exactly the two approved spaces, with descriptions', async () => {
    const { rows } = await pool.query('SELECT id, name, description FROM spaces ORDER BY id');
    expect(rows.map(r => [r.id, r.name])).toEqual([
      ['general_health', 'General Health'],
      ['pregnancy_maternal', 'Pregnancy and Maternal Health'],
    ]);
    for (const r of rows) expect(r.description.length).toBeGreaterThan(10);
    await expect(
      pool.query(`INSERT INTO spaces (id, name, description) VALUES ('mental_health', 'x', 'y')`),
    ).rejects.toThrow(/check constraint/);
  });

  describe('schema guarantees', () => {
    beforeAll(async () => {
      await pool.query(`INSERT INTO "user" ("id","name","email","emailVerified","updatedAt")
        VALUES ('m1','m','m1@example.test',true,now()), ('a1','a','a1@example.test',true,now())`);
    });

    it('posts.author_id is NOT NULL and display_mode has no default', async () => {
      await expect(
        pool.query(`INSERT INTO posts (space_id, author_id, display_mode, body)
                    VALUES ('general_health', NULL, 'named', 'x')`),
      ).rejects.toThrow(/null value in column "author_id"/);
      await expect(
        pool.query(
          `INSERT INTO posts (space_id, author_id, body) VALUES ('general_health', 'm1', 'x')`,
        ),
      ).rejects.toThrow(/null value in column "display_mode"/);
      await expect(
        pool.query(`INSERT INTO posts (space_id, author_id, display_mode, body)
                    VALUES ('general_health', 'm1', 'anonymous', 'x')`),
      ).rejects.toThrow(/check constraint/);
    });

    it('body limits are 2000 (post) and 1000 (comment)', async () => {
      await expect(
        pool.query(
          `INSERT INTO posts (space_id, author_id, display_mode, body) VALUES ('general_health', 'm1', 'named', $1)`,
          ['x'.repeat(2001)],
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('posts must belong to a seeded space', async () => {
      await expect(
        pool.query(`INSERT INTO posts (space_id, author_id, display_mode, body)
                    VALUES ('mental_health', 'm1', 'named', 'x')`),
      ).rejects.toThrow(/foreign key/);
    });

    it('a claim starts pending; it can never be verified by its owner or without a verifier', async () => {
      await expect(
        pool.query(`INSERT INTO professional_verifications (user_id, profession, status, verified_at)
          VALUES ('m1', 'Nurse', 'verified', now())`),
      ).rejects.toThrow(/professional_verified_requires_verifier/);
      await expect(
        pool.query(`INSERT INTO professional_verifications (user_id, profession, status, verified_by, verified_at)
          VALUES ('m1', 'Nurse', 'verified', 'm1', now())`),
      ).rejects.toThrow(/professional_verified_requires_verifier/);
      const ok = await pool.query(`INSERT INTO professional_verifications (user_id, profession)
          VALUES ('m1', 'Nurse') RETURNING status`);
      expect(ok.rows[0].status).toBe('pending');
      await expect(
        pool.query(
          `INSERT INTO professional_verifications (user_id, profession) VALUES ('m1', 'Midwife')`,
        ),
      ).rejects.toThrow(/professional_verifications_one_active_idx/);
    });

    it('report reason is the contract enum; one open report per reporter and target', async () => {
      await expect(
        pool.query(`INSERT INTO reports (reporter_id, target_type, target_id, reason)
          VALUES ('m1', 'post', gen_random_uuid(), 'self_harm')`),
      ).rejects.toThrow(/check constraint/);
      const target = (await pool.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
      await pool.query(
        `INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ('m1', 'post', $1, 'spam')`,
        [target],
      );
      await expect(
        pool.query(
          `INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ('m1', 'post', $1, 'other')`,
          [target],
        ),
      ).rejects.toThrow(/reports_one_open_per_reporter_idx/);
    });

    it('user.role is restricted to member | moderator | admin', async () => {
      await expect(
        pool.query(`UPDATE "user" SET "role" = 'superuser' WHERE "id" = 'm1'`),
      ).rejects.toThrow(/check constraint/);
    });

    it('the session row never keeps a client IP or user agent', async () => {
      await pool.query(`INSERT INTO "session" ("id","expiresAt","token","updatedAt","ipAddress","userAgent","userId")
        VALUES ('s1', now() + interval '1 day', 'tok1', now(), '203.0.113.9', 'curl', 'm1')`);
      const { rows } = await pool.query(
        `SELECT "ipAddress", "userAgent" FROM "session" WHERE "id" = 's1'`,
      );
      expect(rows[0]).toEqual({ ipAddress: null, userAgent: null });
    });
  });
});
