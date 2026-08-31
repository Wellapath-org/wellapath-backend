/**
 * Registry model — pure, in-memory, and never wired to anything.
 *
 * There is no persistence here, no migration, no environment variable, no startup hook and no
 * application wiring. Every operation is a function from a state to a new state; no state is ever
 * mutated in place, so a caller holding the prior state still holds exactly what it had.
 *
 * The invariant that matters most: **a failed operation returns the prior state object itself.**
 * Not a copy that happens to be equal — the same reference. That makes "a failed activation leaves
 * the registry byte-for-byte unchanged" something a test can assert with `toBe`, rather than
 * something a reader has to take on trust after auditing every branch. The audit event describing
 * the failure is returned alongside, for the caller to journal wherever it keeps its journal;
 * recording it into the registry is a separate, explicit act (`withAuditEvent`).
 */
import {
  AnyReasonCode,
  ArtifactIdentity,
  IngestionEnvelope,
  IngestionOperation,
  PipelineStage,
  StageReason,
  formatIdentity,
  identityEquals,
} from '../ingestion/contract';
import { IngestionOutcome } from '../ingestion/pipeline';
import { Environment } from '../contract';
import { AuditAuthority, AuditEvent, buildAuditEvent, canonicalize } from './audit';

/** Composite key for per-environment, per-artifact-line state. */
const lineKey = (environment: Environment, artifactId: string): string =>
  `${environment}::${artifactId}`;

/** A recorded refusal, deliberately carrying no envelope payload. */
export interface RejectedRecord {
  correlation_key: string;
  stage: PipelineStage;
  reason_codes: AnyReasonCode[];
  identity: ArtifactIdentity | null;
  environment: Environment;
  occurred_at: string;
}

/** What an idempotency key was used for, so a replay can be told from a conflict. */
export interface IdempotencyRecord {
  /** Canonical digest of the request payload this key was first used with. */
  payload_digest: string;
  operation: IngestionOperation;
  resulting_revision: number;
  identity: ArtifactIdentity | null;
}

export interface RegistryState {
  /** Monotonic. Increases by exactly one on every accepted mutation, never otherwise. */
  readonly revision: number;
  readonly staged: readonly ArtifactIdentity[];
  readonly published: readonly ArtifactIdentity[];
  /** Active selection per environment per artifact line. At most one, by construction. */
  readonly active: Readonly<Record<string, ArtifactIdentity>>;
  /** The descriptor that was active before the current one, per environment per line. */
  readonly lastKnownGood: Readonly<Record<string, ArtifactIdentity>>;
  /** Every identity the registry has ever seen, keyed `id@version`. Immutable once recorded. */
  readonly knownIdentities: Readonly<Record<string, ArtifactIdentity>>;
  readonly knownObjectKeys: Readonly<Record<string, ArtifactIdentity>>;
  readonly idempotency: Readonly<Record<string, IdempotencyRecord>>;
  /** Append-only. */
  readonly audit: readonly AuditEvent[];
  readonly rejected: readonly RejectedRecord[];
}

export const emptyRegistry = (): RegistryState => ({
  revision: 0,
  staged: [],
  published: [],
  active: {},
  lastKnownGood: {},
  knownIdentities: {},
  knownObjectKeys: {},
  idempotency: {},
  audit: [],
  rejected: [],
});

/** Read-only projection the ingestion pipeline needs, without handing it the whole registry. */
export const registryView = (
  state: RegistryState,
): {
  knownIdentities: ReadonlyMap<string, ArtifactIdentity>;
  knownObjectKeys: ReadonlyMap<string, ArtifactIdentity>;
  seenIdempotencyKeys: ReadonlyMap<string, string>;
} => ({
  knownIdentities: new Map(Object.entries(state.knownIdentities)),
  knownObjectKeys: new Map(Object.entries(state.knownObjectKeys)),
  seenIdempotencyKeys: new Map(
    Object.entries(state.idempotency).map(([key, record]) => [key, record.payload_digest]),
  ),
});

export interface OperationResult {
  ok: boolean;
  /** On failure this is the prior state object itself — identity-equal, not merely deep-equal. */
  state: RegistryState;
  event: AuditEvent;
  reasons: StageReason[];
}

