/**
 * ADR-001 A2 / contract §3: the WellaPath auth facade over Better Auth.
 * - email OTP sign-up / sign-in (TokenPair), OTP rules (5 attempts, newest code wins, 202 always)
 * - refresh rotation, reuse ⇒ whole family revoked, device mismatch ⇒ revoked, the 10 s
 *   same-device race window (F1: one winner, no revocation)
 * - session lifetimes per role (absolute + idle), sign-out, recovery (sessions, revoke-others)
 * - refresh-token-only logout (P6): neutral 204, reuse detection, bearer + other family, scope
 * - suspended ⇒ next request 401; expired / forged access tokens rejected
 * - Better Auth's own handler is not reachable; nothing secret reaches the logs.
 */
import { randomUUID } from 'crypto';
import { LightMyRequestResponse } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, importJWK, base64url } from 'jose';
import {
  bearer,
  CommunityTestApp,
  createCommunityApp,
  describeDb,
  ownerQuery,
  privilegedUser,
  refresh,
  RELAXED_LIMITS,
  requestOtp,
  resetDatabase,
  setRole,
  signIn,
  SignedIn,
  uniqueEmail,
  verifyOtp,
} from './helpers';

const me = (app: CommunityTestApp, token: string): Promise<LightMyRequestResponse> =>
  app.server.inject({ method: 'GET', url: '/v1/community/me', headers: bearer(token) });

const reasonOf = (res: { json: () => unknown }): string | undefined =>
  (res.json() as { error: { details?: { reason?: string } } }).error.details?.reason;

