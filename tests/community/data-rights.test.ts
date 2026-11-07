/**
 * Criteria 9 and 10: per-user JSON export, and account deletion that erases PII, tombstones
 * content and keeps moderation evidence. Also a pg_dump of the Community database.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import {
  bearer,
  createCommunityApp,
  CommunityTestApp,
  describeDb,
  Enrolled,
  OWNER_URL,
  ownerPool,
  privilegedUser,
  resetDatabase,
  signIn,
  SignedIn,
  uniqueEmail,
} from './helpers';

describeDb('export and deletion', () => {
  let app: CommunityTestApp;
  let db: Pool;
  let user: SignedIn;
  let other: SignedIn;
  let moderator: Enrolled;
  let hiddenPostId: string;
  let reportedPostId: string;
  let cleanPostId: string;
  let commentOnOther: string;

  const call = (method: 'GET' | 'POST', url: string, token: string, payload?: object) =>
    app.server.inject({ method, url, headers: bearer(token), payload });

  beforeAll(async () => {
    await resetDatabase();
    db = ownerPool();
    app = await createCommunityApp({ mode: 'public' });
    user = await signIn(app, uniqueEmail('leaver'));
    other = await signIn(app, uniqueEmail('stayer'));
    moderator = await privilegedUser(app, 'dr-mod', 'moderator');
    await call('POST', '/v1/community/me/profile', user.accessToken, {
      display_name: 'Leaving Soon',
    });
    await call('POST', '/v1/community/me/professional', user.accessToken, {
      profession: 'Pharmacist',
    });

    const mk = async (body: string) =>
      (
        await call('POST', '/v1/community/spaces/general_health/posts', user.accessToken, { body })
      ).json().id;
    hiddenPostId = await mk('post that gets hidden');
    reportedPostId = await mk('post that is reported but not actioned');
    cleanPostId = await mk('ordinary post');
    const otherPost = (
      await call('POST', '/v1/community/spaces/general_health/posts', other.accessToken, {
        body: 'other post',
      })
    ).json().id;
    commentOnOther = (
      await call('POST', `/v1/community/posts/${otherPost}/comments`, user.accessToken, {
        body: 'my comment',
      })
    ).json().id;
    await call('POST', `/v1/community/mod/posts/${hiddenPostId}/hide`, moderator.accessToken, {
      reason: 'spam',
    });
    await call('POST', '/v1/community/reports', other.accessToken, {
      target_type: 'post',
      target_id: reportedPostId,
      reason: 'misinformation',
    });
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('exports the user’s own data as JSON, without credentials', async () => {
    const res = await call('GET', '/v1/community/me/export', user.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    const data = res.json();
    expect(data).toMatchObject({
      format: 'wellapath-community-export',
      version: 1,
      account: { id: user.userId, email: user.email },
      profile: { display_name: 'Leaving Soon' },
    });
    expect(data.posts).toHaveLength(3);
    expect(data.comments).toHaveLength(1);
    expect(data.professional_verifications[0]).toMatchObject({
      profession: 'Pharmacist',
      status: 'claimed',
    });
    const text = res.body;
    expect(text).not.toContain(user.sessionToken);
    expect(text).not.toMatch(/"token"|"secret"|"backupCodes"|"privateKey"/);
    expect(text).not.toContain(other.email);
  });

  it('export requires authentication', async () => {
    expect(
      (await app.server.inject({ method: 'GET', url: '/v1/community/me/export' })).statusCode,
    ).toBe(401);
  });

  it('deletion requires an explicit confirmation phrase', async () => {
    const res = await call('POST', '/v1/community/me/delete', user.accessToken, { confirm: 'yes' });
    expect(res.statusCode).toBe(400);
  });

  describe('after deletion', () => {
    beforeAll(async () => {
      const res = await call('POST', '/v1/community/me/delete', user.accessToken, {
        confirm: 'DELETE MY ACCOUNT',
      });
      expect(res.statusCode).toBe(200);
    });

    it('PII is gone from the user row and dependent tables', async () => {
      const { rows } = await db.query(`SELECT * FROM "user" WHERE "id" = $1`, [user.userId]);
      expect(rows[0].email).toBe(`deleted+${user.userId}@deleted.invalid`);
      expect(rows[0].name).toBe('Deleted user');
      expect(rows[0].deletedAt).not.toBeNull();
      for (const [table, col] of [
        ['profiles', 'user_id'],
        ['professional_verifications', 'user_id'],
        ['notifications', 'user_id'],
        ['"session"', '"userId"'],
        ['"account"', '"userId"'],
        ['"twoFactor"', '"userId"'],
      ]) {
        const count = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [
          user.userId,
        ]);
        expect({ table, n: count.rows[0].n }).toEqual({ table, n: 0 });
      }
      const otp = await db.query(
        `SELECT count(*)::int AS n FROM "verification" WHERE "identifier" LIKE $1`,
        [`%${user.email}`],
      );
      expect(otp.rows[0].n).toBe(0);
      const anywhere = await db.query(`SELECT count(*)::int AS n FROM "user" WHERE "email" = $1`, [
        user.email,
      ]);
      expect(anywhere.rows[0].n).toBe(0);
    });

    it('content is tombstoned (body erased), not hard-deleted', async () => {
      const posts = await db.query('SELECT id, body, status FROM posts WHERE author_id = $1', [
        user.userId,
      ]);
      expect(posts.rows).toHaveLength(3);
      for (const p of posts.rows) expect(p).toMatchObject({ body: null, status: 'tombstoned' });
      const comment = await db.query('SELECT body, status FROM comments WHERE id = $1', [
        commentOnOther,
      ]);
      expect(comment.rows[0]).toEqual({ body: null, status: 'tombstoned' });
      const feed = await call(
        'GET',
        '/v1/community/spaces/general_health/posts',
        other.accessToken,
      );
      expect(JSON.stringify(feed.json())).not.toContain('ordinary post');
      expect(cleanPostId).toBeDefined();
    });

    it('moderation evidence is kept: the hide action snapshot and the open report snapshot', async () => {
      const hide = await db.query(
        `SELECT evidence FROM moderation_actions WHERE action = 'hide_content' AND target_id = $1`,
        [hiddenPostId],
      );
      expect(hide.rows[0].evidence.body).toBe('post that gets hidden');
      const del = await db.query(
        `SELECT actor_id, target_id, evidence FROM moderation_actions WHERE action = 'delete_account' AND target_id = $1`,
        [user.userId],
      );
      expect(del.rows[0].evidence.reported_content).toEqual([
        expect.objectContaining({
          target_id: reportedPostId,
          body: 'post that is reported but not actioned',
        }),
      ]);
      const reports = await db.query(
        'SELECT count(*)::int AS n FROM reports WHERE target_id = $1',
        [reportedPostId],
      );
      expect(reports.rows[0].n).toBe(1);
    });

    it('the deleted account’s tokens no longer work', async () => {
      expect((await call('GET', '/v1/community/me', user.accessToken)).statusCode).toBe(401);
    });

    it('signing in with the old email creates a fresh, unrelated account', async () => {
      const again = await signIn(app, user.email);
      expect(again.userId).not.toBe(user.userId);
    });
  });

  const pgDump = process.env.PG_DUMP_BIN ?? 'pg_dump';
  const havePgDump = (() => {
    try {
      execFileSync(pgDump, ['--version']);
      return true;
    } catch {
      return false;
    }
  })();
  (havePgDump ? it : it.skip)(
    'pg_dump produces a custom-format backup containing every table',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'community-dump-'));
      try {
        const file = join(dir, 'community.dump');
        execFileSync(pgDump, ['-Fc', '--no-owner', '-d', OWNER_URL as string, '-f', file]);
        expect(existsSync(file)).toBe(true);
        const restoreBin = pgDump.replace(/pg_dump$/, 'pg_restore');
        const list = execFileSync(restoreBin, ['--list', file]).toString();
        for (const t of [
          'moderation_actions',
          'posts',
          'user',
          'session',
          'reports',
          'notifications',
        ]) {
          expect(list).toMatch(
            new RegExp(`TABLE (DATA )?public ${t}\\b|TABLE (DATA )?public "${t}"`),
          );
        }
        expect(list).toContain('moderation_actions_no_update_delete');
        expect(readFileSync(file).length).toBeGreaterThan(1000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
