/**
 * Candidate artifact-manifest contract v1 — I3 Step 1.
 *
 * This module is the single source of truth for the *inactive* manifest contract that will
 * eventually describe governed artifact delivery. Nothing here is wired into any route: the
 * live `GET /config` response is untouched and remains the only distribution surface. The
 * contract exists as repository-only types, validation code, fixtures and tests so that the
 * governance semantics are pinned down — and fail closed — before anything is ever published
 * through them.
 *
 * The five states below (`present`, `published`, `approved`, `active`,
 * `eligible_for_environment`) are deliberately distinct and must never be treated as synonyms.
 * An artifact that merely exists in storage or in a repository is `present` and nothing more.
 */

export const MANIFEST_CONTRACT_VERSION = '1.0.0';

/** The only manifest major version this code understands. Anything else is rejected. */
export const SUPPORTED_MANIFEST_MAJOR = 1;

/**
 * Manifest-level features this implementation supports. Empty on purpose: a manifest that
 * declares any `required_features` entry is asking for behaviour this code does not have, and
 * fail-closed means rejecting it rather than ignoring the declaration.
 */
export const SUPPORTED_MANIFEST_FEATURES: readonly string[] = [];

/** Artifact content-schema identifiers this implementation knows how to reason about. */
export const SUPPORTED_ARTIFACT_SCHEMAS: readonly string[] = ['wellapath.artifact/1'];

/** The only content type any current artifact is allowed to declare. */
export const SUPPORTED_CONTENT_TYPES: readonly string[] = ['application/json'];

export type Environment = 'development' | 'staging' | 'production';
export const ENVIRONMENTS: readonly Environment[] = ['development', 'staging', 'production'];

export type ReleaseStatus = 'draft' | 'candidate' | 'published' | 'deprecated';
export const RELEASE_STATUSES: readonly ReleaseStatus[] = [
  'draft',
  'candidate',
  'published',
  'deprecated',
];

export type ActivationStatus = 'inactive' | 'active';
export const ACTIVATION_STATUSES: readonly ActivationStatus[] = ['inactive', 'active'];

export type ApprovalStatus = 'granted' | 'denied' | 'pending' | 'not_required';
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'granted',
  'denied',
  'pending',
  'not_required',
];

export type BlockerStatus = 'open' | 'resolved';
export const BLOCKER_STATUSES: readonly BlockerStatus[] = ['open', 'resolved'];

/**
 * A recorded governance approval. `status` must be exactly `'granted'` — with a non-null
 * decision reference — for the approval to count. Absent, null, unknown or malformed approval
 * data means NOT approved.
 */
export interface ApprovalRecord {
  required: boolean;
  status: ApprovalStatus;
  decision_ref: string | null;
  approved_at: string | null;
}

/** A safety or governance blocker. Any status other than `'resolved'` blocks eligibility. */
export interface BlockerRecord {
  id: string;
  status: BlockerStatus;
  reference?: string;
}

/** A version-and-hash-bound reference to another descriptor of the same artifact. */
export interface VersionRef {
  artifact_version: string;
  sha256: string;
}

export interface ArtifactDescriptor {
  /** Stable identity, e.g. `knowledge_base`. Never reused for different content lines. */
  artifact_id: string;
  artifact_version: string;
  /** Content-schema identifier; must be one of `SUPPORTED_ARTIFACT_SCHEMAS`. */
  schema_version: string;
  content_type: string;
  /** `sha256:<64 hex>` over the exact object bytes. */
  sha256: string;
  byte_count: number;
  /** Immutable object key, e.g. `kb.ng.v2.4.json`. Never reused for changed content. */
  object_key: string;
  /** Optional full URL; if present it must resolve to an approved origin and `object_key`. */
  url?: string;
  release_status: ReleaseStatus;
  activation_status: ActivationStatus;
  activation_authorized: boolean;
  activation_decision_ref: string | null;
  target_environments: Environment[];
  /** Minimum compatible mobile build number, where applicable. */
  min_app_build?: number;
  publication_decision_ref: string | null;
  approvals: {
    product: ApprovalRecord;
    clinical: ApprovalRecord;
  };
  blockers: BlockerRecord[];
  predecessor: VersionRef | null;
  /** Explicit, version/hash-bound downgrade target. Downgrades are refused without one. */
  rollback_target: VersionRef | null;
  created_at: string;
  published_at: string | null;
  deprecated: boolean;
  expires_at: string | null;
  country: string;
  /** Free-form traceability references (decision IDs, upstream commits). Never credentials. */
  references?: string[];
}

export interface CandidateManifest {
  manifest_version: string;
  generated_at: string;
  /** Features a consumer must support to use this manifest. Unknown entries are rejected. */
  required_features?: string[];
  artifacts: ArtifactDescriptor[];
}

/** Closed set of machine-readable rejection / denial reasons. */
export const REASON_CODES = [
  'MANIFEST_MALFORMED',
  'MANIFEST_VERSION_UNSUPPORTED',
  'UNKNOWN_REQUIRED_FEATURE',
  'UNKNOWN_FIELD',
  'MISSING_REQUIRED_FIELD',
  'MALFORMED_FIELD',
  'UNSUPPORTED_ARTIFACT_SCHEMA',
  'CONTENT_TYPE_UNSUPPORTED',
  'OBJECT_KEY_INVALID',
  'ORIGIN_NOT_APPROVED',
  'ORIGIN_NOT_HTTPS',
  'ORIGIN_HAS_CREDENTIALS',
  'ORIGIN_HAS_QUERY',
  'DUPLICATE_IDENTITY',
  'RELATIONSHIP_CYCLE',
  'INVALID_ROLLBACK_TARGET',
  'APPROVAL_STATUS_UNKNOWN',
  'HASH_MISMATCH',
  'BYTE_COUNT_MISMATCH',
  'NOT_PUBLISHED',
  'APPROVAL_MISSING',
  'APPROVAL_NOT_GRANTED',
  'BLOCKER_UNRESOLVED',
  'ACTIVATION_NOT_AUTHORIZED',
  'NOT_ACTIVE',
  'ENVIRONMENT_NOT_AUTHORIZED',
  'APP_BUILD_INCOMPATIBLE',
  'DESCRIPTOR_EXPIRED',
  'DESCRIPTOR_DEPRECATED',
  'NO_ACTIVE_ARTIFACT',
  'MULTIPLE_ACTIVE',
  'DOWNGRADE_NOT_AUTHORIZED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** A single machine-readable rejection or denial, always tied to a location and a reason. */
export interface Reason {
  code: ReasonCode;
  /** JSON-path-ish location, e.g. `artifacts[2].approvals.clinical.status`. */
  path: string;
  detail: string;
}

/** Descriptor keys that must be present. Exported so the schema drift check can assert on it. */
export const REQUIRED_DESCRIPTOR_KEYS: readonly string[] = [
  'artifact_id',
  'artifact_version',
  'schema_version',
  'content_type',
  'sha256',
  'byte_count',
  'object_key',
  'release_status',
  'activation_status',
  'activation_authorized',
  'activation_decision_ref',
  'target_environments',
  'publication_decision_ref',
  'approvals',
  'blockers',
  'predecessor',
  'rollback_target',
  'created_at',
  'published_at',
  'deprecated',
  'expires_at',
  'country',
];

/** Descriptor keys that may be present in addition to the required set. */
export const OPTIONAL_DESCRIPTOR_KEYS: readonly string[] = ['url', 'min_app_build', 'references'];
