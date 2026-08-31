/**
 * Registry lifecycle on fully synthetic artifacts.
 *
 * These fixtures are deliberately unrelated to anything WellaPath ships: artifact line
 * `synthetic_fixture`, country `zz`, object keys that cannot collide with a real object. They
 * exist to prove the state machine works, and they grant no authorization to anything real.
 *
 * The properties under test are the ones that matter when this eventually runs for real:
 * transitions are atomic, a failure changes nothing, replays are no-ops, a stale compare-and-swap
 * loses, and last-known-good survives every failure path.
 */
import { ArtifactDescriptor } from '../../src/manifest/contract';
import { AnyReasonCode, ArtifactIdentity } from '../../src/manifest/ingestion/contract';
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
import { buildEnvelope, syntheticDescriptor, testAuthority } from '../helpers/ingestion';

const V1 = syntheticDescriptor('1.0', 'a');
const V2 = syntheticDescriptor('2.0', 'b');

const identity = (descriptor: ArtifactDescriptor): ArtifactIdentity => ({
  artifact_id: descriptor.artifact_id,
  artifact_version: descriptor.artifact_version,
  sha256: descriptor.sha256,
});

const context = (state: RegistryState): IngestionContext => ({
  pins: KB_INTEGRATION_PINS,
  registry: registryView(state),
  now: new Date('2026-08-29T00:00:00Z'),
  appBuild: 100,
});

/** Synthetic envelopes run in development under the explicitly non-operative test trust mode. */
const envelopeFor = (
  descriptor: ArtifactDescriptor,
  operation: 'stage' | 'publish' | 'activate' | 'rollback',
  key: string,
): ReturnType<typeof buildEnvelope> =>
  buildEnvelope({
    descriptor,
    operation,
    environment: 'development',
    trustMode: 'synthetic_test_only',
    synthetic: true,
    idempotencyKey: `synthetic-${key}`,
    publicationRef: 'SYNTHETIC-PUB-001 (test fixture)',
    activationRef: 'SYNTHETIC-ACT-001 (test fixture)',
    rollbackRef: 'SYNTHETIC-ROLLBACK-001 (test fixture)',
  });

const codes = (reasons: { code: AnyReasonCode }[]): AnyReasonCode[] =>
  reasons.map(reason => reason.code);

/** Drives a descriptor all the way to active, asserting each transition on the way. */
const driveToActive = (
  state: RegistryState,
  descriptor: ArtifactDescriptor,
  keyPrefix: string,
): RegistryState => {
  const staged = stageCandidate(state, {
    envelope: envelopeFor(descriptor, 'stage', `${keyPrefix}-stage`),
    outcome: runIngestionPipeline(
      envelopeFor(descriptor, 'stage', `${keyPrefix}-stage`),
      context(state),
    ),
    authority: testAuthority(),
    expectedRevision: state.revision,
    expectedActive: activeFor(state, 'development', descriptor.artifact_id),
  });
  expect(staged.ok).toBe(true);

  const published = publishCandidate(staged.state, {
    envelope: envelopeFor(descriptor, 'publish', `${keyPrefix}-publish`),
    outcome: runIngestionPipeline(
      envelopeFor(descriptor, 'publish', `${keyPrefix}-publish`),
      context(staged.state),
    ),
    authority: testAuthority(),
    expectedRevision: staged.state.revision,
    expectedActive: activeFor(staged.state, 'development', descriptor.artifact_id),
  });
  expect(published.ok).toBe(true);

  const activated = activateCandidate(published.state, {
    envelope: envelopeFor(descriptor, 'activate', `${keyPrefix}-activate`),
    outcome: runIngestionPipeline(
      envelopeFor(descriptor, 'activate', `${keyPrefix}-activate`),
      context(published.state),
    ),
    authority: testAuthority(),
    expectedRevision: published.state.revision,
    expectedActive: activeFor(published.state, 'development', descriptor.artifact_id),
  });
  expect(activated.ok).toBe(true);
  return activated.state;
};