/** Compare-and-swap parameters common to activation and rollback. */
export interface CasExpectation {
  /** The revision the caller believes it is acting on. Anything else is a stale write. */
  expectedRevision: number;
  /** The active identity the caller believes it is replacing. `null` means "expected none". */
  expectedActive: ArtifactIdentity | null;
}

export interface ActivationRequest extends CasExpectation {
  envelope: IngestionEnvelope;
  outcome: IngestionOutcome;
  authority: AuditAuthority;
}

const refusal = (
  state: RegistryState,
  envelope: IngestionEnvelope,
  authority: AuditAuthority,
  eventType: AuditEvent['event_type'],
  stage: PipelineStage,
  reasons: StageReason[],
): OperationResult => ({
  ok: false,
  // The prior state object, returned unchanged.
  state,
  event: buildAuditEvent({
    event_type: eventType,
    prior_revision: state.revision,
    resulting_revision: state.revision,
    environment: envelope.environment,
    operation: envelope.requested_operation,
    identity: envelope.identity ?? null,
    authority,
    outcome: 'refused',
    stage,
    reason_codes: reasons.map(entry => entry.code),
    correlation_key: envelope.idempotency_key,
    occurred_at: envelope.created_at,
  }),
  reasons,
});

const reason = (
  stage: PipelineStage,
  code: AnyReasonCode,
  path: string,
  detail: string,
): StageReason => ({ stage, code, path, detail });

/**
 * Canonical digest of the parts of a request that define what it asks for. Two requests sharing an
 * idempotency key must agree on all of it, or the second is a conflict rather than a replay.
 */
export const requestDigest = (envelope: IngestionEnvelope, expectation: CasExpectation): string =>
  canonicalize({
    operation: envelope.requested_operation,
    identity: envelope.identity,
    environment: envelope.environment,
    byte_count: envelope.byte_count,
    object_key: envelope.object_key,
    authorizations: envelope.authorizations,
    rollback: envelope.rollback,
    expectedRevision: expectation.expectedRevision,
    expectedActive: expectation.expectedActive,
  });

/**
 * Resolves an idempotency key against prior use.
 *
 * `replay` means the identical request was already applied and must not be applied twice.
 * `conflict` means the key was reused for a different request, which is a caller bug and never a
 * reason to guess which one was meant.
 */
export const classifyIdempotency = (
  state: RegistryState,
  key: string,
  digest: string,
): 'fresh' | 'replay' | 'conflict' => {
  const prior = state.idempotency[key];
  if (prior === undefined) return 'fresh';
  return prior.payload_digest === digest ? 'replay' : 'conflict';
};

const recordIdentity = (
  state: RegistryState,
  envelope: IngestionEnvelope,
): Pick<RegistryState, 'knownIdentities' | 'knownObjectKeys'> => ({
  knownIdentities: {
    ...state.knownIdentities,
    [`${envelope.identity.artifact_id}@${envelope.identity.artifact_version}`]: envelope.identity,
  },
  knownObjectKeys: { ...state.knownObjectKeys, [envelope.object_key]: envelope.identity },
});

/* ----------------------------------------------------------------------------- staging */

/**
 * Records a candidate as staged. Staging is Backend bookkeeping: it asserts the envelope was
 * admissible, and nothing else. It confers no publication and no activation.
 */
