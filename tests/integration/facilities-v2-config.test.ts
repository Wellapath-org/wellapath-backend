/**
 * Facilities 2.0 on `/config` — end-to-end through the real application.
 *
 * The load-bearing property: in EVERY state other than a fully approved, fully valid synthetic
 * declaration, `/config` is byte-identical to the frozen v1.1 distribution baseline. A v2
 * failure of any kind must be indistinguishable, to a client, from v2 never having existed.
 *
 * All values are synthetic; see the note in `tests/unit/facilities-v2-gate.test.ts`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { FacilitiesV2Declaration } from '../../src/manifest/facilities-v2';
import { APPROVED_ARTIFACT_ORIGINS } from '../../src/manifest/origin';
import { RecordingSink, TestApp, createTestApp } from '../helpers/app';

const APPROVED_ORIGIN = APPROVED_ARTIFACT_ORIGINS[0];
const SYNTHETIC_SHA256 = `sha256:${'ab'.repeat(32)}`;

const baseline = JSON.parse(
  readFileSync(join(__dirname, '../../docs/baseline/distribution-baseline.v1.json'), 'utf8'),
) as { repository_baseline: { response: Record<string, unknown> } };

const FROZEN_RESPONSE = baseline.repository_baseline.response;

const syntheticApproved = (): FacilitiesV2Declaration => ({
  enabled: true,
  productionApproved: false,
  artifactVersion: '2.999',
  schemaVersion: '2.0',
  url: `${APPROVED_ORIGIN}/facilities.zz.v2.999.json`,
  sha256: SYNTHETIC_SHA256,
  byteCount: '4242',
  status: 'approved',
  mayPublish: 'true',
  sourceVersion: 'synthetic-source-0',
  publicationDecisionRef: 'SYN-TEST-DECISION-000',
});

const appWith = async (
  declaration?: FacilitiesV2Declaration,
  environment?: string,
): Promise<TestApp> =>
  createTestApp({
    telemetrySink: new RecordingSink(),
    ...(declaration || environment
      ? { facilitiesV2: { ...(declaration ? { declaration } : {}), environment } }
      : {}),
  });

describe('default state — /config is byte-identical to the frozen baseline', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await appWith();
  });

  afterAll(async () => app.close());

  it('returns exactly the frozen v1.1 response with no facilities_v2 key', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(FROZEN_RESPONSE);
    expect(response.body).not.toContain('facilities_v2');
  });

  it('keeps the exact frozen top-level key set', async () => {
    const body = (await app.server.inject({ method: 'GET', url: '/config' })).json();
    expect(Object.keys(body).sort()).toEqual(['artifacts', 'country', 'version']);
  });
});

describe('approved synthetic staging manifest — additive exposure only', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await appWith(syntheticApproved());
  });

  afterAll(async () => app.close());

  it('adds facilities_v2 while the four frozen artifacts stay identical', async () => {
    const body = (await app.server.inject({ method: 'GET', url: '/config' })).json();

    expect(Object.keys(body).sort()).toEqual(['artifacts', 'country', 'facilities_v2', 'version']);
    // Everything the frozen baseline asserts is still there, unchanged.
    expect({ version: body.version, country: body.country, artifacts: body.artifacts }).toEqual(
      FROZEN_RESPONSE,
    );
    expect(body.artifacts.facilities.version).toBe('1.1');
  });

  it('exposes the manifest entry in the shape the Mobile PR #79 gate requires', async () => {
    const body = (await app.server.inject({ method: 'GET', url: '/config' })).json();
    expect(body.facilities_v2).toEqual({
      schema_version: '2.0',
      artifact: {
        artifact_id: 'facilities',
        version: '2.999',
        status: 'approved',
        may_publish: true,
        url: `${APPROVED_ORIGIN}/facilities.zz.v2.999.json`,
        sha256: SYNTHETIC_SHA256,
        byte_count: 4242,
        country: 'zz',
        publication_decision_ref: 'SYN-TEST-DECISION-000',
        source_version: 'synthetic-source-0',
      },
    });
  });

  it('still accepts no write method and reads no request input on /config', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const response = await app.server.inject({ method, url: '/config', payload: { lat: 1 } });
      expect([404, 400]).toContain(response.statusCode);
    }
    // A query string changes nothing: the route reads no request data at all.
    const plain = (await app.server.inject({ method: 'GET', url: '/config' })).body;
    const withQuery = (
      await app.server.inject({ method: 'GET', url: '/config?lat=6.5&lng=3.3&q=clinic' })
    ).body;
    expect(withQuery).toBe(plain);
  });
});

describe('every gate failure leaves /config exactly at the frozen v1.1 baseline', () => {
  // Uniform 3-tuples: jest-each reads a callback parameter beyond the row length as a `done`
  // callback, so the environment slot is always present, `undefined` meaning the default.
  const failures: [string, FacilitiesV2Declaration, string | undefined][] = [
    ['candidate status', { ...syntheticApproved(), status: 'candidate_unapproved' }, undefined],
    ['may_publish false', { ...syntheticApproved(), mayPublish: 'false' }, undefined],
    [
      'the real candidate governance state',
      { ...syntheticApproved(), status: 'candidate_unapproved', mayPublish: 'false' },
      undefined,
    ],
    ['unsupported schema major', { ...syntheticApproved(), schemaVersion: '3.0' }, undefined],
    ['invalid artifact version', { ...syntheticApproved(), artifactVersion: 'v2' }, undefined],
    ['invalid sha256', { ...syntheticApproved(), sha256: 'sha256:short' }, undefined],
    ['invalid byte count', { ...syntheticApproved(), byteCount: '0' }, undefined],
    [
      'non-HTTPS url',
      {
        ...syntheticApproved(),
        url: `http://${new URL(APPROVED_ORIGIN).host}/facilities.zz.v2.999.json`,
      },
      undefined,
    ],
    [
      'unapproved host',
      { ...syntheticApproved(), url: 'https://example.invalid/facilities.zz.v2.999.json' },
      undefined,
    ],
    [
      'missing authorization marker',
      { ...syntheticApproved(), publicationDecisionRef: undefined },
      undefined,
    ],
    ['production without production approval', syntheticApproved(), 'production'],
  ];

  it.each(failures)('%s: v1.1 response is unchanged', async (_name, declaration, environment) => {
    const app = await appWith(declaration, environment);
    try {
      const response = await app.server.inject({ method: 'GET', url: '/config' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(FROZEN_RESPONSE);
      expect(response.body).not.toContain('facilities_v2');
      expect(response.body).not.toContain('2.999');
    } finally {
      await app.close();
    }
  });
});

describe('refused declarations are logged as codes only — configured values never reach logs', () => {
  it('logs reason codes for an invalid enabled declaration without any configured value', async () => {
    const app = await appWith({
      enabled: true,
      productionApproved: false,
      artifactVersion: 'SECRET_VERSION_MARKER',
      schemaVersion: '9.9',
      url: 'https://sk-fake-cred@example.invalid/facilities.zz.v9.9.json?key=SECRET_QUERY_MARKER',
      sha256: 'SECRET_HASH_MARKER',
      byteCount: 'SECRET_BYTES_MARKER',
      status: 'candidate_unapproved',
      mayPublish: 'false',
      publicationDecisionRef: undefined,
    });
    try {
      await app.server.inject({ method: 'GET', url: '/config' });
      const logged = app.logs.text();

      expect(logged).toContain('facilities_v2_refused');
      expect(logged).toContain('STATUS_NOT_APPROVED');
      expect(logged).toContain('PUBLICATION_NOT_AUTHORIZED');

      expect(logged).not.toContain('SECRET_');
      expect(logged).not.toContain('sk-fake-cred');
      expect(logged).not.toContain('example.invalid');
    } finally {
      await app.close();
    }
  });

  it('a disabled default declaration logs nothing about facilities v2', async () => {
    const app = await appWith();
    try {
      expect(app.logs.text()).not.toContain('facilities_v2');
    } finally {
      await app.close();
    }
  });
});