describe('synthetic positive path — a valid envelope moves stage by stage', () => {
  it('validates fully and reaches integrity_verified, but no further on its own', () => {
    const envelope = envelopeFor(V1, 'stage', 'pos-1');
    const outcome = runIngestionPipeline(envelope, context(emptyRegistry()));

    expect(outcome.admissible).toBe(true);
    expect(outcome.stage).toBe('integrity_verified');
    expect(outcome.reasons).toEqual([]);
    // Admissible is not staged. The pipeline never promotes itself.
    expect(outcome.reached).not.toContain('staged');
    expect(outcome.reached).toEqual([
      'received',
      'envelope_validated',
      'contract_validated',
      'provenance_verified',
      'governance_verified',
      'integrity_verified',
    ]);
    // The attestation is explicitly non-operative even on the happy path.
    expect(outcome.attestation?.operative).toBe(false);
    expect(outcome.attestation?.verified).toBe(false);
    expect(outcome.attestation?.trust_mode).toBe('synthetic_test_only');
  });

  it('stages, publishes and activates, each as its own transition', () => {
    let state = emptyRegistry();
    expect(state.revision).toBe(0);

    const stageEnvelope = envelopeFor(V1, 'stage', 'pos-stage');
    const staged = stageCandidate(state, {
      envelope: stageEnvelope,
      outcome: runIngestionPipeline(stageEnvelope, context(state)),
      authority: testAuthority(),
      expectedRevision: 0,
      expectedActive: null,
    });
    expect(staged.ok).toBe(true);
    expect(staged.state.revision).toBe(1);
    expect(staged.state.staged).toHaveLength(1);
    // Staging publishes nothing and activates nothing.
    expect(staged.state.published).toEqual([]);
    expect(activeFor(staged.state, 'development', 'synthetic_fixture')).toBeNull();
    state = staged.state;

    const publishEnvelope = envelopeFor(V1, 'publish', 'pos-publish');
    const published = publishCandidate(state, {
      envelope: publishEnvelope,
      outcome: runIngestionPipeline(publishEnvelope, context(state)),
      authority: testAuthority(),
      expectedRevision: 1,
      expectedActive: null,
    });
    expect(published.ok).toBe(true);
    expect(published.state.revision).toBe(2);
    expect(published.state.published).toHaveLength(1);
    // Publication activates nothing.
    expect(activeFor(published.state, 'development', 'synthetic_fixture')).toBeNull();
    state = published.state;

    const activateEnvelope = envelopeFor(V1, 'activate', 'pos-activate');
    const activated = activateCandidate(state, {
      envelope: activateEnvelope,
      outcome: runIngestionPipeline(activateEnvelope, context(state)),
      authority: testAuthority(),
      expectedRevision: 2,
      expectedActive: null,
    });
    expect(activated.ok).toBe(true);
    expect(activated.state.revision).toBe(3);
    expect(activeFor(activated.state, 'development', 'synthetic_fixture')).toEqual(identity(V1));
  });

  it('audit revisions form an unbroken chain', () => {
    const state = driveToActive(emptyRegistry(), V1, 'chain');
    expect(state.audit).toHaveLength(3);
    expect(state.audit.map(event => event.event_type)).toEqual([
      'staging',
      'publication',
      'activation',
    ]);
    state.audit.forEach((event, index) => {
      expect(event.prior_revision).toBe(index);
      expect(event.resulting_revision).toBe(index + 1);
      expect(event.outcome).toBe('accepted');
    });
    // Each event's prior revision is the previous event's resulting revision. No gaps.
    for (let index = 1; index < state.audit.length; index += 1) {
      expect(state.audit[index].prior_revision).toBe(state.audit[index - 1].resulting_revision);
    }
  });

  it('event ids are content-derived, so the same trail replays identically', () => {
    const first = driveToActive(emptyRegistry(), V1, 'det');
    const second = driveToActive(emptyRegistry(), V1, 'det');
    expect(first.audit.map(event => event.event_id)).toEqual(
      second.audit.map(event => event.event_id),
    );
  });
});

