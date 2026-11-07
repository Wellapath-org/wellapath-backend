/**
 * Criteria 2 and 3: email-OTP sign-up/sign-in, access-token validation (expired, revoked,
 * forged), refresh, sign-out, suspension, and account recovery.
 */
import { generateKeyPair, SignJWT, decodeJwt } from 'jose';
import {
  bearer,
  createCommunityApp,
  CommunityTestApp,
  describeDb,
  mintAccessToken,
  privilegedUser,
  resetDatabase,
  signIn,
  uniqueEmail,
} from './helpers';

const me = (app: CommunityTestApp, token: string) =>
  app.server.inject({ method: 'GET', url: '/v1/community/me', headers: bearer(token) });

describeDb('email OTP sign-in and access tokens', () => {
  let app: CommunityTestApp;
  beforeAll(async () => {
    await resetDatabase();
    app = await createCommunityApp();
  });
  afterAll(async () => app.close());

  it('signs up a new account by email OTP and calls an authenticated endpoint', async () => {
    const email = uniqueEmail('new');
    const user = await signIn(app, email);
    expect(app.outbox.messages.filter(m => m.to === email)).toHaveLength(1);
    const res = await me(app, user.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: user.userId,
      role: 'member',
      two_factor_enabled: false,
    });
  });

  it('never writes the OTP, email, session token or access token to the request log', async () => {
    const email = uniqueEmail('logcheck');
    const user = await signIn(app, email);
    await me(app, user.accessToken);
    const logs = app.logs.text();
    expect(logs).not.toContain(app.outbox.latestOtp(email));
    expect(logs).not.toContain(email);
    expect(logs).not.toContain(user.sessionToken);
    expect(logs).not.toContain(user.accessToken);
  });

  it('the access token is a short-lived EdDSA JWT bound to the session', async () => {
    const user = await signIn(app, uniqueEmail('claims'));
    const claims = decodeJwt(user.accessToken);
    expect(claims.sub).toBe(user.userId);
    expect(typeof claims.sid).toBe('string');
    expect(claims.iss).toBe('wellapath-community');
    expect(claims.aud).toBe('wellapath-community-api');
    expect((claims.exp as number) - (claims.iat as number)).toBe(900);
  });

  it('rejects a wrong OTP and locks the OTP after 3 failed attempts', async () => {
    const email = uniqueEmail('wrongotp');
    await app.server.inject({
      method: 'POST',
      url: '/v1/auth/email-otp/send-verification-otp',
      payload: { email, type: 'sign-in' },
    });
    const real = app.outbox.latestOtp(email);
    const wrong = real === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i += 1) {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/auth/sign-in/email-otp',
        payload: { email, otp: wrong },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
    const after = await app.server.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/email-otp',
      payload: { email, otp: real },
    });
    expect(after.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('an OTP is single-use', async () => {
    const email = uniqueEmail('reuse');
    await signIn(app, email);
    const replay = await app.server.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/email-otp',
      payload: { email, otp: app.outbox.latestOtp(email) },
    });
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refresh: the session token mints a new access token that works', async () => {
    const user = await signIn(app, uniqueEmail('refresh'));
    await new Promise(r => setTimeout(r, 1100)); // new iat
    const fresh = await mintAccessToken(app, user.sessionToken);
    expect(fresh).not.toBe(user.accessToken);
    expect((await me(app, fresh)).statusCode).toBe(200);
  });

  it('rejects a missing, malformed or non-Bearer token', async () => {
    expect((await app.server.inject({ method: 'GET', url: '/v1/community/me' })).statusCode).toBe(
      401,
    );
    expect((await me(app, 'not-a-jwt')).statusCode).toBe(401);
    const basic = await app.server.inject({
      method: 'GET',
      url: '/v1/community/me',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(basic.statusCode).toBe(401);
  });

  it('rejects the session token itself where an access token is required', async () => {
    const user = await signIn(app, uniqueEmail('sesstoken'));
    expect((await me(app, user.sessionToken)).statusCode).toBe(401);
  });

  describe('forged tokens', () => {
    let user: Awaited<ReturnType<typeof signIn>>;
    beforeAll(async () => {
      user = await signIn(app, uniqueEmail('forge'));
    });

    it('rejects a token with a tampered payload (role escalation attempt)', async () => {
      const [h, , s] = user.accessToken.split('.');
      const payload = { ...decodeJwt(user.accessToken), role: 'admin', sub: 'someone-else' };
      const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
      const res = await me(app, forged);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('invalid_token');
    });

    it('rejects a token signed by an attacker key with the right claims', async () => {
      const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
      const claims = decodeJwt(user.accessToken);
      const forged = await new SignJWT({ sid: claims.sid })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(user.userId)
        .setIssuer('wellapath-community')
        .setAudience('wellapath-community-api')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);
      expect((await me(app, forged)).statusCode).toBe(401);
    });

    it('rejects alg=none', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(decodeJwt(user.accessToken))).toString(
        'base64url',
      );
      expect((await me(app, `${header}.${payload}.`)).statusCode).toBe(401);
    });

    it('rejects an HS256 token keyed with the public key (algorithm confusion)', async () => {
      const jwks = (await app.server.inject({ method: 'GET', url: '/v1/auth/jwks' })).json();
      const key = new TextEncoder().encode(JSON.stringify(jwks.keys[0]));
      const forged = await new SignJWT({ sid: decodeJwt(user.accessToken).sid })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.userId)
        .setIssuer('wellapath-community')
        .setAudience('wellapath-community-api')
        .setExpirationTime('10m')
        .sign(key);
      expect((await me(app, forged)).statusCode).toBe(401);
    });
  });

  it('sign-out revokes the session: the unexpired access token is rejected', async () => {
    const user = await signIn(app, uniqueEmail('signout'));
    expect((await me(app, user.accessToken)).statusCode).toBe(200);
    const out = await app.server.inject({
      method: 'POST',
      url: '/v1/auth/sign-out',
      headers: bearer(user.sessionToken),
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    const res = await me(app, user.accessToken);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('session_revoked');
    const refresh = await app.server.inject({
      method: 'GET',
      url: '/v1/auth/token',
      headers: bearer(user.sessionToken),
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('suspension revokes all sessions and blocks signing in again', async () => {
    const moderator = await privilegedUser(app, 'susp-mod', 'moderator');
    const target = await signIn(app, uniqueEmail('suspended'));
    const res = await app.server.inject({
      method: 'POST',
      url: `/v1/community/mod/users/${target.userId}/suspend`,
      headers: bearer(moderator.accessToken),
      payload: { reason: 'repeated harassment' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions_revoked).toBeGreaterThanOrEqual(1);
    expect((await me(app, target.accessToken)).statusCode).toBe(401);
    await expect(signIn(app, target.email)).rejects.toThrow(/sign-in: 403/);
  });
});

describeDb('expired access tokens', () => {
  let app: CommunityTestApp;
  beforeAll(async () => {
    app = await createCommunityApp({ accessTokenTtlSeconds: 1 });
  });
  afterAll(async () => app.close());

  it('rejects an access token after exp with token_expired, and refresh recovers', async () => {
    const user = await signIn(app, uniqueEmail('expiry'));
    expect((await me(app, user.accessToken)).statusCode).toBe(200);
    await new Promise(r => setTimeout(r, 2100));
    const res = await me(app, user.accessToken);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('token_expired');
    const fresh = await mintAccessToken(app, user.sessionToken);
    expect((await me(app, fresh)).statusCode).toBe(200);
  });
});

describeDb('expired sessions', () => {
  let app: CommunityTestApp;
  beforeAll(async () => {
    app = await createCommunityApp({ sessionTtlSeconds: 60 });
  });
  afterAll(async () => app.close());

  it('a token whose session has expired is rejected even before its own exp', async () => {
    const user = await signIn(app, uniqueEmail('sessexp'));
    const { ownerPool } = await import('./helpers');
    const pool = ownerPool();
    await pool.query(
      `UPDATE "session" SET "expiresAt" = now() - interval '1 second' WHERE "userId" = $1`,
      [user.userId],
    );
    await pool.end();
    expect((await me(app, user.accessToken)).statusCode).toBe(401);
  });
});

describeDb('account recovery', () => {
  let app: CommunityTestApp;
  beforeAll(async () => {
    app = await createCommunityApp();
  });
  afterAll(async () => app.close());

  it('lost device: email OTP on a new device recovers the same account, then revokes the old device', async () => {
    const email = uniqueEmail('recover');
    const oldDevice = await signIn(app, email);
    const newDevice = await signIn(app, email);
    expect(newDevice.userId).toBe(oldDevice.userId);

    const revoke = await app.server.inject({
      method: 'POST',
      url: '/v1/auth/revoke-other-sessions',
      headers: bearer(newDevice.sessionToken),
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);
    expect((await me(app, oldDevice.accessToken)).statusCode).toBe(401);
    expect((await me(app, newDevice.accessToken)).statusCode).toBe(200);
  });

  it('lost authenticator: a moderator steps up with a single-use backup code', async () => {
    const moderator = await privilegedUser(app, 'backup-mod', 'moderator');
    // New session (new device) with no step-up yet.
    const session = await signIn(app, moderator.email);
    const queue = () =>
      app.server.inject({
        method: 'GET',
        url: '/v1/community/mod/reports',
        headers: bearer(session.accessToken),
      });
    expect((await queue()).json().error.code).toBe('mfa_step_up_required');

    const code = moderator.backupCodes[0];
    const step = await app.server.inject({
      method: 'POST',
      url: '/v1/community/mfa/step-up',
      headers: bearer(session.accessToken),
      payload: { backup_code: code },
    });
    expect(step.statusCode).toBe(200);
    expect((await queue()).statusCode).toBe(200);

    const again = await signIn(app, moderator.email);
    const reuse = await app.server.inject({
      method: 'POST',
      url: '/v1/community/mfa/step-up',
      headers: bearer(again.accessToken),
      payload: { backup_code: code },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('password reset endpoints are disabled (OTP-only accounts)', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/auth/email-otp/reset-password',
      payload: { email: 'x@example.test', otp: '123456', password: 'whatever123' },
    });
    expect(res.statusCode).toBe(404);
  });
});
