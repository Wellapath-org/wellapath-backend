/**
 * Community PoC — hard constraints that hold with no Community database at all.
 *
 * - COMMUNITY_MODE unset/disabled: no /v1/auth or /v1/community route exists, Better Auth is
 *   not loaded, and GET /config is byte-identical to the app built without the Community option.
 * - Enabled mode with the Community DB DOWN: /config, /health, /version still 200 and /config is
 *   still byte-identical; /v1/features fails closed with 200; Community routes answer 503/401.
 * - Configuration refuses typos and refuses enabled Community under NODE_ENV=production.
 * - Isolation: Community code imports nothing from assessment/artifact/manifest/telemetry code.
 */
import { readdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { buildApp } from '../../src/app';
import { loadCommunityConfig, parseCommunityMode } from '../../src/community/config';
import { findProhibitedKey } from '../../src/community/http';
import { createTestApp, LogCapture, TestApp } from '../helpers/app';
import { createCommunityApp, CommunityTestApp } from './helpers';

const COMMUNITY_PATHS = [
  ['POST', '/v1/auth/otp/request'],
  ['POST', '/v1/auth/otp/verify'],
  ['POST', '/v1/auth/refresh'],
  ['POST', '/v1/auth/logout'],
  ['GET', '/v1/auth/sessions'],
  ['POST', '/v1/auth/totp/verify'],
  ['GET', '/v1/auth/get-session'],
  ['POST', '/v1/auth/sign-in/email-otp'],
  ['GET', '/v1/community/me'],
  ['GET', '/v1/community/me/export'],
  ['POST', '/v1/community/me/delete'],
  ['GET', '/v1/community/spaces'],
  ['GET', '/v1/community/mod/reports'],
  ['POST', '/v1/community/admin/accounts/x/role'],
] as const;

const ENABLED_ENV = {
  COMMUNITY_MODE: 'internal',
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  COMMUNITY_REFRESH_PEPPERS: `1:${'p'.repeat(40)}`,
  COMMUNITY_DATABASE_URL: 'postgres://x@127.0.0.1/x',
};

describe('Community disabled (default)', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => app.close());

  it('COMMUNITY_MODE unset parses as disabled', () => {
    expect(parseCommunityMode(undefined)).toBe('disabled');
    expect(parseCommunityMode('')).toBe('disabled');
    expect(loadCommunityConfig({})).toEqual({ mode: 'disabled' });
  });

  it.each(COMMUNITY_PATHS)('%s %s is not registered (404)', async (method, url) => {
    const res = await app.server.inject({
      method,
      url,
      payload: method === 'POST' ? {} : undefined,
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/features answers disabled without any Community configuration', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/v1/features' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ community: 'disabled', community_allowed: false });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('/v1/features is constant even with a bearer token (no auth library, no DB)', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/v1/features',
      headers: { authorization: 'Bearer x.y.z', 'x-request-id': 'client-req-0001' },
    });
    expect(res.json()).toEqual({ community: 'disabled', community_allowed: false });
    expect(res.headers['x-request-id']).toBe('client-req-0001');
  });
});