describe('idempotency and replay', () => {
  it('replaying the identical staging request is a no-op, not a second stage', () => {
    const state = emptyRegistry();
    const envelope = envelopeFor(V1, 'stage', 'replay-1');
    const outcome = runIngestionPipeline(envelope, context(state));
    const request = {
      envelope,
      outcome,
      authority: testAuthority(),
      expectedRevision: 0,
      expectedActive: null,
    };

    const first = stageCandidate(state, request);
    expect(first.ok).toBe(true);
    expect(first.state.revision).toBe(1);

    // A real retry resends the identical request — same expected revision and all. The
    // idempotency check must answer first, or a lost response would surface as REVISION_STALE.
    const replay = stageCandidate(first.state, {
      ...request,
      outcome: runIngestionPipeline(envelope, context(first.state)),
    });
    expect(replay.ok).toBe(true);
    expect(replay.state).toBe(first.state);
    expect(replay.state.revision).toBe(1);
    expect(replay.state.staged).toHaveLength(1);
    expect(replay.event.event_type).toBe('idempotent_replay');
    expect(replay.event.outcome).toBe('no_op');
  });

  it('reusing a key with a changed payload is a conflict, never a replay', () => {
    const state = emptyRegistry();
    const envelope = envelopeFor(V1, 'stage', 'replay-2');
    const first = stageCandidate(state, {
      envelope,
      outcome: runIngestionPipeline(envelope, context(state)),
      authority: testAuthority(),
      expectedRevision: 0,
      expectedActive: null,
    });
    expect(first.ok).toBe(true);

    // Same idempotency key, different artifact.
    const changed = envelopeFor(V2, 'stage', 'replay-2');
    const snapshot = JSON.stringify(first.state);
    const conflict = stageCandidate(first.state, {
      envelope: changed,
      outcome: runIngestionPipeline(changed, context(first.state)),
      authority: testAuthority(),
      expectedRevision: 1,
      expectedActive: null,
    });

    expect(conflict.ok).toBe(false);
    expect(codes(conflict.reasons)).toContain('REPLAY_PAYLOAD_MISMATCH');
    expect(conflict.state).toBe(first.state);
    expect(JSON.stringify(conflict.state)).toBe(snapshot);
    expect(conflict.event.event_type).toBe('conflict');
  });
});

