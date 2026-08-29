/**
 * Hardening found during the I3 Step 3C review.
 *
 * Five things passed when they should not have, and each is a fail-open of exactly the kind this
 * subsystem exists to prevent:
 *
 *   1. a future minor envelope version was accepted, though it may rely on semantics this code
 *      does not implement;
 *   2. a superseded minor (1.0.0) was accepted, silently handing input written under weaker rules
 *      the guarantees of the current contract;
 *   3. the Git object-id constraint was enforced but undocumented, reading as a universal
 *      assumption rather than the compatibility decision it is;
 *   4. an audit event would carry an unbounded payload — a megabyte in a reference field passed,
 *      because it did not *look* like a credential;
 *   5. an environment-variable assignment carrying a secret passed for the same reason.
 *
 * Plus randomized operation sequences over the registry, which the existing tooling supports
 * without adding a dependency: the generator is a seeded, deterministic PRNG so a failure is
 * reproducible from the seed printed with it.
 */
import {
  AUDIT_FIELD_MAX_LENGTH,
  AUDIT_REASON_CODES_MAX,
  buildAuditEvent,
  findSensitiveData,
} from '../../src/manifest/registry/audit';
import {
  AnyReasonCode,
  INGESTION_ENVELOPE_VERSION,
  SOURCE_COMMIT_HEX_LENGTH,
  SOURCE_COMMIT_OBJECT_FORMAT,
  SUPPORTED_ENVELOPE_VERSIONS,
} from '../../src/manifest/ingestion/contract';
import { KB_INTEGRATION_PINS } from '../../src/manifest/ingestion/pins';
import { IngestionContext, runIngestionPipeline } from '../../src/manifest/ingestion/pipeline';
import {
  RegistryState,
  activateCandidate,
  activeFor,
  emptyRegistry,
  lastKnownGoodFor,
  publishCandidate,
  registryView,
  rollbackToTarget,
  stageCandidate,
} from '../../src/manifest/registry/registry';
import { clone, syntheticEnvelope, testAuthority } from '../helpers/ingestion';

const context = (state: RegistryState = emptyRegistry()): IngestionContext => ({
  pins: KB_INTEGRATION_PINS,
  registry: registryView(state),
  now: new Date('2026-08-29T00:00:00Z'),
  appBuild: 100,
});

const codes = (reasons: { code: AnyReasonCode }[]): AnyReasonCode[] =>
  reasons.map(reason => reason.code);

describe('envelope version is a closed set, not a major comparison', () => {
  it('the supported set contains exactly the current version', () => {
    expect([...SUPPORTED_ENVELOPE_VERSIONS]).toEqual([INGESTION_ENVELOPE_VERSION]);
  });

  it.each([
    ['a future minor whose semantics are unknown', '1.9.0'],
    ['a future patch', '1.1.9'],
    ['the superseded 1.0.0 draft', '1.0.0'],
    ['an unsupported major', '2.0.0'],
    ['a non-semver string', 'v1'],
  ])('%s is refused', (_label, version) => {
    const envelope = clone(syntheticEnvelope());
    envelope.envelope_version = version;
    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.admissible).toBe(false);
    expect(codes(outcome.reasons)).toContain('ENVELOPE_VERSION_UNSUPPORTED');
  });

  it('old input cannot silently receive the new provenance guarantees', () => {
    // A document declaring 1.0.0 but carrying every 1.1.0 field. Under 1.0.0 there was no actor
    // and no ingestion-authorization requirement, so honouring its declared version would mean
    // accepting a document written under rules it never had to meet.
    const envelope = clone(syntheticEnvelope());
    envelope.envelope_version = '1.0.0';
    expect(envelope.provenance.actor_ref).toBeTruthy();
    expect(envelope.provenance.authorization_ref).toBeTruthy();

    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.admissible).toBe(false);
    expect(codes(outcome.reasons)).toContain('ENVELOPE_VERSION_UNSUPPORTED');
  });

  it('the current version is the one that is accepted', () => {
    const outcome = runIngestionPipeline(syntheticEnvelope(), context());
    expect(outcome.reasons).toEqual([]);
    expect(outcome.admissible).toBe(true);
  });
});

