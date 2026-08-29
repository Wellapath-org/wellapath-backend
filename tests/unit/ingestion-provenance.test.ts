/**
 * Provenance states, and the one substitution this whole subsystem exists to prevent.
 *
 * A matching digest proves the bytes are the bytes. It does not prove they were approved, that
 * their producer was authorised, or that anyone with authority ever looked at them. The producer's
 * own publication plan states this in as many words — *"an ingester that treats hash agreement as
 * governance evidence has skipped the governance check entirely"* — and this suite is the
 * enforcement of it.
 *
 * The three states are checked for being genuinely distinct, not merely differently named:
 * `claimed` is reachable by populating fields, `integrity_bound` additionally requires the digests
 * to match, and `verified` requires producer authority that no infrastructure can currently
 * establish. Every operation that changes what consumers receive requires `verified`, so all of
 * them fail closed.
 */
import { ArtifactDescriptor } from '../../src/manifest/contract';
import {
  AnyReasonCode,
  OPERATION_PROVENANCE_REQUIREMENT,
  PROVENANCE_STATES,
  PROVENANCE_STATE_RANK,
} from '../../src/manifest/ingestion/contract';
import { KB_INTEGRATION_PINS } from '../../src/manifest/ingestion/pins';
import { IngestionContext, runIngestionPipeline } from '../../src/manifest/ingestion/pipeline';
import { evaluateProvenance } from '../../src/manifest/ingestion/provenance';
import { emptyRegistry, registryView } from '../../src/manifest/registry/registry';
import { clone, syntheticDescriptor, syntheticEnvelope } from '../helpers/ingestion';

const context = (): IngestionContext => ({
  pins: KB_INTEGRATION_PINS,
  registry: registryView(emptyRegistry()),
  now: new Date('2026-08-29T00:00:00Z'),
  appBuild: 100,
});

const codes = (reasons: { code: AnyReasonCode }[]): AnyReasonCode[] =>
  reasons.map(reason => reason.code);

/** A production-like envelope: real trust mode, not synthetic, staging environment. */
const productionLike = (): ReturnType<typeof syntheticEnvelope> => {
  const envelope = clone(syntheticEnvelope());
  envelope.attestation.trust_mode = 'production';
  envelope.synthetic = false;
  envelope.environment = 'staging';
  (envelope.descriptor as ArtifactDescriptor).target_environments = ['staging'];
  return envelope;
};