describe('compare-and-swap atomicity', () => {
  it('a stale revision loses, and changes nothing', () => {
    const state = driveToActive(emptyRegistry(), V1, 'cas');
    const snapshot = JSON.stringify(state);

    const envelope = envelopeFor(V2, 'stage', 'cas-stale');
    const stale = stageCandidate(state, {
      envelope,
      outcome: runIngestionPipeline(envelope, context(state)),
      authority: testAuthority(),
      expectedRevision: state.revision - 1, // someone else moved first
      expectedActive: activeFor(state, 'development', 'synthetic_fixture'),
    });

    expect(stale.ok).toBe(false);
    expect(codes(stale.reasons)).toContain('REVISION_STALE');
    expect(stale.state).toBe(state);
    expect(JSON.stringify(stale.state)).toBe(snapshot);
  });

  it('an unexpected current active loses — a candidate replacement race', () => {
    let state = driveToActive(emptyRegistry(), V1, 'race');
    // V2 is staged and published, so only the active-identity expectation can fail.
    const stageEnvelope = envelopeFor(V2, 'stage', 'race-v2-stage');
    state = stageCandidate(state, {
      envelope: stageEnvelope,
      outcome: runIngestionPipeline(stageEnvelope, context(state)),
      authority: testAuthority(),
      expectedRevision: state.revision,
      expectedActive: activeFor(state, 'development', 'synthetic_fixture'),
    }).state;
    const publishEnvelope = envelopeFor(V2, 'publish', 'race-v2-publish');
    state = publishCandidate(state, {
      envelope: publishEnvelope,
      outcome: runIngestionPipeline(publishEnvelope, context(state)),
      authority: testAuthority(),
      expectedRevision: state.revision,
      expectedActive: activeFor(state, 'development', 'synthetic_fixture'),
    }).state;

    const snapshot = JSON.stringify(state);
    const activateEnvelope = envelopeFor(V2, 'activate', 'race-v2-activate');
    const raced = activateCandidate(state, {
      envelope: activateEnvelope,
      outcome: runIngestionPipeline(activateEnvelope, context(state)),
      authority: testAuthority(),
      expectedRevision: state.revision,
      expectedActive: null, // caller believes nothing is active; V1 actually is
    });

    expect(raced.ok).toBe(false);
    expect(codes(raced.reasons)).toContain('ACTIVE_IDENTITY_UNEXPECTED');
    expect(raced.state).toBe(state);
    expect(JSON.stringify(raced.state)).toBe(snapshot);
    // The genuinely active descriptor is untouched.
    expect(activeFor(raced.state, 'development', 'synthetic_fixture')).toEqual(identity(V1));
  });

  it('activation before publication is refused, leaving state unchanged', () => {
    const state = emptyRegistry();
    const stageEnvelope = envelopeFor(V1, 'stage', 'nopub-stage');
    const staged = stageCandidate(state, {
      envelope: stageEnvelope,
      outcome: runIngestionPipeline(stageEnvelope, context(state)),
      authority: testAuthority(),
      expectedRevision: 0,
      expectedActive: null,
    });
    const snapshot = JSON.stringify(staged.state);

    const activateEnvelope = envelopeFor(V1, 'activate', 'nopub-activate');
    const activated = activateCandidate(staged.state, {
      envelope: activateEnvelope,
      outcome: runIngestionPipeline(activateEnvelope, context(staged.state)),
      authority: testAuthority(),
      expectedRevision: staged.state.revision,
      expectedActive: null,
    });

    expect(activated.ok).toBe(false);
    expect(codes(activated.reasons)).toContain('ACTIVATION_BEFORE_PUBLICATION');
    expect(activated.state).toBe(staged.state);
    expect(JSON.stringify(activated.state)).toBe(snapshot);
    expect(activeFor(activated.state, 'development', 'synthetic_fixture')).toBeNull();
  });

  it('activating the already-active descriptor is refused as a duplicate selection', () => {
    const state = driveToActive(emptyRegistry(), V1, 'dup');
    const snapshot = JSON.stringify(state);
    const envelope = envelopeFor(V1, 'activate', 'dup-again');

    const again = activateCandidate(state, {
      envelope,
      outcome: runIngestionPipeline(envelope, context(state)),
      authority: testAuthority(),
      expectedRevision: state.revision,
      expectedActive: identity(V1),
    });

    expect(again.ok).toBe(false);
    expect(codes(again.reasons)).toContain('DUPLICATE_ACTIVE_SELECTION');
    expect(again.state).toBe(state);
    expect(JSON.stringify(again.state)).toBe(snapshot);
  });

  it('at most one descriptor is ever active per line and environment', () => {
    let state = driveToActive(emptyRegistry(), V1, 'single');
    state = driveToActive(state, V2, 'single2');
    const activeKeys = Object.keys(state.active).filter(key => key.endsWith('::synthetic_fixture'));
    expect(activeKeys).toHaveLength(1);
    expect(activeFor(state, 'development', 'synthetic_fixture')).toEqual(identity(V2));
  });
});

