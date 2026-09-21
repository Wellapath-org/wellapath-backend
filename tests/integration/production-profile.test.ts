/**
 * Production profile — database-independent, security-hardened.
 *
 * These tests build the real application with `NODE_ENV=production` and
 * `DATABASE_ENABLED=false`, and with every DB_* variable blanked, so they prove the
 * production launch configuration end to end: the app boots with no database configuration at
 * all, no pool is created, `/health` answers truthfully, `/config` stays byte-identical to
 * the frozen baseline, the metrics endpoint is unreachable, CORS excludes the superseded
 * staging origin, the security headers are present, and the log pipeline still drops query
 * strings and client addresses.
 *
 * `src/config/env.ts` and `src/app.ts` read the environment at module load, so each app is
 * built inside `jest.isolateModulesAsync` with a purpose-built environment. Blanked variables
 * use the empty string rather than deletion so a developer's local `.env` cannot refill them
 * through `dotenv.config()` (dotenv never overwrites a variable that is already present).
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FastifyInstance } from 'fastify';
import { createTestApp, LogCapture } from '../helpers/app';

interface ProductionApp {
  server: FastifyInstance;
  logs: LogCapture;
  close: () => Promise<void>;
}

const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_ENABLED: 'false',
  DB_HOST: '',
  DB_PORT: '',
  DB_NAME: '',
  DB_USER: '',
  DB_PASSWORD: '',
  DB_SSL: '',
  // Production launches with telemetry off. Blank falls back to the built-in default, which
  // is disabled — this asserts the default, not an explicit opt-out.
  TELEMETRY_ENABLED: '',
  // Deliberately set: production must refuse the metrics endpoint even when asked for it.
  METRICS_ENDPOINT_ENABLED: 'true',
};

const buildProductionApp = async (
  envOverrides: Record<string, string> = {},
): Promise<ProductionApp> => {
  const saved = process.env;
  process.env = { ...saved, ...PRODUCTION_ENV, ...envOverrides };
  const logs = new LogCapture();
  try {
    let server: FastifyInstance | undefined;
    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { buildApp } = require('../../src/app');
      const built = await buildApp({ logDestination: logs });
      server = built.server as FastifyInstance;
    });
    if (!server) throw new Error('production app did not build');
    await server.ready();
    return { server, logs, close: async (): Promise<void> => server?.close() };
  } finally {
    process.env = saved;
  }
};

/** Canonical JSON — same algorithm as the baseline drift suite: sorted keys, no whitespace. */
const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

const baseline = JSON.parse(
  readFileSync(join(__dirname, '../../docs/baseline/distribution-baseline.v1.json'), 'utf8'),
) as {
  repository_baseline: {
    response_canonical_sha256: string;
    response: Record<string, unknown>;
  };
};

describe('production profile — database disabled', () => {
  let app: ProductionApp;

  beforeAll(async () => {
    app = await buildProductionApp();
  });

  afterAll(async () => app.close());

  it('boots with no database configuration and never creates a pool', () => {
    // The pool is created only inside the db plugin, and the plugin decorates `db` as its
    // first observable act — no decorator means the plugin never ran.
    expect(app.server.hasDecorator('db')).toBe(false);
  });

  it('GET /health returns 200 and truthfully reports the database as disabled', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['checks', 'status', 'timestamp']);
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('disabled');
  });

  it('GET /version reports the production environment', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/version' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: '0.1.0', environment: 'production' });
  });

  it('GET /config is byte-identical to the frozen Facilities 1.1 baseline', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/config' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(baseline.repository_baseline.response);

    const digest = createHash('sha256').update(canonicalize(response.json())).digest('hex');
    expect(digest).toBe(baseline.repository_baseline.response_canonical_sha256);
  });

  it('GET /config carries no Facilities 2.0 entry and no staging marker', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/config' });

    expect(response.body).not.toContain('facilities_v2');
    expect(response.body).not.toContain('staging');
    expect(response.body).not.toContain('onrender');
  });

  it('GET /internal/metrics is unavailable despite METRICS_ENDPOINT_ENABLED=true', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/internal/metrics' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { statusCode: 404, message: 'Route not found' },
    });
  });

  it('POST /v1/telemetry/events stays disabled by default', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/v1/telemetry/events',
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain('telemetry_disabled');
  });
});

describe('production CORS — staging origin removed, unapproved origins refused', () => {
  let app: ProductionApp;

  beforeAll(async () => {
    app = await buildProductionApp();
  });

  afterAll(async () => app.close());

  const originHeader = async (origin: string): Promise<string | undefined> => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/config',
      headers: { origin },
    });
    return response.headers['access-control-allow-origin'] as string | undefined;
  };

  it('grants the first-party site origin only', async () => {
    expect(await originHeader('https://wellapath.org')).toBe('https://wellapath.org');
  });

  it('no longer grants the superseded staging origin', async () => {
    expect(await originHeader('https://api-staging.wellapath.org')).toBeUndefined();
  });

  it('grants nothing to an arbitrary origin', async () => {
    expect(await originHeader('https://evil.example')).toBeUndefined();
  });
});

describe('production security headers', () => {
  let app: ProductionApp;

  beforeAll(async () => {
    app = await buildProductionApp();
  });

  afterAll(async () => app.close());

  it('sets HSTS and content-type protection on successful responses', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/config' });

    expect(response.headers['strict-transport-security']).toBe(
      'max-age=15552000; includeSubDomains',
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('sets them on error envelopes too', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/not-a-route' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['strict-transport-security']).toBe(
      'max-age=15552000; includeSubDomains',
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('non-production security headers', () => {
  it('keeps the content-type protection but never commits a non-production host to HSTS', async () => {
    const testApp = await createTestApp();
    const response = await testApp.server.inject({ method: 'GET', url: '/config' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toBeUndefined();

    await testApp.close();
  });
});

describe('production log minimization — unchanged', () => {
  let app: ProductionApp;

  beforeAll(async () => {
    app = await buildProductionApp();
  });

  afterAll(async () => app.close());

  it('drops query strings and client addresses from request logs', async () => {
    app.logs.clear();
    await app.server.inject({
      method: 'GET',
      url: '/config?probe_marker_9f3=should-never-be-logged',
      remoteAddress: '203.0.113.77',
    });

    const logged = app.logs.text();
    expect(logged).toContain('/config');
    expect(logged).not.toContain('probe_marker_9f3');
    expect(logged).not.toContain('should-never-be-logged');
    expect(logged).not.toContain('203.0.113.77');
    expect(logged).not.toContain('remoteAddress');
    expect(logged).not.toContain('127.0.0.1');
  });
});