describe('the three provenance states are distinct', () => {
  it('declares exactly three, strictly ordered', () => {
    expect([...PROVENANCE_STATES]).toEqual(['claimed', 'integrity_bound', 'verified']);
    expect(PROVENANCE_STATE_RANK.claimed).toBeLessThan(PROVENANCE_STATE_RANK.integrity_bound);
    expect(PROVENANCE_STATE_RANK.integrity_bound).toBeLessThan(PROVENANCE_STATE_RANK.verified);
  });

  it('populated fields alone reach claimed and no further', () => {
    const envelope = productionLike();
    // Well-formed fields, but a plan digest that does not match the pin.
    envelope.provenance.publication_plan_sha256 = '0'.repeat(64);

    const evaluation = evaluateProvenance(envelope, KB_INTEGRATION_PINS);
    expect(evaluation.state).toBe('claimed');
    expect(evaluation.established.fields_populated).toBe(true);
    expect(evaluation.established.digests_match).toBe(false);
    expect(evaluation.established.producer_authority_established).toBe(false);
  });

  it('matching digests reach integrity_bound, and stop there for production-like input', () => {
    const evaluation = evaluateProvenance(productionLike(), KB_INTEGRATION_PINS);
    expect(evaluation.state).toBe('integrity_bound');
    expect(evaluation.established.digests_match).toBe(true);
    // The decisive assertion: matching digests did NOT establish producer authority.
    expect(evaluation.established.producer_authority_established).toBe(false);
    expect(evaluation.operative).toBe(false);
  });

  it('production-like provenance can never become verified', () => {
    for (const operation of ['publish', 'activate', 'rollback'] as const) {
      const envelope = productionLike();
      envelope.requested_operation = operation;
      const evaluation = evaluateProvenance(envelope, KB_INTEGRATION_PINS);
      expect(evaluation.state).not.toBe('verified');
      expect(codes(evaluation.reasons)).toContain('PROVENANCE_NOT_VERIFIED');
    }
  });

  it('an operation requiring verified fails closed at the pipeline, not merely in the model', () => {
    const envelope = productionLike();
    envelope.requested_operation = 'publish';
    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.admissible).toBe(false);
    expect(codes(outcome.reasons)).toContain('PROVENANCE_NOT_VERIFIED');
    expect(outcome.reached).not.toContain('provenance_verified');
  });

  it('the synthetic test mode may traverse to verified, and is still non-operative', () => {
    const envelope = clone(syntheticEnvelope({ operation: 'publish' }));
    const evaluation = evaluateProvenance(envelope, KB_INTEGRATION_PINS);
    expect(evaluation.state).toBe('verified');
    // Exercising the transition is not the same as having verified anything.
    expect(evaluation.operative).toBe(false);
  });

  it('populated repository and commit fields alone never confer trusted source authorization', () => {
    const envelope = productionLike();
    // Every provenance field correct and matching the pin.
    expect(envelope.provenance.source_repository).toBe(KB_INTEGRATION_PINS.source_repository);
    expect(envelope.provenance.source_commit).toBe(KB_INTEGRATION_PINS.source_commit);

    const evaluation = evaluateProvenance(envelope, KB_INTEGRATION_PINS);
    expect(evaluation.state).toBe('integrity_bound');
    expect(evaluation.established.producer_authority_established).toBe(false);
  });

  it('every consequential operation requires verified; only staging does not', () => {
    expect(OPERATION_PROVENANCE_REQUIREMENT.stage).toBe('integrity_bound');
    expect(OPERATION_PROVENANCE_REQUIREMENT.publish).toBe('verified');
    expect(OPERATION_PROVENANCE_REQUIREMENT.activate).toBe('verified');
    expect(OPERATION_PROVENANCE_REQUIREMENT.rollback).toBe('verified');
  });
});

