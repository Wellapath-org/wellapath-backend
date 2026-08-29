/**
 * The two real blocked candidates cannot reach staging — proven gate by gate.
 *
 * `token_dictionary` 2.0 and `question_flow` 1.1 are refused as they stand. That single fact is
 * weak evidence on its own: a candidate blocked by one condition tells you nothing about the
 * others, and a fixture that happens to fail early can hide a gate that would not have held. So
 * each disqualifying condition is isolated here by lifting every *earlier* gate and showing the
 * condition still refuses on its own.
 *
 * Nothing in this file alters a fixture to manufacture eligibility. The lifted variants are
 * hypotheticals constructed inside the test; the committed descriptors are never written to.
 */
import { ArtifactDescriptor, Environment } from '../../src/manifest/contract';
import { AnyReasonCode } from '../../src/manifest/ingestion/contract';
import { KB_INTEGRATION_PINS } from '../../src/manifest/ingestion/pins';
import { IngestionContext, runIngestionPipeline } from '../../src/manifest/ingestion/pipeline';
import { emptyRegistry, registryView, stageCandidate } from '../../src/manifest/registry/registry';
import { blockedCandidate, buildEnvelope, clone, testAuthority } from '../helpers/ingestion';

const ENVIRONMENTS: readonly Environment[] = ['development', 'staging', 'production'];

const context = (overrides: Partial<IngestionContext> = {}): IngestionContext => ({
  pins: KB_INTEGRATION_PINS,
  registry: registryView(emptyRegistry()),
  now: new Date('2026-08-29T00:00:00Z'),
  appBuild: 100,
  ...overrides,
});

const codes = (reasons: { code: AnyReasonCode }[]): AnyReasonCode[] =>
  reasons.map(reason => reason.code);

