/**
 * SEC-001 / SEC-002: the security client IP (src/config/client-ip.ts).
 *
 * The app-wide limiter's `x-ratelimit-remaining` is the oracle: a fresh bucket answers
 * `max - 1`, and a bucket already used answers less. Every test asks which bucket a request lands
 * in, i.e. which address the security controls actually keyed on.
 */
import { buildApp } from '../../src/app';
import { canonicalIp, parseClientIpSource } from '../../src/config/client-ip';
import { TestApp, createTestApp } from '../helpers/app';

const MAX = 1000;
const remaining = (res: { headers: Record<string, unknown> }): number =>
  Number(res.headers['x-ratelimit-remaining']);

const SPOOFS = (n: number): Record<string, string> => ({
  'x-forwarded-for': `198.51.100.${n}, 198.51.100.${n + 1}`,
  forwarded: `for=198.51.100.${n}`,
  'x-real-ip': `198.51.100.${n}`,
  'true-client-ip': `198.51.100.${n}`,
});

describe('canonicalIp: exactly one valid address, canonicalised', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['0.0.0.0', '0.0.0.0'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::1', '::1'],
  ])('accepts %s → %s', (raw, want) => {
    expect(canonicalIp(raw)).toBe(want);
  });

  it.each([
    ['empty', ''],
    ['comma list', '203.0.113.7, 198.51.100.1'],
    ['comma, no space', '203.0.113.7,198.51.100.1'],
    ['leading space', ' 203.0.113.7'],
    ['trailing newline', '203.0.113.7\n'],
    ['with port', '203.0.113.7:443'],
    ['bracketed v6', '[2001:db8::1]'],
    ['v6 zone id', 'fe80::1%eth0'],
    ['CIDR', '203.0.113.0/24'],
    ['three octets', '203.0.113'],
    ['hex octet', '0x7f.0.0.1'],
    ['leading-zero octet', '017.0.0.1'],
    ['out of range', '256.1.1.1'],
    ['integer form', '4294967295'],
    ['hostname', 'example.com'],
    ['Forwarded syntax', 'for=203.0.113.7'],
    ['bad v6', '2001:db8:::1'],
    ['overlong', '1'.repeat(46)],
  ])('rejects %s', (_label, raw) => {
    expect(canonicalIp(raw)).toBeNull();
  });

  it('rejects non-strings: missing and duplicated (array) headers', () => {
    expect(canonicalIp(undefined)).toBeNull();
    expect(canonicalIp(['203.0.113.7', '198.51.100.1'])).toBeNull();
    expect(canonicalIp(42)).toBeNull();
  });
});