export const stageCandidate = (
  state: RegistryState,
  request: ActivationRequest,
): OperationResult => {
  const { envelope, outcome, authority } = request;
  const expectation: CasExpectation = {
    expectedRevision: request.expectedRevision,
    expectedActive: request.expectedActive,
  };

  if (!outcome.admissible) {
    return refusal(state, envelope, authority, 'rejection', outcome.stage, outcome.reasons);
  }
  if (envelope.requested_operation !== 'stage') {
    return refusal(state, envelope, authority, 'rejection', 'envelope_validated', [
      reason(
        'envelope_validated',
        'OPERATION_INVALID',
        'envelope.requested_operation',
        `stageCandidate was called for operation ${envelope.requested_operation}`,
      ),
    ]);
  }
  const digest = requestDigest(envelope, expectation);
  const classification = classifyIdempotency(state, envelope.idempotency_key, digest);
  if (classification === 'conflict') {
    return refusal(state, envelope, authority, 'conflict', 'staged', [
      reason(
        'staged',
        'REPLAY_PAYLOAD_MISMATCH',
        'envelope.idempotency_key',
        'this idempotency key was already used for a different request; a key is never reused',
      ),
    ]);
  }
  if (classification === 'replay') {
    return {
      ok: true,
      state,
      event: buildAuditEvent({
        event_type: 'idempotent_replay',
        prior_revision: state.revision,
        resulting_revision: state.revision,
        environment: envelope.environment,
        operation: envelope.requested_operation,
        identity: envelope.identity,
        authority,
        outcome: 'no_op',
        stage: 'staged',
        reason_codes: [],
        correlation_key: envelope.idempotency_key,
        occurred_at: envelope.created_at,
      }),
      reasons: [],
    };
  }

  if (state.revision !== expectation.expectedRevision) {
    return refusal(state, envelope, authority, 'conflict', 'staged', [
      reason(
        'staged',
        'REVISION_STALE',
        'registry.revision',
        `caller expected revision ${expectation.expectedRevision}, registry is at ${state.revision}`,
      ),
    ]);
  }

  const nextRevision = state.revision + 1;
  const event = buildAuditEvent({
    event_type: 'staging',
    prior_revision: state.revision,
    resulting_revision: nextRevision,
    environment: envelope.environment,
    operation: 'stage',
    identity: envelope.identity,
    authority,
    outcome: 'accepted',
    stage: 'staged',
    reason_codes: [],
    correlation_key: envelope.idempotency_key,
    occurred_at: envelope.created_at,
  });

  return {
    ok: true,
    state: {
      ...state,
      revision: nextRevision,
      staged: [...state.staged, envelope.identity],
      ...recordIdentity(state, envelope),
      idempotency: {
        ...state.idempotency,
        [envelope.idempotency_key]: {
          payload_digest: digest,
          operation: 'stage',
          resulting_revision: nextRevision,
          identity: envelope.identity,
        },
      },
      audit: [...state.audit, event],
    },
    event,
    reasons: [],
  };
};

/* ------------------------------------------------------------------------- publication */

/** Moves a staged candidate to published. Publication makes an artifact available; it does not
 * choose it. Nothing about the active selection changes here. */
export const publishCandidate = (
  state: RegistryState,
  request: ActivationRequest,
): OperationResult => {
  const { envelope, outcome, authority } = request;
  const expectation: CasExpectation = {
    expectedRevision: request.expectedRevision,
    expectedActive: request.expectedActive,
  };

  if (!outcome.admissible) {
    return refusal(state, envelope, authority, 'rejection', outcome.stage, outcome.reasons);
  }
  if (envelope.requested_operation !== 'publish') {
    return refusal(state, envelope, authority, 'rejection', 'envelope_validated', [
      reason(
        'envelope_validated',
        'OPERATION_INVALID',
        'envelope.requested_operation',
        `publishCandidate was called for operation ${envelope.requested_operation}`,
      ),
    ]);
  }
  const digest = requestDigest(envelope, expectation);
  const classification = classifyIdempotency(state, envelope.idempotency_key, digest);
  if (classification === 'conflict') {
    return refusal(state, envelope, authority, 'conflict', 'published', [
      reason(
        'published',
        'REPLAY_PAYLOAD_MISMATCH',
        'envelope.idempotency_key',
        'this idempotency key was already used for a different request',
      ),
    ]);
  }
  if (classification === 'replay') {
    return {
      ok: true,
      state,
      event: buildAuditEvent({
        event_type: 'idempotent_replay',
        prior_revision: state.revision,
        resulting_revision: state.revision,
        environment: envelope.environment,
        operation: 'publish',
        identity: envelope.identity,
        authority,
        outcome: 'no_op',
        stage: 'published',
        reason_codes: [],
        correlation_key: envelope.idempotency_key,
        occurred_at: envelope.created_at,
      }),
      reasons: [],
    };
  }

  if (state.revision !== expectation.expectedRevision) {
    return refusal(state, envelope, authority, 'conflict', 'published', [
      reason(
        'published',
        'REVISION_STALE',
        'registry.revision',
        `caller expected revision ${expectation.expectedRevision}, registry is at ${state.revision}`,
      ),
    ]);
  }
  if (!state.staged.some(identity => identityEquals(identity, envelope.identity))) {
    return refusal(state, envelope, authority, 'rejection', 'published', [
      reason(
        'published',
        'CANDIDATE_NOT_STAGED',
        'registry.staged',
        `${formatIdentity(envelope.identity)} was never staged; publication does not skip staging`,
      ),
    ]);
  }

  const nextRevision = state.revision + 1;
  const event = buildAuditEvent({
    event_type: 'publication',
    prior_revision: state.revision,
    resulting_revision: nextRevision,
    environment: envelope.environment,
    operation: 'publish',
    identity: envelope.identity,
    authority,
    outcome: 'accepted',
    stage: 'published',
    reason_codes: [],
    correlation_key: envelope.idempotency_key,
    occurred_at: envelope.created_at,
  });

  return {
    ok: true,
    state: {
      ...state,
      revision: nextRevision,
      published: [...state.published, envelope.identity],
      ...recordIdentity(state, envelope),
      idempotency: {
        ...state.idempotency,
        [envelope.idempotency_key]: {
          payload_digest: digest,
          operation: 'publish',
          resulting_revision: nextRevision,
          identity: envelope.identity,
        },
      },
      audit: [...state.audit, event],
    },
    event,
    reasons: [],
  };
};

