/**
 * The ingestion pipeline — pure, ordered, and deliberately unhelpful.
 *
 * Each stage is a standalone function over its input. A stage that passes says exactly one thing:
 * that its own checks held. It never implies the next stage, and the composed pipeline stops at
 * the first stage that produces a reason. In particular:
 *
 *   received is not staged           — an envelope arriving proves nothing about it.
 *   staged is not published          — staging is a Backend bookkeeping act, not a release.
 *   published is not active          — publication makes an artifact available, not chosen.
 *   storage presence is not publication  — an object existing in R2 is not a governance event.
 *   approval is not activation       — approvals gate publication; activation is its own decision.
 *   a merged KB commit is not publication authorization — merging is not deciding.
 *   a valid descriptor is not eligible   — structure is not governance.
 *
 * Nothing in this file performs IO of any kind. Time is injected. The registry is passed in and
 * never mutated here.
 */
import {
  ArtifactDescriptor,
  Environment,
  ENVIRONMENTS,
  SUPPORTED_CONTENT_TYPES,
} from '../contract';
import { evaluateDescriptor } from '../eligibility';
import { SHA256_PATTERN } from '../integrity';
import { validateManifest } from '../validate';
import {
  ArtifactIdentity,
  IngestionEnvelope,
  IngestionOperation,
  INGESTION_OPERATIONS,
  MANIFEST_SCHEMA_BYTE_COUNT,
  MANIFEST_SCHEMA_SHA256,
  OPTIONAL_ENVELOPE_KEYS,
  PipelineStage,
  REQUIRED_ENVELOPE_KEYS,
  REQUIRED_MANIFEST_CONTRACT_VERSION,
  StageReason,
  SUPPORTED_ENVELOPE_MAJOR,
  SUPPORTED_ENVELOPE_VERSIONS,
  formatIdentity,
  identityEquals,
} from './contract';
import { evaluateProvenance } from './provenance';
import { AttestationResult, evaluateAttestation } from './signing';
import { KbIntegrationPins } from './pins';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const reason = (
  stage: PipelineStage,
  code: StageReason['code'],
  path: string,
  detail: string,
): StageReason => ({ stage, code, path, detail });

/** Minimal read-only view of registry state the pipeline needs. Never mutated here. */
export interface RegistryView {
  /** Known identities by `id@version`, for collision and immutability checks. */
  knownIdentities: ReadonlyMap<string, ArtifactIdentity>;
  /** Object keys already bound to an identity, for the mutable-key check. */
  knownObjectKeys: ReadonlyMap<string, ArtifactIdentity>;
  /** Idempotency keys already seen, mapped to the canonical digest of their payload. */
  seenIdempotencyKeys: ReadonlyMap<string, string>;
}

export const emptyRegistryView = (): RegistryView => ({
  knownIdentities: new Map(),
  knownObjectKeys: new Map(),
  seenIdempotencyKeys: new Map(),
});

export interface IngestionContext {
  pins: KbIntegrationPins;
  registry: RegistryView;
  now: Date;
  /** Consumer build, when the descriptor declares a minimum. Unknown fails closed. */
  appBuild?: number;
}

export interface IngestionOutcome {
  /** The stage at which the envelope came to rest: the last one passed, or `rejected`. */
  stage: PipelineStage;
  /** Stages actually completed, in order. Never inferred. */
  reached: PipelineStage[];
  reasons: StageReason[];
  attestation: AttestationResult | null;
  identity: ArtifactIdentity | null;
  /** True only when every stage up to and including `integrity_verified` passed. */
  admissible: boolean;
}

/* ------------------------------------------------------------------ stage 1: received */

/** The envelope exists and is an object. That is the entire claim. */
export const stageReceived = (envelope: unknown): StageReason[] => {
  if (!isPlainObject(envelope)) {
    return [reason('received', 'ENVELOPE_MALFORMED', 'envelope', 'envelope must be an object')];
  }
  return [];
};

/* --------------------------------------------------------- stage 2: envelope_validated */

