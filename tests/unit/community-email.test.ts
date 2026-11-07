/**
 * Resend OTP sender (mocked fetch ONLY: the real API is never called), the email-provider
 * configuration rules, and the log-safety helpers (no full email address in logs).
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadCommunityConfig } from '../../src/community/config';
import {
  EmailUnavailableError,
  FileOutbox,
  MemoryOutbox,
  OtpMessage,
  otpEmailContent,
  RESEND_ENDPOINT,
  ResendSender,
} from '../../src/community/email';
import {
  maskEmail,
  scrubbingStream,
  scrubEmails,
  scrubLogValue,
} from '../../src/community/log-safety';

/** Obviously fake, but shaped like a Resend key so validation passes. */
const FAKE_KEY = `re_${'T'.repeat(8)}fake${'k'.repeat(12)}`;
const FROM = 'WellaPath <no-reply@example.org>';
const MESSAGE: OtpMessage = {
  to: 'jane.doe@example.test',
  otp: '123456',
  purpose: 'sign-in',
  sentAt: new Date().toISOString(),
};

type FetchArgs = [string, RequestInit];
const okFetch = (status = 200): jest.Mock =>
  jest.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status }));

describe('ResendSender (mocked fetch)', () => {
  it('POSTs one JSON email to the Resend API with the key, sender, recipient and both bodies', async () => {
    const fetchImpl = okFetch();
    const sender = new ResendSender({ apiKey: FAKE_KEY, from: FROM, timeoutMs: 5000, fetchImpl });
    await sender.sendOtp(MESSAGE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as FetchArgs;
    expect(url).toBe(RESEND_ENDPOINT);
    expect(RESEND_ENDPOINT).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      from: FROM,
      to: ['jane.doe@example.test'],
      subject: 'Your WellaPath sign-in code',
      text: expect.stringContaining('123456'),
      html: expect.stringContaining('123456'),
    });
  });

  it.each([400, 401, 403, 422, 429, 500, 503])(
    'HTTP %i ⇒ EmailUnavailableError(rejected), exactly one attempt (no retry)',
    async status => {
      const fetchImpl = okFetch(status);
      const sender = new ResendSender({ apiKey: FAKE_KEY, from: FROM, timeoutMs: 5000, fetchImpl });
      const error = await sender.sendOtp(MESSAGE).catch(e => e);
      expect(error).toBeInstanceOf(EmailUnavailableError);
      expect(error).toMatchObject({ reason: 'rejected', status });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // The error never carries the key, the recipient or the code.
      expect(String(error.message)).not.toMatch(/re_|jane|example\.test|123456/);
    },
  );

  it('network failure ⇒ EmailUnavailableError(network), one attempt', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError(`fetch failed for jane.doe@example.test with ${FAKE_KEY}`);
    });
    const sender = new ResendSender({ apiKey: FAKE_KEY, from: FROM, timeoutMs: 5000, fetchImpl });
    const error = await sender.sendOtp(MESSAGE).catch(e => e);
    expect(error).toMatchObject({ reason: 'network' });
    expect(String(error.message)).not.toContain('jane');
    expect(String(error.message)).not.toContain(FAKE_KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out (AbortSignal) ⇒ EmailUnavailableError(timeout), one attempt', async () => {
    const fetchImpl = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const sender = new ResendSender({
      apiKey: FAKE_KEY,
      from: FROM,
      timeoutMs: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const started = Date.now();
    const error = await sender.sendOtp(MESSAGE).catch(e => e);
    expect(error).toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('the OTP email has plain text and HTML, the expiry, and no clinical content', () => {
    const { subject, text, html } = otpEmailContent('654321');
    expect(subject).toBe('Your WellaPath sign-in code');
    expect(text).toContain('654321');
    expect(text).toContain('5 minutes');
    expect(html).toContain('654321');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    for (const word of [/symptom/i, /diagnos/i, /triage/i, /assessment/i, /health/i, /medic/i]) {
      expect(text).not.toMatch(word);
      expect(html).not.toMatch(word);
    }
    expect(html).not.toMatch(/<img|https?:\/\//); // no tracking pixel, no links
  });
});

describe('test sinks purge (sign-in retention)', () => {
  it('MemoryOutbox drops messages older than the cutoff', async () => {
    const box = new MemoryOutbox();
    await box.sendOtp({ ...MESSAGE, sentAt: new Date(Date.now() - 25 * 3600e3).toISOString() });
    await box.sendOtp(MESSAGE);
    expect(await box.purge(new Date(Date.now() - 23 * 3600e3))).toBe(1);
    expect(box.messages).toHaveLength(1);
  });

  it('FileOutbox rewrites the file without old lines, mode 600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
    try {
      const box = new FileOutbox(dir);
      await box.sendOtp({ ...MESSAGE, sentAt: new Date(Date.now() - 30 * 3600e3).toISOString() });
      await box.sendOtp(MESSAGE);
      expect(await box.purge(new Date(Date.now() - 23 * 3600e3))).toBe(1);
      expect(await box.purge(new Date(Date.now() - 23 * 3600e3))).toBe(0);
      const file = join(dir, 'outbox.jsonl');
      expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('email provider configuration', () => {
  const BASE = {
    COMMUNITY_MODE: 'internal',
    COMMUNITY_DATABASE_URL: 'postgres://community_app@127.0.0.1:5432/x',
    BETTER_AUTH_SECRETS: `1:${'a'.repeat(40)}`,
    COMMUNITY_REFRESH_PEPPERS: `1:${'b'.repeat(40)}`,
  };
  const RESEND = {
    COMMUNITY_EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: FAKE_KEY,
    COMMUNITY_EMAIL_FROM: FROM,
  };
  const load = (env: Record<string, string>): ReturnType<typeof loadCommunityConfig> =>
    loadCommunityConfig({ ...BASE, ...env });

  it('NODE_ENV=production accepts resend', () => {
    const config = load({ ...RESEND, NODE_ENV: 'production' });
    expect(config.mode !== 'disabled' && config.emailSink).toBe('resend');
    expect(config.mode !== 'disabled' && config.resend).toEqual({
      apiKey: FAKE_KEY,
      from: FROM,
      timeoutMs: 5000,
    });
  });

  it.each([
    ['memory', { COMMUNITY_EMAIL_PROVIDER: 'memory' }],
    ['outbox-file', { COMMUNITY_EMAIL_PROVIDER: 'outbox-file' }],
    ['legacy sink name', { COMMUNITY_EMAIL_SINK: 'memory' }],
    ['no provider at all', {}],
  ])('NODE_ENV=production refuses %s', (_label, env) => {
    expect(() => load({ ...env, NODE_ENV: 'production' })).toThrow(/Refusing to boot/);
  });

  it('development defaults to the outbox file sink; the legacy COMMUNITY_EMAIL_SINK still works', () => {
    expect((load({}) as { emailSink: string }).emailSink).toBe('outbox-file');
    expect((load({ COMMUNITY_EMAIL_SINK: 'memory' }) as { emailSink: string }).emailSink).toBe(
      'memory',
    );
    expect(() =>
      load({ COMMUNITY_EMAIL_SINK: 'memory', COMMUNITY_EMAIL_PROVIDER: 'resend' }),
    ).toThrow(/disagree/);
    expect(() => load({ COMMUNITY_EMAIL_PROVIDER: 'sendgrid' })).toThrow(
      /COMMUNITY_EMAIL_PROVIDER/,
    );
  });

  it('validates the Resend settings at boot without echoing them', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ ...RESEND, RESEND_API_KEY: '' }, /RESEND_API_KEY/],
      [
        { ...RESEND, RESEND_API_KEY: 'sk_live_not_a_resend_key_value' },
        /RESEND_API_KEY is malformed/,
      ],
      [{ ...RESEND, RESEND_API_KEY: `${FAKE_KEY} ` }, /RESEND_API_KEY is malformed/],
      [{ ...RESEND, COMMUNITY_EMAIL_FROM: '' }, /COMMUNITY_EMAIL_FROM/],
      [{ ...RESEND, COMMUNITY_EMAIL_FROM: 'not an address' }, /COMMUNITY_EMAIL_FROM is malformed/],
      [{ ...RESEND, COMMUNITY_EMAIL_FROM: 'WellaPath <a@b.org' }, /COMMUNITY_EMAIL_FROM/],
      [{ ...RESEND, COMMUNITY_EMAIL_TIMEOUT_MS: '60000' }, /COMMUNITY_EMAIL_TIMEOUT_MS/],
    ];
    for (const [env, pattern] of cases) {
      let message = '';
      try {
        load(env);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(pattern);
      expect(message).not.toContain(FAKE_KEY);
      expect(message).not.toContain('sk_live');
      expect(message).not.toContain('no-reply@example.org');
    }
    expect(
      (
        load({ ...RESEND, COMMUNITY_EMAIL_FROM: 'no-reply@example.org' }) as {
          resend: { from: string };
        }
      ).resend.from,
    ).toBe('no-reply@example.org');
  });

  it('sign-in retention purge interval: default 15 min, bounded to 60–3600 s', () => {
    expect((load({}) as { authPurgeIntervalSeconds: number }).authPurgeIntervalSeconds).toBe(900);
    expect(() => load({ COMMUNITY_AUTH_PURGE_INTERVAL_SECONDS: '0' })).toThrow(/60, 3600/);
    expect(() => load({ COMMUNITY_AUTH_PURGE_INTERVAL_SECONDS: '7200' })).toThrow(/60, 3600/);
  });
});

describe('log safety: no full email address in logs', () => {
  it('maskEmail keeps the first character and the domain only', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j***@example.com');
    expect(maskEmail('x@y.org')).toBe('x***@y.org');
    expect(maskEmail('nope')).toBe('***');
  });

  it('scrubEmails masks every address in free text; JSON stays valid', () => {
    const line = JSON.stringify({
      msg: 'send to Jane.Doe+tag@Example.co.uk failed, cc a@b.io',
      nested: { list: ['x.y@z.example'] },
    });
    const out = scrubEmails(line);
    expect(out).not.toMatch(/Jane\.Doe\+tag@|a@b\.io|x\.y@z/);
    expect(out).toContain('J***@Example.co.uk');
    expect(() => JSON.parse(out)).not.toThrow();
    expect(scrubEmails('no address here')).toBe('no address here');
  });

  it('scrubLogValue walks plain objects and errors, leaves class instances to serializers', () => {
    const when = new Date();
    const err = Object.assign(new Error('mailbox jane@example.test is full'), { code: 'E1' });
    const out = scrubLogValue({
      a: 'jane@example.test',
      b: [{ c: 'k@example.test' }],
      err,
      when,
    }) as {
      a: string;
      b: { c: string }[];
      err: { message: string; code: string; stack: string };
      when: Date;
    };
    expect(out.a).toBe('j***@example.test');
    expect(out.b[0].c).toBe('k***@example.test');
    expect(out.err.message).toBe('mailbox j***@example.test is full');
    expect(out.err.code).toBe('E1');
    expect(out.err.stack).not.toContain('jane@');
    expect(out.when).toBe(when);
  });

  it('scrubbingStream masks the serialized line before it reaches the destination', () => {
    const written: string[] = [];
    const stream = scrubbingStream({ write: (s: string) => written.push(s) });
    stream.write('{"msg":"hello jane@example.test"}\n');
    expect(written).toEqual(['{"msg":"hello j***@example.test"}\n']);
  });
});
