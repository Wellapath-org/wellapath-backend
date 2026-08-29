/**
 * Negative ingestion fixtures — each fails at its declared stage with its declared reason code.
 *
 * Every case starts from the same admissible synthetic envelope and applies exactly one mutation,
 * so a failure is attributable: the case proves that *this* condition refuses, not that some
 * unrelated part of the fixture happened to be wrong. A case that passes, or fails at a different
 * stage, or fails for a different code, fails this suite.
 *
 * These are mutation and state-transition tests, not schema validation dressed up as coverage:
 * roughly half operate on the registry's compare-and-swap rather than on the document.
 */
import {
  AnyReasonCode,
  IngestionEnvelope,
  PipelineStage,
} from '../../src/manifest/ingestion/contract';
import { KB_INTEGRATION_PINS } from '../../src/manifest/ingestion/pins';
import { IngestionContext, runIngestionPipeline } from '../../src/manifest/ingestion/pipeline';
import {
  RegistryState,
  activateCandidate,
  emptyRegistry,
  publishCandidate,
  registryView,
  stageCandidate,
} from '../../src/manifest/registry/registry';
import { clone, syntheticDescriptor, syntheticEnvelope, testAuthority } from '../helpers/ingestion';

const baseContext = (state: RegistryState = emptyRegistry()): IngestionContext => ({
  pins: KB_INTEGRATION_PINS,
  registry: registryView(state),
  now: new Date('2026-08-29T00:00:00Z'),
  appBuild: 100,
});

/** A mutation applied to an otherwise admissible envelope. */
interface Case {
  name: string;
  stage: PipelineStage;
  code: AnyReasonCode;
  mutate: (envelope: IngestionEnvelope) => void;
  context?: () => IngestionContext;
}

