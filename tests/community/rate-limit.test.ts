/**
 * ADR-001 R3.3: sign-in is rate limited by Better Auth's own limiter (3 OTP sends / minute /
 * client IP). Better Auth derives the client IP from proxy headers; without one it cannot key
 * the limit (PoC finding: Render's proxy header must be configured before beta).
 */
import { buildApp } from '../../src/app';
import { MemoryOutbox } from '../../src/community/email';
import { LogCapture } from '../helpers/app';
import { describeDb, testConfig, uniqueEmail } from './helpers';

describeDb('Better Auth rate limiting', () => {
  it('the 4th OTP request in a minute from one client IP is refused with 429', async () => {
    const built = await buildApp({
      logDestination: new LogCapture(),
      registerDatabase: false,
      rateLimitMax: 100000,
      community: { config: testConfig(), email: new MemoryOutbox(), authRateLimitEnabled: true },
    });
    await built.server.ready();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await built.server.inject({
          method: 'POST',
          url: '/v1/auth/email-otp/send-verification-otp',
          headers: { 'x-forwarded-for': '203.0.113.7' },
          payload: { email: uniqueEmail('rl'), type: 'sign-in' },
        });
        statuses.push(res.statusCode);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      const otherIp = await built.server.inject({
        method: 'POST',
        url: '/v1/auth/email-otp/send-verification-otp',
        headers: { 'x-forwarded-for': '203.0.113.8' },
        payload: { email: uniqueEmail('rl'), type: 'sign-in' },
      });
      expect(otherIp.statusCode).toBe(200);
    } finally {
      await built.server.close();
    }
  });
});