describe.each(['token_dictionary', 'question_flow'])(
  'blocked candidate %s cannot reach staging',
  artifactId => {
    it('is refused at governance_verified, before any staging occurs', () => {
      const descriptor = blockedCandidate(artifactId);
      const envelope = buildEnvelope({ descriptor, operation: 'stage' });

      const outcome = runIngestionPipeline(envelope, context());

      expect(outcome.stage).toBe('rejected');
      expect(outcome.admissible).toBe(false);
      // It got as far as provenance — the refusal is governance, not a malformed envelope.
      expect(outcome.reached).toEqual([
        'received',
        'envelope_validated',
        'contract_validated',
        'provenance_verified',
      ]);
      expect(outcome.reached).not.toContain('staged');
      expect(codes(outcome.reasons)).toContain('APPROVAL_NOT_GRANTED');
      expect(outcome.reasons.every(reason => reason.stage === 'governance_verified')).toBe(true);
    });

    it('is refused in every environment, not merely in staging', () => {
      for (const environment of ENVIRONMENTS) {
        const envelope = buildEnvelope({
          descriptor: blockedCandidate(artifactId),
          operation: 'stage',
          environment,
        });
        const outcome = runIngestionPipeline(envelope, context());
        expect(outcome.admissible).toBe(false);
        expect(outcome.stage).toBe('rejected');
      }
    });

    it('the registry refuses to stage it and is left byte-for-byte unchanged', () => {
      const before = emptyRegistry();
      const snapshot = JSON.stringify(before);
      const envelope = buildEnvelope({ descriptor: blockedCandidate(artifactId) });
      const outcome = runIngestionPipeline(envelope, context());

      const result = stageCandidate(before, {
        envelope,
        outcome,
        authority: testAuthority(),
        expectedRevision: 0,
        expectedActive: null,
      });

      expect(result.ok).toBe(false);
      expect(result.state).toBe(before);
      expect(JSON.stringify(result.state)).toBe(snapshot);
      expect(result.state.staged).toEqual([]);
      expect(result.state.revision).toBe(0);
      expect(result.event.outcome).toBe('refused');
    });

    it('Product artifact-publication approval is pending, and that alone disqualifies it', () => {
      const descriptor = blockedCandidate(artifactId);
      expect(descriptor.approvals.product.status).toBe('pending');

      // Lift everything except the Product approval.
      const lifted = clone(descriptor);
      lifted.approvals.clinical = {
        required: true,
        status: 'granted',
        decision_ref: 'hypothetical clinical sign-off (test only)',
        approved_at: '2026-08-29T00:00:00Z',
        decision_scope: ['artifact_publication'],
      };
      lifted.blockers = lifted.blockers.map(blocker => ({ ...blocker, status: 'resolved' }));

      const outcome = runIngestionPipeline(
        buildEnvelope({ descriptor: lifted, operation: 'stage' }),
        context(),
      );
      expect(outcome.admissible).toBe(false);
      const productReasons = outcome.reasons.filter(
        reason => reason.code === 'APPROVAL_NOT_GRANTED' && reason.path.includes('product'),
      );
      expect(productReasons.length).toBeGreaterThan(0);
    });

    it('Clinical approval is pending, and that alone disqualifies it', () => {
      const descriptor = blockedCandidate(artifactId);
      expect(descriptor.approvals.clinical.status).toBe('pending');

      const lifted = clone(descriptor);
      lifted.approvals.product = {
        required: true,
        status: 'granted',
        decision_ref: 'hypothetical publication approval (test only)',
        approved_at: '2026-08-29T00:00:00Z',
        decision_scope: ['artifact_publication'],
      };
      lifted.blockers = lifted.blockers.map(blocker => ({ ...blocker, status: 'resolved' }));

      const outcome = runIngestionPipeline(
        buildEnvelope({ descriptor: lifted, operation: 'stage' }),
        context(),
      );
      expect(outcome.admissible).toBe(false);
      const clinicalReasons = outcome.reasons.filter(
        reason => reason.code === 'APPROVAL_NOT_GRANTED' && reason.path.includes('clinical'),
      );
      expect(clinicalReasons.length).toBeGreaterThan(0);
    });

    it('publication was not performed, and publication authorization is absent', () => {
      const descriptor = blockedCandidate(artifactId);
      expect(descriptor.release_status).toBe('candidate');
      expect(descriptor.published_at).toBeNull();
      expect(descriptor.publication_decision_ref).toBeNull();

      // Ask to publish, with every approval hypothetically granted and blockers resolved.
      const lifted = fullyApproved(descriptor);
      const outcome = runIngestionPipeline(
        buildEnvelope({ descriptor: lifted, operation: 'publish' }),
        context(),
      );

      expect(outcome.admissible).toBe(false);
      expect(codes(outcome.reasons)).toContain('PUBLICATION_NOT_PERFORMED');
      expect(codes(outcome.reasons)).toContain('PUBLICATION_NOT_AUTHORIZED');
    });

    it('activation authorization is absent even once publication is hypothetically complete', () => {
      const lifted = fullyApproved(blockedCandidate(artifactId));
      lifted.release_status = 'published';
      lifted.published_at = '2026-08-29T00:00:00Z';

      const outcome = runIngestionPipeline(
        buildEnvelope({
          descriptor: lifted,
          operation: 'activate',
          publicationRef: 'hypothetical publication decision (test only)',
        }),
        context(),
      );

      expect(outcome.admissible).toBe(false);
      expect(codes(outcome.reasons)).toContain('ACTIVATION_NOT_AUTHORIZED');
    });

    it('signature policy is unavailable, so even a fully-governed envelope fails closed', () => {
      // Every governance gate lifted; only attestation remains. This is the last line of defence
      // and it must hold on its own.
      const lifted = fullyApproved(blockedCandidate(artifactId));
      lifted.release_status = 'published';
      lifted.published_at = '2026-08-29T00:00:00Z';
      lifted.activation_authorized = true;
      lifted.activation_decision_ref = 'hypothetical activation decision (test only)';

      const outcome = runIngestionPipeline(
        buildEnvelope({
          descriptor: lifted,
          operation: 'activate',
          publicationRef: 'hypothetical publication decision (test only)',
          activationRef: 'hypothetical activation decision (test only)',
          trustMode: 'production',
        }),
        context(),
      );

      expect(outcome.reached).toContain('governance_verified');
      expect(outcome.admissible).toBe(false);
      expect(outcome.stage).toBe('rejected');
      expect(codes(outcome.reasons)).toContain('SIGNATURE_POLICY_UNAVAILABLE');
      expect(outcome.attestation?.operative).toBe(false);
      expect(outcome.attestation?.verified).toBe(false);
    });
  },
);