describeDb('auth facade (A2)', () => {
  let app: CommunityTestApp;
  beforeAll(async () => {
    await resetDatabase();
    app = await createCommunityApp();
  });
  afterAll(async () => app.close());

  describe('email OTP', () => {
    it('signs up a new account and returns a contract TokenPair', async () => {
      const email = uniqueEmail('new');
      expect((await requestOtp(app, email)).statusCode).toBe(202);
      const res = await verifyOtp(app, email, app.outbox.latestOtp(email));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        token_type: 'Bearer',
        expires_in: 900,
        account_created: true,
        account: { email, role: 'member', status: 'active', two_factor_enabled: false },
      });
      expect(body.refresh_token).toMatch(/^wprt_[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(body.access_token_expires_at) - Date.now()).toBeLessThanOrEqual(900_000);
      const days = (Date.parse(body.refresh_token_expires_at) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30);
      expect(res.headers['cache-control']).toBe('no-store');
      // The access token carries sub, sid, iss, aud, iat, exp, jti and is EdDSA.
      const [header, payload] = body.access_token
        .split('.')
        .slice(0, 2)
        .map((p: string) => JSON.parse(Buffer.from(p, 'base64url').toString()));
      expect(header.alg).toBe('EdDSA');
      expect(payload).toEqual(
        expect.objectContaining({
          sub: body.account.account_id,
          sid: expect.stringMatching(/^[0-9a-f-]{36}$/),
          iss: 'wellapath-community',
          aud: 'wellapath-community-api',
          jti: expect.any(String),
        }),
      );
      expect(payload.exp - payload.iat).toBeLessThanOrEqual(900);
      // The Better Auth session token never reaches the client.
      const rows = (await ownerQuery(`SELECT "token" FROM "session"`)) as { token: string }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(res.body).not.toContain(row.token);
      }
    });

    it('signs an existing account in on a new device (account_created false, same id)', async () => {
      const first = await signIn(app, uniqueEmail('again'));
      expect((await requestOtp(app, first.email.toUpperCase())).statusCode).toBe(202);
      const res = await verifyOtp(app, first.email, app.outbox.latestOtp(first.email));
      expect(res.json()).toMatchObject({
        account_created: false,
        account: { account_id: first.userId },
      });
    });

    it('answers 202 {} for unknown, existing and malformed-but-valid emails alike', async () => {
      const known = await signIn(app, uniqueEmail('known'));
      for (const email of [known.email, uniqueEmail('unknown')]) {
        const res = await requestOtp(app, email);
        expect(res.statusCode).toBe(202);
        expect(res.json()).toEqual({});
      }
      expect((await requestOtp(app, 'not-an-email')).json().error).toMatchObject({
        code: 'validation_failed',
        details: { field: 'email', rule: 'format' },
      });
    });

    it('allows 5 verify attempts per code, then invalidates it (invalid_code, not 429)', async () => {
      const email = uniqueEmail('attempts');
      await requestOtp(app, email);
      const code = app.outbox.latestOtp(email);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i += 1) {
        const res = await verifyOtp(app, email, wrong);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('invalid_code');
      }
      const late = await verifyOtp(app, email, code);
      expect(late.statusCode).toBe(400);
      expect(late.json().error.code).toBe('invalid_code');
    });

    it('a code is single use, and a new request invalidates the previous code', async () => {
      const email = uniqueEmail('single');
      await requestOtp(app, email);
      const first = app.outbox.latestOtp(email);
      await requestOtp(app, email);
      const second = app.outbox.latestOtp(email);
      if (first !== second) expect((await verifyOtp(app, email, first)).statusCode).toBe(400);
      expect((await verifyOtp(app, email, second)).statusCode).toBe(200);
      expect((await verifyOtp(app, email, second)).statusCode).toBe(400);
    });

    it('records sign-in audit events without plaintext email', async () => {
      const user = await signIn(app, uniqueEmail('audit'));
      const rows = (await ownerQuery(
        `SELECT event, email_hmac, detail FROM auth_events
          WHERE account_id = $1 OR email_hmac = (
            SELECT email_hmac FROM auth_events WHERE account_id = $1 AND event = 'sign_in_succeeded')
          ORDER BY id`,
        [user.userId],
      )) as { event: string; email_hmac: string | null; detail: unknown }[];
      expect(rows.find(r => r.event === 'otp_requested')?.email_hmac).toEqual(expect.any(String));
      expect(rows.map(r => r.event)).toEqual(
        expect.arrayContaining(['otp_requested', 'family_created', 'sign_in_succeeded']),
      );
      expect(JSON.stringify(rows)).not.toContain(user.email);
    });
  });

  describe('refresh rotation (A2)', () => {
    it('rotate-on-refresh: new refresh token, same sid; the old one is single use', async () => {
      const user = await signIn(app, uniqueEmail('rotate'));
      const res = await refresh(app, user.refreshToken, user.deviceId);
      expect(res.statusCode).toBe(200);
      const pair = res.json();
      expect(pair.refresh_token).not.toBe(user.refreshToken);
      expect(pair.account_created).toBe(false);
      const sid = JSON.parse(
        Buffer.from(pair.access_token.split('.')[1], 'base64url').toString(),
      ).sid;
      expect(sid).toBe(user.familyId);
      expect((await me(app, pair.access_token)).statusCode).toBe(200);
      // And the new one rotates again.
      expect((await refresh(app, pair.refresh_token, user.deviceId)).statusCode).toBe(200);
    });

    it('reuse ⇒ the whole family is revoked (and audited); every holder must sign in again', async () => {
      const user = await signIn(app, uniqueEmail('reuse'));
      const rotated = (await refresh(app, user.refreshToken, user.deviceId)).json();
      // Push the first use outside the 10 s race window.
      await ownerQuery(
        `UPDATE refresh_tokens SET used_at = now() - interval '11 seconds' WHERE family_id = $1 AND used_at IS NOT NULL`,
        [user.familyId],
      );
      const replay = await refresh(app, user.refreshToken, user.deviceId);
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe('unauthenticated');
      expect(reasonOf(replay)).toBe('refresh_reused');
      // The legitimate holder's newer token and access token are dead too.
      const victim = await refresh(app, rotated.refresh_token, user.deviceId);
      expect(victim.statusCode).toBe(401);
      expect((await me(app, rotated.access_token)).statusCode).toBe(401);
      expect((await me(app, user.accessToken)).statusCode).toBe(401);
      const events = (await ownerQuery(`SELECT event FROM auth_events WHERE family_id = $1`, [
        user.familyId,
      ])) as { event: string }[];
      expect(events.map(e => e.event)).toEqual(
        expect.arrayContaining(['refresh_reuse_detected', 'family_revoked']),
      );
    });

    it('a refresh token presented from another device revokes the family', async () => {
      const user = await signIn(app, uniqueEmail('device'));
      const res = await refresh(app, user.refreshToken, randomUUID());
      expect(res.statusCode).toBe(401);
      expect(reasonOf(res)).toBe('refresh_reused');
      expect((await refresh(app, user.refreshToken, user.deviceId)).statusCode).toBe(401);
    });

    it('concurrent refresh race: exactly one winner; the loser gets 409 refresh_race, no revocation', async () => {
      const user = await signIn(app, uniqueEmail('race'));
      const results = await Promise.all([
        refresh(app, user.refreshToken, user.deviceId),
        refresh(app, user.refreshToken, user.deviceId),
        refresh(app, user.refreshToken, user.deviceId),
      ]);
      const statuses = results.map(r => r.statusCode).sort();
      expect(statuses).toEqual([200, 409, 409]);
      for (const loser of results.filter(r => r.statusCode === 409)) {
        expect(loser.json().error).toMatchObject({
          code: 'conflict',
          details: { reason: 'refresh_race' },
        });
      }
      const winner = results.find(r => r.statusCode === 200)?.json();
      // Not revoked: the winner's pair keeps working.
      expect((await me(app, winner.access_token)).statusCode).toBe(200);
      expect((await refresh(app, winner.refresh_token, user.deviceId)).statusCode).toBe(200);
    });

    it('an unknown refresh token is refresh_invalid', async () => {
      const res = await refresh(app, `wprt_${'A'.repeat(43)}`, randomUUID());
      expect(res.statusCode).toBe(401);
      expect(reasonOf(res)).toBe('refresh_invalid');
    });

    it('C6: any bad refresh token is 401 refresh_invalid; only the body shape is a 400', async () => {
      for (const token of ['nope', '', `wprt_${'A'.repeat(10)}`, `wprt_${'A'.repeat(300)}`]) {
        const res = await refresh(app, token, randomUUID());
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthenticated');
        expect(reasonOf(res)).toBe('refresh_invalid');
      }
      for (const payload of [
        { device_id: randomUUID() },
        { refresh_token: 42, device_id: randomUUID() },
        { refresh_token: `wprt_${'A'.repeat(43)}`, device_id: 'not-a-uuid' },
        { refresh_token: `wprt_${'A'.repeat(43)}`, device_id: randomUUID(), extra: 1 },
      ]) {
        const res = await app.server.inject({ method: 'POST', url: '/v1/auth/refresh', payload });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('validation_failed');
      }
    });
  });

  describe('D-019 refresh-race window (tightened, founder 2026-11-08)', () => {
    const familyEvents = async (
      familyId: string,
    ): Promise<{ event: string; detail: Record<string, unknown> }[]> =>
      (await ownerQuery(
        `SELECT event, detail FROM auth_events
          WHERE family_id = $1 AND event IN ('refresh_race', 'refresh_reuse_detected') ORDER BY id`,
        [familyId],
      )) as { event: string; detail: Record<string, unknown> }[];
    const familyRevoked = async (familyId: string): Promise<string | null> =>
      (
        (await ownerQuery(`SELECT revoke_reason FROM refresh_token_families WHERE id = $1`, [
          familyId,
        ])) as { revoke_reason: string | null }[]
      )[0].revoke_reason;

    /** A signed-in user whose first token was just rotated: the old token is "used", < 10 s. */
    const rotatedOnce = async (
      label: string,
    ): Promise<{ user: SignedIn; next: { refresh_token: string; access_token: string } }> => {
      const user = await signIn(app, uniqueEmail(label));
      const res = await refresh(app, user.refreshToken, user.deviceId);
      expect(res.statusCode).toBe(200);
      return { user, next: res.json() };
    };

    it('all conditions hold ⇒ 409 refresh_race, nothing revoked, and the race is logged', async () => {
      const { user, next } = await rotatedOnce('race-ok');
      const res = await refresh(app, user.refreshToken, user.deviceId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'conflict',
        details: { reason: 'refresh_race' },
      });
      expect(await familyRevoked(user.familyId)).toBeNull();
      expect(await familyEvents(user.familyId)).toEqual([
        {
          event: 'refresh_race',
          detail: {
            endpoint: 'refresh',
            outcome: 'tolerated',
            within_race_window: true,
            same_device: true,
            same_family: true,
            replacement_unused: true,
          },
        },
      ]);
      // The winner's pair still works.
      expect((await refresh(app, next.refresh_token, user.deviceId)).statusCode).toBe(200);
    });

    it('a different device_id (inside the window, replacement unused) ⇒ revoked as reuse', async () => {
      const { user, next } = await rotatedOnce('race-device');
      const res = await refresh(app, user.refreshToken, randomUUID());
      expect(res.statusCode).toBe(401);
      expect(reasonOf(res)).toBe('refresh_reused');
      expect(await familyRevoked(user.familyId)).toBe('reuse_detected');
      expect((await refresh(app, next.refresh_token, user.deviceId)).statusCode).toBe(401);
      const [event] = await familyEvents(user.familyId);
      expect(event).toEqual({
        event: 'refresh_reuse_detected',
        detail: expect.objectContaining({
          outcome: 'revoked',
          within_race_window: true,
          same_device: false,
          same_family: true,
          replacement_unused: true,
          device_mismatch: true,
        }),
      });
    });

    it('a replacement outside the token family (inside the window, same device) ⇒ revoked as reuse', async () => {
      const { user } = await rotatedOnce('race-family');
      const other = await signIn(app, uniqueEmail('race-family-other'));
      // The used token's replacement pointer leaves its family (a corrupted or forged chain).
      await ownerQuery(
        `UPDATE refresh_tokens SET replaced_by = (
           SELECT id FROM refresh_tokens WHERE family_id = $2 LIMIT 1)
          WHERE family_id = $1 AND used_at IS NOT NULL`,
        [user.familyId, other.familyId],
      );
      const res = await refresh(app, user.refreshToken, user.deviceId);
      expect(res.statusCode).toBe(401);
      expect(reasonOf(res)).toBe('refresh_reused');
      expect(await familyRevoked(user.familyId)).toBe('reuse_detected');
      expect((await familyEvents(user.familyId))[0].detail).toMatchObject({
        within_race_window: true,
        same_device: true,
        same_family: false,
      });
      // The other account's family is untouched.
      expect(await familyRevoked(other.familyId)).toBeNull();
    });

    it('a replacement that was already used (inside the window, same device) ⇒ revoked as reuse', async () => {
      const { user, next } = await rotatedOnce('race-used');
      const third = await refresh(app, next.refresh_token, user.deviceId);
      expect(third.statusCode).toBe(200);
      const res = await refresh(app, user.refreshToken, user.deviceId);
      expect(res.statusCode).toBe(401);
      expect(reasonOf(res)).toBe('refresh_reused');
      expect(await familyRevoked(user.familyId)).toBe('reuse_detected');
      expect((await refresh(app, third.json().refresh_token, user.deviceId)).statusCode).toBe(401);
      expect((await familyEvents(user.familyId))[0].detail).toMatchObject({
        within_race_window: true,
        same_device: true,
        same_family: true,
        replacement_unused: false,
      });
    });

    it('outside the 10 s window (same device, same family, replacement unused) ⇒ revoked as reuse', async () => {
      const { user } = await rotatedOnce('race-late');
      await ownerQuery(
        `UPDATE refresh_tokens SET used_at = now() - interval '11 seconds'
          WHERE family_id = $1 AND used_at IS NOT NULL`,
        [user.familyId],
      );
      const res = await refresh(app, user.refreshToken, user.deviceId);
      expect(res.statusCode).toBe(401);
      expect(await familyRevoked(user.familyId)).toBe('reuse_detected');
      expect((await familyEvents(user.familyId))[0].detail).toMatchObject({
        within_race_window: false,
        same_device: true,
        same_family: true,
        replacement_unused: true,
      });
    });

    it('concurrent losers are judged by the same rule, and every one is logged', async () => {
      const user = await signIn(app, uniqueEmail('race-concurrent'));
      const results = await Promise.all(
        [0, 1, 2].map(() => refresh(app, user.refreshToken, user.deviceId)),
      );
      expect(results.map(r => r.statusCode).sort()).toEqual([200, 409, 409]);
      const events = await familyEvents(user.familyId);
      expect(events.map(e => e.event)).toEqual(['refresh_race', 'refresh_race']);
      expect(await familyRevoked(user.familyId)).toBeNull();
    });

    it('P6 unchanged: at logout a superseded token revokes even inside the window', async () => {
      const { user } = await rotatedOnce('race-logout');
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refresh_token: user.refreshToken },
      });
      expect(res.statusCode).toBe(204);
      expect(await familyRevoked(user.familyId)).toBe('reuse_detected');
    });
  });

  describe('session lifetimes per role', () => {
    it('member families: 30 days absolute, 7 days idle', async () => {
      const user = await signIn(app, uniqueEmail('life'));
      const [row] = (await ownerQuery(
        `SELECT extract(epoch FROM absolute_expires_at - created_at)::int AS abs,
                extract(epoch FROM idle_expires_at - created_at)::int AS idle
           FROM refresh_token_families WHERE id = $1`,
        [user.familyId],
      )) as { abs: number; idle: number }[];
      expect(row.abs).toBeGreaterThanOrEqual(30 * 86400 - 2);
      expect(row.abs).toBeLessThanOrEqual(30 * 86400 + 2);
      expect(Math.abs(row.idle - 7 * 86400)).toBeLessThanOrEqual(2);
    });

    it('moderator/admin families: 12 hours absolute, 1 hour idle', async () => {
      const mod = await privilegedUser(app, 'lifemod', 'moderator');
      const [row] = (await ownerQuery(
        `SELECT extract(epoch FROM absolute_expires_at - created_at)::int AS abs,
                extract(epoch FROM idle_expires_at - created_at)::int AS idle
           FROM refresh_token_families WHERE id = $1`,
        [mod.familyId],
      )) as { abs: number; idle: number }[];
      expect(Math.abs(row.abs - 12 * 3600)).toBeLessThanOrEqual(2);
      expect(Math.abs(row.idle - 3600)).toBeLessThanOrEqual(2);
    });

    it('idle limit passed ⇒ access 401 session_expired and refresh 401 refresh_expired', async () => {
      const user = await signIn(app, uniqueEmail('idle'));
      await ownerQuery(
        `UPDATE refresh_token_families SET idle_expires_at = now() - interval '1 second' WHERE id = $1`,
        [user.familyId],
      );
      const res = await me(app, user.accessToken);
      expect(res.statusCode).toBe(401);
      expect(reasonOf(res)).toBe('session_expired');
      const r = await refresh(app, user.refreshToken, user.deviceId);
      expect(r.statusCode).toBe(401);
      expect(reasonOf(r)).toBe('refresh_expired');
    });

    it('absolute limit passed ⇒ refresh_expired even if recently used', async () => {
      const user = await signIn(app, uniqueEmail('abs'));
      await ownerQuery(
        `UPDATE refresh_token_families SET absolute_expires_at = now() - interval '1 second' WHERE id = $1`,
        [user.familyId],
      );
      expect(reasonOf(await refresh(app, user.refreshToken, user.deviceId))).toBe(
        'refresh_expired',
      );
    });
  });

  describe('access-token validation', () => {
    it('an expired access token is 401 token_expired (client refreshes once)', async () => {
      const short = await createCommunityApp({ config: { accessTokenTtlSeconds: 1 } });
      try {
        const user = await signIn(short, uniqueEmail('exp'));
        await new Promise(resolve => setTimeout(resolve, 2100));
        const res = await me(short, user.accessToken);
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('token_expired');
        const pair = (await refresh(short, user.refreshToken, user.deviceId)).json();
        expect((await me(short, pair.access_token)).statusCode).toBe(200);
      } finally {
        await short.close();
      }
    });

    it('rejects forged tokens: tampered, attacker key, alg none, HS256 key confusion', async () => {
      const user = await signIn(app, uniqueEmail('forge'));
      const [h, p, sig] = user.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      const tampered = `${h}.${base64url.encode(JSON.stringify({ ...claims, sub: 'someone-else' }))}.${sig}`;

      const attacker = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
      const attackerToken = await new SignJWT(claims)
        .setProtectedHeader({
          alg: 'EdDSA',
          kid: JSON.parse(Buffer.from(h, 'base64url').toString()).kid,
        })
        .sign(attacker.privateKey);

      const none = `${base64url.encode(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${p}.`;

      const [jwk] = (await ownerQuery(`SELECT "publicKey" FROM jwks LIMIT 1`)) as {
        publicKey: string;
      }[];
      const hmacKey = await importJWK({ kty: 'oct', k: base64url.encode(jwk.publicKey) }, 'HS256');
      const confused = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(hmacKey);

      for (const token of [tampered, attackerToken, none, confused, 'garbage', `${h}.${p}`]) {
        const res = await me(app, token);
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthenticated');
      }
      // A refresh token used as an access token is refused too.
      expect((await me(app, user.refreshToken)).statusCode).toBe(401);
      expect((await exportJWK(attacker.publicKey)).kty).toBe('OKP');
    });

    it('missing / non-bearer credentials ⇒ 401 unauthenticated with a reason', async () => {
      const missing = await app.server.inject({ method: 'GET', url: '/v1/community/me' });
      expect(missing.statusCode).toBe(401);
      expect(reasonOf(missing)).toBe('missing_token');
      const basic = await app.server.inject({
        method: 'GET',
        url: '/v1/community/me',
        headers: { authorization: 'Basic YTpi' },
      });
      expect(reasonOf(basic)).toBe('invalid_token');
    });
  });

  describe('sign-out and suspension', () => {
    it('logout revokes the family: the unexpired access token is 401 session_revoked', async () => {
      const user = await signIn(app, uniqueEmail('logout'));
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: bearer(user.accessToken),
        payload: { refresh_token: user.refreshToken },
      });
      expect(res.statusCode).toBe(204);
      const after = await me(app, user.accessToken);
      expect(after.statusCode).toBe(401);
      expect(reasonOf(after)).toBe('session_revoked');
      expect((await refresh(app, user.refreshToken, user.deviceId)).statusCode).toBe(401);
      // Idempotent.
      const again = await app.server.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: bearer(user.accessToken),
      });
      expect(again.statusCode).toBe(204);
    });

    it('logout accepts an expired-but-validly-signed access token', async () => {
      const short = await createCommunityApp({ config: { accessTokenTtlSeconds: 1 } });
      try {
        const user = await signIn(short, uniqueEmail('logoutexp'));
        await new Promise(resolve => setTimeout(resolve, 2100));
        const res = await short.server.inject({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: bearer(user.accessToken),
        });
        expect(res.statusCode).toBe(204);
        expect((await refresh(short, user.refreshToken, user.deviceId)).statusCode).toBe(401);
      } finally {
        await short.close();
      }
    });

    it('suspended ⇒ next request 401; sign-in 403 account_suspended; no OTP is sent', async () => {
      const user = await signIn(app, uniqueEmail('susp'));
      const mod = await privilegedUser(app, 'suspmod', 'moderator');
      // A code issued BEFORE the suspension.
      await requestOtp(app, user.email);
      const preSuspensionCode = app.outbox.latestOtp(user.email);
      const res = await app.server.inject({
        method: 'POST',
        url: `/v1/community/mod/accounts/${user.userId}/suspend`,
        headers: bearer(mod.accessToken),
        payload: { reason: 'repeated harassment of members' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ target_status: 'suspended', sessions_revoked: 1 });
      const after = await me(app, user.accessToken);
      expect(after.statusCode).toBe(401);
      expect(reasonOf(after)).toBe('session_revoked');
      expect((await refresh(app, user.refreshToken, user.deviceId)).statusCode).toBe(401);

      const before = app.outbox.messages.length;
      expect((await requestOtp(app, user.email)).statusCode).toBe(202);
      expect(app.outbox.messages.length).toBe(before); // suppressed

      // Even with a code issued before suspension, sign-in is refused.
      const verify = await verifyOtp(app, user.email, preSuspensionCode);
      expect(verify.statusCode).toBe(403);
      expect(verify.json().error.code).toBe('account_suspended');
    });
  });

  describe('refresh-token-only logout (A4, P6)', () => {
    const logout = (
      payload: unknown,
      headers: Record<string, string> = {},
    ): Promise<LightMyRequestResponse> =>
      app.server.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers,
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });

    const familyRow = async (familyId: string): Promise<{ revoke_reason: string | null }> =>
      (
        (await ownerQuery(`SELECT revoke_reason FROM refresh_token_families WHERE id = $1`, [
          familyId,
        ])) as { revoke_reason: string | null }[]
      )[0];

    /** Everything but the per-request id and the limiter's counter/clock. */
    const stable = (res: LightMyRequestResponse): Record<string, unknown> => {
      const headers = { ...res.headers };
      // (x-ratelimit-* is the app-wide per-IP limiter, also a request counter.)
      for (const k of [
        'x-request-id',
        'ratelimit-remaining',
        'ratelimit-reset',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
        'date',
      ]) {
        delete headers[k];
      }
      return { status: res.statusCode, headers, body: res.body };
    };

    it('staging E2E run 1: refresh-token-only logout revokes the family (204, then refresh 401)', async () => {
      // 1. admin signs in (OTP).
      const first = await signIn(app, uniqueEmail('stagingadmin'));
      await setRole(first.userId, 'admin');
      const admin = await signIn(app, first.email);
      expect((await me(app, admin.accessToken)).json().role).toBe('admin');
      // 2. logout with NO Authorization header, body { refresh_token } (was 401 unauthenticated).
      const res = await logout({ refresh_token: admin.refreshToken });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      // 3. refresh with that token (was 200): now 401, and the family's access token is dead.
      const again = await refresh(app, admin.refreshToken, admin.deviceId);
      expect(again.statusCode).toBe(401);
      expect(again.json().error.code).toBe('unauthenticated');
      expect(reasonOf(again)).toBe('session_revoked');
      const after = await me(app, admin.accessToken);
      expect(after.statusCode).toBe(401);
      expect(reasonOf(after)).toBe('session_revoked');
      expect(await familyRow(admin.familyId)).toEqual({ revoke_reason: 'logout' });
      // The Better Auth session went with it.
      const sessions = (await ownerQuery(
        `SELECT count(*)::int AS n FROM "session" s JOIN refresh_token_families f
            ON f.ba_session_id = s."id" WHERE f.id = $1`,
        [admin.familyId],
      )) as { n: number }[];
      expect(sessions[0].n).toBe(0);
      const events = (await ownerQuery(
        `SELECT account_id, family_id, ip_hash, detail FROM auth_events
          WHERE event = 'logout' AND family_id = $1`,
        [admin.familyId],
      )) as { account_id: string; ip_hash: string | null; detail: Record<string, string> }[];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        account_id: admin.userId,
        detail: { outcome: 'revoked', credential: 'refresh_token' },
      });
      expect(events[0].ip_hash).toEqual(expect.any(String));
    });

    it('every token of the family is refused afterwards, including a rotated-away one', async () => {
      const user = await signIn(app, uniqueEmail('p6family'));
      const rotated = (await refresh(app, user.refreshToken, user.deviceId)).json();
      expect((await logout({ refresh_token: rotated.refresh_token })).statusCode).toBe(204);
      for (const token of [user.refreshToken, rotated.refresh_token]) {
        expect((await refresh(app, token, user.deviceId)).statusCode).toBe(401);
      }
      for (const access of [user.accessToken, rotated.access_token]) {
        expect((await me(app, access)).statusCode).toBe(401);
      }
    });

    it('neutral: unknown, expired, already-revoked and other-account tokens look exactly like a success', async () => {
      const ok = await signIn(app, uniqueEmail('p6ok'));
      const success = await logout({ refresh_token: ok.refreshToken });
      expect(success.statusCode).toBe(204);
      expect(Number(success.headers['ratelimit-limit'])).toBeGreaterThan(0);

      const expired = await signIn(app, uniqueEmail('p6exp'));
      await ownerQuery(
        `UPDATE refresh_token_families SET idle_expires_at = now() - interval '1 second' WHERE id = $1`,
        [expired.familyId],
      );
      const other = await signIn(app, uniqueEmail('p6other'));
      const caller = await signIn(app, uniqueEmail('p6caller'));
      const cases: [string, () => Promise<LightMyRequestResponse>][] = [
        ['unknown', () => logout({ refresh_token: `wprt_${'Q'.repeat(43)}` })],
        [
          'unknown, longer',
          () => logout({ refresh_token: `wprt_${randomUUID()}${'x'.repeat(20)}` }),
        ],
        ['expired family', () => logout({ refresh_token: expired.refreshToken })],
        ['already revoked (second logout)', () => logout({ refresh_token: ok.refreshToken })],
        [
          'other account, with a bearer',
          () => logout({ refresh_token: other.refreshToken }, bearer(caller.accessToken)),
        ],
      ];
      const remaining: number[] = [Number(success.headers['ratelimit-remaining'])];
      for (const [label, run] of cases) {
        const res = await run();
        if (label.includes('bearer')) {
          // A different limiter dimension (per account) on the bearer path; status/body agree.
          expect({ label, status: res.statusCode, body: res.body }).toEqual({
            label,
            status: 204,
            body: '',
          });
          continue;
        }
        expect({ label, ...stable(res) }).toEqual({ label, ...stable(success) });
        remaining.push(Number(res.headers['ratelimit-remaining']));
      }
      // The visible limiter counts requests from this IP, not token state.
      for (let i = 1; i < remaining.length; i += 1) {
        expect(remaining[i]).toBe(Math.max(0, remaining[i - 1] - 1));
      }
      // The expired family is left as it was (it is already unusable).
      expect(await familyRow(expired.familyId)).toEqual({ revoke_reason: null });
    });

    it('a neutral no-op is audited as logout without an account (ip_hash only, outcome noop)', async () => {
      const token = `wprt_${randomUUID().replace(/-/g, '')}${'n'.repeat(12)}`;
      const [{ max }] = (await ownerQuery(
        `SELECT coalesce(max(id), 0)::bigint AS max FROM auth_events`,
      )) as { max: string }[];
      expect((await logout({ refresh_token: token })).statusCode).toBe(204);
      const rows = (await ownerQuery(`SELECT * FROM auth_events WHERE id > $1 ORDER BY id`, [
        max,
      ])) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event: 'logout',
        account_id: null,
        family_id: null,
        email_hmac: null,
        detail: { outcome: 'noop' },
      });
      expect(rows[0].ip_hash).toEqual(expect.any(String));
      expect(JSON.stringify(rows)).not.toContain(token);
    });

    it('400 validation_failed depends only on the body shape, never on stored state', async () => {
      const live = await signIn(app, uniqueEmail('p6shape'));
      const cases: [unknown, string, string][] = [
        [undefined, 'refresh_token', 'required'],
        [{}, 'refresh_token', 'required'],
        [{ refresh_token: 42 }, 'refresh_token', 'type'],
        [{ refresh_token: null }, 'refresh_token', 'type'],
        [{ refresh_token: 'nope' }, 'refresh_token', 'pattern'],
        [{ refresh_token: `wprt_${'a'.repeat(42)}` }, 'refresh_token', 'pattern'],
        [{ refresh_token: `wprt_${'a'.repeat(300)}` }, 'refresh_token', 'max_length'],
        // A LIVE token with an unknown field is still a 400, and nothing is revoked.
        [
          { refresh_token: live.refreshToken, device_id: randomUUID() },
          'device_id',
          'unknown_field',
        ],
        [[live.refreshToken], 'body', 'type'],
      ];
      for (const [payload, field, rule] of cases) {
        const res = await logout(payload);
        expect({ payload, status: res.statusCode, error: res.json().error }).toMatchObject({
          payload,
          status: 400,
          error: { code: 'validation_failed', details: { field, rule } },
        });
      }
      expect((await me(app, live.accessToken)).statusCode).toBe(200);
      expect(await familyRow(live.familyId)).toEqual({ revoke_reason: null });
    });

    it('reuse: a superseded token at logout revokes the family as reuse_detected, still 204', async () => {
      const user = await signIn(app, uniqueEmail('p6reuse'));
      const rotated = (await refresh(app, user.refreshToken, user.deviceId)).json();
      await ownerQuery(
        `UPDATE refresh_tokens SET used_at = now() - interval '11 seconds' WHERE family_id = $1 AND used_at IS NOT NULL`,
        [user.familyId],
      );
      const res = await logout({ refresh_token: user.refreshToken });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(await familyRow(user.familyId)).toEqual({ revoke_reason: 'reuse_detected' });
      // The legitimate holder's newer pair is dead too; refresh reports the reuse.
      const victim = await refresh(app, rotated.refresh_token, user.deviceId);
      expect(victim.statusCode).toBe(401);
      expect(reasonOf(victim)).toBe('refresh_reused');
      expect((await me(app, rotated.access_token)).statusCode).toBe(401);
      const events = (await ownerQuery(
        `SELECT event, account_id, detail FROM auth_events WHERE family_id = $1 ORDER BY id`,
        [user.familyId],
      )) as { event: string; account_id: string; detail: Record<string, unknown> }[];
      expect(events.find(e => e.event === 'refresh_reuse_detected')).toMatchObject({
        account_id: user.userId,
        detail: { endpoint: 'logout', within_race_window: false },
      });
      expect(events.find(e => e.event === 'family_revoked')?.detail).toEqual({
        reason: 'reuse_detected',
      });
      // Not double-counted as a plain logout.
      expect(events.filter(e => e.event === 'logout')).toHaveLength(0);
    });

    it('D-019: a superseded token inside the 10 s window still revokes at logout (no device_id to prove the race)', async () => {
      const user = await signIn(app, uniqueEmail('p6race'));
      const rotated = (await refresh(app, user.refreshToken, user.deviceId)).json();
      // Within the window, the refresh path would answer 409 refresh_race without revoking …
      const race = await refresh(app, user.refreshToken, user.deviceId);
      expect(race.statusCode).toBe(409);
      expect(await familyRow(user.familyId)).toEqual({ revoke_reason: null });
      // … but logout revokes: the caller asked to be signed out.
      expect((await logout({ refresh_token: user.refreshToken })).statusCode).toBe(204);
      expect(await familyRow(user.familyId)).toEqual({ revoke_reason: 'reuse_detected' });
      expect((await refresh(app, rotated.refresh_token, user.deviceId)).statusCode).toBe(401);
      const [reuse] = (await ownerQuery(
        `SELECT detail FROM auth_events WHERE family_id = $1 AND event = 'refresh_reuse_detected'`,
        [user.familyId],
      )) as { detail: Record<string, unknown> }[];
      expect(reuse.detail).toEqual({ endpoint: 'logout', within_race_window: true });
    });

    it('bearer + a refresh token of a different live family the caller holds: both revoked', async () => {
      const phone = await signIn(app, uniqueEmail('p6two'));
      const tablet = await signIn(app, phone.email);
      expect(tablet.familyId).not.toBe(phone.familyId);
      const res = await logout({ refresh_token: tablet.refreshToken }, bearer(phone.accessToken));
      expect(res.statusCode).toBe(204);
      expect(await familyRow(phone.familyId)).toEqual({ revoke_reason: 'logout' });
      expect(await familyRow(tablet.familyId)).toEqual({ revoke_reason: 'logout' });
      expect((await me(app, tablet.accessToken)).statusCode).toBe(401);
      expect((await refresh(app, tablet.refreshToken, tablet.deviceId)).statusCode).toBe(401);
      const events = (await ownerQuery(
        `SELECT family_id, detail FROM auth_events WHERE event = 'logout' AND account_id = $1`,
        [phone.userId],
      )) as { family_id: string; detail: { credential: string } }[];
      expect(events.map(e => [e.family_id, e.detail.credential]).sort()).toEqual(
        [
          [phone.familyId, 'bearer'],
          [tablet.familyId, 'refresh_token'],
        ].sort(),
      );
    });

    it('bearer + anything else in the body is ignored: the bearer family is revoked, 204', async () => {
      const user = await signIn(app, uniqueEmail('p6ignore'));
      const bystander = await signIn(app, user.email);
      // Unknown token: the body is ignored.
      const caller1 = await signIn(app, uniqueEmail('p6ignorecaller'));
      const unknown = await logout(
        { refresh_token: `wprt_${'Z'.repeat(43)}` },
        bearer(caller1.accessToken),
      );
      expect([unknown.statusCode, unknown.body]).toEqual([204, '']);
      expect(await familyRow(caller1.familyId)).toEqual({ revoke_reason: 'logout' });
      // An already-revoked family of the SAME account: the body is ignored.
      const gone = await signIn(app, uniqueEmail('p6gone'));
      expect((await logout({ refresh_token: gone.refreshToken })).statusCode).toBe(204);
      const caller2 = await signIn(app, gone.email);
      const revoked = await logout(
        { refresh_token: gone.refreshToken },
        bearer(caller2.accessToken),
      );
      expect([revoked.statusCode, revoked.body]).toEqual([204, '']);
      expect(await familyRow(caller2.familyId)).toEqual({ revoke_reason: 'logout' });
      // The bearer's own token in the body is the ordinary A4 call (no second revocation).
      const caller = await signIn(app, user.email);
      expect(
        (await logout({ refresh_token: caller.refreshToken }, bearer(caller.accessToken)))
          .statusCode,
      ).toBe(204);
      // A family not named in the body is untouched.
      expect((await me(app, bystander.accessToken)).statusCode).toBe(200);
    });

    it('a bearer that is not a validly signed access token is still 401, even with a live refresh token', async () => {
      const user = await signIn(app, uniqueEmail('p6badbearer'));
      for (const header of [{ authorization: 'Bearer garbage' }, { authorization: 'Basic YTpi' }]) {
        const res = await logout({ refresh_token: user.refreshToken }, header);
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthenticated');
      }
      expect((await me(app, user.accessToken)).statusCode).toBe(200);
    });

    it('idempotent without a bearer: a second logout is 204 too', async () => {
      const user = await signIn(app, uniqueEmail('p6idem'));
      const first = await logout({ refresh_token: user.refreshToken });
      const second = await logout({ refresh_token: user.refreshToken });
      expect([first.statusCode, second.statusCode]).toEqual([204, 204]);
      expect(stable(second)).toEqual(stable(first));
    });

    it('concurrent logouts of the same token: one revocation, every caller 204', async () => {
      const user = await signIn(app, uniqueEmail('p6concurrent'));
      const results = await Promise.all(
        [1, 2, 3].map(() => logout({ refresh_token: user.refreshToken })),
      );
      expect(results.map(r => r.statusCode)).toEqual([204, 204, 204]);
      const revoked = (await ownerQuery(
        `SELECT count(*)::int AS n FROM auth_events WHERE event = 'family_revoked' AND family_id = $1`,
        [user.familyId],
      )) as { n: number }[];
      expect(revoked[0].n).toBe(1);
    });

    it('no weakening elsewhere: a refresh token as bearer, or no bearer, is 401 on protected routes', async () => {
      const user = await signIn(app, uniqueEmail('p6scope'));
      const routes: ['GET' | 'POST', string, Record<string, unknown> | undefined][] = [
        ['GET', '/v1/community/me', undefined],
        ['GET', '/v1/auth/sessions', undefined],
        ['POST', '/v1/auth/sessions/revoke-others', {}],
      ];
      for (const [method, url, payload] of routes) {
        for (const headers of [{}, bearer(user.refreshToken)]) {
          const res = await app.server.inject({ method, url, headers, payload });
          expect({ url, status: res.statusCode, code: res.json().error.code }).toEqual({
            url,
            status: 401,
            code: 'unauthenticated',
          });
        }
        // A refresh token in the BODY is not a credential on these routes either.
        if (method === 'POST') {
          const res = await app.server.inject({
            method,
            url,
            payload: { refresh_token: user.refreshToken },
          });
          expect([400, 401]).toContain(res.statusCode);
        }
      }
      // The session survived all of that.
      expect((await me(app, user.accessToken)).statusCode).toBe(200);
    });

    it('the expired-access-token acceptance stays scoped to logout', async () => {
      const short = await createCommunityApp({ config: { accessTokenTtlSeconds: 1 } });
      try {
        const user = await signIn(short, uniqueEmail('p6expscope'));
        await new Promise(resolve => setTimeout(resolve, 2100));
        for (const [method, url, payload] of [
          ['GET', '/v1/community/me', undefined],
          ['GET', '/v1/auth/sessions', undefined],
          ['POST', '/v1/auth/sessions/revoke-others', {}],
        ] as ['GET' | 'POST', string, Record<string, unknown> | undefined][]) {
          const res = await short.server.inject({
            method,
            url,
            headers: bearer(user.accessToken),
            payload,
          });
          expect({ url, status: res.statusCode, code: res.json().error.code }).toEqual({
            url,
            status: 401,
            code: 'token_expired',
          });
        }
      } finally {
        await short.close();
      }
    });

    it('never logs the refresh token presented at logout', async () => {
      app.logs.clear();
      const user = await signIn(app, uniqueEmail('p6logs'));
      await logout({ refresh_token: user.refreshToken });
      await logout({ refresh_token: `wprt_${'L'.repeat(43)}` });
      const text = app.logs.text();
      expect(text).not.toContain(user.refreshToken);
      expect(text).not.toContain('L'.repeat(43));
      expect(text).not.toContain(user.email);
    });
  });

  describe('logout: bearer of account A + refresh token of account B (founder, 2026-11-08)', () => {
    // Many families per account: the per-email OTP limit is lifted for this block only.
    let xapp: CommunityTestApp;
    beforeAll(async () => {
      xapp = await createCommunityApp({
        config: {
          limitOverrides: {
            ...RELAXED_LIMITS,
            otp_request_email_15m: { max: 100000 },
            otp_request_email_24h: { max: 100000 },
            otp_verify_email: { max: 100000 },
          },
        },
      });
    });
    afterAll(async () => xapp.close());

    const xlogout = (
      payload: Record<string, unknown> | undefined,
      headers: Record<string, string> = {},
    ): Promise<LightMyRequestResponse> =>
      xapp.server.inject({ method: 'POST', url: '/v1/auth/logout', headers, payload });

    const reasonFor = async (familyId: string): Promise<string | null> =>
      (
        (await ownerQuery(`SELECT revoke_reason FROM refresh_token_families WHERE id = $1`, [
          familyId,
        ])) as { revoke_reason: string | null }[]
      )[0].revoke_reason;

    const liveFamilies = async (userId: string): Promise<string[]> =>
      (
        (await ownerQuery(
          `SELECT id FROM refresh_token_families WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id`,
          [userId],
        )) as { id: string }[]
      ).map(r => r.id);

    const stableX = (res: LightMyRequestResponse): Record<string, unknown> => {
      const headers = { ...res.headers };
      for (const k of [
        'x-request-id',
        'ratelimit-remaining',
        'ratelimit-reset',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
        'date',
      ]) {
        delete headers[k];
      }
      return { status: res.statusCode, headers, body: res.body };
    };

    const eventsSince = async (id: string): Promise<Record<string, unknown>[]> =>
      (await ownerQuery(
        `SELECT event, account_id, family_id, detail FROM auth_events WHERE id > $1 ORDER BY id`,
        [id],
      )) as Record<string, unknown>[];
    const lastEventId = async (): Promise<string> =>
      (
        (await ownerQuery(`SELECT coalesce(max(id), 0)::text AS id FROM auth_events`)) as {
          id: string;
        }[]
      )[0].id;

    it('A bearer + B current token: B revoked, A untouched and its token works; response identical to the same-account case', async () => {
      // Same-account reference: C's bearer + another live C family.
      const c1 = await signIn(xapp, uniqueEmail('xsame'));
      const c2 = await signIn(xapp, c1.email);
      const same = await xlogout({ refresh_token: c2.refreshToken }, bearer(c1.accessToken));
      expect(await reasonFor(c1.familyId)).toBe('logout');
      expect(await reasonFor(c2.familyId)).toBe('logout');

      const a = await signIn(xapp, uniqueEmail('xa'));
      const b = await signIn(xapp, uniqueEmail('xb'));
      const before = await lastEventId();
      const cross = await xlogout({ refresh_token: b.refreshToken }, bearer(a.accessToken));
      expect(stableX(cross)).toEqual(stableX(same));
      expect(cross.statusCode).toBe(204);
      expect(cross.body).toBe('');

      expect(await reasonFor(b.familyId)).toBe('logout');
      expect((await me(xapp, b.accessToken)).statusCode).toBe(401);
      expect((await refresh(xapp, b.refreshToken, b.deviceId)).statusCode).toBe(401);
      expect(await reasonFor(a.familyId)).toBeNull();
      expect((await me(xapp, a.accessToken)).statusCode).toBe(200);
      expect((await refresh(xapp, a.refreshToken, a.deviceId)).statusCode).toBe(200);

      const events = await eventsSince(before);
      // (A's later refresh above writes refresh_rotated; everything else of A is this one row.)
      const aRows = events.filter(e => e.account_id === a.userId && e.event !== 'refresh_rotated');
      expect(aRows).toEqual([
        {
          event: 'logout',
          account_id: a.userId,
          family_id: a.familyId,
          detail: { outcome: 'noop', reason: 'cross_account_refresh_token' },
        },
      ]);
      // A's row carries nothing about B.
      expect(JSON.stringify(aRows)).not.toContain(b.userId);
      expect(JSON.stringify(aRows)).not.toContain(b.familyId);
      expect(events.filter(e => e.account_id === b.userId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'logout',
            family_id: b.familyId,
            detail: { outcome: 'revoked', credential: 'refresh_token' },
          }),
        ]),
      );
    });

    it('A bearer + B superseded token: B revoked as reuse_detected (audited as on refresh), A untouched', async () => {
      const a = await signIn(xapp, uniqueEmail('xa2'));
      const b = await signIn(xapp, uniqueEmail('xb2'));
      const rotated = (await refresh(xapp, b.refreshToken, b.deviceId)).json();
      await ownerQuery(
        `UPDATE refresh_tokens SET used_at = now() - interval '11 seconds' WHERE family_id = $1 AND used_at IS NOT NULL`,
        [b.familyId],
      );
      const res = await xlogout({ refresh_token: b.refreshToken }, bearer(a.accessToken));
      expect([res.statusCode, res.body]).toEqual([204, '']);
      expect(await reasonFor(b.familyId)).toBe('reuse_detected');
      expect(reasonOf(await refresh(xapp, rotated.refresh_token, b.deviceId))).toBe(
        'refresh_reused',
      );
      const [reuse] = (await ownerQuery(
        `SELECT account_id, detail FROM auth_events WHERE family_id = $1 AND event = 'refresh_reuse_detected'`,
        [b.familyId],
      )) as { account_id: string; detail: Record<string, unknown> }[];
      expect(reuse).toEqual({
        account_id: b.userId,
        detail: { endpoint: 'logout', within_race_window: false },
      });
      expect(await reasonFor(a.familyId)).toBeNull();
      expect((await me(xapp, a.accessToken)).statusCode).toBe(200);
    });

    it('A bearer + B revoked token: both untouched, 204', async () => {
      const a = await signIn(xapp, uniqueEmail('xa3'));
      const b = await signIn(xapp, uniqueEmail('xb3'));
      expect((await xlogout({ refresh_token: b.refreshToken })).statusCode).toBe(204);
      const before = await lastEventId();
      const res = await xlogout({ refresh_token: b.refreshToken }, bearer(a.accessToken));
      expect([res.statusCode, res.body]).toEqual([204, '']);
      expect(await reasonFor(a.familyId)).toBeNull();
      expect((await me(xapp, a.accessToken)).statusCode).toBe(200);
      expect(await reasonFor(b.familyId)).toBe('logout'); // unchanged
      const events = await eventsSince(before);
      expect(events.filter(e => e.event === 'family_revoked')).toEqual([]);
      expect(events.find(e => e.account_id === a.userId)).toMatchObject({
        detail: { outcome: 'noop', reason: 'cross_account_refresh_token' },
      });
    });

    it('A bearer + B expired family: both untouched, 204', async () => {
      const a = await signIn(xapp, uniqueEmail('xa4'));
      const b = await signIn(xapp, uniqueEmail('xb4'));
      await ownerQuery(
        `UPDATE refresh_token_families SET idle_expires_at = now() - interval '1 second' WHERE id = $1`,
        [b.familyId],
      );
      const res = await xlogout({ refresh_token: b.refreshToken }, bearer(a.accessToken));
      expect([res.statusCode, res.body]).toEqual([204, '']);
      expect(await reasonFor(a.familyId)).toBeNull();
      expect(await reasonFor(b.familyId)).toBeNull();
    });

    it('no session of A other than the bearer’s is ever revoked, whatever the body names from another account or nothing', async () => {
      const a0 = await signIn(xapp, uniqueEmail('xkeep'));
      const keep = [a0, await signIn(xapp, a0.email), await signIn(xapp, a0.email)];
      const keepIds = keep.map(k => k.familyId);
      const other = async (): Promise<SignedIn> => signIn(xapp, uniqueEmail('xother'));
      const bodies: [string, () => Promise<Record<string, unknown> | undefined>][] = [
        ['no body', async () => undefined],
        ['empty body', async () => ({})],
        ['unknown token', async () => ({ refresh_token: `wprt_${'K'.repeat(43)}` })],
        ['B current', async () => ({ refresh_token: (await other()).refreshToken })],
        [
          'B superseded',
          async () => {
            const b = await other();
            await refresh(xapp, b.refreshToken, b.deviceId);
            return { refresh_token: b.refreshToken };
          },
        ],
        [
          'B revoked',
          async () => {
            const b = await other();
            await xlogout({ refresh_token: b.refreshToken });
            return { refresh_token: b.refreshToken };
          },
        ],
      ];
      for (const [label, make] of bodies) {
        const bearerFamily = await signIn(xapp, a0.email);
        const body = await make();
        const res = await xlogout(body, bearer(bearerFamily.accessToken));
        expect({ label, status: res.statusCode }).toEqual({ label, status: 204 });
        const live = await liveFamilies(a0.userId);
        for (const id of keepIds)
          expect({ label, id, live: live.includes(id) }).toEqual({ label, id, live: true });
        const crossAccount = label.startsWith('B ');
        expect({ label, bearerRevoked: !live.includes(bearerFamily.familyId) }).toEqual({
          label,
          bearerRevoked: !crossAccount,
        });
      }
      for (const k of keep) expect((await me(xapp, k.accessToken)).statusCode).toBe(200);
    });
  });

  describe('account recovery', () => {
    it('lost device: OTP on a new device recovers the account; revoke-others kills the old one', async () => {
      const oldDevice = await signIn(app, uniqueEmail('lost'));
      const newDevice = await signIn(app, oldDevice.email);
      expect(newDevice.userId).toBe(oldDevice.userId);
      const list = await app.server.inject({
        method: 'GET',
        url: '/v1/auth/sessions',
        headers: bearer(newDevice.accessToken),
      });
      expect(list.statusCode).toBe(200);
      const items = list.json().items as {
        session_id: string;
        current: boolean;
        device_label: string;
      }[];
      expect(items).toHaveLength(2);
      expect(items.find(i => i.current)?.session_id).toBe(newDevice.familyId);
      expect(JSON.stringify(list.json())).not.toMatch(/ip|user_agent|token/i);

      const revoke = await app.server.inject({
        method: 'POST',
        url: '/v1/auth/sessions/revoke-others',
        headers: bearer(newDevice.accessToken),
        payload: {},
      });
      expect(revoke.json()).toEqual({ revoked: 1 });
      expect((await me(app, oldDevice.accessToken)).statusCode).toBe(401);
      expect((await refresh(app, oldDevice.refreshToken, oldDevice.deviceId)).statusCode).toBe(401);
      expect((await me(app, newDevice.accessToken)).statusCode).toBe(200);
    });

    it('lost authenticator: a single-use backup code steps up; reuse is invalid_code', async () => {
      const mod = await privilegedUser(app, 'backup', 'moderator');
      const code = mod.backupCodes[0];
      const first = await app.server.inject({
        method: 'POST',
        url: '/v1/auth/totp/verify',
        headers: bearer(mod.accessToken),
        payload: { backup_code: code },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().step_up).toBe('verified');
      const reuse = await app.server.inject({
        method: 'POST',
        url: '/v1/auth/totp/verify',
        headers: bearer(mod.accessToken),
        payload: { backup_code: code },
      });
      expect(reuse.statusCode).toBe(400);
      expect(reuse.json().error.code).toBe('invalid_code');
    });
  });

  describe('surface', () => {
    it.each([
      ['POST', '/v1/auth/email-otp/send-verification-otp'],
      ['POST', '/v1/auth/sign-in/email-otp'],
      ['GET', '/v1/auth/get-session'],
      ['GET', '/v1/auth/token'],
      ['GET', '/v1/auth/jwks'],
      ['POST', '/v1/auth/two-factor/enable'],
      ['POST', '/v1/auth/email-otp/request-password-reset'],
      ['POST', '/v1/auth/forget-password/email-otp'],
      ['POST', '/v1/auth/change-email'],
      ['POST', '/v1/auth/sign-in/phone-number'],
    ])('Better Auth / excluded endpoint %s %s is 404', async (method, url) => {
      const res = await app.server.inject({
        method: method as 'GET' | 'POST',
        url,
        payload: method === 'POST' ? {} : undefined,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('session rows keep no client IP or user agent', async () => {
      await signIn(app, uniqueEmail('ip'));
      const rows = (await ownerQuery(
        `SELECT count(*)::int AS n FROM "session" WHERE "ipAddress" IS NOT NULL OR "userAgent" IS NOT NULL`,
      )) as { n: number }[];
      expect(rows[0].n).toBe(0);
    });

    it('never logs the email, OTP or tokens', async () => {
      app.logs.clear();
      const user = await signIn(app, uniqueEmail('logs'));
      const pair = (await refresh(app, user.refreshToken, user.deviceId)).json();
      const text = app.logs.text();
      expect(text.length).toBeGreaterThan(0);
      for (const secret of [
        user.email,
        app.outbox.latestOtp(user.email),
        user.accessToken,
        user.refreshToken,
        pair.refresh_token,
      ]) {
        expect(text).not.toContain(secret);
      }
    });
  });
});
