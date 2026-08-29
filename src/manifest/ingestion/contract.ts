/**
 * Ingestion envelope contract v1 — I3 Step 3.
 *
 * This is the boundary the Backend would one day accept publication output across. Nothing here
 * is wired into any route, no module outside `src/manifest/**` imports it, and no code path in
 * this file touches the filesystem, the network, a database, R2, `process.env` or a clock it was
 * not handed. It exists so that the semantics of ingestion — what an envelope must prove, in
 * what order, and what each refusal means — are pinned down before anything can ever be ingested.
 *
 * It deliberately defines its OWN reason-code namespace rather than extending the manifest
 * contract's `REASON_CODES`. The manifest contract is published at 1.1.0 with a pinned schema
 * digest; adding codes to it would be a contract change, and this step changes no contract that
 * anyone has pinned. The two namespaces are combined only at the point of reporting.
 */
import { Environment, ReasonCode } from '../contract';

/**
 * Version of the ingestion envelope contract itself. Independent of the manifest contract.
 *
 * 1.1.0 supersedes 1.0.0, which existed only on this unmerged branch and was never published or
 * consumed. It adds REQUIRED provenance fields — the producing actor, the authorization the
 * ingestion occurs under, and the governance-register digest where one is referenced — so a 1.0.0
 * draft is invalid under it. That is a pre-merge amendment of a draft, not a compatibility promise
 * being broken. The supported major is unchanged.
 */
export const INGESTION_ENVELOPE_VERSION = '1.1.0';

/** The only envelope major this implementation understands. Anything else is refused. */
export const SUPPORTED_ENVELOPE_MAJOR = 1;

/**
 * The closed set of envelope versions this implementation actually understands.
 *
 * A major check alone is not enough in either direction. A *future* minor may rely on semantics
 * this code does not implement, and accepting it because the major matches is precisely the
 * fail-open behaviour the rest of this subsystem exists to avoid. A *superseded* minor was written
 * under weaker rules — 1.0.0 required no actor and no ingestion authorization — so accepting a
 * document that declares 1.0.0 would hand old input the guarantees of the new contract without it
 * ever having met them.
 *
 * So the rule is membership, not comparison. This mirrors the producer's own pin record, which
 * lists `supported_contract_versions` rather than a range.
 */
export const SUPPORTED_ENVELOPE_VERSIONS: readonly string[] = ['1.1.0'];

/**
 * Git object-id policy for `source_commit`.
 *
 * **A current compatibility constraint, not a universal assumption about Git.** Both repositories
 * in this system use SHA-1 object ids today, so a commit is 40 lowercase hex characters. Git's
 * SHA-256 object format produces 64-hex ids; this implementation deliberately refuses those rather
 * than accepting a length it has not been reconciled against, and the constraint must be revisited
 * — on both sides, together — before either repository migrates.
 */
export const SOURCE_COMMIT_HEX_LENGTH = 40;
export const SOURCE_COMMIT_OBJECT_FORMAT = 'sha1';

/**
 * The manifest contract version an envelope must declare. An envelope that names a different
 * contract is refused rather than interpreted: the Backend will not guess which semantics a
 * producer meant.
 */
export const REQUIRED_MANIFEST_CONTRACT_VERSION = '1.1.0';

/**
 * SHA256 over the exact committed bytes of `docs/contracts/manifest.v1.schema.json` at contract
 * 1.1.0, and its byte count. An envelope declaring a contract pin that does not match these is
 * drift, and drift fails closed — a producer and a consumer that disagree about the schema do
 * not agree about anything downstream of it.
 */
export const MANIFEST_SCHEMA_SHA256 =
  'sha256:948299bc1ca87592e372d4ce889bdd2424a6cfc3d34c7660453dfe7d60d5038a';
export const MANIFEST_SCHEMA_BYTE_COUNT = 7806;

/** Operations an envelope may request. Anything else is `OPERATION_INVALID`. */
export type IngestionOperation = 'stage' | 'publish' | 'activate' | 'rollback';
export const INGESTION_OPERATIONS: readonly IngestionOperation[] = [
  'stage',
  'publish',
  'activate',
  'rollback',
];

/**
 * Trust modes for attestation.
 *
 * `production` is the only mode any real caller can ask for, and it currently always fails with
 * `SIGNATURE_POLICY_UNAVAILABLE` — see `signing.ts`. `synthetic_test_only` exists so the pipeline
 * can be exercised end to end by tests; it is never selectable from application code, never
 * readable from an environment variable, never valid outside `development`, and never produces an
 * operative verification receipt.
 */
