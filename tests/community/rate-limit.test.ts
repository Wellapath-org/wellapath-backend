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
import { Hasher } from '../../src/community/crypto';

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

  describe('SEC-001/SEC-002: CLIENT_IP_SOURCE=cf-connecting-ip (Render edge header)', () => {
    const tightIp = { ...RELAXED_LIMITS, otp_request_ip: { max: 3, interimMax: 3 } };
    const edge = (ip: string, n: number): Record<string, string> => ({
      ...SPOOF_HEADERS(n),
      'cf-connecting-ip': ip,
    });

    it('per-client limits use the edge IP only; spoofed headers cannot escape or move a bucket', async () => {
      await resetDatabase();
      const app = await createCommunityApp({
        clientIpSource: 'cf-connecting-ip',
        config: { limitOverrides: tightIp },
      });
      try {
        // The per-IP rule (max 3) applies, not an interim global ceiling.
        for (let i = 0; i < 3; i += 1) {
          expect(
            (await requestOtp(app, uniqueEmail(`cf${i}`), edge('203.0.113.70', i))).statusCode,
          ).toBe(202);
        }
        // Different spoofed XFF / Forwarded / X-Real-IP / True-Client-IP: still the same client.
        expect429(await requestOtp(app, uniqueEmail('cf-x'), edge('203.0.113.70', 99)));
        // The same client written as IPv4-mapped IPv6 is the same bucket.
        expect429(await requestOtp(app, uniqueEmail('cf-m'), edge('::ffff:203.0.113.70', 5)));
        // A genuinely different client (different edge IP) has its own bucket.
        expect(
          (await requestOtp(app, uniqueEmail('cf-y'), edge('203.0.113.71', 1))).statusCode,
        ).toBe(202);
        // A request without the edge header (Render-internal) falls back to the unattributed bucket,
        // even when it forges every other header with the victim's address.
        const { 'cf-connecting-ip': _dropped, ...noEdge } = SPOOF_HEADERS(70);
        noEdge['x-forwarded-for'] = '203.0.113.70';
        noEdge['x-real-ip'] = '203.0.113.70';
        expect((await requestOtp(app, uniqueEmail('cf-z'), noEdge)).statusCode).toBe(202);
      } finally {
        await app.close();
      }
    });

    it('the limiter bucket and the audit ip_hash come from the same canonical security IP', async () => {
      await resetDatabase();
      const app = await createCommunityApp({
        clientIpSource: 'cf-connecting-ip',
        config: { limitOverrides: tightIp },
      });
      try {
        // SEC-026: the identity of an IPv6 client is its /64; limits and audit both use it.
        const ip = '2001:db8::/64';
        for (let i = 0; i < 3; i += 1) {
          await requestOtp(app, uniqueEmail(`ah${i}`), edge(`2001:DB8:0::7${i}`, i));
        }
        expect429(await requestOtp(app, uniqueEmail('ah-x'), edge('2001:db8:0:0:1::70', 9)));
        const hasher = new Hasher(app.config.refreshPeppers);
        const buckets = (await ownerQuery(
          `SELECT bucket FROM rate_limit_counters WHERE bucket = $1`,
          [`otp_request_ip:${hasher.lookup('otp_request_ip', ip)}`],
        )) as unknown[];
        expect(buckets.length).toBe(1);
        const audited = (await ownerQuery(
          `SELECT ip_hash FROM auth_events WHERE event = 'rate_limited' ORDER BY id DESC LIMIT 1`,
        )) as { ip_hash: string }[];
        expect(audited[0].ip_hash).toBe(hasher.lookup('ip', ip));
        // No bucket or audit row was keyed on any spoofed header value.
        const spoofHash = hasher.lookup('ip', '198.51.100.9');
        expect(
          (await ownerQuery(`SELECT 1 FROM auth_events WHERE ip_hash = $1`, [
            spoofHash,
          ])) as unknown[],
        ).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });

  describe('SEC-026/SEC-027: identity and conservative limits for unattributed traffic', () => {
    // Distinct per-IP (max 2) and interim/global (interimMax 5) ceilings, so the tests can tell
    // which one applied.
    const split = { ...RELAXED_LIMITS, otp_request_ip: { max: 2, interimMax: 5 } };
    const cf = (ip: string): Record<string, string> => ({ 'cf-connecting-ip': ip });
    const run = async (
      app: CommunityTestApp,
      tag: string,
      headers: (i: number) => Record<string, string>,
      n: number,
    ): Promise<number[]> => {
      const codes: number[] = [];
      for (let i = 0; i < n; i += 1) {
        codes.push((await requestOtp(app, uniqueEmail(`${tag}${i}`), headers(i))).statusCode);
      }
      return codes;
    };

    it('attributed clients get the per-IP ceiling; socket mode keeps the interim ceiling', async () => {
      await resetDatabase();
      const edgeApp = await createCommunityApp({
        clientIpSource: 'cf-connecting-ip',
        config: { limitOverrides: split },
      });
      try {
        expect(await run(edgeApp, 'pa', () => cf('203.0.113.80'), 3)).toEqual([202, 202, 429]);
      } finally {
        await edgeApp.close();
      }
      await resetDatabase();
      const socketApp = await createCommunityApp({ config: { limitOverrides: split } });
      try {
        expect(await run(socketApp, 'ps', () => ({}), 6)).toEqual([202, 202, 202, 202, 202, 429]);
      } finally {
        await socketApp.close();
      }
    });

    it('SEC-026: rotating IPv6 addresses inside one /64 hits the per-IP ceiling', async () => {
      await resetDatabase();
      const app = await createCommunityApp({
        clientIpSource: 'cf-connecting-ip',
        config: { limitOverrides: split },
      });
      try {
        expect(await run(app, 'r64', i => cf(`2001:db8:cc:dd::${i + 1}`), 3)).toEqual([
          202, 202, 429,
        ]);
        // The neighbouring /64 is another client.
        expect(await run(app, 'n64', () => cf('2001:db8:cc:de::1'), 1)).toEqual([202]);
      } finally {
        await app.close();
      }
    });

    it('SEC-027: missing, empty and malformed edge headers share one bucket at the interim ceiling', async () => {
      await resetDatabase();
      const app = await createCommunityApp({
        clientIpSource: 'cf-connecting-ip',
        config: { limitOverrides: split },
      });
      try {
        const bad: Record<string, string>[] = [
          {},
          { 'cf-connecting-ip': '' },
          { 'cf-connecting-ip': '203.0.113.81, 198.51.100.2' },
          { 'cf-connecting-ip': 'unattributed:203.0.113.81' },
          { 'cf-connecting-ip': '203.0.113.81:443' },
          { 'cf-connecting-ip': 'x' },
        ];
        // One shared, conservative bucket: five pass (interimMax), the sixth is limited; a client
        // cannot pick or reset it by varying the malformed value.
        expect(await run(app, 'un', i => bad[i], 6)).toEqual([202, 202, 202, 202, 202, 429]);
        // An attributed client is unaffected, and keeps its own per-IP ceiling.
        expect(await run(app, 'ok', () => cf('203.0.113.81'), 3)).toEqual([202, 202, 429]);
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
