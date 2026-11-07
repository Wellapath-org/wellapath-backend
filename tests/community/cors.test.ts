/**
 * C8 (founder-approved and scoped 2026-11-08, contract §1): CORS PUT/DELETE exists only for the
 * configured website origin, only on `/v1/community/*` and `/v1/auth/*`, never with credentials.
 * `/config` and every other route keep the app-wide GET/POST/OPTIONS policy. No wildcard origin.
 */
import { LightMyRequestResponse } from 'fastify';
import { parseWebsiteOrigin } from '../../src/config/cors';
import {
  CommunityTestApp,
  bearer,
  createCommunityApp,
  describeDb,
  resetDatabase,
  signIn,
  uniqueEmail,
} from './helpers';

const WEBSITE = 'https://admin.wellapath.test';
const OTHER = 'https://evil.example';

describe('COMMUNITY_WEBSITE_ORIGIN parsing (no wildcard, one exact origin)', () => {
  it('accepts one exact https origin; unset means no grant', () => {
    expect(parseWebsiteOrigin('https://wellapath.org', 'production')).toBe('https://wellapath.org');
    expect(parseWebsiteOrigin('https://wellapath.org/', 'production')).toBe(
      'https://wellapath.org',
    );
    expect(parseWebsiteOrigin('https://admin.wellapath.org:8443', 'production')).toBe(
      'https://admin.wellapath.org:8443',
    );
    expect(parseWebsiteOrigin(undefined, 'production')).toBeUndefined();
    expect(parseWebsiteOrigin('', 'production')).toBeUndefined();
    expect(parseWebsiteOrigin('http://localhost:3001', 'development')).toBe(
      'http://localhost:3001',
    );
  });

  it.each([
    '*',
    'https://*.wellapath.org',
    'https://a.org,https://b.org',
    'https://wellapath.org/admin',
    'https://wellapath.org?x=1',
    'https://user:pw@wellapath.org',
    'http://wellapath.org',
    'wellapath.org',
    'null',
  ])('refuses %s', value => {
    expect(() => parseWebsiteOrigin(value, 'production')).toThrow(/COMMUNITY_WEBSITE_ORIGIN/);
  });

  it('refuses plain-http localhost in production', () => {
    expect(() => parseWebsiteOrigin('http://localhost:3001', 'production')).toThrow();
  });
});

describeDb('CORS scoping (C8)', () => {
  let app: CommunityTestApp;
  beforeAll(async () => {
    await resetDatabase();
    app = await createCommunityApp({ websiteOrigin: WEBSITE });
  });
  afterAll(async () => app.close());

  const preflight = (
    url: string,
    origin: string,
    method: string,
    headers = 'authorization, content-type, idempotency-key',
  ): Promise<LightMyRequestResponse> =>
    app.server.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': headers,
      },
    });

  const methodsOf = (res: LightMyRequestResponse): string[] =>
    String(res.headers['access-control-allow-methods'] ?? '')
      .split(',')
      .map(m => m.trim())
      .filter(Boolean);

  describe('website origin on a community or auth route', () => {
    it.each([
      ['PUT', '/v1/community/me/profile'],
      ['DELETE', '/v1/community/posts/00000000-0000-4000-8000-000000000001'],
      ['DELETE', '/v1/community/me/professional-claim'],
      ['POST', '/v1/community/mod/accounts/abc/restrict'],
      ['POST', '/v1/auth/refresh'],
    ])('preflight %s %s is allowed, without credentials', async (method, url) => {
      const res = await preflight(url, WEBSITE, method);
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(WEBSITE);
      expect(methodsOf(res)).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
      expect(res.headers['access-control-allow-headers']).toBe(
        'Authorization, Content-Type, Idempotency-Key, X-Request-Id',
      );
      expect(res.headers['access-control-max-age']).toBe('600');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(String(res.headers.vary)).toMatch(/Origin/i);
    });

    it('an actual PUT and DELETE carry the grant (and the contract response is unchanged)', async () => {
      const user = await signIn(app, uniqueEmail('cors'));
      app.config.allowlist.add(user.userId);
      const put = await app.server.inject({
        method: 'PUT',
        url: '/v1/community/me/profile',
        headers: { origin: WEBSITE, ...bearer(user.accessToken) },
        payload: { display_name: `Cors${Date.now() % 100000}` },
      });
      expect(put.statusCode).toBe(200);
      expect(put.headers['access-control-allow-origin']).toBe(WEBSITE);
      expect(put.headers['access-control-expose-headers']).toBe('Retry-After, X-Request-Id');
      expect(put.headers['access-control-allow-credentials']).toBeUndefined();
      expect(put.headers['cache-control']).toBe('no-store');
      const del = await app.server.inject({
        method: 'DELETE',
        url: '/v1/community/me/professional-claim',
        headers: { origin: WEBSITE, ...bearer(user.accessToken) },
      });
      expect(del.statusCode).toBe(422); // no claim; CORS headers still present
      expect(del.headers['access-control-allow-origin']).toBe(WEBSITE);
    });
  });

  describe('any other origin on a community or auth route', () => {
    it.each([
      ['PUT', '/v1/community/me/profile'],
      ['DELETE', '/v1/community/posts/00000000-0000-4000-8000-000000000001'],
      ['POST', '/v1/auth/refresh'],
      ['GET', '/v1/community/me'],
    ])('preflight %s %s is refused, with no CORS headers', async (method, url) => {
      for (const origin of [OTHER, 'https://wellapath.org', 'null']) {
        const res = await preflight(url, origin, method);
        expect(res.statusCode).not.toBe(204);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect(res.headers['access-control-allow-methods']).toBeUndefined();
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      }
    });

    it('an actual PUT from another origin gets no grant (the browser blocks the read)', async () => {
      const user = await signIn(app, uniqueEmail('cors-other'));
      const res = await app.server.inject({
        method: 'PUT',
        url: '/v1/community/me/profile',
        headers: { origin: OTHER, ...bearer(user.accessToken) },
        payload: { display_name: `Other${Date.now() % 100000}` },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });

  describe('/config and every other route stay GET/POST only', () => {
    it.each(['PUT', 'DELETE'])(
      'preflight %s /config from the website origin gets no PUT/DELETE',
      async method => {
        const res = await preflight('/config', WEBSITE, method);
        expect(methodsOf(res)).not.toContain('PUT');
        expect(methodsOf(res)).not.toContain('DELETE');
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      },
    );

    it.each(['/config', '/v1/features', '/health', '/v1/telemetry/events'])(
      'preflight DELETE %s from another origin gets no PUT/DELETE',
      async url => {
        const res = await preflight(url, OTHER, 'DELETE');
        expect(methodsOf(res)).not.toContain('PUT');
        expect(methodsOf(res)).not.toContain('DELETE');
      },
    );

    it('a path that only looks like a community path is not granted (prefix match on the path)', async () => {
      for (const url of ['/v1/communityx/me', '/v1/authx/refresh', '/config?x=/v1/community/']) {
        const res = await preflight(url, WEBSITE, 'PUT');
        expect(methodsOf(res)).not.toContain('PUT');
      }
    });
  });
});

describeDb('CORS with no website origin configured', () => {
  let app: CommunityTestApp;
  beforeAll(async () => {
    app = await createCommunityApp();
  });
  afterAll(async () => app.close());

  it('grants nothing on community or auth routes, to any origin', async () => {
    for (const origin of [WEBSITE, OTHER]) {
      const res = await app.server.inject({
        method: 'OPTIONS',
        url: '/v1/community/me/profile',
        headers: { origin, 'access-control-request-method': 'PUT' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-methods']).toBeUndefined();
    }
  });
});
