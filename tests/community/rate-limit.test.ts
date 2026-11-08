/**
 * ADR-001 A3 / contract §4: the single WellaPath limiter.
 * - Better Auth's limiter is off; counters live in Postgres and survive a restart.
 * - The client IP comes only from Fastify's trusted-proxy configuration: spoofed
 *   X-Forwarded-For / X-Real-IP / CF-Connecting-IP / True-Client-IP / Forwarded cannot change the
 *   bucket, with TRUST_PROXY_HOPS unset (socket peer, interim GLOBAL ceilings) or set to 1.
 * - The per-email limit uses the normalised email (case, +tag, Gmail dots).
 * - 429 has Retry-After and the contract envelope, identically for unknown emails, and is
 *   audited. Refresh-token-only logout is limited per IP and per token hash (P6). TOTP brute force is stopped (5 failures ⇒ session revoked + 15-minute lockout).
 */
import { randomUUID } from 'crypto';
import { LightMyRequestResponse } from 'fastify';
import { MemoryOutbox } from '../../src/community/email';
import { LIMITS } from '../../src/community/limiter';
import {
  bearer,
  CommunityTestApp,
  createCommunityApp,
  describeDb,
  idem,
  memberWithProfile,
  ownerQuery,
  privilegedUser,
  requestOtp,
  resetDatabase,
  RELAXED_LIMITS,
  signIn,
  stepUp,
  totp,
  uniqueEmail,
  wrongTotp,
} from './helpers';

const SPOOF_HEADERS = (n: number): Record<string, string> => ({
  'x-forwarded-for': `198.51.100.${n}`,
  'x-real-ip': `198.51.100.${n}`,
  'cf-connecting-ip': `198.51.100.${n}`,
  'true-client-ip': `198.51.100.${n}`,
  forwarded: `for=198.51.100.${n}`,
});

const expect429 = (res: {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
}): void => {
  expect(res.statusCode).toBe(429);
  const retry = Number(res.headers['retry-after']);
  expect(retry).toBeGreaterThanOrEqual(1);
  expect(res.json()).toMatchObject({
    error: { code: 'rate_limited', details: { retry_after_seconds: retry } },
  });
};

