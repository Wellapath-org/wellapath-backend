/**
 * Criteria 4 and 5, plus /v1/features: mandatory TOTP for privileged roles, role-based access
 * on representative endpoints, admin-only role grants (audited), accountable pseudonymity, the
 * verified-professional model, and the internal/closed_beta allowlist.
 */
import { Pool } from 'pg';
import {
  bearer,
  createCommunityApp,
  CommunityTestApp,
  describeDb,
  enrollTotp,
  Enrolled,
  ownerPool,
  privilegedUser,
  resetDatabase,
  setRole,
  signIn,
  SignedIn,
  stepUp,
  totp,
  uniqueEmail,
} from './helpers';

type Method = 'GET' | 'POST';

describeDb('roles, mandatory 2FA and pseudonymity', () => {
  let app: CommunityTestApp;
  let db: Pool;
  let author: SignedIn;
  let reader: SignedIn;
  let moderator: Enrolled;
  let admin: Enrolled;
  let anonPostId: string;

  const call = (method: Method, url: string, token: string, payload?: object) =>
    app.server.inject({ method, url, headers: bearer(token), payload });

  beforeAll(async () => {
    await resetDatabase();
    db = ownerPool();
    app = await createCommunityApp({ mode: 'internal' });
    author = await signIn(app, uniqueEmail('author'));
    reader = await signIn(app, uniqueEmail('reader'));
    app.config.allowlist.add(author.userId);
    app.config.allowlist.add(reader.userId);
    moderator = await privilegedUser(app, 'moderator', 'moderator');
    admin = await privilegedUser(app, 'admin', 'admin');

    expect(
      (
        await call('POST', '/v1/community/me/profile', author.accessToken, {
          display_name: 'Sunny Path',
        })
      ).statusCode,
    ).toBe(200);
    const post = await call(
      'POST',
      '/v1/community/spaces/pregnancy_maternal/posts',
      author.accessToken,
      {
        body: 'Anyone else get swollen feet in week 30?',
        display_mode: 'anonymous',
      },
    );
    expect(post.statusCode).toBe(201);
    anonPostId = post.json().id;
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  describe('/v1/features and the allowlist', () => {
    it('anonymous caller: community=internal, not allowed', async () => {
      const res = await app.server.inject({ method: 'GET', url: '/v1/features' });
      expect(res.json()).toEqual({ community: 'internal', community_allowed: false });
    });

    it('allowlisted account is allowed; a non-allowlisted account is not', async () => {
      const outsider = await signIn(app, uniqueEmail('outsider'));
      const allowed = await app.server.inject({
        method: 'GET',
        url: '/v1/features',
        headers: bearer(author.accessToken),
      });
      expect(allowed.json()).toEqual({ community: 'internal', community_allowed: true });
      const denied = await app.server.inject({
        method: 'GET',
        url: '/v1/features',
        headers: bearer(outsider.accessToken),
      });
      expect(denied.json()).toEqual({ community: 'internal', community_allowed: false });
      // Server-side enforcement, not just a UI hint.
      const spaces = await call('GET', '/v1/community/spaces', outsider.accessToken);
      expect(spaces.statusCode).toBe(403);
      expect(spaces.json().error.code).toBe('community_not_allowed');
    });

    it('lists exactly the two seeded spaces to an allowed member', async () => {
      const res = await call('GET', '/v1/community/spaces', author.accessToken);
      expect(res.json().spaces.map((s: { slug: string }) => s.slug)).toEqual([
        'general_health',
        'pregnancy_maternal',
      ]);
    });
  });

  describe('member APIs never reveal the account behind a post', () => {
    it('anonymous post in the feed shows only "Anonymous"', async () => {
      const res = await call(
        'GET',
        '/v1/community/spaces/pregnancy_maternal/posts',
        reader.accessToken,
      );
      const post = res.json().posts.find((p: { id: string }) => p.id === anonPostId);
      expect(post.author).toEqual({ display_name: 'Anonymous' });
      expect(JSON.stringify(res.json())).not.toContain(author.userId);
      expect(JSON.stringify(res.json())).not.toContain(author.email);
      expect(JSON.stringify(res.json())).not.toContain('Sunny Path');
    });

    it('post detail and comments never carry author ids or emails', async () => {
      await call('POST', `/v1/community/posts/${anonPostId}/comments`, reader.accessToken, {
        body: 'Yes, elevate them.',
      });
      const res = await call('GET', `/v1/community/posts/${anonPostId}`, reader.accessToken);
      const text = JSON.stringify(res.json());
      expect(text).not.toContain(author.userId);
      expect(text).not.toContain(reader.userId);
      expect(text).not.toContain('@example.test');
      expect(res.json().author).toEqual({ display_name: 'Anonymous' });
    });

    it('the post author is notified of the comment', async () => {
      const res = await call('GET', '/v1/community/notifications', author.accessToken);
      expect(res.json().notifications[0]).toMatchObject({ kind: 'comment_on_post' });
    });

    it('a member cannot attach extra fields (e.g. assessment data) to a post', async () => {
      const res = await call(
        'POST',
        '/v1/community/spaces/general_health/posts',
        author.accessToken,
        {
          body: 'hello',
          triage_result: 'urgent',
        },
      );
      expect(res.statusCode).toBe(400);
    });
  });

  describe('role-based access on representative endpoints', () => {
    const MOD_ENDPOINTS: [Method, string][] = [
      ['GET', '/v1/community/mod/reports'],
      ['GET', '/v1/community/mod/posts/00000000-0000-0000-0000-000000000000'],
    ];

    it.each(MOD_ENDPOINTS)('member is refused %s %s', async (method, url) => {
      const res = await call(method, url, author.accessToken);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    });

    it('member cannot hide content, suspend, grant roles or verify', async () => {
      for (const [url, payload] of [
        [`/v1/community/mod/posts/${anonPostId}/hide`, { reason: 'x' }],
        [`/v1/community/mod/users/${reader.userId}/suspend`, { reason: 'x' }],
        [`/v1/community/admin/users/${author.userId}/role`, { role: 'admin', reason: 'x' }],
        ['/v1/community/admin/verifications/1', { status: 'verified', reason: 'x' }],
      ] as [string, object][]) {
        expect((await call('POST', url, author.accessToken, payload)).statusCode).toBe(403);
      }
    });

    it('moderator API reveals the true account of an anonymous post', async () => {
      const res = await call('GET', `/v1/community/mod/posts/${anonPostId}`, moderator.accessToken);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        author_id: author.userId,
        author_email: author.email,
        author_display_name: 'Sunny Path',
        display_mode: 'anonymous',
      });
    });

    it('report -> moderator queue shows identity -> hide is audited and notifies', async () => {
      const report = await call('POST', '/v1/community/reports', reader.accessToken, {
        target_type: 'post',
        target_id: anonPostId,
        reason: 'unsafe_medical_advice',
        note: 'check this',
      });
      expect(report.statusCode).toBe(201);
      const queue = await call('GET', '/v1/community/mod/reports', moderator.accessToken);
      expect(queue.json().reports[0]).toMatchObject({
        author_id: author.userId,
        reason: 'unsafe_medical_advice',
      });

      const hide = await call(
        'POST',
        `/v1/community/mod/posts/${anonPostId}/hide`,
        moderator.accessToken,
        {
          reason: 'unsafe advice',
        },
      );
      expect(hide.statusCode).toBe(200);
      const { rows } = await db.query(
        `SELECT actor_id, action, target_type, target_id, reason, evidence FROM moderation_actions
          WHERE action = 'hide_content' AND target_id = $1`,
        [anonPostId],
      );
      expect(rows[0]).toMatchObject({
        actor_id: moderator.userId,
        target_type: 'post',
        reason: 'unsafe advice',
      });
      expect(rows[0].evidence.author_id).toBe(author.userId);
      const feed = await call(
        'GET',
        '/v1/community/spaces/pregnancy_maternal/posts',
        reader.accessToken,
      );
      expect(feed.json().posts.map((p: { id: string }) => p.id)).not.toContain(anonPostId);
    });

    it('a moderator cannot grant roles; only an admin can', async () => {
      const byMod = await call(
        'POST',
        `/v1/community/admin/users/${reader.userId}/role`,
        moderator.accessToken,
        {
          role: 'moderator',
          reason: 'trusted member',
        },
      );
      expect(byMod.statusCode).toBe(403);
      expect(byMod.json().error.code).toBe('forbidden');

      const byAdmin = await call(
        'POST',
        `/v1/community/admin/users/${reader.userId}/role`,
        admin.accessToken,
        {
          role: 'moderator',
          reason: 'trusted member',
        },
      );
      expect(byAdmin.statusCode).toBe(200);
      const { rows } = await db.query(
        `SELECT actor_id, evidence FROM moderation_actions WHERE action = 'grant_role' AND target_id = $1`,
        [reader.userId],
      );
      expect(rows[0]).toMatchObject({
        actor_id: admin.userId,
        evidence: { from: 'member', to: 'moderator' },
      });
      await setRole(reader.userId, 'member');
    });

    it('a moderator cannot suspend an admin', async () => {
      const res = await call(
        'POST',
        `/v1/community/mod/users/${admin.userId}/suspend`,
        moderator.accessToken,
        {
          reason: 'x',
        },
      );
      expect(res.statusCode).toBe(403);
    });
  });

  describe('mandatory TOTP for privileged roles', () => {
    it('a moderator without 2FA is refused every privileged action (enrolment required)', async () => {
      const user = await signIn(app, uniqueEmail('new-mod'));
      await setRole(user.userId, 'moderator');
      const res = await call('GET', '/v1/community/mod/reports', user.accessToken);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('mfa_enrollment_required');
      const step = await call('POST', '/v1/community/mfa/step-up', user.accessToken, {
        code: '123456',
      });
      expect(step.json().error.code).toBe('mfa_enrollment_required');
    });

    it('enrolled but not stepped-up on this session is refused (step-up required)', async () => {
      const user = await signIn(app, uniqueEmail('enrolled-mod'));
      await setRole(user.userId, 'admin');
      const enrolled = await enrollTotp(app, user);
      const res = await call(
        'POST',
        `/v1/community/admin/users/${author.userId}/role`,
        enrolled.accessToken,
        {
          role: 'moderator',
          reason: 'x',
        },
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('mfa_step_up_required');
      expect(await stepUp(app, enrolled)).toBe(200);
      const after = await call('GET', '/v1/community/mod/reports', enrolled.accessToken);
      expect(after.statusCode).toBe(200);
    });

    it('a wrong TOTP code does not grant step-up', async () => {
      const user = await signIn(app, uniqueEmail('wrong-code'));
      await setRole(user.userId, 'moderator');
      const enrolled = await enrollTotp(app, user);
      const good = totp(enrolled.totpSecret);
      const bad = good === '000000' ? '000001' : '000000';
      const res = await call('POST', '/v1/community/mfa/step-up', enrolled.accessToken, {
        code: bad,
      });
      expect(res.statusCode).toBe(401);
      expect(
        (await call('GET', '/v1/community/mod/reports', enrolled.accessToken)).statusCode,
      ).toBe(403);
    });

    it('5 wrong codes revoke the session (brute-force guard)', async () => {
      const user = await signIn(app, uniqueEmail('brute'));
      await setRole(user.userId, 'moderator');
      const enrolled = await enrollTotp(app, user);
      const good = totp(enrolled.totpSecret);
      let last = 0;
      for (let i = 0; i < 5; i += 1) {
        const bad = String((Number(good) + 1 + i) % 1000000).padStart(6, '0');
        last = (
          await call('POST', '/v1/community/mfa/step-up', enrolled.accessToken, { code: bad })
        ).statusCode;
      }
      expect(last).toBe(401);
      const res = await call('GET', '/v1/community/me', enrolled.accessToken);
      expect(res.json().error.code).toBe('session_revoked');
    });

    it('step-up is per session: a new session must step up again', async () => {
      const second = await signIn(app, moderator.email);
      const res = await call('GET', '/v1/community/mod/reports', second.accessToken);
      expect(res.json().error.code).toBe('mfa_step_up_required');
    });

    it('step-up expires after its TTL', async () => {
      await db.query(`UPDATE session_step_up SET verified_at = now() - interval '2 hours'`);
      const res = await call('GET', '/v1/community/mod/reports', moderator.accessToken);
      expect(res.json().error.code).toBe('mfa_step_up_required');
      expect(await stepUp(app, moderator)).toBe(200);
      expect(await stepUp(app, admin)).toBe(200);
    });

    it('a member cannot set their own role through the auth API', async () => {
      // /update-user is disabled, and role is `input: false` in any case.
      const res = await call('POST', '/v1/auth/update-user', author.sessionToken, {
        role: 'admin',
      });
      expect(res.statusCode).toBe(404);
      const { rows } = await db.query(`SELECT "role" FROM "user" WHERE "id" = $1`, [author.userId]);
      expect(rows[0].role).toBe('member');
    });
  });

  describe('verified professional model', () => {
    let claimId: string;

    it('a self-declared profession is stored as claimed and shows no badge', async () => {
      const claim = await call('POST', '/v1/community/me/professional', author.accessToken, {
        profession: 'Midwife',
        specialty: 'Antenatal care',
        status: 'verified',
      });
      expect(claim.statusCode).toBe(400); // status is not an input
      const ok = await call('POST', '/v1/community/me/professional', author.accessToken, {
        profession: 'Midwife',
        specialty: 'Antenatal care',
      });
      expect(ok.json().status).toBe('claimed');
      claimId = String(ok.json().id);
      const post = await call(
        'POST',
        '/v1/community/spaces/general_health/posts',
        author.accessToken,
        {
          body: 'Hydration matters.',
        },
      );
      const detail = await call('GET', `/v1/community/posts/${post.json().id}`, reader.accessToken);
      expect(detail.json().author).toEqual({
        display_name: 'Sunny Path',
        verified_professional: null,
      });
    });

    it('only an admin can verify; the badge then appears; the action is audited', async () => {
      const byMod = await call(
        'POST',
        `/v1/community/admin/verifications/${claimId}`,
        moderator.accessToken,
        {
          status: 'verified',
          reason: 'licence checked',
        },
      );
      expect(byMod.statusCode).toBe(403);
      const byAdmin = await call(
        'POST',
        `/v1/community/admin/verifications/${claimId}`,
        admin.accessToken,
        {
          status: 'verified',
          reason: 'licence checked',
        },
      );
      expect(byAdmin.statusCode).toBe(200);
      const feed = await call(
        'GET',
        '/v1/community/spaces/general_health/posts',
        reader.accessToken,
      );
      expect(feed.json().posts[0].author).toEqual({
        display_name: 'Sunny Path',
        verified_professional: { profession: 'Midwife' },
      });
      const { rows } = await db.query(
        `SELECT actor_id FROM moderation_actions WHERE action = 'verify_professional' AND target_id = $1`,
        [claimId],
      );
      expect(rows[0].actor_id).toBe(admin.userId);
    });

    it('an admin cannot verify their own profession', async () => {
      const own = await call('POST', '/v1/community/me/professional', admin.accessToken, {
        profession: 'Doctor',
      });
      const res = await call(
        'POST',
        `/v1/community/admin/verifications/${own.json().id}`,
        admin.accessToken,
        {
          status: 'verified',
          reason: 'me',
        },
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('self_verification');
    });
  });
});