/** Structure, version, closed field set, operation vocabulary and idempotency key. */
export const stageEnvelopeValidated = (envelope: Record<string, unknown>): StageReason[] => {
  const reasons: StageReason[] = [];
  const allowed = [...REQUIRED_ENVELOPE_KEYS, ...OPTIONAL_ENVELOPE_KEYS];

  for (const key of Object.keys(envelope)) {
    if (!allowed.includes(key)) {
      reasons.push(
        reason('envelope_validated', 'ENVELOPE_UNKNOWN_FIELD', `envelope.${key}`, 'unknown field'),
      );
    }
  }
  for (const key of REQUIRED_ENVELOPE_KEYS) {
    if (!(key in envelope)) {
      reasons.push(
        reason(
          'envelope_validated',
          'ENVELOPE_MISSING_FIELD',
          `envelope.${key}`,
          `required field ${key} is absent`,
        ),
      );
    }
  }

  const version = envelope.envelope_version;
  const match = typeof version === 'string' ? SEMVER.exec(version) : null;
  if (!match) {
    reasons.push(
      reason(
        'envelope_validated',
        'ENVELOPE_VERSION_UNSUPPORTED',
        'envelope.envelope_version',
        `envelope version ${String(version)} is not a semantic version`,
      ),
    );
  } else if (Number.parseInt(match[1], 10) !== SUPPORTED_ENVELOPE_MAJOR) {
    reasons.push(
      reason(
        'envelope_validated',
        'ENVELOPE_VERSION_UNSUPPORTED',
        'envelope.envelope_version',
        `envelope major ${match[1]} is not supported (supported: ${SUPPORTED_ENVELOPE_MAJOR})`,
      ),
    );
  } else if (!SUPPORTED_ENVELOPE_VERSIONS.includes(version as string)) {
    // Membership, not comparison. A future minor may need semantics this code lacks; a superseded
    // minor was written under weaker rules and must not inherit the current guarantees.
    reasons.push(
      reason(
        'envelope_validated',
        'ENVELOPE_VERSION_UNSUPPORTED',
        'envelope.envelope_version',
        `envelope version ${String(version)} is not one this implementation understands (supported: ${SUPPORTED_ENVELOPE_VERSIONS.join(', ')}); a newer minor may rely on semantics this code does not implement, and an older one was written under weaker requirements`,
      ),
    );
  }

  if (
    !(INGESTION_OPERATIONS as readonly string[]).includes(envelope.requested_operation as string)
  ) {
    reasons.push(
      reason(
        'envelope_validated',
        'OPERATION_INVALID',
        'envelope.requested_operation',
        `operation ${String(envelope.requested_operation)} is not one of ${INGESTION_OPERATIONS.join(', ')}`,
      ),
    );
  }

  const key = envelope.idempotency_key;
  if (key === undefined || key === null || key === '') {
    reasons.push(
      reason(
        'envelope_validated',
        'IDEMPOTENCY_KEY_MISSING',
        'envelope.idempotency_key',
        'an idempotency key is required so a replay can be distinguished from a new request',
      ),
    );
  } else if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
    reasons.push(
      reason(
        'envelope_validated',
        'IDEMPOTENCY_KEY_MALFORMED',
        'envelope.idempotency_key',
        'idempotency key must be 8-128 chars of [A-Za-z0-9._:-] starting alphanumeric',
      ),
    );
  }

  if (typeof envelope.created_at !== 'string' || !ISO_UTC.test(envelope.created_at)) {
    reasons.push(
      reason(
        'envelope_validated',
        'ENVELOPE_MALFORMED',
        'envelope.created_at',
        'created_at must be an ISO-8601 UTC timestamp',
      ),
    );
  }

  if (!(ENVIRONMENTS as readonly string[]).includes(envelope.environment as string)) {
    reasons.push(
      reason(
        'envelope_validated',
        'ENVELOPE_MALFORMED',
        'envelope.environment',
        `unknown environment ${String(envelope.environment)}`,
      ),
    );
  }

  if (typeof envelope.synthetic !== 'boolean') {
    reasons.push(
      reason(
        'envelope_validated',
        'ENVELOPE_MALFORMED',
        'envelope.synthetic',
        'synthetic must be an explicit boolean',
      ),
    );
  }

  return reasons;
};

/* --------------------------------------------------------- stage 3: contract_validated */