describe('Community configuration', () => {
  it('rejects an unknown COMMUNITY_MODE instead of guessing', () => {
    expect(() => parseCommunityMode('enabled')).toThrow(/COMMUNITY_MODE/);
    expect(() => parseCommunityMode('true')).toThrow(/COMMUNITY_MODE/);
  });

  it('requires its own COMMUNITY_DATABASE_URL, auth secret and refresh pepper (never DB_*)', () => {
    expect(() => loadCommunityConfig({ COMMUNITY_MODE: 'internal' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      loadCommunityConfig({ COMMUNITY_MODE: 'internal', BETTER_AUTH_SECRET: 'x'.repeat(40) }),
    ).toThrow(/COMMUNITY_REFRESH_PEPPERS/);
    expect(() =>
      loadCommunityConfig({ ...ENABLED_ENV, COMMUNITY_DATABASE_URL: undefined }),
    ).toThrow(/COMMUNITY_DATABASE_URL/);
    expect(() => loadCommunityConfig({ ...ENABLED_ENV, BETTER_AUTH_SECRET: 'short' })).toThrow(
      /at least 32/,
    );
  });

  it('supports versioned BETTER_AUTH_SECRETS and refresh peppers, newest first', () => {
    const config = loadCommunityConfig({
      ...ENABLED_ENV,
      BETTER_AUTH_SECRET: undefined,
      BETTER_AUTH_SECRETS: `1:${'a'.repeat(40)},2:${'b'.repeat(40)}`,
      COMMUNITY_REFRESH_PEPPERS: `3:${'c'.repeat(40)},4:${'d'.repeat(40)}`,
    });
    if (config.mode === 'disabled') throw new Error('expected enabled');
    expect(config.authSecrets.map(s => s.version)).toEqual([2, 1]);
    expect(config.refreshPeppers.map(s => s.version)).toEqual([4, 3]);
    expect(() =>
      loadCommunityConfig({ ...ENABLED_ENV, COMMUNITY_REFRESH_PEPPERS: `1:${'x'.repeat(40)}` }),
    ).toThrow(/distinct/);
    expect(() =>
      loadCommunityConfig({ ...ENABLED_ENV, COMMUNITY_REFRESH_PEPPERS: 'nope' }),
    ).toThrow(/COMMUNITY_REFRESH_PEPPERS/);
  });

  it('bounds the access-token lifetime to 60–900 s (contract §3.2, P5)', () => {
    for (const bad of ['901', '59', '1']) {
      expect(() =>
        loadCommunityConfig({ ...ENABLED_ENV, COMMUNITY_ACCESS_TOKEN_TTL_SECONDS: bad }),
      ).toThrow(/COMMUNITY_ACCESS_TOKEN_TTL_SECONDS/);
    }
    for (const ok of ['60', '900']) {
      const config = loadCommunityConfig({
        ...ENABLED_ENV,
        COMMUNITY_ACCESS_TOKEN_TTL_SECONDS: ok,
      });
      expect(config.mode !== 'disabled' && config.accessTokenTtlSeconds).toBe(Number(ok));
    }
  });

  it('refuses to boot enabled Community under NODE_ENV=production without the resend provider', () => {
    expect(() => loadCommunityConfig({ ...ENABLED_ENV, NODE_ENV: 'production' })).toThrow(
      /Refusing to boot/,
    );
  });

  it('parses the allowlist of account ids', () => {
    const config = loadCommunityConfig({
      ...ENABLED_ENV,
      COMMUNITY_MODE: 'closed_beta',
      COMMUNITY_ALLOWLIST: ' a1, b2 ,,',
    });
    expect(config.mode).toBe('closed_beta');
    expect(config.mode !== 'disabled' && [...config.allowlist]).toEqual(['a1', 'b2']);
  });
});

describe('Community enabled with the Community database DOWN', () => {
  let baseline: TestApp;
  let app: CommunityTestApp;

  beforeAll(async () => {
    baseline = await createTestApp();
    // Port 1 on loopback: connection refused, immediately.
    app = await createCommunityApp({
      config: { databaseUrl: 'postgres://nobody@127.0.0.1:1/none' },
    });
  });
  afterAll(async () => {
    await baseline.close();
    await app.close();
  });

  it('GET /config is 200 and byte-identical to the Community-free app', async () => {
    const expected = await baseline.server.inject({ method: 'GET', url: '/config' });
    const actual = await app.server.inject({ method: 'GET', url: '/config' });
    expect(actual.statusCode).toBe(200);
    expect(actual.body).toBe(expected.body);
    expect(actual.headers['content-type']).toBe(expected.headers['content-type']);
  });

  it('/health and /version do not depend on the Community database', async () => {
    const health = await app.server.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().checks).toEqual({ database: 'disabled' });
    const version = await app.server.inject({ method: 'GET', url: '/version' });
    expect(version.statusCode).toBe(200);
  });

  it('/v1/features answers 200 and reports disabled (contract §6: DB down ⇒ disabled)', async () => {
    for (const headers of [{}, { authorization: 'Bearer some.jwt.token' }]) {
      const res = await app.server.inject({ method: 'GET', url: '/v1/features', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ community: 'disabled', community_allowed: false });
    }
  });

  it('auth and Community routes answer 503 community_unavailable, never leaking details', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email: 'x@example.test' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('community_unavailable');
    expect(res.body).not.toContain('127.0.0.1');
    expect(res.body).not.toContain('ECONNREFUSED');
    const refresh = await app.server.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {
        refresh_token: `wprt_${'a'.repeat(43)}`,
        device_id: '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(refresh.statusCode).toBe(503);
    const me = await app.server.inject({
      method: 'GET',
      url: '/v1/community/me',
      headers: { authorization: 'Bearer a.b.c' },
    });
    expect([401, 503]).toContain(me.statusCode);
    expect(me.json().error).toEqual(
      expect.objectContaining({ code: expect.any(String), request_id: expect.any(String) }),
    );
  });

  it('/config stays 200 after Community errors have occurred', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(200);
  });
});