/** Hypothetically grants every approval and resolves every blocker. Test-local only. */
const fullyApproved = (descriptor: ArtifactDescriptor): ArtifactDescriptor => {
  const lifted = clone(descriptor);
  lifted.approvals.product = {
    required: true,
    status: 'granted',
    decision_ref: 'hypothetical publication approval (test only)',
    approved_at: '2026-08-29T00:00:00Z',
    decision_scope: ['artifact_publication'],
  };
  lifted.approvals.clinical = {
    required: true,
    status: 'granted',
    decision_ref: 'hypothetical clinical sign-off (test only)',
    approved_at: '2026-08-29T00:00:00Z',
    decision_scope: ['artifact_publication'],
  };
  lifted.blockers = lifted.blockers.map(blocker => ({ ...blocker, status: 'resolved' }));
  return lifted;
};

describe('question_flow retains both open blockers and IM-003 disabled', () => {
  const descriptor = blockedCandidate('question_flow');

  it('both blockers are still open in the committed fixture', () => {
    const open = descriptor.blockers.filter(blocker => blocker.status === 'open');
    expect(open.map(blocker => blocker.id).sort()).toEqual(['IM001-CLIN-FLAG-001', 'IM003-SB-001']);
  });

  it('IM-003 is recorded as disabled and activation remains unauthorized', () => {
    const references = (descriptor.references ?? []).join('\n');
    expect(references).toContain('IM-003');
    expect(references).toMatch(/disabled/i);
    expect(references).toMatch(/unauthorized/i);
    expect(descriptor.activation_authorized).toBe(false);
  });

  it('an open blocker alone refuses ingestion, with every approval hypothetically granted', () => {
    const lifted = clone(descriptor);
    lifted.approvals.product = {
      required: true,
      status: 'granted',
      decision_ref: 'hypothetical publication approval (test only)',
      approved_at: '2026-08-29T00:00:00Z',
      decision_scope: ['artifact_publication'],
    };
    lifted.approvals.clinical = {
      required: true,
      status: 'granted',
      decision_ref: 'hypothetical clinical sign-off (test only)',
      approved_at: '2026-08-29T00:00:00Z',
      decision_scope: ['artifact_publication'],
    };
    // Blockers deliberately left open.

    const outcome = runIngestionPipeline(
      buildEnvelope({ descriptor: lifted, operation: 'stage' }),
      context(),
    );
    expect(outcome.admissible).toBe(false);
    expect(codes(outcome.reasons)).toContain('BLOCKER_UNRESOLVED');
  });
});

describe('token_dictionary 2.0 rollback policy is unresolved', () => {
  it('a cross-schema rollback is refused, and no rollback target is invented', () => {
    // 2.0 declares schema 2.0; its predecessor 1.1 declares the implicit schema 1.0. The KB
    // records this as KB_ROLLBACK_SCHEMA_INCOMPATIBLE and no policy has been approved either side.
    const descriptor = blockedCandidate('token_dictionary');
    expect(descriptor.rollback_target).toBeNull();

    const envelope = buildEnvelope({ descriptor, operation: 'rollback' });
    envelope.rollback = {
      target: {
        artifact_id: 'token_dictionary',
        artifact_version: '1.1',
        sha256: 'sha256:0cc47ad9537c0bd4c6ef3aec8f1931eb9b4c62103a8809d16544f94a90b5c019',
      },
      target_schema_version: 'wellapath.artifact/0',
    };
    envelope.authorizations.rollback_decision_ref = 'hypothetical rollback decision (test only)';

    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.admissible).toBe(false);
    expect(codes(outcome.reasons)).toContain('ROLLBACK_SCHEMA_INCOMPATIBLE');
    expect(codes(outcome.reasons)).toContain('ROLLBACK_POLICY_UNRESOLVED');
  });

  it('an unauthorized rollback is refused before any target is even considered', () => {
    const envelope = buildEnvelope({
      descriptor: blockedCandidate('token_dictionary'),
      operation: 'rollback',
    });
    const outcome = runIngestionPipeline(envelope, context());
    expect(codes(outcome.reasons)).toContain('ROLLBACK_NOT_AUTHORIZED');
    expect(codes(outcome.reasons)).toContain('ROLLBACK_TARGET_UNKNOWN');
  });
});
