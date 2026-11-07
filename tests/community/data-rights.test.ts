/**
 * Data rights (contract §7 M7/M8; NDPA): per-user JSON export, and account deletion that erases
 * PII, tombstones content and keeps moderation evidence. Also a pg_dump of the Community DB.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { LightMyRequestResponse } from 'fastify';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import {
  bearer,
  createCommunityApp,
  CommunityTestApp,
  describeDb,
  Enrolled,
  idem,
  memberWithProfile,
  OWNER_ROLE,
  OWNER_URL,
  ownerPool,
  privilegedUser,
  refresh,
  requestOtp,
  resetDatabase,
  signIn,
  SignedIn,
  verifyOtp,
} from './helpers';
import { otpIdentifiers } from '../../src/community/data-rights';

describeDb('export and deletion', () => {
  let app: CommunityTestApp;
  let db: Pool;
  let user: SignedIn;
  let other: SignedIn;
  let moderator: Enrolled;
  let hiddenPostId: string;
  let reportedPostId: string;
  let commentOnOther: string;
  let secondDevice: SignedIn;

  const call = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    token: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> =>
    app.server.inject({ method, url, headers: { ...bearer(token), ...idem() }, payload });

  beforeAll(async () => {
    await resetDatabase();
    db = ownerPool();
    app = await createCommunityApp({ config: { mode: 'public' } });
    user = await memberWithProfile(app, 'leaver', 'Leaving Soon');
    other = await memberWithProfile(app, 'stayer');
    moderator = await privilegedUser(app, 'drmod', 'moderator');
    await call('POST', '/v1/community/me/professional-claim', user.accessToken, {
      profession: 'Pharmacist',
    });
    const mk = async (body: string): Promise<string> =>
      (
        await call('POST', '/v1/community/spaces/general_health/posts', user.accessToken, {
          body,
          display_mode: 'named',
        })
      ).json().id;
    hiddenPostId = await mk('post that gets hidden');
    reportedPostId = await mk('post that is reported but not actioned');
    await mk('ordinary post');
    const otherPost = (
      await call('POST', '/v1/community/spaces/general_health/posts', other.accessToken, {
        body: 'other post',
        display_mode: 'named',
      })
    ).json().id;
    commentOnOther = (
      await call('POST', `/v1/community/posts/${otherPost}/comments`, user.accessToken, {
        body: 'my comment',
        display_mode: 'pseudonymous',
      })
    ).json().id;
    await call('POST', `/v1/community/mod/posts/${hiddenPostId}/hide`, moderator.accessToken, {
      reason: 'spam spam spam',
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

  it('exports the user’s own data as JSON (contract keys), without credentials', async () => {
    const res = await call('GET', '/v1/community/me/export', user.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="wellapath-community-export.json"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const data = res.json();
    expect(Object.keys(data).sort()).toEqual(
      [
        'format',
        'version',
        'exported_at',
        'account',
        'profile',
        'professional_verifications',
        'posts',
        'comments',
        'reports_filed',
        'notifications',
        'sessions',
        'restrictions',
      ].sort(),
    );
    expect(data).toMatchObject({
      format: 'wellapath-community-export',
      version: 1,
      account: { id: user.userId, email: user.email, role: 'member', two_factor_enabled: false },
      profile: { display_name: 'Leaving Soon' },
    });
    expect(data.posts).toHaveLength(3);
    expect(data.posts.find((p: { id: string }) => p.id === hiddenPostId)).toMatchObject({
      status: 'hidden',
      body: 'post that gets hidden',
    });
    expect(data.comments).toHaveLength(1);
    expect(data.professional_verifications[0]).toMatchObject({
      profession: 'Pharmacist',
      status: 'pending',
    });
    expect(data.sessions[0]).toHaveProperty('device_label');
    const text = res.body;
    expect(text).not.toContain(user.refreshToken);
    expect(text).not.toContain(user.accessToken);
    expect(text).not.toMatch(/"token|hash|secret|backupCodes|privateKey|pepper/i);
    expect(text).not.toContain(other.email);
    expect(text).not.toContain(other.userId);
    // The export is audited.
    const ev = await db.query(
      `SELECT count(*)::int AS n FROM auth_events WHERE event = 'data_exported' AND account_id = $1`,
      [user.userId],
    );
    expect(ev.rows[0].n).toBe(1);
  });

  it('export requires authentication', async () => {
    expect(
      (await app.server.inject({ method: 'GET', url: '/v1/community/me/export' })).statusCode,
    ).toBe(401);
  });

  it('deletion requires the exact confirmation phrase', async () => {
    const res = await call('POST', '/v1/community/me/delete', user.accessToken, { confirm: 'yes' });
    expect(res.statusCode).toBe(400);
  });

  it('a moderator/admin must be demoted first (422 privileged_account)', async () => {
    const res = await call('POST', '/v1/community/me/delete', moderator.accessToken, {
      confirm: 'DELETE MY ACCOUNT',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toEqual({ reason: 'privileged_account' });
  });

  it('P1: export is available to every role; self-deletion is for members only', async () => {
    const res = await call('GET', '/v1/community/me/export', moderator.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      format: 'wellapath-community-export',
      account: { id: moderator.userId, role: 'moderator' },
    });
    const admin = await privilegedUser(app, 'dradmin', 'admin');
    expect((await call('GET', '/v1/community/me/export', admin.accessToken)).statusCode).toBe(200);
    const del = await call('POST', '/v1/community/me/delete', admin.accessToken, {
      confirm: 'DELETE MY ACCOUNT',
    });
    expect(del.statusCode).toBe(422);
    expect(del.json().error.details).toEqual({ reason: 'privileged_account' });
    // Nothing was deleted or audited for the refused request.
    const audited = await db.query(
      `SELECT count(*)::int AS n FROM moderation_actions
        WHERE action = 'delete_account' AND target_id = $1`,
      [admin.userId],
    );
    expect(audited.rows[0].n).toBe(0);
  });

  it('P8: sign-out keeps the device_id on the (revoked) family row', async () => {
    secondDevice = await signIn(app, user.email);
    const out = await app.server.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refresh_token: secondDevice.refreshToken },
    });
    expect(out.statusCode).toBe(204);
    const { rows } = await db.query(
      `SELECT device_id::text AS device_id, revoke_reason FROM refresh_token_families WHERE id = $1`,
      [secondDevice.familyId],
    );
    expect(rows).toEqual([{ device_id: secondDevice.deviceId, revoke_reason: 'logout' }]);
  });

  describe('after deletion', () => {
    beforeAll(async () => {
      const res = await call('POST', '/v1/community/me/delete', user.accessToken, {
        confirm: 'DELETE MY ACCOUNT',
      });
      expect(res.statusCode).toBe(204);
    });

    it('PII is gone from the user row and dependent tables', async () => {
      const { rows } = await db.query(`SELECT * FROM "user" WHERE "id" = $1`, [user.userId]);
      expect(rows[0].email).toBe(`deleted+${user.userId}@deleted.invalid`);
      expect(rows[0].name).toBe('');
      expect(rows[0].deletedAt).not.toBeNull();
      for (const [table, col] of [
        ['profiles', 'user_id'],
        ['professional_verifications', 'user_id'],
        ['notifications', 'user_id'],
        ['refresh_token_families', 'user_id'],
        ['totp_lockouts', 'user_id'],
        ['idempotency_keys', 'account_id'],
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

    it('content is tombstoned (body erased, pseudonymous), not hard-deleted, and never shown', async () => {
      const posts = await db.query(
        'SELECT body, status, display_mode FROM posts WHERE author_id = $1',
        [user.userId],
      );
      expect(posts.rows).toHaveLength(3);
      for (const p of posts.rows) {
        expect(p).toEqual({ body: null, status: 'tombstoned', display_mode: 'pseudonymous' });
      }
      const comment = await db.query('SELECT body, status FROM comments WHERE id = $1', [
        commentOnOther,
      ]);
      expect(comment.rows[0]).toEqual({ body: null, status: 'tombstoned' });
      const feed = await call(
        'GET',
        '/v1/community/spaces/general_health/posts',
        other.accessToken,
      );
      expect(feed.body).not.toContain('ordinary post');
      expect(feed.body).not.toContain('Leaving Soon');
    });

    it('moderation evidence is kept: the hide snapshot and the open-report snapshot', async () => {
      const hide = await db.query(
        `SELECT evidence FROM moderation_actions WHERE action = 'hide_content' AND target_id = $1`,
        [hiddenPostId],
      );
      expect(hide.rows[0].evidence.body).toBe('post that gets hidden');
      const del = await db.query(
        `SELECT actor_account_id, target_type, reason, evidence FROM moderation_actions
          WHERE action = 'delete_account' AND target_id = $1`,
        [user.userId],
      );
      expect(del.rows[0]).toMatchObject({
        actor_account_id: user.userId,
        target_type: 'account',
        reason: 'user-requested account deletion',
      });
      expect(del.rows[0].evidence.reported_content).toEqual([
        expect.objectContaining({
          target_id: reportedPostId,
          body: 'post that is reported but not actioned',
        }),
      ]);
      const ev = await db.query(
        `SELECT count(*)::int AS n FROM auth_events WHERE event = 'account_deleted' AND account_id = $1`,
        [user.userId],
      );
      expect(ev.rows[0].n).toBe(1);
    });

    it('P8: account deletion erases every device_id of the account', async () => {
      for (const deviceId of [user.deviceId, secondDevice.deviceId]) {
        const families = await db.query(
          `SELECT count(*)::int AS n FROM refresh_token_families WHERE device_id = $1`,
          [deviceId],
        );
        expect(families.rows[0].n).toBe(0);
        const events = await db.query(
          `SELECT count(*)::int AS n FROM auth_events WHERE detail::text LIKE $1`,
          [`%${deviceId}%`],
        );
        expect(events.rows[0].n).toBe(0);
        const actions = await db.query(
          `SELECT count(*)::int AS n FROM moderation_actions WHERE evidence::text LIKE $1`,
          [`%${deviceId}%`],
        );
        expect(actions.rows[0].n).toBe(0);
      }
    });

    it('the deleted account’s tokens no longer work', async () => {
      expect((await call('GET', '/v1/community/me', user.accessToken)).statusCode).toBe(401);
      expect((await refresh(app, user.refreshToken, user.deviceId)).statusCode).toBe(401);
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
        execFileSync(pgDump, [
          '-Fc',
          '--no-owner',
          // The migrator has no privilege of its own: dump as the owner (explicit SET ROLE).
          ...(OWNER_ROLE ? [`--role=${OWNER_ROLE}`] : []),
          '-d',
          OWNER_URL as string,
          '-f',
          file,
        ]);
        expect(existsSync(file)).toBe(true);
        const restoreBin = pgDump.replace(/pg_dump$/, 'pg_restore');
        const list = execFileSync(restoreBin, ['--list', file]).toString();
        for (const t of [
          'moderation_actions',
          'auth_events',
          'refresh_token_families',
          'refresh_tokens',
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
        expect(list).toContain('auth_events_no_update_delete');
        expect(readFileSync(file).length).toBeGreaterThan(1000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describeDb('SEC-008: deletion removes only the account’s own pending sign-in codes', () => {
  let app: CommunityTestApp;
  let db: Pool;
  beforeAll(async () => {
    app = await createCommunityApp();
    db = ownerPool();
  });
  afterAll(async () => {
    await db.end();
    await app.close();
  });

  const pending = async (emails: string[]): Promise<number> =>
    (
      await db.query(
        `SELECT count(*)::int AS n FROM "verification" WHERE "identifier" = ANY($1::text[])`,
        [emails.map(e => `sign-in-otp-${e}`)],
      )
    ).rows[0].n;

  it('LIKE metacharacters in the address match nothing else; other users’ codes survive', async () => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const deleterEmail = `q_z.${stamp}@example.test`;
    const deleter = await signIn(app, deleterEmail);
    // `_` would be a single-character wildcard, a leading `%` any prefix.
    const others = [`qyz.${stamp}@example.test`, `xq_z.${stamp}@example.test`];
    for (const e of others) expect((await requestOtp(app, e)).statusCode).toBe(202);
    // The deleter's own pending code (requested again after signing in) must go.
    expect((await requestOtp(app, deleterEmail)).statusCode).toBe(202);
    expect(await pending(others)).toBe(2);
    expect(await pending([deleterEmail])).toBe(1);

    const del = await app.server.inject({
      method: 'POST',
      url: '/v1/community/me/delete',
      headers: bearer(deleter.accessToken),
      payload: { confirm: 'DELETE MY ACCOUNT' },
    });
    expect(del.statusCode).toBe(204);
    expect(await pending([deleterEmail])).toBe(0);
    expect(await pending(others)).toBe(2);
    const code = app.outbox.latestOtp(others[0], 'sign-in');
    expect((await verifyOtp(app, others[0], code)).statusCode).toBe(200);
  });

  it('matches the exact Better Auth identifiers, case-folded, with no pattern', () => {
    expect(otpIdentifiers('A_b%c@Example.test')).toEqual([
      'sign-in-otp-A_b%c@Example.test',
      'sign-in-otp-a_b%c@example.test',
      'email-verification-otp-A_b%c@Example.test',
      'email-verification-otp-a_b%c@example.test',
      'forget-password-otp-A_b%c@Example.test',
      'forget-password-otp-a_b%c@example.test',
    ]);
    expect(otpIdentifiers('a@b.ng')).toEqual([
      'sign-in-otp-a@b.ng',
      'email-verification-otp-a@b.ng',
      'forget-password-otp-a@b.ng',
    ]);
  });
});