describe('parseClientIpSource', () => {
  it('defaults to socket and accepts only the two sources', () => {
    expect(parseClientIpSource(undefined)).toBe('socket');
    expect(parseClientIpSource('')).toBe('socket');
    expect(parseClientIpSource('socket')).toBe('socket');
    expect(parseClientIpSource(' cf-connecting-ip ')).toBe('cf-connecting-ip');
    for (const bad of ['x-forwarded-for', 'true', 'CF-Connecting-IP', 'true-client-ip']) {
      expect(() => parseClientIpSource(bad)).toThrow(/CLIENT_IP_SOURCE/);
    }
  });

  it('refuses to boot with CLIENT_IP_SOURCE=cf-connecting-ip and TRUST_PROXY_HOPS together', async () => {
    await expect(
      buildApp({
        registerDatabase: false,
        telemetryEnabled: false,
        clientIpSource: 'cf-connecting-ip',
        trustProxyHops: 1,
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('refuses to boot on an invalid CLIENT_IP_SOURCE', async () => {
    const saved = process.env.CLIENT_IP_SOURCE;
    process.env.CLIENT_IP_SOURCE = 'x-forwarded-for';
    try {
      await expect(buildApp({ registerDatabase: false, telemetryEnabled: false })).rejects.toThrow(
        /CLIENT_IP_SOURCE/,
      );
    } finally {
      if (saved === undefined) delete process.env.CLIENT_IP_SOURCE;
      else process.env.CLIENT_IP_SOURCE = saved;
    }
  });
});

describe('app-wide limiter keys on the security client IP', () => {
  let app: TestApp;
  const get = (headers: Record<string, string | string[]>, url = '/health') =>
    app.server.inject({ method: 'GET', url, remoteAddress: '10.1.2.3', headers });

  describe('CLIENT_IP_SOURCE=cf-connecting-ip (Render)', () => {
    beforeEach(async () => {
      app = await createTestApp({ clientIpSource: 'cf-connecting-ip', rateLimitMax: MAX });
    });
    afterEach(async () => app.close());

    it('one client keeps one bucket; another client gets its own', async () => {
      expect(remaining(await get({ 'cf-connecting-ip': '203.0.113.10' }))).toBe(MAX - 1);
      expect(remaining(await get({ 'cf-connecting-ip': '203.0.113.10' }))).toBe(MAX - 2);
      expect(remaining(await get({ 'cf-connecting-ip': '203.0.113.20' }))).toBe(MAX - 1);
      // Canonical form: the same IPv6 written differently is the same bucket.
      expect(remaining(await get({ 'cf-connecting-ip': '2001:DB8::0:1' }))).toBe(MAX - 1);
      expect(remaining(await get({ 'cf-connecting-ip': '2001:db8::1' }))).toBe(MAX - 2);
      expect(remaining(await get({ 'cf-connecting-ip': '::ffff:203.0.113.20' }))).toBe(MAX - 2);
    });

    it('forged X-Forwarded-For / Forwarded / X-Real-IP / True-Client-IP cannot choose a bucket', async () => {
      const real = { 'cf-connecting-ip': '203.0.113.30' };
      expect(remaining(await get(real))).toBe(MAX - 1);
      for (let i = 0; i < 5; i += 1) {
        expect(remaining(await get({ ...real, ...SPOOFS(i * 2) }))).toBe(MAX - 2 - i);
      }
      // ...and spoofing without the edge header lands in the unattributed bucket, not the spoofed one.
      expect(remaining(await get(SPOOFS(100)))).toBe(MAX - 1);
      expect(remaining(await get(SPOOFS(102)))).toBe(MAX - 2);
    });

    it('missing, comma-separated, duplicated or malformed edge headers fall back to one unattributed bucket', async () => {
      const victim = { 'cf-connecting-ip': '203.0.113.40' };
      expect(remaining(await get(victim))).toBe(MAX - 1);
      const fallbacks: Record<string, string | string[]>[] = [
        {},
        { 'cf-connecting-ip': '203.0.113.40, 198.51.100.9' }, // never parsed as its first entry
        { 'cf-connecting-ip': ['203.0.113.40', '198.51.100.9'] },
        { 'cf-connecting-ip': '203.0.113.40:80' },
        { 'cf-connecting-ip': 'for=203.0.113.40' },
        { 'cf-connecting-ip': '' },
      ];
      for (const [i, headers] of fallbacks.entries()) {
        expect(remaining(await get(headers))).toBe(MAX - 1 - i);
      }
      // None of them touched the victim's bucket.
      expect(remaining(await get(victim))).toBe(MAX - 2);
    });

    it('route-level limits (telemetry) inherit the same key', async () => {
      await app.close();
      app = await createTestApp({
        clientIpSource: 'cf-connecting-ip',
        rateLimitMax: MAX,
        telemetryRateLimitMax: 50,
      });
      const post = (headers: Record<string, string>) =>
        app.server.inject({
          method: 'POST',
          url: '/v1/telemetry/events',
          remoteAddress: '10.1.2.3',
          headers: { 'content-type': 'application/json', ...headers },
          payload: '{}',
        });
      const a = { 'cf-connecting-ip': '203.0.113.50' };
      expect(remaining(await post(a))).toBe(49);
      expect(remaining(await post({ ...a, ...SPOOFS(1) }))).toBe(48);
      expect(remaining(await post({ 'cf-connecting-ip': '203.0.113.51' }))).toBe(49);
    });
  });

  describe('CLIENT_IP_SOURCE unset (socket: local, tests, today)', () => {
    beforeEach(async () => {
      app = await createTestApp({ rateLimitMax: MAX });
    });
    afterEach(async () => app.close());

    it('ignores CF-Connecting-IP and every forwarding header: the socket peer only', async () => {
      expect(remaining(await get({}))).toBe(MAX - 1);
      expect(remaining(await get({ 'cf-connecting-ip': '203.0.113.60' }))).toBe(MAX - 2);
      expect(remaining(await get({ 'cf-connecting-ip': '203.0.113.61', ...SPOOFS(3) }))).toBe(
        MAX - 3,
      );
    });
  });
});