/* -------------------------------------------------------------------------- activation */

/**
 * Atomic compare-and-swap activation.
 *
 * Every precondition is checked before anything is built, and any failure returns the prior state
 * object itself. There is no partial application: the new state is constructed once, at the end,
 * from values already proven.
 */
export const activateCandidate = (
  state: RegistryState,
  request: ActivationRequest,
): OperationResult => {
  const { envelope, outcome, authority } = request;
  const expectation: CasExpectation = {
    expectedRevision: request.expectedRevision,
    expectedActive: request.expectedActive,
  };
  const key = lineKey(envelope.environment, envelope.identity?.artifact_id ?? '');

  if (!outcome.admissible) {
    return refusal(state, envelope, authority, 'rejection', outcome.stage, outcome.reasons);
  }
  if (envelope.requested_operation !== 'activate') {
    return refusal(state, envelope, authority, 'rejection', 'envelope_validated', [
      reason(
        'envelope_validated',
        'OPERATION_INVALID',
        'envelope.requested_operation',
        `activateCandidate was called for operation ${envelope.requested_operation}`,
      ),
    ]);
  }

  // Stale write: someone else moved the registry since the caller read it.
  const digest = requestDigest(envelope, expectation);
  const classification = classifyIdempotency(state, envelope.idempotency_key, digest);
  if (classification === 'conflict') {
    return refusal(state, envelope, authority, 'conflict', 'active', [
      reason(
        'active',
        'REPLAY_PAYLOAD_MISMATCH',
        'envelope.idempotency_key',
        'this idempotency key was already used for a different request',
      ),
    ]);
  }
  if (classification === 'replay') {
    return {
      ok: true,
      state,
      event: buildAuditEvent({
        event_type: 'idempotent_replay',
        prior_revision: state.revision,
        resulting_revision: state.revision,
        environment: envelope.environment,
        operation: 'activate',
        identity: envelope.identity,
        authority,
        outcome: 'no_op',
        stage: 'active',
        reason_codes: [],
        correlation_key: envelope.idempotency_key,
        occurred_at: envelope.created_at,
      }),
      reasons: [],
    };
  }

  if (state.revision !== expectation.expectedRevision) {
    return refusal(state, envelope, authority, 'conflict', 'active', [
      reason(
        'active',
        'REVISION_STALE',
        'registry.revision',
        `caller expected revision ${expectation.expectedRevision}, registry is at ${state.revision}`,
      ),
    ]);
  }

  // The caller must correctly state what it believes it is replacing.
  const currentActive = state.active[key] ?? null;
  if (!identityEquals(currentActive, expectation.expectedActive)) {
    return refusal(state, envelope, authority, 'conflict', 'active', [
      reason(
        'active',
        'ACTIVE_IDENTITY_UNEXPECTED',
        'registry.active',
        `caller expected active ${expectation.expectedActive === null ? 'none' : formatIdentity(expectation.expectedActive)}, registry holds ${currentActive === null ? 'none' : formatIdentity(currentActive)}`,
      ),
    ]);
  }

  // Activation strictly follows publication, which strictly follows staging.
  if (!state.staged.some(identity => identityEquals(identity, envelope.identity))) {
    return refusal(state, envelope, authority, 'rejection', 'active', [
      reason(
        'active',
        'CANDIDATE_NOT_STAGED',
        'registry.staged',
        `${formatIdentity(envelope.identity)} was never staged`,
      ),
    ]);
  }
  if (!state.published.some(identity => identityEquals(identity, envelope.identity))) {
    return refusal(state, envelope, authority, 'rejection', 'active', [
      reason(
        'active',
        'ACTIVATION_BEFORE_PUBLICATION',
        'registry.published',
        `${formatIdentity(envelope.identity)} is not published; a staged candidate is not activatable`,
      ),
    ]);
  }
  if (identityEquals(currentActive, envelope.identity)) {
    return refusal(state, envelope, authority, 'conflict', 'active', [
      reason(
        'active',
        'DUPLICATE_ACTIVE_SELECTION',
        'registry.active',
        `${formatIdentity(envelope.identity)} is already the active descriptor for this line and environment`,
      ),
    ]);
  }

  const nextRevision = state.revision + 1;
  const event = buildAuditEvent({
    event_type: 'activation',
    prior_revision: state.revision,
    resulting_revision: nextRevision,
    environment: envelope.environment,
    operation: 'activate',
    identity: envelope.identity,
    authority,
    outcome: 'accepted',
    stage: 'active',
    reason_codes: [],
    correlation_key: envelope.idempotency_key,
    occurred_at: envelope.created_at,
  });

  // Last-known-good advances only on a successful activation, and only to the descriptor that
  // was genuinely serving before this one.
  const nextLastKnownGood =
    currentActive === null ? state.lastKnownGood : { ...state.lastKnownGood, [key]: currentActive };

  return {
    ok: true,
    state: {
      ...state,
      revision: nextRevision,
      active: { ...state.active, [key]: envelope.identity },
      lastKnownGood: nextLastKnownGood,
      ...recordIdentity(state, envelope),
      idempotency: {
        ...state.idempotency,
        [envelope.idempotency_key]: {
          payload_digest: digest,
          operation: 'activate',
          resulting_revision: nextRevision,
          identity: envelope.identity,
        },
      },
      audit: [...state.audit, event],
    },
    event,
    reasons: [],
  };
};