const cases: Case[] = [
  /* ------------------------------------------------------- envelope_validated */
  {
    name: 'unknown envelope major version is refused',
    stage: 'envelope_validated',
    code: 'ENVELOPE_VERSION_UNSUPPORTED',
    mutate: envelope => {
      envelope.envelope_version = '2.0.0';
    },
  },
  {
    name: 'a non-semver envelope version is refused',
    stage: 'envelope_validated',
    code: 'ENVELOPE_VERSION_UNSUPPORTED',
    mutate: envelope => {
      envelope.envelope_version = 'v1';
    },
  },
  {
    name: 'an unknown envelope field is refused, never ignored',
    stage: 'envelope_validated',
    code: 'ENVELOPE_UNKNOWN_FIELD',
    mutate: envelope => {
      (envelope as unknown as Record<string, unknown>).force_publish = true;
    },
  },
  {
    name: 'a missing required envelope field is refused',
    stage: 'envelope_validated',
    code: 'ENVELOPE_MISSING_FIELD',
    mutate: envelope => {
      delete (envelope as unknown as Record<string, unknown>).environment;
    },
  },
  {
    name: 'an invalid operation is refused',
    stage: 'envelope_validated',
    code: 'OPERATION_INVALID',
    mutate: envelope => {
      (envelope as unknown as Record<string, unknown>).requested_operation = 'delete';
    },
  },
  {
    name: 'a missing idempotency key is refused',
    stage: 'envelope_validated',
    code: 'IDEMPOTENCY_KEY_MISSING',
    mutate: envelope => {
      (envelope as unknown as Record<string, unknown>).idempotency_key = '';
    },
  },
  {
    name: 'a malformed idempotency key is refused',
    stage: 'envelope_validated',
    code: 'IDEMPOTENCY_KEY_MALFORMED',
    mutate: envelope => {
      envelope.idempotency_key = 'short';
    },
  },

  /* -------------------------------------------------------- contract_validated */
  {
    name: 'a mismatched manifest contract version is refused',
    stage: 'contract_validated',
    code: 'CONTRACT_VERSION_MISMATCH',
    mutate: envelope => {
      envelope.manifest_contract_version = '1.0.0';
    },
  },
  {
    name: 'contract schema hash drift is refused',
    stage: 'contract_validated',
    code: 'CONTRACT_PIN_DRIFT',
    mutate: envelope => {
      envelope.manifest_schema_sha256 = `sha256:${'0'.repeat(64)}`;
    },
  },
  {
    name: 'contract schema byte-count drift is refused',
    stage: 'contract_validated',
    code: 'CONTRACT_PIN_DRIFT',
    mutate: envelope => {
      envelope.manifest_schema_byte_count = 7807;
    },
  },
  {
    name: 'approval-scope substitution is refused at contract validation',
    stage: 'contract_validated',
    code: 'APPROVAL_SCOPE_MISMATCH',
    mutate: envelope => {
      const descriptor = envelope.descriptor as ReturnType<typeof syntheticDescriptor>;
      descriptor.approvals.product = {
        required: true,
        status: 'granted',
        decision_ref: 'a complete display decision',
        approved_at: '2026-08-29T00:00:00Z',
        decision_scope: ['product_display'],
      };
    },
  },
  {
    name: 'a granted approval with no recorded scope is refused',
    stage: 'contract_validated',
    code: 'APPROVAL_SCOPE_MISSING',
    mutate: envelope => {
      const descriptor = envelope.descriptor as ReturnType<typeof syntheticDescriptor>;
      descriptor.approvals.product.decision_scope = null;
    },
  },

  /* ------------------------------------------------------- provenance_verified */
  {
    name: 'absent provenance is refused',
    stage: 'provenance_verified',
    code: 'PROVENANCE_MISSING',
    mutate: envelope => {
      (envelope as unknown as Record<string, unknown>).provenance = null;
    },
  },
  {
    name: 'an empty provenance field is refused',
    stage: 'provenance_verified',
    code: 'PROVENANCE_MISSING',
    mutate: envelope => {
      envelope.provenance.generator = '';
    },
  },
  {
    name: 'a producing commit other than the pinned one is refused',
    stage: 'provenance_verified',
    code: 'KB_SOURCE_MISMATCH',
    mutate: envelope => {
      envelope.provenance.source_commit = 'c1b07944ea0b231914943ac17b2265441e53b85c';
    },
  },
  {
    name: 'a branch name in place of a commit id is refused as a mutable reference',
    stage: 'provenance_verified',
    code: 'PROVENANCE_SOURCE_MUTABLE_REFERENCE',
    mutate: envelope => {
      envelope.provenance.source_commit = 'develop';
    },
  },
  {
    name: 'a symbolic ref is refused as a mutable reference',
    stage: 'provenance_verified',
    code: 'PROVENANCE_SOURCE_MUTABLE_REFERENCE',
    mutate: envelope => {
      envelope.provenance.source_commit = 'HEAD';
    },
  },
  {
    name: 'a truncated commit id is refused',
    stage: 'provenance_verified',
    code: 'KB_SOURCE_MISMATCH',
    mutate: envelope => {
      envelope.provenance.source_commit = '1f1b8dd';
    },
  },
  {
    name: 'a missing actor is refused',
    stage: 'provenance_verified',
    code: 'PROVENANCE_ACTOR_MISSING',
    mutate: envelope => {
      envelope.provenance.actor_ref = '';
    },
  },
  {
    name: 'a missing ingestion authorization is refused',
    stage: 'provenance_verified',
    code: 'PROVENANCE_AUTHORIZATION_MISSING',
    mutate: envelope => {
      envelope.provenance.authorization_ref = '';
    },
  },
  {
    name: 'a governance-register digest that differs from the pin is refused',
    stage: 'provenance_verified',
    code: 'GOVERNANCE_REGISTER_HASH_MISMATCH',
    mutate: envelope => {
      envelope.provenance.governance_register_sha256 = '1'.repeat(64);
    },
  },
  {
    name: 'envelope and plan naming different governance registers is a contradiction',
    stage: 'provenance_verified',
    code: 'PROVENANCE_CONTRADICTION',
    mutate: envelope => {
      envelope.provenance.governance_register_sha256 =
        '0848fbd3f6a577e936c322523bfb47419b40a4e774e76f56f0620e8b93705735';
      // The plan block names a register the envelope does not.
      envelope.plan_source_provenance = {
        decision_register_sha256:
          '0848fbd3f6a577e936c322523bfb47419b40a4e774e76f56f0620e8b93705735',
        repository_branch_cited: false,
        kinds: ['decision_record_provenance'],
      };
      envelope.provenance.governance_register_sha256 = '2'.repeat(64);
    },
  },
  {
    name: 'a plan citing a mutable branch tip as its own source is refused',
    stage: 'provenance_verified',
    code: 'PROVENANCE_SOURCE_MUTABLE_REFERENCE',
    mutate: envelope => {
      envelope.plan_source_provenance = {
        decision_register_sha256: null,
        repository_branch_cited: true,
        kinds: ['repository_branch_state'],
      };
    },
  },
  {
    name: 'an unknown source-provenance kind is refused, never ignored',
    stage: 'provenance_verified',
    code: 'SOURCE_PROVENANCE_KIND_UNKNOWN',
    mutate: envelope => {
      envelope.plan_source_provenance = {
        decision_register_sha256: null,
        repository_branch_cited: false,
        kinds: ['artifact_byte_identity', 'producer_self_attestation'],
      };
    },
  },
  {
    name: 'a malformed source-provenance block is refused',
    stage: 'provenance_verified',
    code: 'SOURCE_PROVENANCE_MALFORMED',
    mutate: envelope => {
      envelope.plan_source_provenance = {
        decision_register_sha256: null,
        repository_branch_cited: false,
        kinds: [],
      };
    },
  },
  {
    name: 'a descriptor that is not the one the envelope names is refused',
    stage: 'provenance_verified',
    code: 'DESCRIPTOR_REFERENCE_MISMATCH',
    mutate: envelope => {
      envelope.identity.artifact_version = '9.9';
      envelope.object_key = 'synthetic_fixture.zz.v9.9.json';
    },
  },
  {
    name: 'a stale KB commit carrying a current plan hash is refused',
    stage: 'provenance_verified',
    code: 'KB_SOURCE_MISMATCH',
    mutate: envelope => {
      envelope.provenance.source_commit = '77beffec2f7c8612a3760af30659a299ce2820a3';
    },
  },
  {
    name: 'a current KB commit carrying a stale plan hash is refused',
    stage: 'provenance_verified',
    code: 'PLAN_HASH_MISMATCH',
    mutate: envelope => {
      // The Step 3 hash for the same plan, superseded by the Step 3B re-pin.
      envelope.provenance.publication_plan_sha256 =
        '7f70788658d4d49e77e858465f931a0913e16c261e32045ebf6433829d2864aa';
    },
  },
  {
    name: 'only one candidate plan re-pinned leaves the other plan hash stale',
    stage: 'provenance_verified',
    code: 'PLAN_HASH_MISMATCH',
    mutate: envelope => {
      envelope.provenance.publication_plan_id = 'question_flow.ng.v1.1.dryrun';
      // Its Step 3 hash: the question_flow plan was not advanced with the token_dictionary one.
      envelope.provenance.publication_plan_sha256 =
        '947c810cca92acb2dce4916272d7d7eca432cc879e3a36f289fb850f1bd99413';
    },
  },
  {
    name: 'provenance merely integrity-bound is refused where verified is required',
    stage: 'provenance_verified',
    code: 'PROVENANCE_NOT_VERIFIED',
    mutate: envelope => {
      envelope.requested_operation = 'publish';
      envelope.attestation.trust_mode = 'production';
      envelope.synthetic = false;
      envelope.environment = 'staging';
      (envelope.descriptor as ReturnType<typeof syntheticDescriptor>).target_environments = [
        'staging',
      ];
    },
  },
  {
    name: 'an unexpected producing repository is refused',
    stage: 'provenance_verified',
    code: 'KB_SOURCE_MISMATCH',
    mutate: envelope => {
      envelope.provenance.source_repository = 'someone-else/wellapath-knowledge-base';
    },
  },
  {
    name: 'an unknown publication plan is refused',
    stage: 'provenance_verified',
    code: 'PLAN_HASH_MISMATCH',
    mutate: envelope => {
      envelope.provenance.publication_plan_id = 'not_a_known_plan';
    },
  },
  {
    name: 'a publication plan whose digest differs from the pin is refused',
    stage: 'provenance_verified',
    code: 'PLAN_HASH_MISMATCH',
    mutate: envelope => {
      envelope.provenance.publication_plan_sha256 = '0'.repeat(64);
    },
  },
  {
    // A mutable alias never even reaches provenance: the manifest contract's own object-key
    // pattern requires a numeric version, so `vlatest` is refused as a malformed key first.
    name: 'a mutable object-key alias is refused by the contract itself',
    stage: 'contract_validated',
    code: 'OBJECT_KEY_INVALID',
    mutate: envelope => {
      const descriptor = envelope.descriptor as ReturnType<typeof syntheticDescriptor>;
      envelope.object_key = 'synthetic_fixture.zz.vlatest.json';
      descriptor.object_key = 'synthetic_fixture.zz.vlatest.json';
    },
  },
  {
    // Structurally valid, but it is not the key this identity implies.
    name: 'a well-formed object key that does not match the identity is refused',
    stage: 'provenance_verified',
    code: 'OBJECT_KEY_MUTABLE',
    mutate: envelope => {
      const descriptor = envelope.descriptor as ReturnType<typeof syntheticDescriptor>;
      envelope.object_key = 'synthetic_fixture.zz.v9.9.json';
      descriptor.object_key = 'synthetic_fixture.zz.v9.9.json';
    },
  },
  {
    name: 'rebinding a known object key to different content is refused',
    stage: 'provenance_verified',
    code: 'OBJECT_KEY_MUTABLE',
    mutate: envelope => {
      envelope.identity.sha256 = `sha256:${'d'.repeat(64)}`;
      (envelope.descriptor as ReturnType<typeof syntheticDescriptor>).sha256 =
        `sha256:${'d'.repeat(64)}`;
    },
    context: () => {
      // A registry that already binds this key to different bytes.
      const state = emptyRegistry();
      return {
        ...baseContext(state),
        registry: {
          knownIdentities: new Map(),
          knownObjectKeys: new Map([
            [
              'synthetic_fixture.zz.v1.0.json',
              {
                artifact_id: 'synthetic_fixture',
                artifact_version: '1.0',
                sha256: `sha256:${'a'.repeat(64)}`,
              },
            ],
          ]),
          seenIdempotencyKeys: new Map(),
        },
      };
    },
  },
  {
    name: 'republishing a known version with different content is an identity collision',
    stage: 'provenance_verified',
    code: 'IDENTITY_COLLISION',
    mutate: envelope => {
      envelope.identity.sha256 = `sha256:${'e'.repeat(64)}`;
      (envelope.descriptor as ReturnType<typeof syntheticDescriptor>).sha256 =
        `sha256:${'e'.repeat(64)}`;
    },
    context: () => ({
      ...baseContext(),
      registry: {
        knownIdentities: new Map([
          [
            'synthetic_fixture@1.0',
            {
              artifact_id: 'synthetic_fixture',
              artifact_version: '1.0',
              sha256: `sha256:${'a'.repeat(64)}`,
            },
          ],
        ]),
        knownObjectKeys: new Map(),
        seenIdempotencyKeys: new Map(),
      },
    }),
  },

  /* ------------------------------------------------------- governance_verified */
  {
    name: 'a pending Product approval refuses ingestion',
    stage: 'governance_verified',
    code: 'APPROVAL_NOT_GRANTED',
    mutate: envelope => {
      const descriptor = envelope.descriptor as ReturnType<typeof syntheticDescriptor>;
      descriptor.approvals.product = {
        required: true,
        status: 'pending',
        decision_ref: null,
        approved_at: null,
        decision_scope: null,
      };
    },
  },
  {
    name: 'a pending Clinical approval refuses ingestion where clinical is required',
    stage: 'governance_verified',
    code: 'APPROVAL_NOT_GRANTED',
    mutate: envelope => {
      const descriptor = envelope.descriptor as ReturnType<typeof syntheticDescriptor>;
      descriptor.approvals.clinical = {
        required: true,
        status: 'pending',
        decision_ref: null,
        approved_at: null,
        decision_scope: null,
      };
    },
  },
  {
    name: 'an open blocker refuses ingestion regardless of approvals',
    stage: 'governance_verified',
    code: 'BLOCKER_UNRESOLVED',
    mutate: envelope => {
      const descriptor = envelope.descriptor as ReturnType<typeof syntheticDescriptor>;
      descriptor.blockers = [{ id: 'SYNTHETIC-BLOCK-001', status: 'open' }];
    },
  },
  {
    name: 'an unpublished descriptor cannot be published',
    stage: 'governance_verified',
    code: 'PUBLICATION_NOT_PERFORMED',
    mutate: envelope => {
      envelope.requested_operation = 'publish';
      const descriptor = envelope.descriptor as ReturnType<typeof syntheticDescriptor>;
      descriptor.release_status = 'candidate';
      descriptor.published_at = null;
    },
  },
  {
    name: 'publication without a cited publication decision is refused',
    stage: 'governance_verified',
    code: 'PUBLICATION_NOT_AUTHORIZED',
    mutate: envelope => {
      envelope.requested_operation = 'publish';
      envelope.authorizations.publication_decision_ref = null;
    },
  },
  {
    name: 'activation without a cited activation decision is refused',
    stage: 'governance_verified',
    code: 'ACTIVATION_NOT_AUTHORIZED',
    mutate: envelope => {
      envelope.requested_operation = 'activate';
      envelope.authorizations.activation_decision_ref = null;
    },
  },
  {
    name: 'an environment the descriptor does not target is refused',
    stage: 'governance_verified',
    code: 'ENVIRONMENT_NOT_AUTHORIZED',
    mutate: envelope => {
      const descriptor = envelope.descriptor as ReturnType<typeof syntheticDescriptor>;
      descriptor.target_environments = ['production'];
    },
  },
  {
    name: 'an incompatible consumer build is refused',
    stage: 'governance_verified',
    code: 'APP_BUILD_INCOMPATIBLE',
    mutate: envelope => {
      (envelope.descriptor as unknown as Record<string, unknown>).min_app_build = 999;
    },
  },
  {
    name: 'an unknown consumer build fails closed when a minimum is declared',
    stage: 'governance_verified',
    code: 'APP_BUILD_INCOMPATIBLE',
    mutate: envelope => {
      (envelope.descriptor as unknown as Record<string, unknown>).min_app_build = 10;
    },
    context: () => ({ ...baseContext(), appBuild: undefined }),
  },
  {
    name: 'an unauthorized rollback is refused',
    stage: 'governance_verified',
    code: 'ROLLBACK_NOT_AUTHORIZED',
    mutate: envelope => {
      envelope.requested_operation = 'rollback';
      envelope.authorizations.rollback_decision_ref = null;
      envelope.rollback = {
        target: {
          artifact_id: 'synthetic_fixture',
          artifact_version: '0.9',
          sha256: `sha256:${'f'.repeat(64)}`,
        },
        target_schema_version: 'wellapath.artifact/1',
      };
    },
  },
  {
    name: 'a rollback naming an unknown target is refused',
    stage: 'governance_verified',
    code: 'ROLLBACK_TARGET_UNKNOWN',
    mutate: envelope => {
      envelope.requested_operation = 'rollback';
      envelope.rollback = {
        target: {
          artifact_id: 'synthetic_fixture',
          artifact_version: '0.9',
          sha256: `sha256:${'f'.repeat(64)}`,
        },
        target_schema_version: 'wellapath.artifact/1',
      };
    },
  },
  {
    name: 'a cross-schema rollback is refused because no policy exists',
    stage: 'governance_verified',
    code: 'ROLLBACK_SCHEMA_INCOMPATIBLE',
    mutate: envelope => {
      envelope.requested_operation = 'rollback';
      envelope.rollback = {
        target: {
          artifact_id: 'synthetic_fixture',
          artifact_version: '0.9',
          sha256: `sha256:${'f'.repeat(64)}`,
        },
        target_schema_version: 'wellapath.artifact/0',
      };
    },
  },

  /* -------------------------------------------------------- integrity_verified */
  {
    // Caught at provenance now: a descriptor that disagrees with its own envelope is two
    // different claims about which artifact is being ingested, not merely a digest problem.
    name: 'an identity digest that disagrees with the descriptor is refused',
    stage: 'provenance_verified',
    code: 'DESCRIPTOR_REFERENCE_MISMATCH',
    mutate: envelope => {
      envelope.identity.sha256 = `sha256:${'b'.repeat(64)}`;
      envelope.object_key = 'synthetic_fixture.zz.v1.0.json';
    },
  },
  {
    name: 'a byte count that disagrees with the descriptor is refused',
    stage: 'integrity_verified',
    code: 'BYTE_COUNT_MISMATCH',
    mutate: envelope => {
      envelope.byte_count = 999;
    },
  },
  {
    name: 'an unexpected content type is refused',
    stage: 'integrity_verified',
    code: 'CONTENT_TYPE_UNSUPPORTED',
    mutate: envelope => {
      envelope.content_type = 'application/octet-stream';
    },
  },
  {
    name: 'unsigned production-like input fails closed',
    stage: 'integrity_verified',
    code: 'SIGNATURE_POLICY_UNAVAILABLE',
    mutate: envelope => {
      envelope.attestation.trust_mode = 'production';
    },
  },
  {
    name: 'a producer claiming to have signed does not change the outcome',
    stage: 'integrity_verified',
    code: 'SIGNATURE_POLICY_UNAVAILABLE',
    mutate: envelope => {
      envelope.attestation = {
        trust_mode: 'production',
        claimed_signed: true,
        signature_ref: 'sig-0001',
      };
    },
  },
  {
    name: 'the test trust mode is refused in staging',
    stage: 'integrity_verified',
    code: 'TEST_TRUST_MODE_FORBIDDEN',
    mutate: envelope => {
      envelope.environment = 'staging';
      (envelope.descriptor as ReturnType<typeof syntheticDescriptor>).target_environments = [
        'staging',
      ];
    },
  },
  {
    name: 'the test trust mode is refused in production',
    stage: 'integrity_verified',
    code: 'TEST_TRUST_MODE_FORBIDDEN',
    mutate: envelope => {
      envelope.environment = 'production';
      (envelope.descriptor as ReturnType<typeof syntheticDescriptor>).target_environments = [
        'production',
      ];
    },
  },
  {
    name: 'the test trust mode is refused on an envelope not declaring itself synthetic',
    stage: 'integrity_verified',
    code: 'TEST_TRUST_MODE_FORBIDDEN',
    mutate: envelope => {
      envelope.synthetic = false;
    },
  },
  {
    name: 'an unknown trust mode is refused',
    stage: 'integrity_verified',
    code: 'TRUST_MODE_UNKNOWN',
    mutate: envelope => {
      (envelope.attestation as unknown as Record<string, unknown>).trust_mode = 'trusted';
    },
  },
];

