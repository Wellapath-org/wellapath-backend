/**
 * Facilities 2.0 gate — every value here is synthetic.
 *
 * The version (`2.999`), country (`zz`), digest (`abab…`) and decision reference are chosen to
 * be impossible to mistake for the real candidate, whose URL, hash, byte size and content are
 * deliberately absent from this repository. Rejection tests use the reserved domain
 * `example.invalid`.
 */
import {
  FACILITIES_V2_REASON_CODES,
  FacilitiesV2Declaration,
  parseFacilitiesV2Env,
  resolveFacilitiesV2,
} from '../../src/manifest/facilities-v2';
import { APPROVED_ARTIFACT_ORIGINS } from '../../src/manifest/origin';

const APPROVED_ORIGIN = APPROVED_ARTIFACT_ORIGINS[0];
const SYNTHETIC_SHA256 = `sha256:${'ab'.repeat(32)}`;

/** A fully valid, fully synthetic staging declaration. Every gate test perturbs one field. */
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

/**
 * The real candidate's GOVERNANCE state (status and publication flag only) on otherwise valid
 * synthetic metadata. Its real URL, hash and byte size appear nowhere in this repository.
 */
const candidateGovernanceState = (): FacilitiesV2Declaration => ({
  ...syntheticApproved(),
  status: 'candidate_unapproved',
  mayPublish: 'false',
});

const codes = (declaration: FacilitiesV2Declaration, environment = 'test'): string[] =>
  resolveFacilitiesV2(declaration, environment).reasons.map(reason => reason.code);

describe('parseFacilitiesV2Env — defaults', () => {
  it('parses an empty environment to disabled with every field absent', () => {
    const declaration = parseFacilitiesV2Env({});
    expect(declaration).toEqual({
      enabled: false,
      productionApproved: false,
      artifactVersion: undefined,
      schemaVersion: undefined,
      url: undefined,
      sha256: undefined,
      byteCount: undefined,
      status: undefined,
      mayPublish: undefined,
      sourceVersion: undefined,
      publicationDecisionRef: undefined,
    });
  });

  it('treats empty strings as absent', () => {
    const declaration = parseFacilitiesV2Env({
      FACILITIES_V2_DISTRIBUTION_ENABLED: '',
      FACILITIES_V2_STATUS: '',
      FACILITIES_V2_SHA256: '',
    });
    expect(declaration.enabled).toBe(false);
    expect(declaration.status).toBeUndefined();
    expect(declaration.sha256).toBeUndefined();
  });

  it.each(['false', '1', 'yes', 'TRUE ', 'enabled', 'on'])(
    'enables nothing for the boolean value %j',
    value => {
      expect(parseFacilitiesV2Env({ FACILITIES_V2_DISTRIBUTION_ENABLED: value }).enabled).toBe(
        false,
      );
      expect(
        parseFacilitiesV2Env({ FACILITIES_V2_PRODUCTION_APPROVED: value }).productionApproved,
      ).toBe(false);
    },
  );
});

describe('resolveFacilitiesV2 — default off', () => {
  it('exposes nothing for an unconfigured environment', () => {
    const resolution = resolveFacilitiesV2(parseFacilitiesV2Env({}), 'test');
    expect(resolution.exposure).toBeNull();
    expect(codes(parseFacilitiesV2Env({}))).toContain('V2_NOT_ENABLED');
  });

  it('exposes nothing when everything is valid but the master switch is off', () => {
    const declaration = { ...syntheticApproved(), enabled: false };
    const resolution = resolveFacilitiesV2(declaration, 'test');
    expect(resolution.exposure).toBeNull();
    expect(resolution.reasons.map(r => r.code)).toEqual(['V2_NOT_ENABLED']);
  });
});