describe('hash agreement is never governance', () => {
  /** Every digest correct, every approval outstanding. The exact substitution being prevented. */
  const allHashesMatchNothingApproved = (): ReturnType<typeof syntheticEnvelope> => {
    const descriptor = syntheticDescriptor();
    descriptor.approvals.product = {
      required: true,
      status: 'pending',
      decision_ref: null,
      approved_at: null,
      decision_scope: null,
    };
    descriptor.approvals.clinical = {
      required: true,
      status: 'pending',
      decision_ref: null,
      approved_at: null,
      decision_scope: null,
    };
    descriptor.release_status = 'candidate';
    descriptor.published_at = null;
    descriptor.publication_decision_ref = null;
    descriptor.activation_authorized = false;
    descriptor.activation_decision_ref = null;
    return syntheticEnvelope({ descriptor, operation: 'stage' });
  };

  it('the artifact digest matches, and the descriptor is still unapproved', () => {
    const envelope = allHashesMatchNothingApproved();
    const descriptor = envelope.descriptor as ArtifactDescriptor;

    // Byte identity holds exactly.
    expect(envelope.identity.sha256).toBe(descriptor.sha256);
    expect(envelope.byte_count).toBe(descriptor.byte_count);
    // Provenance is integrity-bound or better.
    const evaluation = evaluateProvenance(envelope, KB_INTEGRATION_PINS);
    expect(['integrity_bound', 'verified']).toContain(evaluation.state);

    // And none of that granted anything.
    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.admissible).toBe(false);
    expect(codes(outcome.reasons)).toContain('APPROVAL_NOT_GRANTED');
  });

  it.each([
    ['artifact sha256', 'establishes byte identity only'],
    ['publication plan sha256', 'establishes plan identity only'],
    ['governance register sha256', 'establishes register-byte identity only'],
  ])('a matching %s %s — it grants no approval', (_which, _what) => {
    const envelope = allHashesMatchNothingApproved();
    const descriptor = envelope.descriptor as ArtifactDescriptor;

    // All three digests agree with what this implementation holds.
    expect(envelope.provenance.publication_plan_sha256).toBe(
      KB_INTEGRATION_PINS.publication_plans['token_dictionary.ng.v2.0.dryrun'].sha256,
    );
    expect(envelope.provenance.governance_register_sha256).toBe(
      KB_INTEGRATION_PINS.governance.decision_register_v1.sha256,
    );
    expect(envelope.identity.sha256).toBe(descriptor.sha256);

    const outcome = runIngestionPipeline(envelope, context());

    // Product approval: not granted.
    expect(
      outcome.reasons.some(
        reason => reason.code === 'APPROVAL_NOT_GRANTED' && reason.path.includes('product'),
      ),
    ).toBe(true);
    // Clinical approval: not granted.
    expect(
      outcome.reasons.some(
        reason => reason.code === 'APPROVAL_NOT_GRANTED' && reason.path.includes('clinical'),
      ),
    ).toBe(true);
    // Not eligible.
    expect(outcome.admissible).toBe(false);
  });

  it('publication authorization is not conferred by any digest agreement', () => {
    const envelope = allHashesMatchNothingApproved();
    envelope.requested_operation = 'publish';
    envelope.authorizations.publication_decision_ref = null;

    // This envelope runs in the synthetic test mode, so provenance reaches `verified` and the
    // refusal comes from governance itself — which is the sharper demonstration: every digest
    // agrees, provenance is as good as it can get, and publication is still refused.
    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.admissible).toBe(false);
    expect(codes(outcome.reasons)).toContain('PUBLICATION_NOT_AUTHORIZED');
    expect(codes(outcome.reasons)).toContain('PUBLICATION_NOT_PERFORMED');
  });

  it('activation authorization is not conferred by any digest agreement', () => {
    const envelope = allHashesMatchNothingApproved();
    envelope.requested_operation = 'activate';
    envelope.authorizations.activation_decision_ref = null;

    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.admissible).toBe(false);
  });

  it('actor authority is not proved by any digest agreement', () => {
    const envelope = allHashesMatchNothingApproved();
    // Every hash matches; the actor is simply absent.
    envelope.provenance.actor_ref = '';

    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.admissible).toBe(false);
    expect(codes(outcome.reasons)).toContain('PROVENANCE_ACTOR_MISSING');
  });

  it('only a correctly scoped approval record contributes to approved', () => {
    const envelope = allHashesMatchNothingApproved();
    const descriptor = envelope.descriptor as ArtifactDescriptor;

    // A decision scoped elsewhere does not count, however real it is.
    descriptor.approvals.product = {
      required: true,
      status: 'granted',
      decision_ref: 'a complete product display decision',
      approved_at: '2026-08-29T00:00:00Z',
      decision_scope: ['product_display'],
    };
    expect(codes(runIngestionPipeline(envelope, context()).reasons)).toContain(
      'APPROVAL_SCOPE_MISMATCH',
    );

    // Correctly scoped, it does.
    descriptor.approvals.product.decision_scope = ['artifact_publication'];
    descriptor.approvals.clinical = {
      required: true,
      status: 'granted',
      decision_ref: 'a clinical sign-off scoped to publication',
      approved_at: '2026-08-29T00:00:00Z',
      decision_scope: ['artifact_publication'],
    };
    descriptor.release_status = 'published';
    descriptor.published_at = '2026-08-29T00:00:00Z';
    descriptor.activation_authorized = true;
    descriptor.activation_decision_ref = 'SYNTHETIC-ACT-001 (test fixture)';
    descriptor.publication_decision_ref = 'SYNTHETIC-PUB-001 (test fixture)';

    const outcome = runIngestionPipeline(envelope, context());
    expect(codes(outcome.reasons)).not.toContain('APPROVAL_NOT_GRANTED');
    expect(outcome.admissible).toBe(true);
  });
});

