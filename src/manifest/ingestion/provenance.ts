/**
 * Provenance evaluation — what an envelope has actually established about where its bytes came
 * from, who produced them, and under whose authority.
 *
 * The single idea this module exists to enforce: **a matching digest proves the bytes are the
 * bytes, and nothing else.** It does not prove the bytes were approved, that their producer was
 * authorised, or that anyone with authority ever looked at them. An ingester that reads hash
 * agreement as governance evidence has skipped the governance check entirely — the producer's own
 * publication plan says exactly that, and this module is the enforcement of it.
 *
 * Hence three states that are never synonyms:
 *
 *   claimed          fields are populated. Anyone can populate fields.
 *   integrity_bound  the declared digests match the digests we hold. The bytes are the bytes.
 *   verified         the producer's identity and authority are cryptographically established.
 *
 * `verified` requires trusted-producer infrastructure that does not exist. Production-like
 * provenance therefore cannot reach it, and any operation requiring it fails closed. The synthetic
 * test mode may traverse the transition so the rest of the pipeline can be exercised, and the
 * result it produces is explicitly non-operative.
 */
import { ArtifactDescriptor } from '../contract';
import {
  IngestionEnvelope,
  IngestionOperation,
  MUTABLE_SOURCE_REFERENCES,
  OPERATION_PROVENANCE_REQUIREMENT,
  PlanSourceProvenance,
  PROVENANCE_STATE_RANK,
  ProvenanceState,
  REQUIRED_PROVENANCE_KEYS,
  SOURCE_PROVENANCE_KINDS,
  StageReason,
} from './contract';
import { KbIntegrationPins } from './pins';

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const BARE_SHA256 = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const reason = (code: StageReason['code'], path: string, detail: string): StageReason => ({
  stage: 'provenance_verified',
  code,
  path,
  detail,
});

/** Strips an optional `sha256:` prefix so the two spellings can be compared. */
const bareDigest = (value: string): string => value.replace(/^sha256:/, '');

export interface ProvenanceEvaluation {
  state: ProvenanceState;
  /** Every reason the state is not higher, plus every outright refusal. */
  reasons: StageReason[];
  /**
   * Always false. No verification receipt this implementation can produce is operative, because
   * no trusted-producer infrastructure exists to produce one from.
   */
  operative: boolean;
  /** What each state was, and was not, established by. Recorded so it cannot be misread later. */
  established: {
    fields_populated: boolean;
    digests_match: boolean;
    producer_authority_established: boolean;
  };
}

/**
 * Establishes whether the envelope's claimed source is usable as an identity at all.
 *
 * A branch name, tag or symbolic ref is refused outright: it names whatever it points at when
 * someone looks, which is the one property a provenance record must not have. This is checked
 * before any digest comparison, because a mutable reference is not made trustworthy by the bytes
 * beside it matching.
 */
