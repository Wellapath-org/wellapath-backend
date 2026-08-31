/**
 * Baseline drift check — I3 Step 1.
 *
 * `docs/baseline/distribution-baseline.v1.json` freezes the artifact-distribution baseline.
 * This suite deterministically regenerates the repository side of that freeze by driving the
 * real application and comparing field-for-field and hash-for-hash. If `/config` moves in any
 * way — a key, a value, a hash, an artifact — this fails, which is exactly the alarm the
 * freeze exists to raise. Deployed-observation sections are point-in-time records and are
 * asserted for presence and provenance, not re-observed (tests must not depend on the network).
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RecordingSink, TestApp, createTestApp } from '../helpers/app';

interface BaselineArtifactRecord {
  hash: string;
  url: string;
}

interface BaselineDocument {
  provenance: {
    repository_commit: string;
    knowledge_base_authoritative_commit: string;
    generated_at: string;
  };
  repository_baseline: {
    authentication: string;
    cache_headers_set_by_backend: null;
    response_canonical_sha256: string;
    response: { artifacts: Record<string, BaselineArtifactRecord> };
  };
  deployed_observation: {
    artifact_objects: {
      object_key: string;
      http_status: number;
      sha256_recomputed: string;
      matches_config_hash: boolean;
    }[];
  };
  inferred: string[];
  unavailable_evidence: string[];
}

const baseline = JSON.parse(
  readFileSync(join(__dirname, '../../docs/baseline/distribution-baseline.v1.json'), 'utf8'),
) as BaselineDocument;

/** Canonical JSON: object keys sorted recursively, no whitespace. */
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

describe('distribution baseline freeze — repository baseline matches the running app', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ telemetrySink: new RecordingSink() });
  });

  afterAll(async () => app.close());

  it('GET /config returns exactly the frozen response', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(baseline.repository_baseline.response);
  });

  it('the canonical hash of the live response matches the frozen hash', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/config' });
    const digest = createHash('sha256').update(canonicalize(response.json())).digest('hex');
    expect(digest).toBe(baseline.repository_baseline.response_canonical_sha256);
  });

  it('the backend sets no cache headers on /config, as frozen', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/config' });
    expect(baseline.repository_baseline.cache_headers_set_by_backend).toBeNull();
    expect(response.headers['cache-control']).toBeUndefined();
    expect(response.headers.expires).toBeUndefined();
  });

  it('/config requires no authentication, as frozen', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/config' });
    expect(response.statusCode).toBe(200);
    expect(baseline.repository_baseline.authentication).toContain('none');
  });
});

describe('distribution baseline freeze — internal consistency and provenance', () => {
  it('records provenance: commit, generation time and the authoritative KB commit', () => {
    expect(baseline.provenance.repository_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.provenance.knowledge_base_authoritative_commit).toBe(
      'c1b07944ea0b231914943ac17b2265441e53b85c',
    );
    expect(Date.parse(baseline.provenance.generated_at)).not.toBeNaN();
  });

  it('separates repository baseline, deployed observation, inference and unavailable evidence', () => {
    expect(baseline.repository_baseline).toBeDefined();
    expect(baseline.deployed_observation).toBeDefined();
    expect(Array.isArray(baseline.inferred)).toBe(true);
    expect(Array.isArray(baseline.unavailable_evidence)).toBe(true);
    expect(baseline.unavailable_evidence.length).toBeGreaterThan(0);
  });

  it('deployed observation carries a hash-verified record for each of the four artifacts', () => {
    const observed = baseline.deployed_observation.artifact_objects;
    expect(observed).toHaveLength(4);
    const artifacts = baseline.repository_baseline.response.artifacts;
    for (const record of observed) {
      const entry = Object.values(artifacts).find(a => a.url.endsWith(`/${record.object_key}`));
      expect(entry).toBeDefined();
      expect(record.sha256_recomputed).toBe(entry?.hash);
      expect(record.http_status).toBe(200);
      expect(record.matches_config_hash).toBe(true);
    }
  });

  it('exposes no secret material', () => {
    const raw = JSON.stringify(baseline).toLowerCase();
    for (const marker of ['password', 'secret', 'authorization', 'bearer ', 'api_key', 'apikey']) {
      expect(raw).not.toContain(marker);
    }
    // No signed URLs or query-string parameters anywhere in the freeze.
    expect(raw).not.toMatch(/https:\/\/[^"]*\?/);
  });
});
