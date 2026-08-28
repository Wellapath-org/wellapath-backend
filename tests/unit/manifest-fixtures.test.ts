/**
 * Fixture-driven contract tests.
 *
 * Positive: the baseline manifest and the blocked-candidates manifest validate, and the
 * blocked candidates are provably synthetic (their hashes derive from a fixture seed bound to
 * the authoritative knowledge-base commit) and provably ineligible.
 *
 * Negative: every case in `negative-fixtures.json` must fail at its declared stage with its
 * declared reason code. A case passing, or failing for a different reason, fails this suite.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ArtifactDescriptor,
  CandidateManifest,
  Environment,
  ReasonCode,
} from '../../src/manifest/contract';
import { evaluateDescriptor, selectActiveDescriptor } from '../../src/manifest/eligibility';
import { verifyArtifactBytes } from '../../src/manifest/integrity';
import { validateManifest } from '../../src/manifest/validate';

const KB_AUTHORITATIVE_COMMIT = 'c1b07944ea0b231914943ac17b2265441e53b85c';

interface NegativeCase {
  name: string;
  stage: 'validation' | 'eligibility' | 'selection' | 'integrity';
  expected_code: ReasonCode;
  manifest_overrides?: Record<string, unknown>;
  descriptor_overrides?: Record<string, unknown>;
  remove_descriptor_fields?: string[];
  append_duplicate_of_target?: boolean;
  other_descriptor_overrides?: {
    artifact_id: string;
    artifact_version: string;
    overrides: Record<string, unknown>;
  };
  context_overrides?: { app_build?: number | null };
  bytes_utf8?: string;
}

interface NegativeFixtureFile {
  base: string;
  target: { artifact_id: string; artifact_version: string };
  context: { environment: Environment; app_build: number; now: string };
  cases: NegativeCase[];
}

const fixturesDir = join(__dirname, '../fixtures/manifest');
const loadJson = <T>(name: string): T =>
  JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as T;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deep merge for fixture overrides: objects merge, everything else replaces. */
const deepMerge = (base: Record<string, unknown>, overrides: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(overrides)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      deepMerge(base[key] as Record<string, unknown>, value);
    } else {
      base[key] = value;
    }
  }
};

const removePath = (base: Record<string, unknown>, path: string): void => {
  const segments = path.split('.');
  let cursor: Record<string, unknown> = base;
  for (const segment of segments.slice(0, -1)) {
    cursor = cursor[segment] as Record<string, unknown>;
  }
  delete cursor[segments[segments.length - 1]];
};