export const evaluateSourceIdentity = (
  envelope: IngestionEnvelope,
  pins: KbIntegrationPins,
): StageReason[] => {
  const reasons: StageReason[] = [];
  const provenance = envelope.provenance;
  const path = 'envelope.provenance';

  if (!isPlainObject(provenance)) {
    return [
      reason(
        'PROVENANCE_MISSING',
        path,
        'provenance is absent; an envelope of unknown origin is never ingested',
      ),
    ];
  }

  for (const key of REQUIRED_PROVENANCE_KEYS) {
    const value = (provenance as unknown as Record<string, unknown>)[key];
    if (key === 'governance_register_sha256') continue; // nullable; checked separately
    if (typeof value !== 'string' || value.trim() === '') {
      const code =
        key === 'actor_ref'
          ? 'PROVENANCE_ACTOR_MISSING'
          : key === 'authorization_ref'
            ? 'PROVENANCE_AUTHORIZATION_MISSING'
            : 'PROVENANCE_MISSING';
      reasons.push(
        reason(
          code,
          `${path}.${key}`,
          key === 'actor_ref'
            ? 'no actor is named; an ingestion with no attributable actor is never accepted'
            : key === 'authorization_ref'
              ? 'no authorization is cited for the ingestion itself; absence is not authorization'
              : `provenance field ${key} is absent or empty`,
        ),
      );
    }
  }
  if (reasons.length > 0) return reasons;

  if (!COMMIT_SHA.test(provenance.source_commit)) {
    const lowered = provenance.source_commit.trim().toLowerCase();
    if (MUTABLE_SOURCE_REFERENCES.includes(lowered) || !/^[0-9a-f]+$/.test(lowered)) {
      reasons.push(
        reason(
          'PROVENANCE_SOURCE_MUTABLE_REFERENCE',
          `${path}.source_commit`,
          `source_commit "${provenance.source_commit}" is a mutable or symbolic reference; provenance must name an exact 40-hex commit`,
        ),
      );
    } else {
      reasons.push(
        reason(
          'KB_SOURCE_MISMATCH',
          `${path}.source_commit`,
          'source_commit must be a full 40-hex commit id',
        ),
      );
    }
  } else if (provenance.source_commit !== pins.source_commit) {
    reasons.push(
      reason(
        'KB_SOURCE_MISMATCH',
        `${path}.source_commit`,
        `envelope names commit ${provenance.source_commit}; the pinned producing commit is ${pins.source_commit}`,
      ),
    );
  }

  if (provenance.source_repository !== pins.source_repository) {
    reasons.push(
      reason(
        'KB_SOURCE_MISMATCH',
        `${path}.source_repository`,
        `envelope names repository ${provenance.source_repository}; the pinned producer is ${pins.source_repository}`,
      ),
    );
  }

  return reasons;
};

/**
 * Compares the envelope's declared digests against the pins.
 *
 * A match here raises provenance to `integrity_bound` and no further. The comment on each check
 * says what it establishes, because the failure mode this whole module guards against is someone
 * reading one of these matches as approval.
 */
export const evaluateIntegrityBinding = (
  envelope: IngestionEnvelope,
  pins: KbIntegrationPins,
): StageReason[] => {
  const reasons: StageReason[] = [];
  const provenance = envelope.provenance;
  const path = 'envelope.provenance';

  // Establishes: this is the plan we hold a copy of. Establishes nothing about governance.
  const pinnedPlan = pins.publication_plans[provenance.publication_plan_id];
  if (pinnedPlan === undefined) {
    reasons.push(
      reason(
        'PLAN_HASH_MISMATCH',
        `${path}.publication_plan_id`,
        `no pinned publication plan is known by id ${provenance.publication_plan_id}`,
      ),
    );
  } else if (bareDigest(provenance.publication_plan_sha256) !== pinnedPlan.sha256) {
    reasons.push(
      reason(
        'PLAN_HASH_MISMATCH',
        `${path}.publication_plan_sha256`,
        'the envelope names a publication plan whose digest differs from the pinned copy; a stale plan hash and a current commit do not describe the same tree',
      ),
    );
  }

  // Establishes: this is the register we hold a copy of. Establishes nothing about its contents
  // having granted anything.
  const register = pins.governance.decision_register_v1;
  const declared = provenance.governance_register_sha256;
  if (declared !== null) {
    if (typeof declared !== 'string' || !BARE_SHA256.test(bareDigest(declared))) {
      reasons.push(
        reason(
          'GOVERNANCE_REGISTER_HASH_MISMATCH',
          `${path}.governance_register_sha256`,
          'governance register digest is malformed',
        ),
      );
    } else if (bareDigest(declared) !== register.sha256) {
      reasons.push(
        reason(
          'GOVERNANCE_REGISTER_HASH_MISMATCH',
          `${path}.governance_register_sha256`,
          `envelope names governance register ${bareDigest(declared)}; the pinned register is ${register.sha256}`,
        ),
      );
    }
  }

  return reasons;
};

/**
 * Validates the producer's informational `source_provenance` block.
 *
 * Checked for structure, known kinds, and agreement with what the envelope independently claims.
 * It is never permitted to *supply* anything: if the block and the envelope disagree, that is a
 * contradiction and both are refused rather than one silently winning. And a plan that cites a
 * mutable branch tip as its own source is refused, because a document cannot make a branch name
 * into an identity by putting it in a field.
 */