describeDb('WellaPath rate limiter (A3)', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it('uses the contract numbers, with interim global ceilings while hops are unmeasured', () => {
    expect(LIMITS.otp_request_email_15m).toEqual({ max: 3, windowSeconds: 900 });
    expect(LIMITS.otp_request_email_24h).toEqual({ max: 10, windowSeconds: 86400 });
    expect(LIMITS.otp_request_ip).toEqual({ max: 20, windowSeconds: 3600, interimMax: 600 });
    expect(LIMITS.otp_verify_ip).toEqual({ max: 60, windowSeconds: 3600, interimMax: 1200 });
    expect(LIMITS.refresh_ip).toEqual({ max: 120, windowSeconds: 60, interimMax: 3000 });
    expect(LIMITS.features_ip).toEqual({ max: 60, windowSeconds: 60, interimMax: 6000 });
    expect(LIMITS.logout_ip).toEqual({ max: 60, windowSeconds: 60, interimMax: 3000 });
    expect(LIMITS.logout_token).toEqual({ max: 10, windowSeconds: 60 });
  });

  describe('per-email OTP limit (3 / 15 min)', () => {
    let app: CommunityTestApp;
    beforeAll(async () => {
      app = await createCommunityApp();
    });
    afterAll(async () => app.close());

    it('case, +tag and Gmail dots normalise to one bucket', async () => {
      const local = `bucket${Date.now()}`;
      const variants = [
        `${local}@gmail.com`,
        `${local.toUpperCase()}@GMAIL.COM`,
        `${local}+promo@gmail.com`,
        `${local.slice(0, 3)}.${local.slice(3)}@googlemail.com`,
      ];
      for (const email of variants.slice(0, 3))
        expect((await requestOtp(app, email)).statusCode).toBe(202);
      expect429(await requestOtp(app, variants[3]));
    });

    it('applies identically to unknown emails (no existence oracle) and audits the 429', async () => {
      const unknown = uniqueEmail('never-registered');
      for (let i = 0; i < 3; i += 1) expect((await requestOtp(app, unknown)).statusCode).toBe(202);
      const limited = await requestOtp(app, unknown);
      expect429(limited);
      // The per-email bucket is never exposed in RateLimit-* headers.
      const ok = await requestOtp(app, uniqueEmail('fresh'));
      expect(Number(ok.headers['ratelimit-limit'])).not.toBe(3);
      const events = (await ownerQuery(
        `SELECT detail FROM auth_events WHERE event = 'rate_limited' ORDER BY id DESC LIMIT 1`,
      )) as { detail: { dimension: string; endpoint: string } }[];
      expect(events[0].detail).toEqual({
        dimension: 'otp_request_email_15m',
        endpoint: 'otp_request',
      });
      expect(JSON.stringify(events)).not.toContain(unknown);
    });

    it('limits persist across a server restart (Postgres counters, not memory)', async () => {
      const email = uniqueEmail('restart');
      const outbox = new MemoryOutbox();
      const first = await createCommunityApp({ outbox });
      for (let i = 0; i < 3; i += 1) expect((await requestOtp(first, email)).statusCode).toBe(202);
      await first.close();
      const second = await createCommunityApp({ outbox });
      try {
        expect429(await requestOtp(second, email));
      } finally {
        await second.close();
      }
    });

    it('Better Auth runs with its own limiter disabled (no in-memory per-IP bucket)', async () => {
      // 3 different emails × 3 from one IP: well past Better Auth's old 3/min per-IP rule.
      for (let i = 0; i < 9; i += 1) {
        expect((await requestOtp(app, uniqueEmail(`ba${i}`))).statusCode).toBe(202);
      }
    });
  });

  describe('IP dimension: spoofed headers cannot change the bucket', () => {
    const tightIp = { ...RELAXED_LIMITS, otp_request_ip: { max: 3, interimMax: 3 } };

    it('TRUST_PROXY_HOPS unset: socket peer only (interim global ceiling)', async () => {
      await resetDatabase();
      const app = await createCommunityApp({ config: { limitOverrides: tightIp } });
      try {
        for (let i = 0; i < 3; i += 1) {
          expect((await requestOtp(app, uniqueEmail(`sp${i}`), SPOOF_HEADERS(i))).statusCode).toBe(
            202,
          );
        }
        // A fourth, with yet another spoofed identity, is still the same (global) bucket.
        expect429(await requestOtp(app, uniqueEmail('sp-x'), SPOOF_HEADERS(99)));
      } finally {
        await app.close();
      }
    });

    it('TRUST_PROXY_HOPS=1: only the hop added by the trusted proxy counts', async () => {
      await resetDatabase();
      const app = await createCommunityApp({
        trustProxyHops: 1,
        config: { limitOverrides: tightIp },
      });
      try {
        // The rightmost X-Forwarded-For entry is the one the (single) trusted proxy appended.
        const from = (real: string, spoof: string): Record<string, string> => ({
          ...SPOOF_HEADERS(7),
          'x-forwarded-for': `${spoof}, ${real}`,
        });
        for (let i = 0; i < 3; i += 1) {
          const res = await requestOtp(
            app,
            uniqueEmail(`hop${i}`),
            from('203.0.113.10', `10.0.0.${i}`),
          );
          expect(res.statusCode).toBe(202);
        }
        expect429(await requestOtp(app, uniqueEmail('hop-x'), from('203.0.113.10', '192.0.2.1')));
        // A genuinely different client (different trusted hop) has its own bucket.
        expect(
          (await requestOtp(app, uniqueEmail('hop-y'), from('203.0.113.20', '10.0.0.1')))
            .statusCode,
        ).toBe(202);
      } finally {
        await app.close();
      }
    });
  });

  describe('refresh-token-only logout (P6): per trusted-proxy IP and per token hash', () => {
    const logout = (
      app: CommunityTestApp,
      refreshToken: string,
      headers: Record<string, string> = {},
    ): Promise<LightMyRequestResponse> =>
      app.server.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refresh_token: refreshToken },
        headers,
      });

    it('per token hash: the 4th logout of one token is 429 whatever its state; others are unaffected', async () => {
      await resetDatabase();
      const app = await createCommunityApp({
        config: { limitOverrides: { ...RELAXED_LIMITS, logout_token: { max: 3 } } },
      });
      try {
        const known = (await signIn(app, uniqueEmail('lo-tok'))).refreshToken;
        const unknown = `wprt_${'U'.repeat(43)}`;
        for (const token of [known, unknown]) {
          for (let i = 0; i < 3; i += 1) {
            const ok = await logout(app, token, SPOOF_HEADERS(i));
            expect(ok.statusCode).toBe(204);
            // The per-token bucket is hidden: RateLimit-* shows the (relaxed) IP bucket only.
            expect(ok.headers['ratelimit-limit']).toBe('100000');
          }
          // Same 429 for a real (now revoked) token and an unknown one: no oracle.
          expect429(await logout(app, token, SPOOF_HEADERS(9)));
        }
        expect((await logout(app, `wprt_${'V'.repeat(43)}`)).statusCode).toBe(204);
        const audited = (await ownerQuery(
          `SELECT detail FROM auth_events WHERE event = 'rate_limited'`,
        )) as { detail: Record<string, string> }[];
        expect(audited.map(a => a.detail)).toEqual(
          expect.arrayContaining([{ dimension: 'logout_token', endpoint: 'logout' }]),
        );
      } finally {
        await app.close();
      }
    });

    it('per IP (interim global): spoofed client headers cannot escape the bucket', async () => {
      await resetDatabase();
      const app = await createCommunityApp({
        config: { limitOverrides: { ...RELAXED_LIMITS, logout_ip: { max: 3, interimMax: 3 } } },
      });
      try {
        for (let i = 0; i < 3; i += 1) {
          const res = await logout(app, `wprt_${String(i).repeat(43)}`, SPOOF_HEADERS(i));
          expect(res.statusCode).toBe(204);
          expect(res.headers['ratelimit-limit']).toBe('3');
        }
        expect429(await logout(app, `wprt_${'9'.repeat(43)}`, SPOOF_HEADERS(99)));
        // A bearer logout is limited per account instead, so it still works.
        const user = await signIn(app, uniqueEmail('lo-ip'));
        const res = await app.server.inject({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: bearer(user.accessToken),
        });
        expect(res.statusCode).toBe(204);
        // A bearer whose family is already gone proves no account: it is back on the IP bucket.
        const again = await app.server.inject({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: bearer(user.accessToken),
        });
        expect429(again);
      } finally {
        await app.close();
      }
    });
  });

  describe('per-account content limits', () => {
    it('create post: 5 / hour per account, 429 with Retry-After', async () => {
      await resetDatabase();
      const app = await createCommunityApp({
        config: { limitOverrides: { ...RELAXED_LIMITS, create_post_hour: { max: 5 } } },
      });
      try {
        const user = await memberWithProfile(app, 'poster');
        const post = (): Promise<LightMyRequestResponse> =>
          app.server.inject({
            method: 'POST',
            url: '/v1/community/spaces/general_health/posts',
            headers: { ...bearer(user.accessToken), ...idem() },
            payload: { body: 'hello', display_mode: 'pseudonymous' },
          });
        for (let i = 0; i < 5; i += 1) expect((await post()).statusCode).toBe(201);
        expect429(await post());
      } finally {
        await app.close();
      }
    });
  });

  describe('TOTP brute force is stopped', () => {
    it('5 consecutive failures ⇒ this session revoked + 15-minute lockout (429) for every session', async () => {
      await resetDatabase();
      const app = await createCommunityApp();
      try {
        const mod = await privilegedUser(app, 'brute', 'moderator');
        const wrong = wrongTotp(mod.totpSecret);
        for (let i = 0; i < 4; i += 1) {
          const res = await stepUp(app, mod, { code: wrong });
          expect(res.statusCode).toBe(400);
          expect(res.json().error.code).toBe('invalid_code');
        }
        const fifth = await stepUp(app, mod, { code: wrong });
        expect(fifth.statusCode).toBe(401);
        expect(fifth.json().error.details.reason).toBe('session_revoked');
        const gone = await app.server.inject({
          method: 'GET',
          url: '/v1/community/me',
          headers: bearer(mod.accessToken),
        });
        expect(gone.statusCode).toBe(401);

        // A fresh session cannot continue guessing — even the correct code is refused.
        const again = { ...mod, ...(await signIn(app, mod.email)) };
        const locked = await stepUp(app, again, { code: totp(mod.totpSecret) });
        expect429(locked);
        expect(Number(locked.headers['retry-after'])).toBeGreaterThan(14 * 60);
        const events = (await ownerQuery(
          `SELECT event FROM auth_events WHERE account_id = $1 AND event IN ('step_up_failed', 'totp_lockout')`,
          [mod.userId],
        )) as { event: string }[];
        expect(events.filter(e => e.event === 'step_up_failed')).toHaveLength(5);
        expect(events.filter(e => e.event === 'totp_lockout')).toHaveLength(1);

        // After the lockout passes, the correct code works again.
        await ownerQuery(
          `UPDATE totp_lockouts SET locked_until = now() - interval '1 second' WHERE user_id = $1`,
          [mod.userId],
        );
        expect((await stepUp(app, again, { code: totp(mod.totpSecret) })).statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('also caps TOTP attempts at 20 / hour per account', async () => {
      await resetDatabase();
      const app = await createCommunityApp({
        config: { limitOverrides: { ...RELAXED_LIMITS, totp_attempts_account: { max: 20 } } },
      });
      try {
        const mod = await privilegedUser(app, 'hourly', 'moderator');
        // enrol confirm consumed 1 attempt
        for (let i = 0; i < 19; i += 1) expect((await stepUp(app, mod)).statusCode).toBe(200);
        expect429(await stepUp(app, mod));
        expect(randomUUID()).toBeDefined();
      } finally {
        await app.close();
      }
    });
  });
});