describe('negative ingestion fixtures', () => {
  it.each(cases.map(testCase => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const envelope = clone(syntheticEnvelope());
    testCase.mutate(envelope);

    const outcome = runIngestionPipeline(envelope, (testCase.context ?? baseContext)());

    expect(outcome.admissible).toBe(false);
    expect(outcome.stage).toBe('rejected');
    const matching = outcome.reasons.filter(reason => reason.code === testCase.code);
    expect(matching.length).toBeGreaterThan(0);
    // The refusal must come from the stage the case declares, not merely somewhere.
    expect(matching.every(reason => reason.stage === testCase.stage)).toBe(true);
    // And the pipeline must not have advanced past that stage.
    expect(outcome.reached).not.toContain(testCase.stage);
  });

  it('the base envelope every case mutates is genuinely admissible', () => {
    const outcome = runIngestionPipeline(syntheticEnvelope(), baseContext());
    expect(outcome.reasons).toEqual([]);
    expect(outcome.admissible).toBe(true);
  });

  it('covers every stage that can refuse a document', () => {
    const stages = new Set(cases.map(testCase => testCase.stage));
    expect(stages).toEqual(
      new Set([
        'envelope_validated',
        'contract_validated',
        'provenance_verified',
        'governance_verified',
        'integrity_verified',
      ]),
    );
  });
});