/* ---------------------------------------------------------------------------- rollback */

/**
 * Atomic compare-and-swap rollback — a separate operation, never a fallback path of activation.
 *
 * The pipeline has already refused any rollback that is unauthorized, unbound, aimed at an unknown
 * or mutated target, or crossing a schema boundary without approved policy. What remains here is
 * the registry-level compare-and-swap and the requirement that the target actually be the
 * last-known-good the caller claims.
 */
export const rollbackToTarget = (
  state: RegistryState,
  request: ActivationRequest,
): OperationResult => {
  const { envelope, outcome, authority } = request;
  const expectation: CasExpectation = {
    expectedRevision: request.expectedRevision,
    expectedActive: request.expectedActive,
  };
  const key = lineKey(envelope.environment, envelope.identity?.artifact_id ?? '');

  if (!outcome.admissible) {
    return refusal(state, envelope, authority, 'rejection', outcome.stage, outcome.reasons);
  }
  if (envelope.requested_operation !== 'rollback') {
    return refusal(state, envelope, authority, 'rejection', 'envelope_validated', [
      reason(
        'envelope_validated',
        'OPERATION_INVALID',
        'envelope.requested_operation',
        `rollbackToTarget was called for operation ${envelope.requested_operation}`,
      ),
    ]);
  }
  const digest = requestDigest(envelope, expectation);
  const classification = classifyIdempotency(state, envelope.idempotency_key, digest);
  if (classification === 'conflict') {
    return refusal(state, envelope, authority, 'conflict', 'active', [
      reason(
        'active',
        'REPLAY_PAYLOAD_MISMATCH',
        'envelope.idempotency_key',
        'this idempotency key was already used for a different request',
      ),
    ]);
  }
  if (classification === 'replay') {
    return {
      ok: true,
      state,
      event: buildAuditEvent({
        event_type: 'idempotent_replay',
        prior_revision: state.revision,
        resulting_revision: state.revision,
        environment: envelope.environment,
        operation: 'rollback',
        // The replay check runs before the target is resolved, so name it from the envelope.
        identity: envelope.rollback?.target ?? null,
        authority,
        outcome: 'no_op',
        stage: 'active',
        reason_codes: [],
        correlation_key: envelope.idempotency_key,
        occurred_at: envelope.created_at,
      }),
      reasons: [],
    };
  }

  if (state.revision !== expectation.expectedRevision) {
    return refusal(state, envelope, authority, 'conflict', 'active', [
      reason(
        'active',
        'REVISION_STALE',
        'registry.revision',
        `caller expected revision ${expectation.expectedRevision}, registry is at ${state.revision}`,
      ),
    ]);
  }

  const currentActive = state.active[key] ?? null;
  if (!identityEquals(currentActive, expectation.expectedActive)) {
    return refusal(state, envelope, authority, 'conflict', 'active', [
      reason(
        'active',
        'ACTIVE_IDENTITY_UNEXPECTED',
        'registry.active',
        'the registry does not hold the active descriptor the caller expected to roll back from',
      ),
    ]);
  }

  const target = envelope.rollback?.target ?? null;
  if (target === null) {
    return refusal(state, envelope, authority, 'rejection', 'active', [
      reason(
        'active',
        'ROLLBACK_TARGET_UNKNOWN',
        'envelope.rollback.target',
        'no rollback target was named',
      ),
    ]);
  }
  const knownTarget = state.knownIdentities[`${target.artifact_id}@${target.artifact_version}`];
  if (knownTarget === undefined || !identityEquals(knownTarget, target)) {
    return refusal(state, envelope, authority, 'rejection', 'active', [
      reason(
        'active',
        'ROLLBACK_TARGET_UNKNOWN',
        'envelope.rollback.target',
        'the rollback target is not a known, immutable descriptor in this registry',
      ),
    ]);
  }
  if (!state.published.some(identity => identityEquals(identity, target))) {
    return refusal(state, envelope, authority, 'rejection', 'active', [
      reason(
        'active',
        'CANDIDATE_NOT_PUBLISHED',
        'registry.published',
        'a rollback target must itself be published',
      ),
    ]);
  }

  const nextRevision = state.revision + 1;
  const event = buildAuditEvent({
    event_type: 'rollback',
    prior_revision: state.revision,
    resulting_revision: nextRevision,
    environment: envelope.environment,
    operation: 'rollback',
    identity: target,
    authority,
    outcome: 'accepted',
    stage: 'active',
    reason_codes: [],
    correlation_key: envelope.idempotency_key,
    occurred_at: envelope.created_at,
  });

  return {
    ok: true,
    state: {
      ...state,
      revision: nextRevision,
      active: { ...state.active, [key]: target },
      // Rolling back does not invent a new last-known-good: the thing being rolled away from is
      // precisely what was found wanting.
      lastKnownGood: state.lastKnownGood,
      idempotency: {
        ...state.idempotency,
        [envelope.idempotency_key]: {
          payload_digest: digest,
          operation: 'rollback',
          resulting_revision: nextRevision,
          identity: target,
        },
      },
      audit: [...state.audit, event],
    },
    event,
    reasons: [],
  };
};

/* ------------------------------------------------------------------------- journalling */

/** Appends an audit event to the registry. A deliberate, separate act from the operation. */
export const withAuditEvent = (state: RegistryState, event: AuditEvent): RegistryState => ({
  ...state,
  audit: [...state.audit, event],
});

/** Records a refusal without the envelope payload. Never carries the offending document. */
export const withRejection = (state: RegistryState, record: RejectedRecord): RegistryState => ({
  ...state,
  rejected: [...state.rejected, record],
});

/** The active descriptor for a line and environment, or null. Never guesses. */
export const activeFor = (
  state: RegistryState,
  environment: Environment,
  artifactId: string,
): ArtifactIdentity | null => state.active[lineKey(environment, artifactId)] ?? null;

/** The last-known-good descriptor for a line and environment, or null. */
export const lastKnownGoodFor = (
  state: RegistryState,
  environment: Environment,
  artifactId: string,
): ArtifactIdentity | null => state.lastKnownGood[lineKey(environment, artifactId)] ?? null;