describe('the plan provenance block is informational only', () => {
  it('cannot supply the source commit the envelope must supply itself', () => {
    const envelope = clone(syntheticEnvelope());
    envelope.provenance.source_commit = '';
    // A rich, entirely correct plan block does not fill the gap.
    envelope.plan_source_provenance = {
      decision_register_sha256: KB_INTEGRATION_PINS.governance.decision_register_v1.sha256,
      repository_branch_cited: false,
      kinds: ['ingestion_boundary', 'decision_record_provenance'],
    };

    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.admissible).toBe(false);
    expect(codes(outcome.reasons)).toContain('PROVENANCE_MISSING');
  });

  it('cannot self-certify its producer or authorization', () => {
    const envelope = clone(syntheticEnvelope());
    envelope.provenance.actor_ref = '';
    envelope.provenance.authorization_ref = '';
    envelope.plan_source_provenance = {
      decision_register_sha256: KB_INTEGRATION_PINS.governance.decision_register_v1.sha256,
      repository_branch_cited: false,
      kinds: ['generator_input_identity', 'publication_plan_provenance'],
    };

    const outcome = runIngestionPipeline(envelope, context());
    expect(codes(outcome.reasons)).toContain('PROVENANCE_ACTOR_MISSING');
    expect(codes(outcome.reasons)).toContain('PROVENANCE_AUTHORIZATION_MISSING');
  });

  it('a null plan block is legitimate: it is informational, not required evidence', () => {
    const envelope = clone(syntheticEnvelope());
    envelope.plan_source_provenance = null;
    const outcome = runIngestionPipeline(envelope, context());
    expect(outcome.reasons).toEqual([]);
    expect(outcome.admissible).toBe(true);
  });

  it('its narrative is never copied into an approval slot', () => {
    const envelope = clone(syntheticEnvelope());
    const descriptor = envelope.descriptor as ArtifactDescriptor;
    const approvals = JSON.stringify(descriptor.approvals);
    for (const kind of envelope.plan_source_provenance?.kinds ?? []) {
      expect(approvals).not.toContain(kind);
    }
    expect(approvals).not.toContain('provenance');
    expect(approvals).not.toContain('ingestion_boundary');
  });
});

describe('the KB re-pin advanced as a whole', () => {
  it('both publication plans are pinned at the Step 3B digests', () => {
    expect(KB_INTEGRATION_PINS.source_commit).toBe('1f1b8dd0bf9cadf8b210aba16bfa516603444130');
    expect(KB_INTEGRATION_PINS.publication_plans['token_dictionary.ng.v2.0.dryrun'].sha256).toBe(
      'df262e9eef6886d71a19cdca7ae81048dcf46e38771ea88d17fd92ceeaef6681',
    );
    expect(KB_INTEGRATION_PINS.publication_plans['question_flow.ng.v1.1.dryrun'].sha256).toBe(
      '2ae4b69471725a8a24e669f3f22406821e6f1d0957ed9bfda482e94a9dd05d48',
    );
  });

  it('no pin still carries a superseded Step 3 digest', () => {
    const superseded = [
      '7f70788658d4d49e77e858465f931a0913e16c261e32045ebf6433829d2864aa',
      '947c810cca92acb2dce4916272d7d7eca432cc879e3a36f289fb850f1bd99413',
      'a4069eb582d4c4d34da626dd6ffbb37a44287ddf0d2a20775bbd5ee603906d81',
      'c6ea18ec68cf3b46d5722ad0c00cbe4c53cf3d3ba7746097138c963eeb82d354',
    ];
    const serialised = JSON.stringify(KB_INTEGRATION_PINS);
    for (const digest of superseded) {
      expect(serialised).not.toContain(digest);
    }
    expect(serialised).not.toContain('77beffec2f7c8612a3760af30659a299ce2820a3');
  });

  it('the governance register is pinned and unchanged across the re-pin', () => {
    expect(KB_INTEGRATION_PINS.governance.decision_register_v1.sha256).toBe(
      '0848fbd3f6a577e936c322523bfb47419b40a4e774e76f56f0620e8b93705735',
    );
    expect(KB_INTEGRATION_PINS.governance.decision_register_v1.byte_count).toBe(13421);
  });
});
