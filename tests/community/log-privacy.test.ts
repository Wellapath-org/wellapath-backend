/**
 * No full email address in normal application logs, on the OTP request/verify flows including
 * every error path, and the Resend sender wired through the real facade (mocked fetch ONLY:
 * the real Resend API is never called).
 *
 * Every test captures the real Pino output of the real app (`LogCapture`) and asserts that no
 * address used in it appears, in any letter case, anywhere in the captured text.
 */
import { EmailSender, OtpMessage, ResendSender } from '../../src/community/email';
import {
  CommunityTestApp,
  createCommunityApp,
  describeDb,
  requestOtp,
  resetDatabase,
  uniqueEmail,
  verifyOtp,
} from './helpers';

const FAKE_KEY = `re_${'Q'.repeat(10)}notreal${'z'.repeat(10)}`;
const FROM = 'WellaPath <no-reply@example.org>';

const expectNoAddress = (app: CommunityTestApp, addresses: string[]): void => {
  const text = app.logs.text().toLowerCase();
  expect(text.length).toBeGreaterThan(0);
  for (const address of addresses) {
    const lower = address.toLowerCase();
    expect([address, text.includes(lower)]).toEqual([address, false]);
    // Not even the full local part next to the @.
    expect([address, text.includes(`${lower.split('@')[0]}@`)]).toEqual([address, false]);
  }
  expect(text).not.toContain(FAKE_KEY.toLowerCase());
};

const mockFetch = (status: number): jest.Mock =>
  jest.fn(async () => new Response('{"id":"x"}', { status }));

describeDb('log privacy on the OTP flows (no full email address in logs)', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it('request + wrong code + right code + malformed + unknown + case variants', async () => {
    const app = await createCommunityApp();
    try {
      const email = uniqueEmail('Log.Privacy');
      const mixed = email.toUpperCase();
      const unknown = uniqueEmail('never-signed-up');
      expect((await requestOtp(app, email)).statusCode).toBe(202);
      expect((await requestOtp(app, mixed)).statusCode).toBe(202);
      expect((await requestOtp(app, unknown)).statusCode).toBe(202);
      const wrong = await verifyOtp(app, email, '000000');
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error.code).toBe('invalid_code');
      const ok = await verifyOtp(app, email, app.outbox.latestOtp(email, 'sign-in'));
      expect(ok.statusCode).toBe(200);
      const malformed = `bad..${email}`;
      expect((await requestOtp(app, malformed)).statusCode).toBe(400);
      const bad = await app.server.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        payload: { email, code: 'abc', device_id: 'not-a-uuid' },
      });
      expect(bad.statusCode).toBe(400);
      // Unknown field next to the email (validation error path).
      const extra = await app.server.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { email, note: email },
      });
      expect(extra.statusCode).toBe(400);
      expectNoAddress(app, [email, mixed, unknown, malformed]);
    } finally {
      await app.close();
    }
  });

  it('rate-limited path (per-email limit: 429, audited) logs no address', async () => {
    const app = await createCommunityApp({ config: { limitOverrides: undefined } });
    try {
      const email = uniqueEmail('limited');
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) codes.push((await requestOtp(app, email)).statusCode);
      expect(codes).toContain(429);
      for (let i = 0; i < 25; i += 1) await verifyOtp(app, email, '000000');
      expectNoAddress(app, [email]);
    } finally {
      await app.close();
    }
  });

  it('email provider down (Resend 500): 503 email_unavailable, one attempt, no address or key in logs', async () => {
    const fetchImpl = mockFetch(500);
    const email = new ResendSender({ apiKey: FAKE_KEY, from: FROM, timeoutMs: 2000, fetchImpl });
    const real = await createCommunityApp({ email });
    try {
      const address = uniqueEmail('resend-down');
      const res = await requestOtp(real, address);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({
        code: 'community_unavailable',
        details: { reason: 'email_unavailable' },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry
      expect(real.logs.text()).toContain('community_email_unavailable');
      expectNoAddress(real, [address]);
    } finally {
      await real.close();
    }
  });

  it('a sender that throws an error containing the address: 503, the address is not logged', async () => {
    const leaky: EmailSender = {
      name: 'leaky-test-sender',
      async sendOtp(message: OtpMessage): Promise<void> {
        throw new Error(`mailbox ${message.to} rejected the message`);
      },
    };
    const app = await createCommunityApp({ email: leaky });
    try {
      const address = uniqueEmail('leaky');
      expect((await requestOtp(app, address)).statusCode).toBe(503);
      // Even a direct log call with the address is masked by the logger itself.
      app.server.log.error({ email: address, note: `for ${address}` }, `failed for ${address}`);
      expect(app.logs.text()).toContain(`${address[0]}***@example.test`);
      expectNoAddress(app, [address]);
    } finally {
      await app.close();
    }
  });

  it('Resend success path: 202, exactly one POST with the recipient, nothing logged about it', async () => {
    const fetchImpl = mockFetch(200);
    const app = await createCommunityApp({
      email: new ResendSender({ apiKey: FAKE_KEY, from: FROM, timeoutMs: 2000, fetchImpl }),
    });
    try {
      const address = uniqueEmail('resend-ok');
      expect((await requestOtp(app, address)).statusCode).toBe(202);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.to).toEqual([address.toLowerCase()]);
      expect(body.text).toMatch(/\b\d{6}\b/);
      expectNoAddress(app, [address]);
    } finally {
      await app.close();
    }
  });
});
