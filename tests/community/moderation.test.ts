/**
 * Moderation (`/mod/*`) and admin (`/admin/*`) — contract §2.1, §12; ADR R1.4/R4.1.
 * - Individual privileged accounts with MANDATORY TOTP: role → enrolled → fresh step-up, in
 *   that order, before any privileged action.
 * - No identity in the report queue or moderator content view; the audited
 *   `POST /mod/identity/reveal` is the only way to the account, and email is never returned.
 * - hide / remove / restore / dismiss / restrict / suspend / reinstate with a mandatory reason
 *   (10–500), the state machine, self-action refusal, admin-only rules, and exactly one
 *   append-only audit row per action (actor, action, target, reason, server time).
 * - Admin-only role grants (revoking the target's sessions), TOTP reset, professional
 *   verification, and the first-admin bootstrap CLI (no default password).
 */
import { randomUUID } from 'crypto';
import { LightMyRequestResponse } from 'fastify';
import { bootstrapAdmin } from '../../src/community/bootstrap-admin';
import {
  bearer,
  CommunityTestApp,
  createCommunityApp,
  describeDb,
  enrollTotp,
  Enrolled,
  idem,
  memberWithProfile,
  ownerPool,
  ownerQuery,
  privilegedUser,
  resetDatabase,
  setRole,
  signIn,
  SignedIn,
  stepUp,
  uniqueEmail,
} from './helpers';

const REASON = 'violates the community guidelines';