/** The declared manifest contract, its pinned schema digest, and the descriptor's own validity. */
export const stageContractValidated = (envelope: IngestionEnvelope): StageReason[] => {
  const reasons: StageReason[] = [];

  if (envelope.manifest_contract_version !== REQUIRED_MANIFEST_CONTRACT_VERSION) {
    reasons.push(
      reason(
        'contract_validated',
        'CONTRACT_VERSION_MISMATCH',
        'envelope.manifest_contract_version',
        `envelope declares manifest contract ${String(envelope.manifest_contract_version)}; this implementation requires ${REQUIRED_MANIFEST_CONTRACT_VERSION}`,
      ),
    );
  }

  if (
    envelope.manifest_schema_sha256 !== MANIFEST_SCHEMA_SHA256 ||
    envelope.manifest_schema_byte_count !== MANIFEST_SCHEMA_BYTE_COUNT
  ) {
    reasons.push(
      reason(
        'contract_validated',
        'CONTRACT_PIN_DRIFT',
        'envelope.manifest_schema_sha256',
        'the envelope pins a manifest schema digest or byte count that differs from this implementation; producer and consumer do not agree on the contract',
      ),
    );
  }

  // The descriptor must be valid under the manifest contract in its own right. Wrapping it in a
  // one-artifact manifest reuses the real validator rather than a second, divergent copy.
  const wrapped = {
    manifest_version: REQUIRED_MANIFEST_CONTRACT_VERSION,
    generated_at: envelope.created_at,
    artifacts: [envelope.descriptor],
  };
  const result = validateManifest(wrapped);
  for (const manifestReason of result.reasons) {
    reasons.push(
      reason(
        'contract_validated',
        manifestReason.code,
        `envelope.descriptor${manifestReason.path.replace(/^artifacts\[0\]/, '')}`,
        manifestReason.detail,
      ),
    );
  }

  return reasons;
};

/* -------------------------------------------------------- stage 4: provenance_verified */

/**
 * Where it came from, who produced it, under what authority, and whether its identity is
 * immutable in this registry.
 *
 * Source identity, digest binding, the producer's informational provenance block and the
 * descriptor cross-reference are all delegated to `provenance.ts`, which also computes how far
 * provenance actually got. What stays here is the part that needs registry state: an object key
 * must be the immutable key its identity implies and must never be rebound, and a known version
 * must never reappear with different content.
 */
export const stageProvenanceVerified = (
  envelope: IngestionEnvelope,
  context: IngestionContext,
): StageReason[] => {
  const evaluation = evaluateProvenance(envelope, context.pins);
  const reasons: StageReason[] = [...evaluation.reasons];

  const identity = envelope.identity;
  if (!isPlainObject(identity) || !SHA256_PATTERN.test(String(identity.sha256))) {
    reasons.push(
      reason(
        'provenance_verified',
        'IDENTITY_COLLISION',
        'envelope.identity',
        'artifact identity is malformed; identity is the id, version and digest together',
      ),
    );
    return reasons;
  }

  // The object key is immutable: it must be derivable from the identity, and never rebound.
  const expectedKey = `${identity.artifact_id}.${(envelope.descriptor as ArtifactDescriptor)?.country ?? 'ng'}.v${identity.artifact_version}.json`;
  if (envelope.object_key !== expectedKey) {
    reasons.push(
      reason(
        'provenance_verified',
        'OBJECT_KEY_MUTABLE',
        'envelope.object_key',
        `object key ${envelope.object_key} is not the immutable key for this identity (${expectedKey})`,
      ),
    );
  }
  const boundToKey = context.registry.knownObjectKeys.get(envelope.object_key);
  if (boundToKey !== undefined && !identityEquals(boundToKey, envelope.identity)) {
    reasons.push(
      reason(
        'provenance_verified',
        'OBJECT_KEY_MUTABLE',
        'envelope.object_key',
        `object key ${envelope.object_key} is already bound to ${formatIdentity(boundToKey)}; an object key is never reused for changed content`,
      ),
    );
  }

  const versionKey = `${identity.artifact_id}@${identity.artifact_version}`;
  const known = context.registry.knownIdentities.get(versionKey);
  if (known !== undefined && known.sha256 !== identity.sha256) {
    reasons.push(
      reason(
        'provenance_verified',
        'IDENTITY_COLLISION',
        'envelope.identity',
        `${versionKey} is already known with digest ${known.sha256}; a version is never republished with different content`,
      ),
    );
  }

  return reasons;
};

/* -------------------------------------------------------- stage 5: governance_verified */

/**
 * Governance for the requested operation. Approvals, blockers, publication state and the explicit
 * authorization the operation needs. Nothing here is inferred from anything else being fine.
 */