export type TrustMode = 'production' | 'synthetic_test_only';
export const TRUST_MODES: readonly TrustMode[] = ['production', 'synthetic_test_only'];

/**
 * Pipeline stages, in order. A stage NEVER implies the next one: reaching `staged` says nothing
 * about publication, `published` says nothing about activation, and storage presence says nothing
 * about any of them. `rejected` is terminal and reachable from every other stage.
 */
export type PipelineStage =
  | 'received'
  | 'envelope_validated'
  | 'contract_validated'
  | 'provenance_verified'
  | 'governance_verified'
  | 'integrity_verified'
  | 'staged'
  | 'published'
  | 'active'
  | 'rejected';

/** The ordered progression. `rejected` is deliberately absent: it is terminal, not a step. */
export const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = [
  'received',
  'envelope_validated',
  'contract_validated',
  'provenance_verified',
  'governance_verified',
  'integrity_verified',
  'staged',
  'published',
  'active',
];

export const PIPELINE_STAGES: readonly PipelineStage[] = [...PIPELINE_STAGE_ORDER, 'rejected'];

/**
 * Ingestion-specific refusal codes. Closed set; every rejection cites exactly one of these or one
 * of the manifest contract's own `ReasonCode`s, always together with the stage that produced it.
 */
export const INGESTION_REASON_CODES = [
  // envelope_validated
  'ENVELOPE_MALFORMED',
  'ENVELOPE_VERSION_UNSUPPORTED',
  'ENVELOPE_UNKNOWN_FIELD',
  'ENVELOPE_MISSING_FIELD',
  'OPERATION_INVALID',
  'IDEMPOTENCY_KEY_MISSING',
  'IDEMPOTENCY_KEY_MALFORMED',
  // contract_validated
  'CONTRACT_VERSION_MISMATCH',
  'CONTRACT_PIN_DRIFT',
  // provenance_verified
  'PROVENANCE_MISSING',
  'KB_SOURCE_MISMATCH',
  'PLAN_HASH_MISMATCH',
  'OBJECT_KEY_MUTABLE',
  'IDENTITY_COLLISION',
  // governance_verified
  'PUBLICATION_NOT_PERFORMED',
  'PUBLICATION_NOT_AUTHORIZED',
  'ROLLBACK_NOT_AUTHORIZED',
  'ROLLBACK_TARGET_UNKNOWN',
  'ROLLBACK_TARGET_NOT_IMMUTABLE',
  'ROLLBACK_SCHEMA_INCOMPATIBLE',
  'ROLLBACK_POLICY_UNRESOLVED',
  // provenance_verified — source, actor and authorization
  'PROVENANCE_SOURCE_MUTABLE_REFERENCE',
  'PROVENANCE_ACTOR_MISSING',
  'PROVENANCE_AUTHORIZATION_MISSING',
  'PROVENANCE_CONTRADICTION',
  'PROVENANCE_NOT_VERIFIED',
  'GOVERNANCE_REGISTER_HASH_MISMATCH',
  'DESCRIPTOR_REFERENCE_MISMATCH',
  'SOURCE_PROVENANCE_MALFORMED',
  'SOURCE_PROVENANCE_KIND_UNKNOWN',
  // integrity_verified — attestation
  'SIGNATURE_POLICY_UNAVAILABLE',
  'TEST_TRUST_MODE_FORBIDDEN',
  'TRUST_MODE_UNKNOWN',
  // registry / compare-and-swap
  'REVISION_STALE',
  'ACTIVE_IDENTITY_UNEXPECTED',
  'ACTIVATION_BEFORE_PUBLICATION',
  'CANDIDATE_NOT_STAGED',
  'CANDIDATE_NOT_PUBLISHED',
  'DUPLICATE_ACTIVE_SELECTION',
  'REPLAY_PAYLOAD_MISMATCH',
  'IDEMPOTENCY_KEY_REUSED',
  // audit
  'AUDIT_SENSITIVE_DATA',
] as const;

export type IngestionReasonCode = (typeof INGESTION_REASON_CODES)[number];

/** Either namespace of code may appear in a refusal, always bound to a stage. */
export type AnyReasonCode = ReasonCode | IngestionReasonCode;

/** A refusal, always tied to the stage that produced it and a location within the envelope. */
export interface StageReason {
  stage: PipelineStage;
  code: AnyReasonCode;
  /** JSON-path-ish location, e.g. `envelope.provenance.kb_commit`. */
  path: string;
  detail: string;
}