describe('negative registry transitions', () => {
  const admissible = (
    envelope: IngestionEnvelope,
    state: RegistryState,
  ): ReturnType<typeof runIngestionPipeline> => runIngestionPipeline(envelope, baseContext(state));

  it('publishing something never staged is refused', () => {
    const state = emptyRegistry();
    const envelope = syntheticEnvelope({ operation: 'publish', idempotencyKey: 'neg-publish-001' });
    const snapshot = JSON.stringify(state);

    const result = publishCandidate(state, {
      envelope,
      outcome: admissible(envelope, state),
      authority: testAuthority(),
      expectedRevision: 0,
      expectedActive: null,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.map(reason => reason.code)).toContain('CANDIDATE_NOT_STAGED');
    expect(result.state).toBe(state);
    expect(JSON.stringify(result.state)).toBe(snapshot);
  });

  it('calling an operation the envelope did not request is refused', () => {
    const state = emptyRegistry();
    const envelope = syntheticEnvelope({ operation: 'stage', idempotencyKey: 'neg-wrongop-001' });

    const result = activateCandidate(state, {
      envelope,
      outcome: admissible(envelope, state),
      authority: testAuthority(),
      expectedRevision: 0,
      expectedActive: null,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.map(reason => reason.code)).toContain('OPERATION_INVALID');
    expect(result.state).toBe(state);
  });

  it('a refused registry operation emits a refusal event and never mutates', () => {
    const state = emptyRegistry();
    const envelope = syntheticEnvelope({ operation: 'stage', idempotencyKey: 'neg-stale-0001' });
    const snapshot = JSON.stringify(state);

    const result = stageCandidate(state, {
      envelope,
      outcome: admissible(envelope, state),
      authority: testAuthority(),
      expectedRevision: 42,
      expectedActive: null,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.map(reason => reason.code)).toContain('REVISION_STALE');
    expect(result.event.outcome).toBe('refused');
    expect(result.event.prior_revision).toBe(result.event.resulting_revision);
    expect(result.state).toBe(state);
    expect(JSON.stringify(result.state)).toBe(snapshot);
  });

  it('an inadmissible envelope is refused by every registry operation', () => {
    const state = emptyRegistry();
    const envelope = clone(syntheticEnvelope({ idempotencyKey: 'neg-inadmis-001' }));
    envelope.attestation.trust_mode = 'production';
    const outcome = admissible(envelope, state);
    expect(outcome.admissible).toBe(false);

    for (const operation of [stageCandidate, publishCandidate, activateCandidate]) {
      const result = operation(state, {
        envelope,
        outcome,
        authority: testAuthority(),
        expectedRevision: 0,
        expectedActive: null,
      });
      expect(result.ok).toBe(false);
      expect(result.state).toBe(state);
      expect(result.reasons.map(reason => reason.code)).toContain('SIGNATURE_POLICY_UNAVAILABLE');
    }
  });
});