export const stageGovernanceVerified = (
  envelope: IngestionEnvelope,
  context: IngestionContext,
): StageReason[] => {
  const reasons: StageReason[] = [];
  const descriptor = envelope.descriptor as ArtifactDescriptor;
  const operation: IngestionOperation = envelope.requested_operation;

  // Descriptor-level governance, evaluated by the contract's own eligibility engine.
  const evaluation = evaluateDescriptor(descriptor, {
    environment: envelope.environment as Environment,
    now: context.now,
    appBuild: context.appBuild,
  });

  // For staging we care about approvals and blockers, not about being published yet.
  const relevant = evaluation.reasons.filter(entry => {
    if (operation === 'stage') {
      return entry.code !== 'NOT_PUBLISHED' && entry.code !== 'ACTIVATION_NOT_AUTHORIZED';
    }
    return true;
  });
  for (const entry of relevant) {
    reasons.push(
      reason('governance_verified', entry.code, `envelope.descriptor:${entry.path}`, entry.detail),
    );
  }

  const authorizations = envelope.authorizations ?? {
    publication_decision_ref: null,
    activation_decision_ref: null,
    rollback_decision_ref: null,
  };

  const hasRef = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

  if (operation === 'publish' || operation === 'activate') {
    // Publication must actually have happened, and have been authorized. These are two facts.
    if (descriptor?.release_status !== 'published' || descriptor?.published_at === null) {
      reasons.push(
        reason(
          'governance_verified',
          'PUBLICATION_NOT_PERFORMED',
          'envelope.descriptor.release_status',
          'the descriptor has not been published; a merged upstream commit is not publication',
        ),
      );
    }
    if (!hasRef(authorizations.publication_decision_ref)) {
      reasons.push(
        reason(
          'governance_verified',
          'PUBLICATION_NOT_AUTHORIZED',
          'envelope.authorizations.publication_decision_ref',
          'no publication decision is cited; absence of a decision is not authorization',
        ),
      );
    }
  }

  if (operation === 'activate') {
    if (!hasRef(authorizations.activation_decision_ref)) {
      reasons.push(
        reason(
          'governance_verified',
          'ACTIVATION_NOT_AUTHORIZED',
          'envelope.authorizations.activation_decision_ref',
          'no activation decision is cited; approval to publish is not approval to activate',
        ),
      );
    }
  }

  if (operation === 'rollback') {
    if (!hasRef(authorizations.rollback_decision_ref)) {
      reasons.push(
        reason(
          'governance_verified',
          'ROLLBACK_NOT_AUTHORIZED',
          'envelope.authorizations.rollback_decision_ref',
          'no rollback decision is cited; rollback is an explicit act, never a fallback',
        ),
      );
    }
    const rollback = envelope.rollback;
    if (rollback === null || !isPlainObject(rollback)) {
      reasons.push(
        reason(
          'governance_verified',
          'ROLLBACK_TARGET_UNKNOWN',
          'envelope.rollback',
          'a rollback must name an exact version-and-hash-bound target',
        ),
      );
    } else {
      const target = rollback.target;
      if (!isPlainObject(target) || !SHA256_PATTERN.test(String(target.sha256))) {
        reasons.push(
          reason(
            'governance_verified',
            'ROLLBACK_TARGET_UNKNOWN',
            'envelope.rollback.target',
            'rollback target must carry an artifact id, version and digest',
          ),
        );
      } else {
        const targetKey = `${target.artifact_id}@${target.artifact_version}`;
        const known = context.registry.knownIdentities.get(targetKey);
        if (known === undefined) {
          reasons.push(
            reason(
              'governance_verified',
              'ROLLBACK_TARGET_UNKNOWN',
              'envelope.rollback.target',
              `rollback target ${targetKey} is not a known descriptor; a target is never invented`,
            ),
          );
        } else if (known.sha256 !== target.sha256) {
          reasons.push(
            reason(
              'governance_verified',
              'ROLLBACK_TARGET_NOT_IMMUTABLE',
              'envelope.rollback.target.sha256',
              'rollback target digest does not match the known descriptor for that version',
            ),
          );
        }
        // Cross-schema rollback. No policy exists, so this refuses rather than deciding.
        const currentSchema = descriptor?.schema_version;
        if (
          typeof rollback.target_schema_version === 'string' &&
          rollback.target_schema_version !== currentSchema
        ) {
          reasons.push(
            reason(
              'governance_verified',
              'ROLLBACK_SCHEMA_INCOMPATIBLE',
              'envelope.rollback.target_schema_version',
              `rollback crosses a schema boundary (${String(currentSchema)} -> ${rollback.target_schema_version}); no cross-schema rollback policy has been approved`,
            ),
          );
          reasons.push(
            reason(
              'governance_verified',
              'ROLLBACK_POLICY_UNRESOLVED',
              'envelope.rollback',
              'cross-schema rollback policy is unresolved; this refusal stands until it is decided and recorded',
            ),
          );
        }
      }
    }
  }

  return reasons;
};

/* --------------------------------------------------------- stage 6: integrity_verified */