/** Immutable artifact identity. Identity is the triple; two of three is not an identity. */
export interface ArtifactIdentity {
  artifact_id: string;
  artifact_version: string;
  /** `sha256:<64 hex>` over the exact object bytes. */
  sha256: string;
}

/**
 * Where an envelope came from, who produced it, and under what authorization.
 *
 * The producer's own publication plan states the division explicitly: the plan supplies artifact
 * byte identity, hash-bound decision-record provenance and contract provenance; the *envelope*
 * must supply the source repository and commit the bytes were taken from, the actor performing
 * the ingestion, and the authorization it occurs under. None of those three may be inferred from
 * an artifact hash, a descriptor, a branch name or an object key — the plan says so in as many
 * words, and this contract enforces it.
 */
export interface EnvelopeProvenance {
  /** Producing repository, e.g. `wellapath-org/wellapath-knowledge-base`. */
  source_repository: string;
  /**
   * Exact producing commit — a full 40-hex id. Never a branch name, tag or symbolic ref: those
   * are mutable and name whatever they happen to point at today.
   */
  source_commit: string;
  /** Identity of the publication plan this envelope was generated from. */
  publication_plan_id: string;
  /** `sha256:<64 hex>` over the exact committed bytes of that plan. */
  publication_plan_sha256: string;
  /**
   * Digest of the governance register, required whenever the envelope's plan provenance
   * references one. `null` only when nothing references a register.
   */
  governance_register_sha256: string | null;
  /**
   * Who performed the ingestion. A reference to a recorded operator or system identity, never a
   * person's name or credential. Absent means the ingestion has no attributable actor.
   */
  actor_ref: string;
  /** The authorization the ingestion itself occurs under. Distinct from per-operation decisions. */
  authorization_ref: string;
  /** Tool that produced the envelope, for traceability. */
  generator: string;
  generator_version: string;
}

/**
 * How far provenance has actually been established. These three are never synonyms.
 *
 *   claimed          — the fields are populated. That is the entire claim: anyone can populate
 *                      fields, so this establishes nothing beyond the envelope being well formed.
 *   integrity_bound  — the declared digests match the digests this implementation holds. The
 *                      bytes are the bytes. It says nothing about who approved them, who produced
 *                      them, or whether the producer was authorised.
 *   verified         — the producer's identity and authority have been cryptographically
 *                      established. This requires trusted-producer infrastructure that does not
 *                      exist, so production-like provenance can never reach it today.
 */
export type ProvenanceState = 'claimed' | 'integrity_bound' | 'verified';
export const PROVENANCE_STATES: readonly ProvenanceState[] = [
  'claimed',
  'integrity_bound',
  'verified',
];

/** Ordering for "at least" comparisons. Never treat a lower state as satisfying a higher one. */
export const PROVENANCE_STATE_RANK: Readonly<Record<ProvenanceState, number>> = {
  claimed: 0,
  integrity_bound: 1,
  verified: 2,
};

/**
 * The provenance state each operation requires.
 *
 * Staging is Backend bookkeeping and needs the bytes to be what they say they are. Publishing,
 * activating and rolling back change what consumers receive, so each requires provenance to be
 * `verified` — which, with no trusted-producer infrastructure, means they fail closed outside a
 * synthetic test.
 */
export const OPERATION_PROVENANCE_REQUIREMENT: Readonly<
  Record<IngestionOperation, ProvenanceState>
> = {
  stage: 'integrity_bound',
  publish: 'verified',
  activate: 'verified',
  rollback: 'verified',
};

/**
 * Kinds the producer's informational `source_provenance` block may declare. Closed: an unknown
 * kind is refused rather than ignored, because a kind this implementation does not understand may
 * be making a claim it does not know how to disbelieve.
 */
export const SOURCE_PROVENANCE_KINDS: readonly string[] = [
  'artifact_byte_identity',
  'generator_input_identity',
  'decision_record_provenance',
  'publication_plan_provenance',
  'repository_branch_state',
  'ingestion_boundary',
];

/**
 * The producer's `source_provenance` block, carried verbatim and treated as INFORMATIONAL.
 *
 * It is integrity-bound (it lives inside a plan whose digest is pinned) and it is useful context,
 * but it can never override envelope provenance and can never certify its own producer or
 * authorization. A document does not become authoritative about its own origin by describing it.
 */
export interface PlanSourceProvenance {
  /** Digest of the governance register the plan's decision-record provenance names. */
  decision_register_sha256: string | null;
  /** Whether the plan cites a mutable branch tip. Must be false; a branch tip names nothing fixed. */
  repository_branch_cited: boolean;
  /** The kinds the block declares, checked against `SOURCE_PROVENANCE_KINDS`. */
  kinds: string[];
}