describe('last-known-good and rollback', () => {
  it('advances last-known-good only on a successful activation', () => {
    let state = driveToActive(emptyRegistry(), V1, 'lkg1');
    expect(lastKnownGoodFor(state, 'development', 'synthetic_fixture')).toBeNull();

    state = driveToActive(state, V2, 'lkg2');
    expect(activeFor(state, 'development', 'synthetic_fixture')).toEqual(identity(V2));
    expect(lastKnownGoodFor(state, 'development', 'synthetic_fixture')).toEqual(identity(V1));
  });

  it('rolls back to exactly the last-known-good identity', () => {
    let state = driveToActive(emptyRegistry(), V1, 'rb1');
    state = driveToActive(state, V2, 'rb2');

    const envelope = envelopeFor(V2, 'rollback', 'rb-do');
    envelope.rollback = {
      target: identity(V1),
      target_schema_version: V1.schema_version,
    };
    const priorRevision = state.revision;

    const rolled = rollbackToTarget(state, {
      envelope,
      outcome: runIngestionPipeline(envelope, context(state)),
      authority: testAuthority(),
      expectedRevision: state.revision,
      expectedActive: identity(V2),
    });

    expect(rolled.ok).toBe(true);
    expect(rolled.state.revision).toBe(priorRevision + 1);
    expect(activeFor(rolled.state, 'development', 'synthetic_fixture')).toEqual(identity(V1));
    expect(rolled.event.event_type).toBe('rollback');
    // Rolling back does not promote the thing we rolled away from.
    expect(lastKnownGoodFor(rolled.state, 'development', 'synthetic_fixture')).toEqual(
      identity(V1),
    );
  });

  it('a failed activation cannot overwrite last-known-good', () => {
    let state = driveToActive(emptyRegistry(), V1, 'keep1');
    state = driveToActive(state, V2, 'keep2');
    const lkgBefore = lastKnownGoodFor(state, 'development', 'synthetic_fixture');
    const snapshot = JSON.stringify(state);

    // A stale activation attempt, and an unexpected-active attempt.
    const envelope = envelopeFor(V1, 'activate', 'keep-fail');
    for (const attempt of [
      { expectedRevision: 0, expectedActive: identity(V2) },
      { expectedRevision: state.revision, expectedActive: null },
    ]) {
      const failed = activateCandidate(state, {
        envelope,
        outcome: runIngestionPipeline(envelope, context(state)),
        authority: testAuthority(),
        ...attempt,
      });
      expect(failed.ok).toBe(false);
      expect(failed.state).toBe(state);
      expect(JSON.stringify(failed.state)).toBe(snapshot);
      expect(lastKnownGoodFor(failed.state, 'development', 'synthetic_fixture')).toEqual(lkgBefore);
    }
  });

  it('a failed rollback cannot overwrite last-known-good or the active descriptor', () => {
    let state = driveToActive(emptyRegistry(), V1, 'rbfail1');
    state = driveToActive(state, V2, 'rbfail2');
    const snapshot = JSON.stringify(state);

    const envelope = envelopeFor(V2, 'rollback', 'rb-unknown');
    envelope.rollback = {
      // A target that was never registered.
      target: {
        artifact_id: 'synthetic_fixture',
        artifact_version: '9.9',
        sha256: `sha256:${'c'.repeat(64)}`,
      },
      target_schema_version: V2.schema_version,
    };

    const failed = rollbackToTarget(state, {
      envelope,
      outcome: runIngestionPipeline(envelope, context(state)),
      authority: testAuthority(),
      expectedRevision: state.revision,
      expectedActive: identity(V2),
    });

    expect(failed.ok).toBe(false);
    expect(codes(failed.reasons)).toContain('ROLLBACK_TARGET_UNKNOWN');
    expect(failed.state).toBe(state);
    expect(JSON.stringify(failed.state)).toBe(snapshot);
    expect(activeFor(failed.state, 'development', 'synthetic_fixture')).toEqual(identity(V2));
    expect(lastKnownGoodFor(failed.state, 'development', 'synthetic_fixture')).toEqual(
      identity(V1),
    );
  });
});