describe('source commit object-id policy is a recorded compatibility constraint', () => {
  it('declares SHA-1 40-hex explicitly, rather than assuming it', () => {
    expect(SOURCE_COMMIT_HEX_LENGTH).toBe(40);
    expect(SOURCE_COMMIT_OBJECT_FORMAT).toBe('sha1');
  });

  it('a 64-hex SHA-256 object id is refused rather than silently accepted', () => {
    const envelope = clone(syntheticEnvelope());
    envelope.provenance.source_commit = 'a'.repeat(64);
    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.admissible).toBe(false);
    expect(codes(outcome.reasons)).toContain('KB_SOURCE_MISMATCH');
  });

  it.each([
    ['uppercase hex', KB_INTEGRATION_PINS.source_commit.toUpperCase()],
    ['leading whitespace', ` ${KB_INTEGRATION_PINS.source_commit}`],
    ['trailing whitespace', `${KB_INTEGRATION_PINS.source_commit} `],
    ['truncated', KB_INTEGRATION_PINS.source_commit.slice(0, 12)],
  ])('%s cannot produce an ambiguous identity', (_label, commit) => {
    const envelope = clone(syntheticEnvelope());
    envelope.provenance.source_commit = commit;
    expect(runIngestionPipeline(envelope, context()).admissible).toBe(false);
  });

  it.each([
    ['an https URL', 'https://github.com/wellapath-org/wellapath-knowledge-base'],
    [
      'a URL bearing credentials',
      'https://u:tok@github.com/wellapath-org/wellapath-knowledge-base',
    ],
    ['an ssh URL', 'git@github.com:wellapath-org/wellapath-knowledge-base.git'],
    ['a case variant', 'Wellapath-org/wellapath-knowledge-base'],
    ['a trailing slash', `${KB_INTEGRATION_PINS.source_repository}/`],
    ['a .git suffix', `${KB_INTEGRATION_PINS.source_repository}.git`],
  ])('repository identity %s is refused as ambiguous', (_label, repository) => {
    const envelope = clone(syntheticEnvelope());
    envelope.provenance.source_repository = repository;
    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.admissible).toBe(false);
    expect(codes(outcome.reasons)).toContain('KB_SOURCE_MISMATCH');
  });
});

describe('an audit event cannot carry an unbounded or secret-shaped payload', () => {
  const draft = (overrides: Record<string, unknown> = {}): Parameters<typeof buildAuditEvent>[0] =>
    ({
      event_type: 'activation',
      prior_revision: 1,
      resulting_revision: 2,
      environment: 'development',
      operation: 'activate',
      identity: {
        artifact_id: 'synthetic_fixture',
        artifact_version: '1.0',
        sha256: `sha256:${'a'.repeat(64)}`,
      },
      authority: {
        actor_ref: 'SYNTHETIC-OPERATOR-001',
        publication_decision_ref: null,
        activation_decision_ref: null,
        rollback_decision_ref: null,
      },
      outcome: 'accepted',
      stage: 'active',
      reason_codes: [],
      correlation_key: 'synthetic-audit-key-0001',
      occurred_at: '2026-08-29T00:00:00Z',
      ...overrides,
    }) as unknown as Parameters<typeof buildAuditEvent>[0];

  it('refuses an oversized correlation key', () => {
    expect(() => buildAuditEvent(draft({ correlation_key: 'x'.repeat(1_000_000) }))).toThrow(
      /oversized field/,
    );
  });

  it('refuses an oversized actor reference', () => {
    expect(() =>
      buildAuditEvent(
        draft({
          authority: {
            actor_ref: 'y'.repeat(AUDIT_FIELD_MAX_LENGTH + 1),
            publication_decision_ref: null,
            activation_decision_ref: null,
            rollback_decision_ref: null,
          },
        }),
      ),
    ).toThrow(/oversized field/);
  });

  it('refuses an oversized reason-code array', () => {
    expect(() =>
      buildAuditEvent(
        draft({ reason_codes: Array(AUDIT_REASON_CODES_MAX + 1).fill('APPROVAL_NOT_GRANTED') }),
      ),
    ).toThrow(/oversized array/);
  });

  it('refuses an environment-variable assignment carrying a secret', () => {
    for (const value of [
      'DB_PASSWORD=hunter2',
      'API_KEY=abcdef',
      'SESSION_TOKEN = xyz',
      'MY_APP_SECRET=s',
    ]) {
      expect(() => buildAuditEvent(draft({ correlation_key: value }))).toThrow(/sensitive data/);
    }
  });

  it('still accepts an ordinary event at the boundary', () => {
    const event = buildAuditEvent(draft({ correlation_key: 'k'.repeat(AUDIT_FIELD_MAX_LENGTH) }));
    expect(findSensitiveData(event)).toEqual([]);
  });

  it('reports every oversized field, not merely the first', () => {
    const findings = findSensitiveData({
      a: 'x'.repeat(AUDIT_FIELD_MAX_LENGTH + 1),
      b: 'y'.repeat(AUDIT_FIELD_MAX_LENGTH + 1),
    });
    expect(findings).toHaveLength(2);
  });
});

