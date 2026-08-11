/**
 * Regression suite for everything that existed before the telemetry work.
 *
 * The frozen artifact values are asserted literally rather than read from the route, so this
 * fails if `/config` changes at all — the E9.1 freeze says the four beta artifacts must not
 * move, and telemetry work has no business touching them.
 */
import { RecordingSink, TestApp, createTestApp } from '../helpers/app';

/** The E9.1 frozen beta artifact set, verified live on staging 2026-07-27. */
const FROZEN_ARTIFACTS = {
  token_dictionary: {
    version: '1.1',
    file: 'token_dictionary.ng.v1.1.json',
    hash: 'sha256:0cc47ad9537c0bd4c6ef3aec8f1931eb9b4c62103a8809d16544f94a90b5c019',
    release_date: '2026-04-05',
  },
  knowledge_base: {
    version: '2.4',
    file: 'kb.ng.v2.4.json',
    hash: 'sha256:6c00d8257f8417e86bd5e237630bf8a4623ad72e2e46b1b071dd447c067cec2b',
    release_date: '2026-07-27',
  },
  rules: {
    version: '2.2',
    file: 'rules.ng.v2.2.json',
    hash: 'sha256:1d27e854cba95b179577a88f92445400f494a7fe8e6a53a60fcaa98b3870d1c4',
    release_date: '2026-07-26',
  },
  facilities: {
    version: '1.1',
    file: 'facilities.ng.v1.1.json',
    hash: 'sha256:25684c714367abf2f3c305c8a5597b5f7eb0d11baaf658c5b9e2f8f5e2982398',
    release_date: '2026-07-26',
  },
};

describe('GET /config — mobile bootstrap contract is unchanged', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ telemetrySink: new RecordingSink() });
  });

  afterAll(async () => app.close());

  it('returns 200 with the same top-level shape', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/config' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['artifacts', 'country', 'version']);
    expect(body.version).toBe('1.0');
    expect(body.country).toBe('ng');
  });

  it('returns exactly the four frozen artifacts', async () => {
    const body = (await app.server.inject({ method: 'GET', url: '/config' })).json();
    expect(Object.keys(body.artifacts).sort()).toEqual(Object.keys(FROZEN_ARTIFACTS).sort());
  });

  it.each(Object.entries(FROZEN_ARTIFACTS))(
    'serves %s at its frozen version, hash and release date',
    async (name, expected) => {
      const body = (await app.server.inject({ method: 'GET', url: '/config' })).json();
      const artifact = body.artifacts[name];

      expect(artifact.version).toBe(expected.version);
      expect(artifact.hash).toBe(expected.hash);
      expect(artifact.release_date).toBe(expected.release_date);
      expect(artifact.country).toBe('ng');
      expect(artifact.url).toBe(
        `https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev/${expected.file}`,
      );
    },
  );

  it('builds every artifact URL from the configured base URL', async () => {
    const body = (await app.server.inject({ method: 'GET', url: '/config' })).json();
    for (const artifact of Object.values(body.artifacts) as { url: string }[]) {
      expect(artifact.url.startsWith(process.env.ARTIFACT_BASE_URL as string)).toBe(true);
    }
  });

  it('carries no telemetry-related field', async () => {
    const raw = (await app.server.inject({ method: 'GET', url: '/config' })).body;
    expect(raw).not.toContain('telemetry');
    expect(raw).not.toContain('contract_version');
  });
});

describe('GET /version — unchanged', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ telemetrySink: new RecordingSink() });
  });

  afterAll(async () => app.close());

  it('returns the version and environment only', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/version' });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(['environment', 'version']);
    expect(response.json().version).toBe('0.1.0');
  });
});

describe('GET /health — unchanged', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ registerDatabase: true, telemetrySink: new RecordingSink() });
  });

  afterAll(async () => app.close());

  it('keeps its response shape and its database check', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/health' });

    // The test database is unroutable, so a degraded answer is the expected one here. What
    // matters for regression is the contract: same keys, same semantics, same status mapping.
    expect([200, 503]).toContain(response.statusCode);

    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['checks', 'status', 'timestamp']);
    expect(['ok', 'degraded']).toContain(body.status);
    expect(['ok', 'error']).toContain(body.checks.database);
    expect(body.status === 'ok' ? 200 : 503).toBe(response.statusCode);
  });

  it('reports no telemetry state', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/health' });
    expect(response.body).not.toContain('telemetry');
  });
});

describe('security behaviour — unchanged', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ telemetrySink: new RecordingSink() });
  });

  afterAll(async () => app.close());

  it('returns the standard envelope for an unknown route', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/not-a-route' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { statusCode: 404, message: 'Route not found' },
    });
  });

  it('still refuses methods outside the CORS allowlist', async () => {
    const response = await app.server.inject({
      method: 'OPTIONS',
      url: '/config',
      headers: {
        origin: 'https://wellapath.org',
        'access-control-request-method': 'DELETE',
      },
    });

    expect(response.headers['access-control-allow-methods']).not.toContain('DELETE');
    expect(response.headers['access-control-allow-methods']).not.toContain('PUT');
  });

  it('exposes rate limit headers', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/config' });
    expect(response.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('rate-limits with the documented envelope rather than a 500', async () => {
    const limited = await createTestApp({
      rateLimitMax: 1,
      telemetrySink: new RecordingSink(),
    });

    await limited.server.inject({ method: 'GET', url: '/config' });
    const response = await limited.server.inject({ method: 'GET', url: '/config' });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.statusCode).toBe(429);
    expect(response.json().error.message).toContain('Rate limit exceeded');

    await limited.close();
  });

  it('accepts no write method on the pre-existing endpoints', async () => {
    for (const url of ['/config', '/version', '/health']) {
      const response = await app.server.inject({ method: 'POST', url, payload: { a: 1 } });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe('artifact distribution — no clinical artifact schema touched', () => {
  it('leaves the committed E1 skeleton artifacts untouched', () => {
    // These are unused leftovers per docs/DEPLOYMENT.md §5, but a telemetry change must not
    // rewrite them either.
    const kb = require('../../src/artifacts/kb.ng.v1.0.json');
    const rules = require('../../src/artifacts/rules.ng.v1.0.json');
    const facilities = require('../../src/artifacts/facilities.ng.v1.0.json');

    for (const artifact of [kb, rules, facilities]) {
      expect(artifact).toHaveProperty('version');
      expect(artifact).not.toHaveProperty('telemetry');
    }
  });
});