describeDb('moderation and admin', () => {
  let app: CommunityTestApp;
  let mod: Enrolled;
  let admin: Enrolled;
  let alice: SignedIn;
  let bob: SignedIn;
  let postId: string;
  let commentId: string;

  const call = (
    user: SignedIn,
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> =>
    app.server.inject({ method, url, headers: bearer(user.accessToken), payload });

  const auditRows = async (targetId: string): Promise<Record<string, unknown>[]> =>
    (await ownerQuery(
      `SELECT actor_account_id, action, target_type, target_id, reason, created_at
         FROM moderation_actions WHERE target_id = $1 ORDER BY id`,
      [targetId],
    )) as Record<string, unknown>[];

  beforeAll(async () => {
    await resetDatabase();
    app = await createCommunityApp();
    mod = await privilegedUser(app, 'mod', 'moderator');
    admin = await privilegedUser(app, 'admin', 'admin');
    alice = await memberWithProfile(app, 'alice', 'AliceA');
    bob = await memberWithProfile(app, 'bob', 'BobB');
    postId = (
      await app.server.inject({
        method: 'POST',
        url: '/v1/community/spaces/general_health/posts',
        headers: { ...bearer(alice.accessToken), ...idem() },
        payload: { body: 'Questionable advice', display_mode: 'pseudonymous' },
      })
    ).json().id;
    commentId = (
      await app.server.inject({
        method: 'POST',
        url: `/v1/community/posts/${postId}/comments`,
        headers: { ...bearer(bob.accessToken), ...idem() },
        payload: { body: 'a comment', display_mode: 'named' },
      })
    ).json().id;
    for (const [user, reason] of [
      [bob, 'unsafe_medical_advice'],
      [mod, 'self_harm_or_emergency'],
    ] as const) {
      await app.server.inject({
        method: 'POST',
        url: '/v1/community/reports',
        headers: { ...bearer(user.accessToken), ...idem() },
        payload: { target_type: 'post', target_id: postId, reason },
      });
    }
  });
  afterAll(async () => app.close());

  describe('privileged gate (mandatory TOTP)', () => {
    it('a member is 403 forbidden on /mod and /admin routes', async () => {
      expect((await call(alice, 'GET', '/v1/community/mod/reports')).json().error.code).toBe(
        'forbidden',
      );
      expect(
        (await call(alice, 'GET', '/v1/community/admin/verifications')).json().error.code,
      ).toBe('forbidden');
      // Members never need TOTP; enrolment is refused for them.
      expect((await call(alice, 'POST', '/v1/auth/totp/enrol', {})).json().error.code).toBe(
        'forbidden',
      );
    });

    it('a moderator without TOTP ⇒ 403 mfa_enrollment_required on every privileged route', async () => {
      const first = await signIn(app, uniqueEmail('nototp'));
      await setRole(first.userId, 'moderator');
      const fresh = await signIn(app, first.email);
      for (const [method, url, payload] of [
        ['GET', '/v1/community/mod/reports', undefined],
        ['POST', `/v1/community/mod/posts/${postId}/hide`, { reason: REASON }],
        [
          'POST',
          '/v1/community/mod/identity/reveal',
          { target_type: 'post', target_id: postId, reason: REASON },
        ],
      ] as const) {
        const res = await call(fresh, method, url, payload);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('mfa_enrollment_required');
      }
      expect(
        (await stepUp(app, { ...fresh, totpSecret: 'A', backupCodes: [] })).json().error.code,
      ).toBe('mfa_enrollment_required');
    });

    it('enrolled but no step-up on THIS session ⇒ 403 mfa_step_up_required; step-up then allows', async () => {
      const second = { ...mod, ...(await signIn(app, mod.email)) };
      const res = await call(second, 'GET', '/v1/community/mod/reports');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('mfa_step_up_required');
      expect((await stepUp(app, second)).statusCode).toBe(200);
      expect((await call(second, 'GET', '/v1/community/mod/reports')).statusCode).toBe(200);
    });

    it('re-enrolment is refused (409 totp_already_enrolled); a member cannot gain a role by herself', async () => {
      const res = await call(mod, 'POST', '/v1/auth/totp/enrol', {});
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details).toEqual({ reason: 'totp_already_enrolled' });
      // There is no self-service role field anywhere.
      const put = await app.server.inject({
        method: 'PUT',
        url: '/v1/community/me/profile',
        headers: bearer(alice.accessToken),
        payload: { display_name: 'AliceA', role: 'admin' },
      });
      expect(put.statusCode).toBe(400);
    });

    it('the step-up expires after STEP_UP_TTL', async () => {
      await ownerQuery(
        `UPDATE refresh_token_families SET step_up_at = now() - interval '13 hours' WHERE id = $1`,
        [mod.familyId],
      );
      expect((await call(mod, 'GET', '/v1/community/mod/reports')).json().error.code).toBe(
        'mfa_step_up_required',
      );
      expect((await stepUp(app, mod)).statusCode).toBe(200);
    });
  });

  describe('report queue and identity', () => {
    it('queue: self_harm_or_emergency first, then oldest; NO author or reporter identity', async () => {
      const res = await call(mod, 'GET', '/v1/community/mod/reports');
      expect(res.statusCode).toBe(200);
      const items = res.json().items;
      expect(items.map((i: { reason: string }) => i.reason)).toEqual([
        'self_harm_or_emergency',
        'unsafe_medical_advice',
      ]);
      expect(items[0].target).toMatchObject({
        id: postId,
        kind: 'post',
        body: 'Questionable advice',
        status: 'visible',
        open_report_count: 2,
        author: { display_mode: 'pseudonymous', display_name: null, badge: null },
      });
      for (const secret of [alice.userId, alice.email, bob.userId, bob.email, 'AliceA']) {
        expect(res.body).not.toContain(secret);
      }
      const one = await call(mod, 'GET', `/v1/community/mod/reports/${items[0].id}`);
      expect(one.json().id).toBe(items[0].id);
      expect((await call(mod, 'GET', '/v1/community/mod/reports?status=bogus')).statusCode).toBe(
        400,
      );
    });

    it('moderator content view returns any status, still without identity', async () => {
      const res = await call(mod, 'GET', `/v1/community/mod/posts/${postId}`);
      expect(res.json()).toMatchObject({ id: postId, kind: 'post', post_id: null });
      expect(res.body).not.toContain(alice.userId);
      const c = await call(mod, 'GET', `/v1/community/mod/comments/${commentId}`);
      expect(c.json()).toMatchObject({ id: commentId, kind: 'comment', post_id: postId });
    });

    it('POST /mod/identity/reveal returns the accountable identity (no email) and is audited', async () => {
      const res = await call(mod, 'POST', '/v1/community/mod/identity/reveal', {
        target_type: 'post',
        target_id: postId,
        reason: 'self-harm report needs follow-up',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        account_id: alice.userId,
        display_name: 'AliceA',
        role: 'member',
        status: 'active',
        prior_moderation_actions: 0,
        reveal_action_id: expect.stringMatching(/^\d+$/),
      });
      expect(res.body).not.toContain(alice.email);
      expect(res.json()).not.toHaveProperty('email');
      const rows = await auditRows(postId);
      expect(rows).toEqual([
        expect.objectContaining({
          actor_account_id: mod.userId,
          action: 'reveal_identity',
          target_type: 'post',
          reason: 'self-harm report needs follow-up',
        }),
      ]);
      // A reason is mandatory, 10–500 chars.
      const noReason = await call(mod, 'POST', '/v1/community/mod/identity/reveal', {
        target_type: 'post',
        target_id: postId,
        reason: 'short',
      });
      expect(noReason.statusCode).toBe(400);
    });
  });

  describe('content actions', () => {
    it('hide (visible only) → actioned reports, author notice; restore → visible; audit trail', async () => {
      expect(
        (await call(mod, 'POST', `/v1/community/mod/posts/${postId}/hide`, {})).statusCode,
      ).toBe(400);
      const hide = await call(mod, 'POST', `/v1/community/mod/posts/${postId}/hide`, {
        reason: REASON,
      });
      expect(hide.statusCode).toBe(200);
      expect(hide.json()).toMatchObject({
        id: expect.stringMatching(/^\d+$/),
        actor_account_id: mod.userId,
        action: 'hide_content',
        target_type: 'post',
        target_id: postId,
        reason: REASON,
        target_status: 'hidden',
      });
      expect((await call(alice, 'GET', `/v1/community/posts/${postId}`)).statusCode).toBe(404);
      const again = await call(mod, 'POST', `/v1/community/mod/posts/${postId}/hide`, {
        reason: REASON,
      });
      expect(again.json().error.details).toEqual({ reason: 'already_in_state' });
      const queue = await call(mod, 'GET', '/v1/community/mod/reports?status=actioned');
      expect(queue.json().items.length).toBe(2);
      const notices = (await call(alice, 'GET', '/v1/community/notifications')).json().items;
      expect(notices[0]).toMatchObject({
        type: 'moderation_notice',
        notice: 'content_hidden',
        post_id: postId,
      });
      expect(JSON.stringify(notices)).not.toContain(REASON);
      expect(JSON.stringify(notices)).not.toContain(mod.userId);

      const restore = await call(mod, 'POST', `/v1/community/mod/posts/${postId}/restore`, {
        reason: REASON,
      });
      expect(restore.json().target_status).toBe('visible');
      expect((await call(alice, 'GET', `/v1/community/posts/${postId}`)).statusCode).toBe(200);
      const notHidden = await call(mod, 'POST', `/v1/community/mod/posts/${postId}/restore`, {
        reason: REASON,
      });
      expect(notHidden.json().error.details).toEqual({ reason: 'not_hidden_or_removed' });
    });

    it('remove keeps the body for evidence; erased content cannot be restored', async () => {
      const remove = await call(mod, 'POST', `/v1/community/mod/comments/${commentId}/remove`, {
        reason: REASON,
      });
      expect(remove.json().target_status).toBe('removed');
      expect((await call(mod, 'GET', `/v1/community/mod/comments/${commentId}`)).json().body).toBe(
        'a comment',
      );
      const [evidence] = (await ownerQuery(
        `SELECT evidence FROM moderation_actions WHERE action = 'remove_content' AND target_id = $1`,
        [commentId],
      )) as { evidence: { body: string; author_account_id: string } }[];
      expect(evidence.evidence).toMatchObject({ body: 'a comment', author_account_id: bob.userId });

      const own = await app.server.inject({
        method: 'POST',
        url: '/v1/community/spaces/general_health/posts',
        headers: { ...bearer(bob.accessToken), ...idem() },
        payload: { body: 'gone soon', display_mode: 'named' },
      });
      await app.server.inject({
        method: 'DELETE',
        url: `/v1/community/posts/${own.json().id}`,
        headers: bearer(bob.accessToken),
      });
      const erased = await call(mod, 'POST', `/v1/community/mod/posts/${own.json().id}/restore`, {
        reason: REASON,
      });
      expect(erased.json().error.details).toEqual({ reason: 'content_erased' });
    });

    it('a moderator cannot act on their own content (403 self_action_forbidden)', async () => {
      const own = await app.server.inject({
        method: 'POST',
        url: '/v1/community/spaces/general_health/posts',
        headers: { ...bearer(mod.accessToken), ...idem() },
        payload: { body: 'mod post', display_mode: 'named' },
      });
      const res = await call(mod, 'POST', `/v1/community/mod/posts/${own.json().id}/hide`, {
        reason: REASON,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('self_action_forbidden');
    });

    it('dismiss: open → dismissed once; then already_in_state', async () => {
      const r = await app.server.inject({
        method: 'POST',
        url: '/v1/community/reports',
        headers: { ...bearer(bob.accessToken), ...idem() },
        payload: { target_type: 'post', target_id: postId, reason: 'other' },
      });
      const dismiss = await call(mod, 'POST', `/v1/community/mod/reports/${r.json().id}/dismiss`, {
        reason: REASON,
      });
      expect(dismiss.json()).toMatchObject({ action: 'dismiss_report', target_type: 'report' });
      const again = await call(mod, 'POST', `/v1/community/mod/reports/${r.json().id}/dismiss`, {
        reason: REASON,
      });
      expect(again.statusCode).toBe(422);
    });
  });

  describe('account actions', () => {
    it('restrict (with until) → reinstate; until must be future and ≤ 365 days', async () => {
      const past = await call(mod, 'POST', `/v1/community/mod/accounts/${bob.userId}/restrict`, {
        reason: REASON,
        until: '2001-01-01T00:00:00Z',
      });
      expect(past.json().error.details).toEqual({ field: 'until', rule: 'not_allowed_value' });
      const until = new Date(Date.now() + 7 * 86400_000).toISOString();
      const res = await call(mod, 'POST', `/v1/community/mod/accounts/${bob.userId}/restrict`, {
        reason: REASON,
        until,
      });
      expect(res.json()).toMatchObject({
        action: 'restrict_account',
        target_type: 'account',
        target_status: 'restricted',
      });
      expect((await call(bob, 'GET', '/v1/community/me')).json()).toMatchObject({
        status: 'restricted',
        restricted_until: until,
      });
      const reinstate = await call(
        mod,
        'POST',
        `/v1/community/mod/accounts/${bob.userId}/reinstate`,
        {
          reason: REASON,
        },
      );
      expect(reinstate.json().target_status).toBe('active');
      const none = await call(mod, 'POST', `/v1/community/mod/accounts/${bob.userId}/reinstate`, {
        reason: REASON,
      });
      expect(none.json().error.details).toEqual({ reason: 'not_restricted_or_suspended' });
    });

    it('a moderator cannot suspend an admin or themselves; an admin can suspend a moderator', async () => {
      const onAdmin = await call(
        mod,
        'POST',
        `/v1/community/mod/accounts/${admin.userId}/suspend`,
        {
          reason: REASON,
        },
      );
      expect(onAdmin.json().error.code).toBe('forbidden');
      const self = await call(mod, 'POST', `/v1/community/mod/accounts/${mod.userId}/suspend`, {
        reason: REASON,
      });
      expect(self.json().error.code).toBe('self_action_forbidden');
      expect(
        (
          await call(mod, 'POST', '/v1/community/mod/accounts/not!an!id/suspend', {
            reason: REASON,
          })
        ).statusCode,
      ).toBe(404);
      const other = await privilegedUser(app, 'mod2', 'moderator');
      const res = await call(admin, 'POST', `/v1/community/mod/accounts/${other.userId}/suspend`, {
        reason: REASON,
      });
      // privilegedUser() signed in twice (member device, then privileged): both families go.
      expect(res.json()).toMatchObject({ target_status: 'suspended', sessions_revoked: 2 });
      expect((await call(other, 'GET', '/v1/community/me')).statusCode).toBe(401);
    });

    it('GET /mod/actions: newest first, filterable; there is no write API', async () => {
      const res = await call(mod, 'GET', `/v1/community/mod/actions?target_id=${bob.userId}`);
      expect(res.json().items.map((a: { action: string }) => a.action)).toEqual([
        'reinstate_account',
        'restrict_account',
      ]);
      const filtered = await call(
        mod,
        'GET',
        '/v1/community/mod/actions?action=hide_content&limit=1',
      );
      expect(filtered.json().items).toHaveLength(1);
      expect((await call(mod, 'GET', '/v1/community/mod/actions?action=nope')).statusCode).toBe(
        400,
      );
      for (const method of ['POST', 'PUT', 'DELETE'] as const) {
        const w = await app.server.inject({
          method,
          url: '/v1/community/mod/actions',
          headers: bearer(admin.accessToken),
          payload: {},
        });
        expect(w.statusCode).toBe(404);
      }
    });
  });

  describe('admin', () => {
    it('role grants are admin-only, audited {from,to}, and revoke the target sessions', async () => {
      const carol = await memberWithProfile(app, 'carol');
      const byMod = await call(mod, 'POST', `/v1/community/admin/accounts/${carol.userId}/role`, {
        role: 'moderator',
        reason: REASON,
      });
      expect(byMod.json().error.code).toBe('forbidden');
      const res = await call(admin, 'POST', `/v1/community/admin/accounts/${carol.userId}/role`, {
        role: 'moderator',
        reason: REASON,
      });
      expect(res.json()).toMatchObject({ action: 'change_role', target_role: 'moderator' });
      expect((await call(carol, 'GET', '/v1/community/me')).statusCode).toBe(401);
      const [row] = (await ownerQuery(
        `SELECT evidence FROM moderation_actions WHERE action = 'change_role' AND target_id = $1`,
        [carol.userId],
      )) as { evidence: unknown }[];
      expect(row.evidence).toEqual({ from: 'member', to: 'moderator' });
      const same = await call(admin, 'POST', `/v1/community/admin/accounts/${carol.userId}/role`, {
        role: 'moderator',
        reason: REASON,
      });
      expect(same.json().error.details).toEqual({ reason: 'already_in_state' });
      const self = await call(admin, 'POST', `/v1/community/admin/accounts/${admin.userId}/role`, {
        role: 'member',
        reason: REASON,
      });
      expect(self.json().error.code).toBe('self_action_forbidden');
      // The new moderator must enrol TOTP before any privileged action.
      const back = await signIn(app, carol.email);
      expect((await call(back, 'GET', '/v1/community/mod/reports')).json().error.code).toBe(
        'mfa_enrollment_required',
      );
      const enrolled = await enrollTotp(app, back);
      expect((await call(enrolled, 'GET', '/v1/community/mod/reports')).statusCode).toBe(200);
    });

    it('TOTP reset (lost authenticator): admin-only, revokes sessions, then re-enrolment', async () => {
      const target = await privilegedUser(app, 'lostauth', 'moderator');
      const res = await call(
        admin,
        'POST',
        `/v1/community/admin/accounts/${target.userId}/totp-reset`,
        {
          reason: 'lost phone, identity checked',
        },
      );
      expect(res.json()).toMatchObject({ action: 'reset_totp', target_type: 'account' });
      expect((await call(target, 'GET', '/v1/community/me')).statusCode).toBe(401);
      const again = await call(
        admin,
        'POST',
        `/v1/community/admin/accounts/${target.userId}/totp-reset`,
        {
          reason: 'lost phone, identity checked',
        },
      );
      expect(again.json().error.details).toEqual({ reason: 'not_enrolled' });
      const back = await signIn(app, target.email);
      await enrollTotp(app, back);
    });

    it('professional verification: queue, verify (badge appears), revoke (badge disappears)', async () => {
      const nurse = await memberWithProfile(app, 'nurse', 'NurseJoy');
      const claim = await app.server.inject({
        method: 'POST',
        url: '/v1/community/me/professional-claim',
        headers: { ...bearer(nurse.accessToken), ...idem() },
        payload: { profession: 'Midwife', specialty: 'Antenatal care' },
      });
      const vid = claim.json().id;
      const queue = await call(admin, 'GET', '/v1/community/admin/verifications');
      expect(queue.json().items).toEqual([
        expect.objectContaining({
          id: vid,
          account_id: nurse.userId,
          display_name: 'NurseJoy',
          status: 'pending',
        }),
      ]);
      expect((await call(mod, 'GET', '/v1/community/admin/verifications')).json().error.code).toBe(
        'forbidden',
      );
      const noRef = await call(admin, 'POST', `/v1/community/admin/verifications/${vid}/verify`, {
        reason: REASON,
      });
      expect(noRef.statusCode).toBe(400);
      const verify = await call(admin, 'POST', `/v1/community/admin/verifications/${vid}/verify`, {
        reason: 'licence checked with the council',
        evidence_ref: 'NMCN-2026-0001',
      });
      expect(verify.json()).toMatchObject({
        action: 'verify_professional',
        target_status: 'verified',
      });
      const p = await app.server.inject({
        method: 'POST',
        url: '/v1/community/spaces/pregnancy_maternal/posts',
        headers: { ...bearer(nurse.accessToken), ...idem() },
        payload: { body: 'verified advice', display_mode: 'named' },
      });
      expect(p.json().author.badge).toEqual({ profession: 'Midwife', specialty: 'Antenatal care' });
      const twice = await call(admin, 'POST', `/v1/community/admin/verifications/${vid}/verify`, {
        reason: REASON,
        evidence_ref: 'x',
      });
      expect(twice.json().error.details).toEqual({ reason: 'not_pending' });
      const revoke = await call(admin, 'POST', `/v1/community/admin/verifications/${vid}/revoke`, {
        reason: 'licence lapsed per council',
      });
      expect(revoke.json().target_status).toBe('revoked');
      const after = await call(nurse, 'GET', `/v1/community/posts/${p.json().id}`);
      expect(after.json().author.badge).toBeNull();
      const notices = (await call(nurse, 'GET', '/v1/community/notifications')).json().items;
      expect(
        notices.filter((n: { notice: string }) => n.notice === 'verification_updated'),
      ).toHaveLength(2);
    });

    it('an admin cannot verify their own claim (403, also a DB CHECK)', async () => {
      const claim = await app.server.inject({
        method: 'POST',
        url: '/v1/community/me/professional-claim',
        headers: { ...bearer(admin.accessToken), ...idem() },
        payload: { profession: 'Doctor' },
      });
      const res = await call(
        admin,
        'POST',
        `/v1/community/admin/verifications/${claim.json().id}/verify`,
        {
          reason: REASON,
          evidence_ref: 'self',
        },
      );
      expect(res.json().error.code).toBe('self_action_forbidden');
    });

    it('every privileged mutation wrote exactly one audit row with actor, action, target, reason, time', async () => {
      const rows = (await ownerQuery(
        `SELECT actor_account_id, action, target_type, target_id, reason, created_at
           FROM moderation_actions WHERE action <> 'withdraw_professional'`,
      )) as { actor_account_id: string; reason: string; created_at: Date }[];
      expect(rows.length).toBeGreaterThan(10);
      for (const r of rows) {
        expect(r.actor_account_id).toEqual(expect.any(String));
        expect(r.reason.length).toBeGreaterThanOrEqual(10);
        expect(r.created_at).toBeInstanceOf(Date);
      }
    });

    it('Idempotency-Key is optional on mutating moderator POSTs and replays when sent', async () => {
      const r = await app.server.inject({
        method: 'POST',
        url: '/v1/community/reports',
        headers: { ...bearer(bob.accessToken), ...idem() },
        payload: { target_type: 'post', target_id: postId, reason: 'spam' },
      });
      const key = { 'idempotency-key': randomUUID() };
      const url = `/v1/community/mod/reports/${r.json().id}/dismiss`;
      const first = await app.server.inject({
        method: 'POST',
        url,
        headers: { ...bearer(mod.accessToken), ...key },
        payload: { reason: REASON },
      });
      const replay = await app.server.inject({
        method: 'POST',
        url,
        headers: { ...bearer(mod.accessToken), ...key },
        payload: { reason: REASON },
      });
      expect(first.statusCode).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json().id).toBe(first.json().id);
    });
  });

  describe('first-admin bootstrap CLI (no default password)', () => {
    it('refuses while an admin exists; creates the first admin otherwise, audited', async () => {
      const pool = ownerPool();
      try {
        await expect(bootstrapAdmin(pool, 'someone@example.test')).rejects.toThrow(
          /already exists/,
        );
        await resetDatabase();
        await expect(bootstrapAdmin(pool, 'not-an-email')).rejects.toThrow(/valid --email/);
        const result = await bootstrapAdmin(pool, 'Founder@Example.test');
        expect(result.created).toBe(true);
        const [user] = (await ownerQuery(`SELECT "email", "role" FROM "user" WHERE "id" = $1`, [
          result.accountId,
        ])) as { email: string; role: string }[];
        expect(user).toEqual({ email: 'founder@example.test', role: 'admin' });
        const accounts = (await ownerQuery(`SELECT * FROM "account" WHERE "userId" = $1`, [
          result.accountId,
        ])) as unknown[];
        expect(accounts).toHaveLength(0); // no credential row: no password exists
        const [audit] = (await ownerQuery(
          `SELECT action, actor_account_id, evidence FROM moderation_actions WHERE target_id = $1`,
          [result.accountId],
        )) as { action: string; actor_account_id: string; evidence: unknown }[];
        expect(audit).toEqual({
          action: 'change_role',
          actor_account_id: result.accountId,
          evidence: { from: null, to: 'admin', via: 'bootstrap-cli' },
        });
      } finally {
        await pool.end();
      }
      // The bootstrapped admin signs in by OTP and still faces mandatory TOTP.
      const fresh = await createCommunityApp();
      try {
        const founder = await signIn(fresh, 'founder@example.test');
        const res = await fresh.server.inject({
          method: 'GET',
          url: '/v1/community/admin/verifications',
          headers: bearer(founder.accessToken),
        });
        expect(res.json().error.code).toBe('mfa_enrollment_required');
        const enrolled = await enrollTotp(fresh, founder);
        const ok = await fresh.server.inject({
          method: 'GET',
          url: '/v1/community/admin/verifications',
          headers: bearer(enrolled.accessToken),
        });
        expect(ok.statusCode).toBe(200);
      } finally {
        await fresh.close();
      }
    });
  });
});