describe('blocked candidates — Vocabulary 2.0 and Question Flow 1.1', () => {
  const manifest = loadJson<CandidateManifest>('blocked-candidates.manifest.json');
  const context = { environment: 'staging' as const, now: new Date('2026-08-28T00:00:00Z') };

  it('the fixture manifest is structurally valid', () => {
    const result = validateManifest(manifest);
    expect(result.reasons).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each(['vocabulary', 'question_flow'])(
    '%s descriptor is provably synthetic: its hash derives from a fixture seed bound to the authoritative KB commit',
    artifactId => {
      const descriptor = manifest.artifacts.find(
        entry => entry.artifact_id === artifactId,
      ) as ArtifactDescriptor;
      const seed = `fixture-only:${descriptor.artifact_id}@${descriptor.artifact_version}@kb:${KB_AUTHORITATIVE_COMMIT}`;
      const digest = `sha256:${createHash('sha256').update(seed).digest('hex')}`;
      expect(descriptor.sha256).toBe(digest);
      expect(descriptor.byte_count).toBe(Buffer.byteLength(seed));
    },
  );

  it.each(['vocabulary', 'question_flow'])(
    '%s remains unpublished, inactive and ineligible for every environment',
    artifactId => {
      const descriptor = manifest.artifacts.find(
        entry => entry.artifact_id === artifactId,
      ) as ArtifactDescriptor;
      for (const environment of ['development', 'staging', 'production'] as const) {
        const { states } = evaluateDescriptor(descriptor, { ...context, environment });
        expect(states.published).toBe(false);
        expect(states.active).toBe(false);
        expect(states.eligible_for_environment).toBe(false);
      }
    },
  );

  it('question_flow reflects its exact governance state', () => {
    const descriptor = manifest.artifacts.find(
      entry => entry.artifact_id === 'question_flow',
    ) as ArtifactDescriptor;

    // IM-001 product decisions complete — but that alone changes nothing below.
    expect(descriptor.approvals.product.status).toBe('granted');
    expect(descriptor.approvals.product.decision_ref).toContain('IM-001');
    // Clinical approval is not granted and no reviewer is assigned.
    expect(descriptor.approvals.clinical.status).not.toBe('granted');
    // Both safety blockers are open.
    const blockerIds = descriptor.blockers.map(blocker => `${blocker.id}:${blocker.status}`);
    expect(blockerIds).toContain('IM001-CLIN-FLAG-001:open');
    expect(blockerIds).toContain('IM003-SB-001:open');
    // Activation is not authorized.
    expect(descriptor.activation_authorized).toBe(false);
    expect(descriptor.activation_status).toBe('inactive');

    const { states, reasons } = evaluateDescriptor(descriptor, context);
    expect(states.eligible_for_environment).toBe(false);
    const codes = reasons.map(reason => reason.code);
    expect(codes).toContain('NOT_PUBLISHED');
    expect(codes).toContain('APPROVAL_NOT_GRANTED');
    expect(codes).toContain('BLOCKER_UNRESOLVED');
    expect(codes).toContain('ACTIVATION_NOT_AUTHORIZED');
  });

  it('neither blocked candidate can ever be selected', () => {
    for (const artifactId of ['vocabulary', 'question_flow']) {
      const result = selectActiveDescriptor(manifest, artifactId, context);
      expect(result.selected).toBeNull();
      expect(result.reasons.map(reason => reason.code)).toContain('NO_ACTIVE_ARTIFACT');
    }
  });
});

describe('negative fixtures — each fails at its declared stage for its declared reason', () => {
  const fixture = loadJson<NegativeFixtureFile>('negative-fixtures.json');
  const baseManifest = loadJson<CandidateManifest>(fixture.base);

  const buildCase = (
    testCase: NegativeCase,
  ): { manifest: CandidateManifest; target: ArtifactDescriptor } => {
    const manifest = clone(baseManifest);
    const target = manifest.artifacts.find(
      descriptor =>
        descriptor.artifact_id === fixture.target.artifact_id &&
        descriptor.artifact_version === fixture.target.artifact_version,
    ) as ArtifactDescriptor;

    if (testCase.manifest_overrides) {
      deepMerge(manifest as unknown as Record<string, unknown>, testCase.manifest_overrides);
    }
    if (testCase.descriptor_overrides) {
      deepMerge(target as unknown as Record<string, unknown>, testCase.descriptor_overrides);
    }
    for (const path of testCase.remove_descriptor_fields ?? []) {
      removePath(target as unknown as Record<string, unknown>, path);
    }
    if (testCase.append_duplicate_of_target) {
      manifest.artifacts.push(clone(target));
    }
    if (testCase.other_descriptor_overrides) {
      const other = manifest.artifacts.find(
        descriptor =>
          descriptor.artifact_id === testCase.other_descriptor_overrides?.artifact_id &&
          descriptor.artifact_version === testCase.other_descriptor_overrides.artifact_version,
      ) as ArtifactDescriptor;
      deepMerge(
        other as unknown as Record<string, unknown>,
        testCase.other_descriptor_overrides.overrides,
      );
    }

    return { manifest, target };
  };

  const buildContext = (
    testCase: NegativeCase,
  ): { environment: Environment; appBuild?: number; now: Date } => {
    const appBuildOverride = testCase.context_overrides?.app_build;
    return {
      environment: fixture.context.environment,
      appBuild:
        testCase.context_overrides && 'app_build' in testCase.context_overrides
          ? (appBuildOverride ?? undefined)
          : fixture.context.app_build,
      now: new Date(fixture.context.now),
    };
  };

  it.each(fixture.cases.map(testCase => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      const { manifest, target } = buildCase(testCase);
      const context = buildContext(testCase);

      if (testCase.stage === 'validation') {
        const result = validateManifest(manifest);
        expect(result.valid).toBe(false);
        expect(result.reasons.map(reason => reason.code)).toContain(testCase.expected_code);
        return;
      }

      // Every non-validation case must still be structurally valid — otherwise it would be
      // testing the wrong layer.
      expect(validateManifest(manifest).valid).toBe(true);

      if (testCase.stage === 'eligibility') {
        const { states, reasons } = evaluateDescriptor(target, context);
        expect(states.eligible_for_environment).toBe(false);
        expect(reasons.map(reason => reason.code)).toContain(testCase.expected_code);
        return;
      }

      if (testCase.stage === 'selection') {
        const result = selectActiveDescriptor(manifest, fixture.target.artifact_id, context);
        expect(result.selected).toBeNull();
        expect(result.reasons.map(reason => reason.code)).toContain(testCase.expected_code);
        return;
      }

      const reasons = verifyArtifactBytes(Buffer.from(testCase.bytes_utf8 ?? '', 'utf8'), target);
      expect(reasons.map(reason => reason.code)).toContain(testCase.expected_code);
    },
  );

  it('covers every stage', () => {
    const stages = new Set(fixture.cases.map(testCase => testCase.stage));
    expect(stages).toEqual(new Set(['validation', 'eligibility', 'selection', 'integrity']));
  });
});
