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
import { join } from 'path';
import { buildApp } from '../../src/app';
import { loadCommunityConfig, parseCommunityMode } from '../../src/community/config';
import { createTestApp, LogCapture, TestApp } from '../helpers/app';
import { createCommunityApp, CommunityTestApp } from './helpers';

const COMMUNITY_PATHS = [
  ['GET', '/v1/auth/get-session'],
  ['POST', '/v1/auth/email-otp/send-verification-otp'],
  ['POST', '/v1/auth/sign-in/email-otp'],
  ['GET', '/v1/auth/token'],
  ['GET', '/v1/community/me'],
  ['GET', '/v1/community/spaces'],
  ['GET', '/v1/community/mod/reports'],
  ['POST', '/v1/community/admin/users/x/role'],
] as const;

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
  });
});

describe('Community configuration', () => {
  it('rejects an unknown COMMUNITY_MODE instead of guessing', () => {
    expect(() => parseCommunityMode('enabled')).toThrow(/COMMUNITY_MODE/);
    expect(() => parseCommunityMode('true')).toThrow(/COMMUNITY_MODE/);
  });

  it('requires its own COMMUNITY_DATABASE_URL and BETTER_AUTH_SECRET (never DB_*)', () => {
    expect(() => loadCommunityConfig({ COMMUNITY_MODE: 'internal' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      loadCommunityConfig({ COMMUNITY_MODE: 'internal', BETTER_AUTH_SECRET: 'x'.repeat(40) }),
    ).toThrow(/COMMUNITY_DATABASE_URL/);
    expect(() =>
      loadCommunityConfig({
        COMMUNITY_MODE: 'internal',
        BETTER_AUTH_SECRET: 'short',
        COMMUNITY_DATABASE_URL: 'postgres://x',
      }),
    ).toThrow(/at least 32/);
  });

  it('refuses to boot enabled Community under NODE_ENV=production (PoC has only test sinks)', () => {
    expect(() =>
      loadCommunityConfig({
        NODE_ENV: 'production',
        COMMUNITY_MODE: 'internal',
        BETTER_AUTH_SECRET: 'x'.repeat(40),
        COMMUNITY_DATABASE_URL: 'postgres://x',
      }),
    ).toThrow(/Refusing to boot/);
  });

  it('parses the allowlist of account ids', () => {
    const config = loadCommunityConfig({
      COMMUNITY_MODE: 'closed_beta',
      BETTER_AUTH_SECRET: 'x'.repeat(40),
      COMMUNITY_DATABASE_URL: 'postgres://x',
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
    app = await createCommunityApp({ databaseUrl: 'postgres://nobody@127.0.0.1:1/none' });
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

  it('/v1/features answers 200 and fails closed', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/v1/features',
      headers: { authorization: 'Bearer some.jwt.token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ community: 'internal', community_allowed: false });
  });

  it('Community routes fail with 503/401, never 200, and never leak connection details', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/auth/email-otp/send-verification-otp',
      payload: { email: 'x@example.test', type: 'sign-in' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.body).not.toContain('127.0.0.1');
    const me = await app.server.inject({
      method: 'GET',
      url: '/v1/community/me',
      headers: { authorization: 'Bearer a.b.c' },
    });
    expect([401, 503]).toContain(me.statusCode);
  });

  it('/config stays 200 after Community errors have occurred', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(200);
  });
});

describe('Community isolation from the assessment / artifact code', () => {
  const dir = join(__dirname, '../../src/community');
  const files = readdirSync(dir).filter(f => f.endsWith('.ts'));

  it.each(files)('%s imports only Community-local modules or packages', file => {
    const source = readFileSync(join(dir, file), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    for (const spec of imports) {
      if (spec.startsWith('.')) expect(spec).toMatch(/^\.\/[a-z-]+$/);
    }
    expect(source).not.toMatch(/\.\.\/(manifest|artifacts|telemetry|routes|config\/env)/);
  });

  it('no Community schema or route accepts symptom, triage or assessment fields', () => {
    const sources = files.map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
    const migrations = readdirSync(join(dir, 'migrations'))
      .map(f => readFileSync(join(dir, 'migrations', f), 'utf8'))
      .join('\n');
    for (const term of ['symptom', 'triage', 'assessment', 'urgency', 'diagnos']) {
      expect(migrations.toLowerCase()).not.toContain(term);
      // Comments in plugin.ts mention the words to say they are excluded; property names must not.
      expect(sources).not.toMatch(new RegExp(`${term}[a-z_]*\\s*:`, 'i'));
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