describe('resolveFacilitiesV2 — the synthetic approved declaration', () => {
  it('passes every gate outside production', () => {
    const resolution = resolveFacilitiesV2(syntheticApproved(), 'test');
    expect(resolution.reasons).toEqual([]);
    expect(resolution.exposure).toEqual({
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

  it('omits source_version when no provenance version is configured', () => {
    const declaration = { ...syntheticApproved(), sourceVersion: undefined };
    const exposure = resolveFacilitiesV2(declaration, 'test').exposure;
    expect(exposure).not.toBeNull();
    expect(exposure?.artifact).not.toHaveProperty('source_version');
  });

  it('satisfies the shape the Mobile PR #79 parser requires', () => {
    const exposure = resolveFacilitiesV2(syntheticApproved(), 'test').exposure;
    // FacilitiesV2Manifest.tryParse reads exactly these fields and types.
    expect(typeof exposure?.schema_version).toBe('string');
    expect(typeof exposure?.artifact.version).toBe('string');
    expect(exposure?.artifact.status).toBe('approved');
    expect(exposure?.artifact.may_publish).toBe(true);
    expect(typeof exposure?.artifact.url).toBe('string');
    expect(exposure?.artifact.sha256.length).toBeGreaterThan(0);
    expect(exposure?.schema_version.startsWith('2.')).toBe(true);
  });
});

describe('resolveFacilitiesV2 — the current candidate fails on both governance fields', () => {
  it('refuses the candidate state with independent status AND publication reasons', () => {
    const reasons = codes(candidateGovernanceState());
    expect(reasons).toContain('STATUS_NOT_APPROVED');
    expect(reasons).toContain('PUBLICATION_NOT_AUTHORIZED');
  });

  it('still fails on may_publish when only status is (hypothetically) lifted', () => {
    const declaration = { ...candidateGovernanceState(), status: 'approved' };
    expect(codes(declaration)).toEqual(['PUBLICATION_NOT_AUTHORIZED']);
    expect(resolveFacilitiesV2(declaration, 'test').exposure).toBeNull();
  });

  it('still fails on status when only may_publish is (hypothetically) lifted', () => {
    const declaration = { ...candidateGovernanceState(), mayPublish: 'true' };
    expect(codes(declaration)).toEqual(['STATUS_NOT_APPROVED']);
    expect(resolveFacilitiesV2(declaration, 'test').exposure).toBeNull();
  });
});

describe('resolveFacilitiesV2 — individual gates fail closed', () => {
  it.each([
    ['candidate_unapproved', 'STATUS_NOT_APPROVED'],
    ['Approved', 'STATUS_NOT_APPROVED'],
    ['APPROVED', 'STATUS_NOT_APPROVED'],
    [' approved', 'STATUS_NOT_APPROVED'],
    [undefined, 'STATUS_NOT_APPROVED'],
  ])('refuses status %j', (status, code) => {
    expect(codes({ ...syntheticApproved(), status: status as string | undefined })).toEqual([code]);
  });

  it.each(['false', 'TRUE', 'True', '1', 'yes', ' true', undefined])(
    'refuses may_publish %j — only the exact literal true authorizes',
    mayPublish => {
      expect(
        codes({ ...syntheticApproved(), mayPublish: mayPublish as string | undefined }),
      ).toEqual(['PUBLICATION_NOT_AUTHORIZED']);
    },
  );

  it.each(['1.0', '3.0', '2', undefined, 'two', '2.x', '02a'])(
    'refuses schema version %j unless its major is supported and well-formed',
    schemaVersion => {
      const reasons = codes({
        ...syntheticApproved(),
        schemaVersion: schemaVersion as string | undefined,
      });
      if (schemaVersion === '2') {
        // Bare major `2` is well-formed and supported.
        expect(reasons).toEqual([]);
      } else {
        expect(reasons).toEqual(['SCHEMA_MAJOR_UNSUPPORTED']);
      }
    },
  );

  it.each(['1.1', 'v2.0', '', undefined, '3.0'])('refuses artifact version %j', version => {
    expect(
      codes({ ...syntheticApproved(), artifactVersion: version as string | undefined }),
    ).toEqual(['ARTIFACT_VERSION_INVALID']);
  });

  it.each([
    `sha256:${'ab'.repeat(31)}`, // too short
    'ab'.repeat(32), // missing prefix
    `sha256:${'AB'.repeat(32)}`, // uppercase hex refused
    'sha256:not-a-digest',
    undefined,
  ])('refuses sha256 %j', sha256 => {
    expect(codes({ ...syntheticApproved(), sha256: sha256 as string | undefined })).toEqual([
      'SHA256_INVALID',
    ]);
  });

  it.each(['0', '-1', '1.5', '1e6', 'big', '', undefined, '9007199254740993'])(
    'refuses byte count %j',
    byteCount => {
      expect(codes({ ...syntheticApproved(), byteCount: byteCount as string | undefined })).toEqual(
        ['BYTE_COUNT_INVALID'],
      );
    },
  );

  it.each([
    [`http://${new URL(APPROVED_ORIGIN).host}/facilities.zz.v2.999.json`, 'URL_NOT_HTTPS'],
    ['https://example.invalid/facilities.zz.v2.999.json', 'ORIGIN_NOT_APPROVED'],
    ['https://cdn.example.invalid/facilities.zz.v2.999.json', 'ORIGIN_NOT_APPROVED'],
    [`${APPROVED_ORIGIN}/facilities.zz.v2.999.json?token=x`, 'URL_HAS_QUERY'],
    [`${APPROVED_ORIGIN}/facilities.zz.v2.999.json#frag`, 'URL_HAS_QUERY'],
    [`${APPROVED_ORIGIN}/nested/facilities.zz.v2.999.json`, 'OBJECT_KEY_INVALID'],
    [`${APPROVED_ORIGIN}/facilities.zz.v2.999.txt`, 'OBJECT_KEY_INVALID'],
    [`${APPROVED_ORIGIN}/kb.zz.v2.999.json`, 'ARTIFACT_LINE_MISMATCH'],
    ['not a url', 'URL_INVALID'],
    [undefined, 'URL_INVALID'],
  ])('refuses url %j with %s', (url, code) => {
    expect(codes({ ...syntheticApproved(), url: url as string | undefined })).toContain(code);
  });

  it('refuses a url embedding credentials, and never echoes them in the reason', () => {
    const resolution = resolveFacilitiesV2(
      {
        ...syntheticApproved(),
        url: `https://user:hunter2-fake@${new URL(APPROVED_ORIGIN).host}/facilities.zz.v2.999.json`,
      },
      'test',
    );
    expect(resolution.exposure).toBeNull();
    expect(resolution.reasons.map(r => r.code)).toContain('URL_HAS_CREDENTIALS');
    expect(JSON.stringify(resolution.reasons)).not.toContain('hunter2-fake');
  });

  it.each(['', '   ', undefined])('refuses authorization marker %j', marker => {
    expect(
      codes({ ...syntheticApproved(), publicationDecisionRef: marker as string | undefined }),
    ).toEqual(['AUTHORIZATION_MARKER_MISSING']);
  });

  it('refuses production without the separate production approval', () => {
    expect(codes(syntheticApproved(), 'production')).toEqual(['PRODUCTION_NOT_APPROVED']);
  });

  it('passes production only with the separate production approval set', () => {
    const declaration = { ...syntheticApproved(), productionApproved: true };
    expect(resolveFacilitiesV2(declaration, 'production').exposure).not.toBeNull();
    // And that approval changes nothing about the other gates.
    expect(
      resolveFacilitiesV2({ ...candidateGovernanceState(), productionApproved: true }, 'production')
        .exposure,
    ).toBeNull();
  });
});

describe('resolveFacilitiesV2 — refusals never carry configured values', () => {
  it('reports codes, fields and rules only, for a declaration full of secret-looking values', () => {
    const resolution = resolveFacilitiesV2(
      {
        enabled: true,
        productionApproved: false,
        artifactVersion: 'SECRET_VERSION_MARKER',
        schemaVersion: 'SECRET_SCHEMA_MARKER',
        url: 'https://sk-secret-token@example.invalid/x?key=SECRET_QUERY_MARKER',
        sha256: 'SECRET_HASH_MARKER',
        byteCount: 'SECRET_BYTES_MARKER',
        status: 'SECRET_STATUS_MARKER',
        mayPublish: 'SECRET_FLAG_MARKER',
        publicationDecisionRef: undefined,
      },
      'test',
    );
    expect(resolution.exposure).toBeNull();
    const serialized = JSON.stringify(resolution);
    expect(serialized).not.toContain('SECRET_');
    expect(serialized).not.toContain('sk-secret-token');
    for (const reason of resolution.reasons) {
      expect((FACILITIES_V2_REASON_CODES as readonly string[]).includes(reason.code)).toBe(true);
      expect(reason.field.startsWith('FACILITIES_V2_')).toBe(true);
    }
  });
});

describe('resolveFacilitiesV2 — no environment-variable combination exposes an unapproved manifest', () => {
  /** Deterministic seeded PRNG (mulberry32) — reproducible property-style sweep. */
  const mulberry32 = (seed: number): (() => number) => {
    let state = seed;
    return (): number => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  const pick = <T>(random: () => number, values: T[]): T =>
    values[Math.floor(random() * values.length)];

  it('across 2,000 randomized declarations, exposure requires exactly the approved state', () => {
    const random = mulberry32(0x5eed);
    const statuses = ['approved', 'candidate_unapproved', 'Approved', 'published', '', undefined];
    const bools = ['true', 'false', 'TRUE', '1', '', undefined];
    const versions = ['2.0', '2.999', '1.1', '3.0', 'x', '', undefined];
    const urls = [
      `${APPROVED_ORIGIN}/facilities.zz.v2.999.json`,
      'https://example.invalid/facilities.zz.v2.999.json',
      `http://${new URL(APPROVED_ORIGIN).host}/facilities.zz.v2.999.json`,
      `${APPROVED_ORIGIN}/kb.zz.v2.999.json`,
      '',
      undefined,
    ];
    const hashes = [SYNTHETIC_SHA256, 'sha256:short', '', undefined];
    const byteCounts = ['4242', '0', '-1', 'x', '', undefined];
    const markers = ['SYN-TEST-DECISION-000', '', '   ', undefined];
    const environments = ['test', 'development', 'staging', 'production'];

    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const declaration: FacilitiesV2Declaration = {
        enabled: pick(random, bools)?.toLowerCase() === 'true',
        productionApproved: pick(random, bools)?.toLowerCase() === 'true',
        artifactVersion: pick(random, versions),
        schemaVersion: pick(random, versions),
        url: pick(random, urls) || undefined,
        sha256: pick(random, hashes) || undefined,
        byteCount: pick(random, byteCounts) || undefined,
        status: pick(random, statuses) || undefined,
        mayPublish: pick(random, bools) || undefined,
        publicationDecisionRef: pick(random, markers),
      };
      const environment = pick(random, environments);
      const resolution = resolveFacilitiesV2(declaration, environment);

      if (resolution.exposure !== null) {
        // Anything exposed must have passed EVERY gate exactly.
        expect(declaration.enabled).toBe(true);
        expect(declaration.status).toBe('approved');
        expect(declaration.mayPublish).toBe('true');
        expect(resolution.exposure.artifact.status).toBe('approved');
        expect(resolution.exposure.artifact.may_publish).toBe(true);
        expect(resolution.exposure.schema_version.split('.')[0]).toBe('2');
        expect(resolution.exposure.artifact.url.startsWith(APPROVED_ORIGIN)).toBe(true);
        if (environment === 'production') {
          expect(declaration.productionApproved).toBe(true);
        }
      } else {
        expect(resolution.reasons.length).toBeGreaterThan(0);
      }

      // The unapproved governance state is never exposed, whatever else is set.
      if (declaration.status !== 'approved' || declaration.mayPublish !== 'true') {
        expect(resolution.exposure).toBeNull();
      }
    }
  });
});
