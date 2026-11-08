/**
 * ADR-001 B5: Community DB connections use sslmode=verify-full for every non-local host.
 * Runtime URLs without it refuse startup (value never echoed); owner/migration URLs are forced.
 */
import { loadCommunityConfig } from '../../src/community/config';
import {
  assertVerifyFull,
  forceVerifyFull,
  isLocalDatabaseHost,
  runtimeUrl,
} from '../../src/community/db-url';

const SECRET = 'S3cretPassw0rd-never-echo';
const REMOTE = `postgresql://owner:${SECRET}@db.example.invalid/appdb`;

const ENABLED_ENV = {
  COMMUNITY_MODE: 'internal',
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'a'.repeat(40),
  COMMUNITY_REFRESH_PEPPERS: `1:${'b'.repeat(40)}`,
};

describe('Community DB TLS policy (B5)', () => {
  it.each(['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '', '/tmp', 'x.localhost'])(
    'treats %p as local',
    host => expect(isLocalDatabaseHost(host)).toBe(true),
  );
  it.each(['db.example.invalid', '10.0.0.5', '128.0.0.1', 'localhost.invalid', '::2'])(
    'treats %p as remote',
    host => expect(isLocalDatabaseHost(host)).toBe(false),
  );

  describe('runtime URL (assertVerifyFull)', () => {
    it.each([
      ['missing', REMOTE],
      ['require', `${REMOTE}?sslmode=require`],
      ['prefer', `${REMOTE}?sslmode=prefer`],
      ['verify-ca', `${REMOTE}?sslmode=verify-ca`],
      ['disable', `${REMOTE}?sslmode=disable`],
      ['case variant', `${REMOTE}?sslmode=VERIFY-FULL`],
    ])('refuses a non-local URL with sslmode %s, without echoing it', (_label, url) => {
      let message = '';
      try {
        assertVerifyFull(url, 'COMMUNITY_DATABASE_URL');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/COMMUNITY_DATABASE_URL .*verify-full/);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('example.invalid');
      expect(message).not.toContain('owner');
    });

    it('accepts verify-full on a non-local host, unchanged', () => {
      const url = `${REMOTE}?sslmode=verify-full&channel_binding=require`;
      expect(assertVerifyFull(url, 'X')).toBe(url);
    });

    it('accepts local URLs without TLS (CI / developer Postgres)', () => {
      for (const url of [
        'postgres://u:p@127.0.0.1:5432/db',
        'postgres://u@localhost/db?sslmode=disable',
        'postgres://u@[::1]:5432/db',
        'postgres:///db?host=/var/run/postgresql',
      ]) {
        expect(assertVerifyFull(url, 'X')).toBe(url);
      }
    });

    it('a ?host= override decides locality (cannot smuggle a remote host past the check)', () => {
      expect(() =>
        assertVerifyFull('postgres://u@127.0.0.1/db?host=db.example.invalid', 'X'),
      ).toThrow(/verify-full/);
    });

    it('refuses garbage without echoing it', () => {
      expect(() => assertVerifyFull(`not a url ${SECRET}`, 'X')).toThrow(
        /^X is not a valid postgres/,
      );
      expect(() => assertVerifyFull(`mysql://u:${SECRET}@h/db`, 'X')).toThrow(
        /^X must be a postgres/,
      );
    });

    it('startup refusal: loadCommunityConfig throws for a non-local URL without verify-full', () => {
      let message = '';
      try {
        loadCommunityConfig({
          ...ENABLED_ENV,
          COMMUNITY_DATABASE_URL: `${REMOTE}?sslmode=require`,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/Refusing to start/);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('example.invalid');
    });

    it('startup accepts verify-full (and local URLs)', () => {
      const url = `${REMOTE}?sslmode=verify-full`;
      const cfg = loadCommunityConfig({ ...ENABLED_ENV, COMMUNITY_DATABASE_URL: url });
      expect(cfg.mode !== 'disabled' && cfg.databaseUrl).toBe(url);
      expect(() =>
        loadCommunityConfig({
          ...ENABLED_ENV,
          COMMUNITY_DATABASE_URL: 'postgres://u@127.0.0.1/db',
        }),
      ).not.toThrow();
    });

    it('disabled mode reads no Community variable, so a bad URL is irrelevant', () => {
      expect(loadCommunityConfig({ COMMUNITY_DATABASE_URL: REMOTE })).toEqual({
        mode: 'disabled',
      });
    });
  });

  describe('owner / migration URL (forceVerifyFull)', () => {
    it.each(['', '?sslmode=require', '?sslmode=disable', '?sslmode=prefer&uselibpqcompat=true'])(
      'forces verify-full on a non-local URL (%p), keeping other parameters',
      suffix => {
        const forced = new URL(
          forceVerifyFull(`${REMOTE}${suffix}${suffix ? '&' : '?'}channel_binding=require`, 'X'),
        );
        expect(forced.searchParams.get('sslmode')).toBe('verify-full');
        expect(forced.searchParams.get('channel_binding')).toBe('require');
        expect(forced.searchParams.has('uselibpqcompat')).toBe(false);
        expect(forced.password).toBe(SECRET);
        expect(forced.hostname).toBe('db.example.invalid');
      },
    );
    it('leaves local URLs alone', () => {
      const url = 'postgres://u@127.0.0.1:5432/db?sslmode=disable';
      expect(forceVerifyFull(url, 'X')).toBe(url);
    });
  });

  describe('runtime URL construction (provisioning)', () => {
    it('swaps user and password, keeps host/db/params, sets verify-full', () => {
      const built = new URL(
        runtimeUrl(
          `${REMOTE.replace('db.', 'db-pooler.')}?sslmode=require&channel_binding=require`,
          'community_app',
          'p/w+&x',
        ),
      );
      expect(built.username).toBe('community_app');
      expect(decodeURIComponent(built.password)).toBe('p/w+&x');
      expect(built.hostname).toBe('db-pooler.example.invalid');
      expect(built.pathname).toBe('/appdb');
      expect(built.searchParams.get('sslmode')).toBe('verify-full');
      expect(built.searchParams.get('channel_binding')).toBe('require');
    });
  });
});
