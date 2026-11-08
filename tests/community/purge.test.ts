/**
 * Sign-in retention purge (src/community/purge.ts): pending OTP `verification` rows (their
 * identifier embeds the email address) are deleted once expired, and after 23 h whatever their
 * expiry; expired rate-limit windows go too. Runs as `community_app`, is idempotent, batched
 * and indexed, and runs on a timer inside the Community plugin.
 */
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PURGE_TABLES, RUNTIME_PRIVILEGES, TABLE_CLASSES } from '../../src/community/db-roles';
import { MAX_AGE_HOURS, purgeAuthRecords } from '../../src/community/purge';
import {
  appPool,
  createCommunityApp,
  describeDb,
  ownerQuery,
  requestOtp,
  resetDatabase,
  uniqueEmail,
  verifyOtp,
} from './helpers';

const insertVerification = async (
  identifier: string,
  expiresInSeconds: number,
  ageSeconds = 0,
): Promise<string> => {
  const id = randomUUID();
  await ownerQuery(
    `INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
     VALUES ($1, $2, 'hashed', now() + make_interval(secs => $3::int),
             now() - make_interval(secs => $4::int), now())`,
    [id, identifier, expiresInSeconds, ageSeconds],
  );
  return id;
};

const verificationIds = async (): Promise<string[]> =>
  ((await ownerQuery(`SELECT "id" FROM "verification" ORDER BY 1`)) as { id: string }[]).map(
    r => r.id,
  );

describeDb('sign-in retention purge', () => {
  let app: Pool;
  beforeAll(async () => {
    await resetDatabase();
    app = appPool();
  });
  afterAll(async () => {
    await app.end();
  });
  beforeEach(async () => {
    await ownerQuery(`DELETE FROM "verification"`);
    await ownerQuery(`DELETE FROM rate_limit_counters`);
  });

  it('runs as community_app, which has exactly DML (incl. DELETE) on the purged tables', async () => {
    expect((await app.query('SELECT current_user AS u')).rows[0].u).toBe('community_app');
    for (const table of PURGE_TABLES) {
      expect(RUNTIME_PRIVILEGES[TABLE_CLASSES[table]]).toContain('DELETE');
    }
  });

  it('deletes expired rows and rows older than the 23 h cap; keeps fresh pending ones', async () => {
    const fresh = await insertVerification('sign-in-otp-fresh@example.test', 300);
    await insertVerification('sign-in-otp-expired@example.test', -1);
    await insertVerification('sign-in-otp-old@example.test', 3600, MAX_AGE_HOURS * 3600 + 60);
    const young = await insertVerification('sign-in-otp-young@example.test', 3600, 22 * 3600);
    const result = await purgeAuthRecords(app);
    expect(result.verification).toBe(2);
    expect(await verificationIds()).toEqual([fresh, young].sort());
    // Idempotent.
    expect((await purgeAuthRecords(app)).verification).toBe(0);
    expect(await verificationIds()).toEqual([fresh, young].sort());
  });

  it('the oldest row that can survive a run is younger than 24 h', async () => {
    await insertVerification('sign-in-otp-a@example.test', 7 * 24 * 3600, 24 * 3600 - 1);
    await purgeAuthRecords(app);
    expect(await verificationIds()).toEqual([]);
    expect(MAX_AGE_HOURS).toBeLessThan(24);
  });

  it('works in bounded batches', async () => {
    await ownerQuery(
      `INSERT INTO "verification" ("id", "identifier", "value", "expiresAt")
       SELECT gen_random_uuid()::text, 'sign-in-otp-bulk' || g || '@example.test', 'h',
              now() - interval '1 minute'
         FROM generate_series(1, 2500) g`,
    );
    const result = await purgeAuthRecords(app, { batchSize: 1000 });
    expect(result.verification).toBe(2500);
    expect(await verificationIds()).toEqual([]);
  });

  it('is index-backed (expiresAt and createdAt indexes from migration 0009)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT "id" FROM "verification"
          WHERE "expiresAt" < now() OR "createdAt" < now() - make_interval(secs => 82800)`,
      );
      const plan = rows.map(r => r['QUERY PLAN']).join('\n');
      expect(plan).toContain('verification_expires_at_idx');
      expect(plan).toContain('verification_created_at_idx');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('deletes only finished rate-limit windows', async () => {
    await ownerQuery(
      `INSERT INTO rate_limit_counters (bucket, window_start, window_seconds, count) VALUES
         ('done', now() - interval '2 hours', 3600, 3),
         ('live', date_trunc('hour', now()), 3600, 1),
         ('day',  now() - interval '2 hours', 86400, 1)`,
    );
    const result = await purgeAuthRecords(app);
    expect(result.rateLimitCounters).toBe(1);
    const rows = (await ownerQuery(`SELECT bucket FROM rate_limit_counters ORDER BY 1`)) as {
      bucket: string;
    }[];
    expect(rows.map(r => r.bucket)).toEqual(['day', 'live']);
  });

  it('a real pending OTP (identifier contains the address) is purged once expired; the code then fails', async () => {
    const community = await createCommunityApp();
    try {
      const email = uniqueEmail('purge');
      expect((await requestOtp(community, email)).statusCode).toBe(202);
      const [row] = (await ownerQuery(`SELECT "identifier" FROM "verification"`)) as {
        identifier: string;
      }[];
      expect(row.identifier).toContain(email);
      const code = community.outbox.latestOtp(email, 'sign-in');
      await ownerQuery(`UPDATE "verification" SET "expiresAt" = now() - interval '1 second'`);
      expect((await purgeAuthRecords(app, { email: community.outbox })).verification).toBe(1);
      expect(await verificationIds()).toEqual([]);
      const res = await verifyOtp(community, email, code);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_code');
    } finally {
      await community.close();
    }
  });

  it('the plugin runs the purge on a timer (and stops it on close)', async () => {
    const community = await createCommunityApp({ config: { authPurgeIntervalSeconds: 1 } });
    try {
      await insertVerification('sign-in-otp-timer@example.test', -1);
      const deadline = Date.now() + 5000;
      while ((await verificationIds()).length > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      expect(await verificationIds()).toEqual([]);
      expect(community.logs.text()).toContain('community_auth_purge');
    } finally {
      await community.close();
    }
  });
});