/** Declared digest and byte count agree with the descriptor, content type is allowed, and the
 * attestation policy is applied. Integrity is checked independently of anything transport said. */
export const stageIntegrityVerified = (
  envelope: IngestionEnvelope,
): { reasons: StageReason[]; attestation: AttestationResult } => {
  const reasons: StageReason[] = [];
  const descriptor = envelope.descriptor as ArtifactDescriptor;

  if (!SUPPORTED_CONTENT_TYPES.includes(envelope.content_type)) {
    reasons.push(
      reason(
        'integrity_verified',
        'CONTENT_TYPE_UNSUPPORTED',
        'envelope.content_type',
        `content type ${String(envelope.content_type)} is not an expected artifact type`,
      ),
    );
  }

  if (descriptor?.sha256 !== envelope.identity?.sha256) {
    reasons.push(
      reason(
        'integrity_verified',
        'HASH_MISMATCH',
        'envelope.identity.sha256',
        'the envelope identity digest does not match the descriptor it carries',
      ),
    );
  }
  if (descriptor?.byte_count !== envelope.byte_count) {
    reasons.push(
      reason(
        'integrity_verified',
        'BYTE_COUNT_MISMATCH',
        'envelope.byte_count',
        `envelope declares ${String(envelope.byte_count)} bytes, descriptor declares ${String(descriptor?.byte_count)}`,
      ),
    );
  }
  if (
    descriptor?.artifact_id !== envelope.identity?.artifact_id ||
    descriptor?.artifact_version !== envelope.identity?.artifact_version
  ) {
    reasons.push(
      reason(
        'integrity_verified',
        'IDENTITY_COLLISION',
        'envelope.identity',
        'the envelope identity does not name the descriptor it carries',
      ),
    );
  }

  const attestation = evaluateAttestation(envelope);
  reasons.push(...attestation.reasons);

  return { reasons, attestation: attestation.result };
};

/* ------------------------------------------------------------------------ composition */

/**
 * Runs the stages in order, stopping at the first that refuses.
 *
 * `admissible: true` means only that the envelope passed every check up to and including
 * integrity. It is NOT staging, publication or activation — those are registry operations with
 * their own compare-and-swap preconditions.
 */
export const runIngestionPipeline = (
  rawEnvelope: unknown,
  context: IngestionContext,
): IngestionOutcome => {
  const reached: PipelineStage[] = [];

  const receivedReasons = stageReceived(rawEnvelope);
  if (receivedReasons.length > 0) {
    return {
      stage: 'rejected',
      reached,
      reasons: receivedReasons,
      attestation: null,
      identity: null,
      admissible: false,
    };
  }
  reached.push('received');

  const envelopeRecord = rawEnvelope as Record<string, unknown>;
  const structural = stageEnvelopeValidated(envelopeRecord);
  if (structural.length > 0) {
    return {
      stage: 'rejected',
      reached,
      reasons: structural,
      attestation: null,
      identity: null,
      admissible: false,
    };
  }
  reached.push('envelope_validated');

  const envelope = rawEnvelope as unknown as IngestionEnvelope;

  const contractReasons = stageContractValidated(envelope);
  if (contractReasons.length > 0) {
    return {
      stage: 'rejected',
      reached,
      reasons: contractReasons,
      attestation: null,
      identity: envelope.identity ?? null,
      admissible: false,
    };
  }
  reached.push('contract_validated');

  const provenanceReasons = stageProvenanceVerified(envelope, context);
  if (provenanceReasons.length > 0) {
    return {
      stage: 'rejected',
      reached,
      reasons: provenanceReasons,
      attestation: null,
      identity: envelope.identity ?? null,
      admissible: false,
    };
  }
  reached.push('provenance_verified');

  const governanceReasons = stageGovernanceVerified(envelope, context);
  if (governanceReasons.length > 0) {
    return {
      stage: 'rejected',
      reached,
      reasons: governanceReasons,
      attestation: null,
      identity: envelope.identity,
      admissible: false,
    };
  }
  reached.push('governance_verified');

  const integrity = stageIntegrityVerified(envelope);
  if (integrity.reasons.length > 0) {
    return {
      stage: 'rejected',
      reached,
      reasons: integrity.reasons,
      attestation: integrity.attestation,
      identity: envelope.identity,
      admissible: false,
    };
  }
  reached.push('integrity_verified');

  return {
    stage: 'integrity_verified',
    reached,
    reasons: [],
    attestation: integrity.attestation,
    identity: envelope.identity,
    admissible: true,
  };
};