describe('Community isolation from the assessment / artifact code', () => {
  const dir = join(__dirname, '../../src/community');
  const files = readdirSync(dir, { recursive: true })
    .map(String)
    .filter(f => f.endsWith('.ts'));

  it.each(files)('%s imports only Community-local modules or packages', file => {
    const source = readFileSync(join(dir, file), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    for (const spec of imports) {
      if (!spec.startsWith('.')) continue;
      // Every relative import must resolve inside src/community.
      const resolved = resolve(dirname(join(dir, file)), spec);
      expect(resolved.startsWith(dir)).toBe(true);
    }
    expect(source).not.toMatch(/(manifest|artifacts|telemetry|config\/env)'/);
  });

  // Contract §5 reference list. No migration column, route schema or response key may carry it.
  const PROHIBITED_REFERENCE = [
    'symptoms',
    'symptom_ids',
    'answers',
    'assessment',
    'assessment_id',
    'assessment_result',
    'assessment_history',
    'triage',
    'triage_result',
    'triage_level',
    'urgency',
    'urgency_level',
    'red_flags',
    'red_flag',
    'diagnosis',
    'differential',
    'condition_ids',
    'care_recommendation',
    'engine_version',
    'artifact_version',
  ];

  it('no Community schema or route has a prohibited (assessment-data) field', () => {
    const sources = files
      .filter(f => !f.endsWith('http.ts')) // http.ts holds the rejection regex itself
      .map(f => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    const migrations = readdirSync(join(dir, 'migrations'))
      .map(f => readFileSync(join(dir, 'migrations', f), 'utf8'))
      .join('\n')
      .toLowerCase();
    for (const term of [...PROHIBITED_REFERENCE, 'symptom', 'diagnos', 'red_flag']) {
      expect(migrations).not.toMatch(new RegExp(`\\b${term}\\b`));
      // Property/column names only: comments may say what is excluded.
      expect(sources).not.toMatch(new RegExp(`['"]?\\b${term}['"]?\\s*:`, 'i'));
    }
  });

  it('the prohibited-key matcher covers the whole reference list (and not ordinary keys)', () => {
    for (const key of PROHIBITED_REFERENCE) {
      expect(findProhibitedKey({ [key]: 1 })).toBe(key);
      expect(findProhibitedKey({ nested: [{ [key.toUpperCase()]: 1 }] })).toBe(
        `nested[0].${key.toUpperCase()}`,
      );
    }
    for (const key of ['body', 'display_mode', 'reason', 'note', 'target_id', 'email', 'code']) {
      expect(findProhibitedKey({ [key]: 'x' })).toBeUndefined();
    }
  });

  it('the app built with no Community option still serves the same /config', async () => {
    const built = await buildApp({ registerDatabase: false, logDestination: new LogCapture() });
    await built.server.ready();
    const res = await built.server.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(200);
    await built.server.close();
  });
});