/** Governance decision references carried by the envelope. Absent means NOT authorized. */
export interface EnvelopeAuthorizations {
  publication_decision_ref: string | null;
  activation_decision_ref: string | null;
  rollback_decision_ref: string | null;
}

/** Attestation claim made by the producer. A claim is not a verification. */
export interface EnvelopeAttestation {
  trust_mode: TrustMode;
  /** Producer's claim. The Backend verifies independently and never trusts this field. */
  claimed_signed: boolean;
  /** Opaque identifier of the signature, when one exists. Never key material. */
  signature_ref: string | null;
}

/** Version-and-hash-bound rollback identity. A rollback without one is refused. */
export interface RollbackIdentity {
  target: ArtifactIdentity;
  /** Schema version the target declares; a cross-schema rollback needs approved policy. */
  target_schema_version: string;
}

/**
 * The ingestion envelope.
 *
 * Deliberately carries no URL, no credential, no presigned link and no artifact bytes: the object
 * is named by immutable identity and verified by digest, so nothing here can leak a secret or be
 * replayed against a live endpoint.
 */
export interface IngestionEnvelope {
  envelope_version: string;
  manifest_contract_version: string;
  /** The producer's copy of the manifest schema digest, checked against the pin. */
  manifest_schema_sha256: string;
  manifest_schema_byte_count: number;
  provenance: EnvelopeProvenance;
  /** The descriptor being offered, exactly as the manifest contract defines it. */
  descriptor: unknown;
  identity: ArtifactIdentity;
  byte_count: number;
  content_type: string;
  /** Immutable object key. Reuse for changed content is `OBJECT_KEY_MUTABLE`. */
  object_key: string;
  environment: Environment;
  requested_operation: IngestionOperation;
  authorizations: EnvelopeAuthorizations;
  attestation: EnvelopeAttestation;
  created_at: string;
  /** Caller-supplied replay key. Same key with different payload is a conflict, never a replay. */
  idempotency_key: string;
  predecessor: ArtifactIdentity | null;
  rollback: RollbackIdentity | null;
  /**
   * The producer's own provenance narrative, carried for traceability. Informational only: it is
   * checked for structure and agreement, and it is never read as approval or authorization.
   */
  plan_source_provenance: PlanSourceProvenance | null;
  /** Marks a fixture that names no real object. Required by the test-only trust mode. */
  synthetic: boolean;
}

/** Envelope keys that must be present. Exported so the schema drift check asserts on it. */
export const REQUIRED_ENVELOPE_KEYS: readonly string[] = [
  'envelope_version',
  'manifest_contract_version',
  'manifest_schema_sha256',
  'manifest_schema_byte_count',
  'provenance',
  'descriptor',
  'identity',
  'byte_count',
  'content_type',
  'object_key',
  'environment',
  'requested_operation',
  'authorizations',
  'attestation',
  'created_at',
  'idempotency_key',
  'predecessor',
  'rollback',
  'plan_source_provenance',
  'synthetic',
];

/** No optional envelope keys today. Unknown keys are refused, never ignored. */
export const OPTIONAL_ENVELOPE_KEYS: readonly string[] = [];

export const REQUIRED_PROVENANCE_KEYS: readonly string[] = [
  'source_repository',
  'source_commit',
  'publication_plan_id',
  'publication_plan_sha256',
  'governance_register_sha256',
  'actor_ref',
  'authorization_ref',
  'generator',
  'generator_version',
];

/**
 * Reference forms that are never acceptable as source identity. A mutable ref names whatever it
 * points at when someone looks, which is exactly the property a provenance record must not have.
 */
export const MUTABLE_SOURCE_REFERENCES: readonly string[] = [
  'develop',
  'main',
  'master',
  'head',
  'latest',
  'current',
  'stable',
  'live',
  'production',
  'prod',
  'default',
  'trunk',
];

/** Formats an identity for audit and reason text. Never includes a URL or any secret. */
export const formatIdentity = (identity: ArtifactIdentity): string =>
  `${identity.artifact_id}@${identity.artifact_version}#${identity.sha256}`;

/** Structural identity equality. All three components, or it is not the same artifact. */
export const identityEquals = (a: ArtifactIdentity | null, b: ArtifactIdentity | null): boolean => {
  if (a === null || b === null) return a === b;
  return (
    a.artifact_id === b.artifact_id &&
    a.artifact_version === b.artifact_version &&
    a.sha256 === b.sha256
  );
};
