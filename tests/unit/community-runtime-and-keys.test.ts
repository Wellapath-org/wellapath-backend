/**
 * No-database checks for ADR-001 amendments A1 and A3:
 * - A1: engines, .nvmrc, CI setup-node and the Dockerfile agree on Node 22, and the suite is
 *   actually running on Node ≥ 22.
 * - A3: TRUST_PROXY_HOPS is an explicit integer (never `true`); email normalisation for the
 *   per-email limit (case, NFKC, +tag, Gmail dots, googlemail.com).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { normaliseEmail } from '../../src/community/crypto';
import { parseTrustProxyHops } from '../../src/config/trust-proxy';

const root = join(__dirname, '../..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

describe('A1: Node 22 LTS everywhere', () => {
  it('package.json engines is ">=22"', () => {
    expect(JSON.parse(read('package.json')).engines).toEqual({ node: '>=22' });
  });

  it('.nvmrc pins 22', () => {
    expect(read('.nvmrc').trim()).toBe('22');
  });

  it('the Dockerfile builds and runs on node:22-alpine only', () => {
    const froms = [...read('Dockerfile').matchAll(/^FROM\s+(\S+)/gm)].map(m => m[1]);
    expect(froms.length).toBeGreaterThan(0);
    for (const image of froms) expect(image).toBe('node:22-alpine');
  });

  it('every CI setup-node step reads .nvmrc (no other Node version is pinned)', () => {
    const ci = read('.github/workflows/ci.yml');
    const setups = ci.split('actions/setup-node@').length - 1;
    expect(setups).toBeGreaterThan(0);
    expect((ci.match(/node-version-file: '\.nvmrc'/g) ?? []).length).toBe(setups);
    expect(ci).not.toMatch(/node-version:\s*'?\d/);
  });

  it('the test runtime itself is Node >= 22', () => {
    expect(Number.parseInt(process.versions.node.split('.')[0], 10)).toBeGreaterThanOrEqual(22);
  });
});

describe('A3: TRUST_PROXY_HOPS', () => {
  it('unset or empty ⇒ no proxy trusted (socket peer)', () => {
    expect(parseTrustProxyHops(undefined)).toBeUndefined();
    expect(parseTrustProxyHops('')).toBeUndefined();
  });

  it('accepts an explicit integer hop count', () => {
    expect(parseTrustProxyHops('1')).toBe(1);
    expect(parseTrustProxyHops(' 2 ')).toBe(2);
  });

  it.each(['true', 'TRUE', 'yes', '*', '0', '-1', '1.5', '11', 'loopback', '10.0.0.0/8'])(
    'refuses %p (trustProxy: true is never used)',
    value => {
      expect(() => parseTrustProxyHops(value)).toThrow(/TRUST_PROXY_HOPS/);
    },
  );
});

describe('A3: per-email key normalisation', () => {
  it.each([
    ['Alice@Example.com', 'alice@example.com'],
    ['  alice@example.com  ', 'alice@example.com'],
    ['alice+promo@example.com', 'alice@example.com'],
    ['alice+a+b@example.ng', 'alice@example.ng'],
    ['a.l.i.c.e@gmail.com', 'alice@gmail.com'],
    ['A.Lice+x@GoogleMail.com', 'alice@gmail.com'],
    ['a.lice@example.com', 'a.lice@example.com'], // dots only matter for Gmail
    ['ａlice@example.com', 'alice@example.com'], // NFKC (full-width a)
  ])('%s → %s', (input, expected) => {
    expect(normaliseEmail(input)).toBe(expected);
  });
});