export const evaluatePlanSourceProvenance = (
  envelope: IngestionEnvelope,
  pins: KbIntegrationPins,
): StageReason[] => {
  const block: PlanSourceProvenance | null = envelope.plan_source_provenance;
  const path = 'envelope.plan_source_provenance';
  if (block === null) return [];

  if (!isPlainObject(block)) {
    return [reason('SOURCE_PROVENANCE_MALFORMED', path, 'must be null or an object')];
  }

  const reasons: StageReason[] = [];

  if (!Array.isArray(block.kinds) || block.kinds.length === 0) {
    reasons.push(
      reason(
        'SOURCE_PROVENANCE_MALFORMED',
        `${path}.kinds`,
        'must declare a non-empty array of provenance kinds',
      ),
    );
  } else {
    for (const kind of block.kinds) {
      if (typeof kind !== 'string' || !SOURCE_PROVENANCE_KINDS.includes(kind)) {
        reasons.push(
          reason(
            'SOURCE_PROVENANCE_KIND_UNKNOWN',
            `${path}.kinds`,
            `unknown source-provenance kind ${String(kind)}; an unrecognised kind may be making a claim this implementation does not know how to disbelieve`,
          ),
        );
      }
    }
  }

  if (typeof block.repository_branch_cited !== 'boolean') {
    reasons.push(
      reason(
        'SOURCE_PROVENANCE_MALFORMED',
        `${path}.repository_branch_cited`,
        'must be an explicit boolean',
      ),
    );
  } else if (block.repository_branch_cited === true) {
    reasons.push(
      reason(
        'PROVENANCE_SOURCE_MUTABLE_REFERENCE',
        `${path}.repository_branch_cited`,
        'the plan cites a mutable branch tip as source; a branch names whatever it points at today and is never provenance',
      ),
    );
  }

  // The block's register digest must agree with what the envelope declares and with the pin.
  const blockRegister = block.decision_register_sha256;
  if (blockRegister !== null) {
    if (typeof blockRegister !== 'string' || !BARE_SHA256.test(bareDigest(blockRegister))) {
      reasons.push(
        reason(
          'SOURCE_PROVENANCE_MALFORMED',
          `${path}.decision_register_sha256`,
          'must be null or a sha256 digest',
        ),
      );
    } else {
      if (bareDigest(blockRegister) !== pins.governance.decision_register_v1.sha256) {
        reasons.push(
          reason(
            'GOVERNANCE_REGISTER_HASH_MISMATCH',
            `${path}.decision_register_sha256`,
            'the plan names a governance register that is not the pinned one',
          ),
        );
      }
      const envelopeRegister = envelope.provenance?.governance_register_sha256 ?? null;
      if (envelopeRegister === null) {
        reasons.push(
          reason(
            'PROVENANCE_MISSING',
            'envelope.provenance.governance_register_sha256',
            'the plan references a governance register but the envelope declares none; the envelope must supply what it is relying on',
          ),
        );
      } else if (bareDigest(envelopeRegister) !== bareDigest(blockRegister)) {
        reasons.push(
          reason(
            'PROVENANCE_CONTRADICTION',
            `${path}.decision_register_sha256`,
            'the envelope and the plan name different governance registers; a contradiction is refused rather than resolved in favour of either',
          ),
        );
      }
    }
  }

  return reasons;
};

/**
 * Checks that the descriptor the envelope carries is the one its identity and object key name.
 *
 * A descriptor that disagrees with its own envelope is not a small inconsistency: it is two
 * different claims about which artifact is being ingested.
 */