describe('randomized registry operation sequences preserve every invariant', () => {
  /** Deterministic PRNG (mulberry32). Seeded, so any failure is reproducible from its seed. */
  const rng = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  const OPERATIONS = ['stage', 'publish', 'activate', 'rollback'] as const;

  it.each([1, 2, 3, 7, 11, 42, 1337, 90210])(
    'seed %i: no sequence of operations can violate the invariants',
    seed => {
      const next = rng(seed);
      let state = emptyRegistry();
      let lastRevision = state.revision;

      for (let step = 0; step < 60; step += 1) {
        const operation = OPERATIONS[Math.floor(next() * OPERATIONS.length)];
        const version = next() < 0.5 ? '1.0' : '2.0';
        const before = state;
        const snapshot = JSON.stringify(before);
        const priorLkg = lastKnownGoodFor(before, 'development', 'synthetic_fixture');

        const envelope = syntheticEnvelope({
          operation,
          idempotencyKey: `seed${seed}-step${step}-${operation}`,
        });
        // Deliberately vary the identity so collisions, races and duplicates all arise.
        envelope.identity.artifact_version = version;
        envelope.object_key = `synthetic_fixture.zz.v${version}.json`;
        (envelope.descriptor as { artifact_version: string }).artifact_version = version;
        (envelope.descriptor as { object_key: string }).object_key =
          `synthetic_fixture.zz.v${version}.json`;
        if (operation === 'rollback') {
          envelope.rollback = {
            target: {
              artifact_id: 'synthetic_fixture',
              artifact_version: version === '1.0' ? '2.0' : '1.0',
              sha256: `sha256:${'a'.repeat(64)}`,
            },
            target_schema_version: 'wellapath.artifact/1',
          };
        }

        // Sometimes present a stale expectation, so compare-and-swap failures occur.
        const staleRevision = next() < 0.3;
        const expectedRevision = staleRevision ? Math.max(0, before.revision - 1) : before.revision;
        const wrongActive = next() < 0.3;
        const expectedActive = wrongActive
          ? null
          : activeFor(before, 'development', 'synthetic_fixture');

        const outcome = runIngestionPipeline(envelope, context(before));
        const request = {
          envelope,
          outcome,
          authority: testAuthority(),
          expectedRevision,
          expectedActive,
        };
        const apply = {
          stage: stageCandidate,
          publish: publishCandidate,
          activate: activateCandidate,
          rollback: rollbackToTarget,
        }[operation];

        const result = apply(before, request);

        if (!result.ok) {
          // INVARIANT: a failed operation returns the prior state object itself, unchanged.
          expect(result.state).toBe(before);
          expect(JSON.stringify(result.state)).toBe(snapshot);
          expect(lastKnownGoodFor(result.state, 'development', 'synthetic_fixture')).toEqual(
            priorLkg,
          );
          expect(result.event.prior_revision).toBe(result.event.resulting_revision);
        } else {
          // INVARIANT: revision is monotonic, and moves by 0 (replay) or exactly 1.
          const delta = result.state.revision - before.revision;
          expect([0, 1]).toContain(delta);
          expect(result.state.revision).toBeGreaterThanOrEqual(lastRevision);
          // INVARIANT: at most one active descriptor per line and environment.
          const activeKeys = Object.keys(result.state.active);
          expect(new Set(activeKeys).size).toBe(activeKeys.length);
          // INVARIANT: audit is append-only and continuous.
          expect(result.state.audit.length).toBeGreaterThanOrEqual(before.audit.length);
          for (let i = 1; i < result.state.audit.length; i += 1) {
            expect(result.state.audit[i].prior_revision).toBe(
              result.state.audit[i - 1].resulting_revision,
            );
          }
          // INVARIANT: anything active is also published.
          for (const identity of Object.values(result.state.active)) {
            expect(
              result.state.published.some(
                published =>
                  published.artifact_id === identity.artifact_id &&
                  published.artifact_version === identity.artifact_version &&
                  published.sha256 === identity.sha256,
              ),
            ).toBe(true);
          }
          // INVARIANT: anything published was staged first.
          for (const identity of result.state.published) {
            expect(
              result.state.staged.some(
                staged =>
                  staged.artifact_id === identity.artifact_id &&
                  staged.artifact_version === identity.artifact_version,
              ),
            ).toBe(true);
          }
          state = result.state;
          lastRevision = state.revision;
        }
      }
    },
  );
});