export const evaluateDescriptorReference = (envelope: IngestionEnvelope): StageReason[] => {
  const reasons: StageReason[] = [];
  const descriptor = envelope.descriptor as ArtifactDescriptor;
  const identity = envelope.identity;

  if (!isPlainObject(descriptor) || !isPlainObject(identity)) return reasons;

  if (
    descriptor.artifact_id !== identity.artifact_id ||
    descriptor.artifact_version !== identity.artifact_version
  ) {
    reasons.push(
      reason(
        'DESCRIPTOR_REFERENCE_MISMATCH',
        'envelope.descriptor',
        `the envelope names ${identity.artifact_id}@${identity.artifact_version} but carries a descriptor for ${String(descriptor.artifact_id)}@${String(descriptor.artifact_version)}`,
      ),
    );
  }
  if (typeof descriptor.object_key === 'string' && descriptor.object_key !== envelope.object_key) {
    reasons.push(
      reason(
        'DESCRIPTOR_REFERENCE_MISMATCH',
        'envelope.object_key',
        `the envelope names object key ${envelope.object_key} but its descriptor declares ${descriptor.object_key}`,
      ),
    );
  }
  if (
    typeof descriptor.sha256 === 'string' &&
    PREFIXED_SHA256.test(descriptor.sha256) &&
    descriptor.sha256 !== identity.sha256
  ) {
    reasons.push(
      reason(
        'DESCRIPTOR_REFERENCE_MISMATCH',
        'envelope.identity.sha256',
        'the envelope identity digest does not match the descriptor it carries',
      ),
    );
  }

  return reasons;
};

/**
 * Computes the provenance state reached, and refuses when the requested operation needs more.
 *
 * The state ladder is walked deliberately rather than short-circuited, so the result records what
 * *was* established as well as what was not. `verified` is reachable only under the synthetic
 * test-only trust mode, and even then the evaluation is marked non-operative: exercising a
 * transition is not the same as having verified anything.
 */
export const evaluateProvenance = (
  envelope: IngestionEnvelope,
  pins: KbIntegrationPins,
): ProvenanceEvaluation => {
  const reasons: StageReason[] = [];

  const identityReasons = evaluateSourceIdentity(envelope, pins);
  reasons.push(...identityReasons);

  // Fields being present and well formed is `claimed`. Nothing more is implied by it.
  const fieldsPopulated = identityReasons.length === 0;

  const integrityReasons = fieldsPopulated ? evaluateIntegrityBinding(envelope, pins) : [];
  reasons.push(...integrityReasons);
  reasons.push(...evaluatePlanSourceProvenance(envelope, pins));
  reasons.push(...evaluateDescriptorReference(envelope));

  const digestsMatch = fieldsPopulated && reasons.length === 0;

  // Producer authority. There is no trusted-producer infrastructure, so this is establishable
  // only inside a synthetic test, and never operatively.
  const syntheticTest =
    envelope.attestation?.trust_mode === 'synthetic_test_only' &&
    envelope.synthetic === true &&
    envelope.environment === 'development';
  const producerAuthorityEstablished = digestsMatch && syntheticTest;

  const state: ProvenanceState = producerAuthorityEstablished
    ? 'verified'
    : digestsMatch
      ? 'integrity_bound'
      : 'claimed';

  const operation: IngestionOperation = envelope.requested_operation;
  const required = OPERATION_PROVENANCE_REQUIREMENT[operation];
  if (
    required !== undefined &&
    PROVENANCE_STATE_RANK[state] < PROVENANCE_STATE_RANK[required] &&
    reasons.length === 0
  ) {
    // Only reported when nothing else already refused: otherwise the earlier reason is the
    // honest one, and this would merely restate it.
    reasons.push(
      reason(
        'PROVENANCE_NOT_VERIFIED',
        'envelope.provenance',
        `operation ${operation} requires provenance state ${required}; this envelope reached ${state}. ` +
          'Matching digests establish that the bytes are the bytes and nothing more: no trusted-producer ' +
          'infrastructure exists, so production-like provenance cannot be verified.',
      ),
    );
  }

  return {
    state,
    reasons,
    operative: false,
    established: {
      fields_populated: fieldsPopulated,
      digests_match: digestsMatch,
      producer_authority_established: producerAuthorityEstablished,
    },
  };
};
