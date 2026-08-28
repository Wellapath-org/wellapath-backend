/**
 * Eligibility and activation semantics — the fail-closed core of the manifest contract.
 *
 * Five distinct states are computed for every descriptor, and they are never synonyms:
 *
 *   present                  — the descriptor exists and is structurally sound.
 *   published                — its release status is `published`, with a publication date.
 *   approved                 — every required approval is explicitly `granted`, with a decision
 *                              reference AND a recorded decision scope that includes
 *                              `artifact_publication`. Absent, pending, denied, unknown or
 *                              malformed approval data all mean NOT approved, and so does a
 *                              decision scoped to something other than artifact publication:
 *                              a decision taken for another purpose is not an approval here.
 *   active                   — activation is explicitly `active` AND explicitly authorized.
 *   eligible_for_environment — everything a given environment requires holds simultaneously:
 *                              published, approved, no open blocker, activation authorized,
 *                              environment targeted, not expired, not deprecated, app-build
 *                              compatible.
 *
 * A candidate is distributable only when it is BOTH eligible for the environment AND active.
 * Existing in storage or in a repository confers `present` and nothing else.
 */
import {
  APPROVAL_SCOPES,
  ARTIFACT_APPROVAL_SLOT_SCOPE,
  ApprovalRecord,
  ArtifactDescriptor,
  CandidateManifest,
  Environment,
  Reason,
} from './contract';
import { SHA256_PATTERN } from './integrity';

export interface EligibilityContext {
  environment: Environment;
  /** Consumer build number. Required whenever a descriptor declares `min_app_build`. */
  appBuild?: number;
  /** Injectable clock for expiry checks; defaults to real time. */
  now?: Date;
}

export interface DescriptorStates {
  present: boolean;
  published: boolean;
  approved: boolean;
  active: boolean;
  eligible_for_environment: boolean;
}

export interface DescriptorEvaluation {
  states: DescriptorStates;
  /** Every reason eligibility (or activation) is denied. Empty only for a distributable one. */
  reasons: Reason[];
}

export interface SelectionResult {
  selected: ArtifactDescriptor | null;
  reasons: Reason[];
}

const descriptorPath = (descriptor: ArtifactDescriptor): string =>
  `artifact ${descriptor.artifact_id}@${descriptor.artifact_version}`;

/**
 * Decides whether a *granted* approval's cited decision was scoped to occupy an
 * artifact-publication approval slot.
 *
 * This repeats the check `validateManifest` already performs, deliberately: a descriptor
 * evaluated in isolation must still fail closed rather than inherit a guarantee from a
 * validation pass that may never have run. An empty result means the scope is sound.
 */
const evaluateApprovalScope = (approval: ApprovalRecord, path: string, role: string): Reason[] => {
  const scope = approval.decision_scope;
  const scopePath = `${path}.decision_scope`;

  if (scope === null || scope === undefined) {
    return [
      {
        code: 'APPROVAL_SCOPE_MISSING',
        path: scopePath,
        detail: `${role} approval cites a decision with no recorded scope; an unscoped decision is not an artifact-publication approval`,
      },
    ];
  }
  if (!Array.isArray(scope) || scope.length === 0) {
    return [
      {
        code: 'APPROVAL_SCOPE_MISSING',
        path: scopePath,
        detail: `${role} approval declares a malformed scope; treated as no scope at all`,
      },
    ];
  }
  const unknown = scope.filter(
    entry => typeof entry !== 'string' || !(APPROVAL_SCOPES as readonly string[]).includes(entry),
  );
  if (unknown.length > 0) {
    return [
      {
        code: 'APPROVAL_SCOPE_UNKNOWN',
        path: scopePath,
        detail: `${role} approval declares unrecognised scope ${unknown.map(String).join(', ')}; unknown scope is never read as authorisation`,
      },
    ];
  }
  if (!scope.includes(ARTIFACT_APPROVAL_SLOT_SCOPE)) {
    return [
      {
        code: 'APPROVAL_SCOPE_MISMATCH',
        path: scopePath,
        detail: `${role} approval cites a decision scoped to ${scope.join(', ')}; that scope excludes ${ARTIFACT_APPROVAL_SLOT_SCOPE}, so it cannot stand as an artifact-publication approval`,
      },
    ];
  }
  return [];
};

/**
 * Evaluates one descriptor's states against an environment. Assumes the manifest already
 * passed `validateManifest`; even so, governance data is re-checked defensively so a malformed
 * descriptor evaluated in isolation still fails closed rather than passing by omission.
 */
export const evaluateDescriptor = (
  descriptor: ArtifactDescriptor,
  context: EligibilityContext,
): DescriptorEvaluation => {
  const reasons: Reason[] = [];
  const path = descriptorPath(descriptor);

  const present =
    typeof descriptor.artifact_id === 'string' &&
    typeof descriptor.artifact_version === 'string' &&
    typeof descriptor.sha256 === 'string' &&
    SHA256_PATTERN.test(descriptor.sha256) &&
    Number.isInteger(descriptor.byte_count) &&
    descriptor.byte_count > 0;
  if (!present) {
    reasons.push({
      code: 'MALFORMED_FIELD',
      path,
      detail: 'descriptor lacks sound identity or integrity metadata',
    });
  }

  const published =
    descriptor.release_status === 'published' &&
    typeof descriptor.published_at === 'string' &&
    descriptor.published_at.length > 0;
  if (!published) {
    reasons.push({
      code: 'NOT_PUBLISHED',
      path,
      detail: `release status is ${String(descriptor.release_status)}; only an explicitly published artifact can be distributed`,
    });
  }

  let approved = true;
  const approvals = descriptor.approvals;
  if (approvals === null || typeof approvals !== 'object') {
    approved = false;
    reasons.push({
      code: 'APPROVAL_MISSING',
      path: `${path}.approvals`,
      detail: 'approvals are absent; absence means not approved',
    });
  } else {
    for (const role of ['product', 'clinical'] as const) {
      const approval = approvals[role];
      if (approval === null || typeof approval !== 'object') {
        approved = false;
        reasons.push({
          code: 'APPROVAL_MISSING',
          path: `${path}.approvals.${role}`,
          detail: `${role} approval record is absent; absence means not approved`,
        });
        continue;
      }
      if (approval.required === false) {
        // Explicitly not required — but any other value of `required` is fail-closed below.
        continue;
      }
      if (approval.required !== true) {
        approved = false;
        reasons.push({
          code: 'APPROVAL_MISSING',
          path: `${path}.approvals.${role}.required`,
          detail: 'approval requirement is not explicitly declared; treated as not approved',
        });
        continue;
      }
      if (
        approval.status !== 'granted' &&
        approval.status !== 'denied' &&
        approval.status !== 'pending' &&
        approval.status !== 'not_required'
      ) {
        approved = false;
        reasons.push({
          code: 'APPROVAL_STATUS_UNKNOWN',
          path: `${path}.approvals.${role}.status`,
          detail: `unknown approval status ${String(approval.status)}; treated as not approved`,
        });
        continue;
      }
      if (
        approval.status !== 'granted' ||
        typeof approval.decision_ref !== 'string' ||
        approval.decision_ref.trim() === ''
      ) {
        approved = false;
        reasons.push({
          code: 'APPROVAL_NOT_GRANTED',
          path: `${path}.approvals.${role}`,
          detail: `${role} approval is required but not explicitly granted with a decision reference`,
        });
        continue;
      }
      // The approval claims to be granted. It only counts if the decision it cites was
      // actually scoped to artifact publication — a decision taken for some other purpose,
      // however complete and however senior its author, authorises nothing here.
      const scopeReasons = evaluateApprovalScope(approval, `${path}.approvals.${role}`, role);
      if (scopeReasons.length > 0) {
        approved = false;
        reasons.push(...scopeReasons);
      }
    }
  }

  let blockersResolved = true;
  if (!Array.isArray(descriptor.blockers)) {
    blockersResolved = false;
    reasons.push({
      code: 'BLOCKER_UNRESOLVED',
      path: `${path}.blockers`,
      detail: 'blocker list is malformed; treated as blocked',
    });
  } else {
    for (const blocker of descriptor.blockers) {
      if (blocker.status !== 'resolved') {
        blockersResolved = false;
        reasons.push({
          code: 'BLOCKER_UNRESOLVED',
          path: `${path}.blockers`,
          detail: `blocker ${blocker.id} is ${String(blocker.status)}`,
        });
      }
    }
  }

  const activationAuthorized =
    descriptor.activation_authorized === true &&
    typeof descriptor.activation_decision_ref === 'string' &&
    descriptor.activation_decision_ref.trim() !== '';
  if (!activationAuthorized) {
    reasons.push({
      code: 'ACTIVATION_NOT_AUTHORIZED',
      path,
      detail: 'activation is not explicitly authorized with a decision reference',
    });
  }

  const active = descriptor.activation_status === 'active' && activationAuthorized;

  const environmentAuthorized =
    Array.isArray(descriptor.target_environments) &&
    descriptor.target_environments.includes(context.environment);
  if (!environmentAuthorized) {
    reasons.push({
      code: 'ENVIRONMENT_NOT_AUTHORIZED',
      path,
      detail: `descriptor does not target environment ${context.environment}`,
    });
  }

  const now = context.now ?? new Date();
  let notExpired = true;
  if (descriptor.expires_at !== null && descriptor.expires_at !== undefined) {
    const expiry = Date.parse(descriptor.expires_at);
    notExpired = Number.isFinite(expiry) && expiry > now.getTime();
    if (!notExpired) {
      reasons.push({
        code: 'DESCRIPTOR_EXPIRED',
        path,
        detail: `descriptor expired at ${descriptor.expires_at}`,
      });
    }
  }

  const notDeprecated =
    descriptor.deprecated === false && descriptor.release_status !== 'deprecated';
  if (!notDeprecated) {
    reasons.push({
      code: 'DESCRIPTOR_DEPRECATED',
      path,
      detail: 'deprecated artifacts are not eligible for distribution',
    });
  }

  let appCompatible = true;
  if (descriptor.min_app_build !== undefined) {
    // No known consumer build is itself an incompatibility: fail closed.
    appCompatible = context.appBuild !== undefined && context.appBuild >= descriptor.min_app_build;
    if (!appCompatible) {
      reasons.push({
        code: 'APP_BUILD_INCOMPATIBLE',
        path,
        detail: `descriptor requires app build >= ${descriptor.min_app_build}, consumer build is ${String(context.appBuild)}`,
      });
    }
  }

  const eligible =
    present &&
    published &&
    approved &&
    blockersResolved &&
    activationAuthorized &&
    environmentAuthorized &&
    notExpired &&
    notDeprecated &&
    appCompatible;

  return {
    states: {
      present,
      published,
      approved,
      active,
      eligible_for_environment: eligible,
    },
    reasons,
  };
};

/**
 * Selects the distributable descriptor for one artifact line, or nothing.
 *
 * A descriptor is selected only when it is active AND eligible for the environment. When no
 * descriptor qualifies, the result is explicitly empty — a candidate is NEVER promoted to fill
 * the gap, however valid it looks. Two simultaneously active descriptors are a governance
 * fault, not a choice, so that also selects nothing.
 */
export const selectActiveDescriptor = (
  manifest: CandidateManifest,
  artifactId: string,
  context: EligibilityContext,
): SelectionResult => {
  const line = manifest.artifacts.filter(descriptor => descriptor.artifact_id === artifactId);
  const reasons: Reason[] = [];

  const qualified = line.filter(descriptor => {
    const evaluation = evaluateDescriptor(descriptor, context);
    if (!(evaluation.states.active && evaluation.states.eligible_for_environment)) {
      if (evaluation.states.eligible_for_environment && !evaluation.states.active) {
        reasons.push({
          code: 'NOT_ACTIVE',
          path: descriptorPath(descriptor),
          detail: 'eligible but not activated; publication alone does not activate',
        });
      }
      reasons.push(...evaluation.reasons);
      return false;
    }
    return true;
  });

  if (qualified.length === 0) {
    reasons.push({
      code: 'NO_ACTIVE_ARTIFACT',
      path: `artifacts(${artifactId})`,
      detail: 'no active, eligible descriptor exists; a candidate is never selected implicitly',
    });
    return { selected: null, reasons };
  }
  if (qualified.length > 1) {
    reasons.push({
      code: 'MULTIPLE_ACTIVE',
      path: `artifacts(${artifactId})`,
      detail: `${qualified.length} descriptors are simultaneously active; refusing to choose`,
    });
    return { selected: null, reasons };
  }

  return { selected: qualified[0], reasons: [] };
};

/** Numeric, segment-wise comparison of dotted versions ('2.4' < '2.10'). */
export const compareVersions = (a: string, b: string): number => {
  const left = a.split('.').map(segment => Number.parseInt(segment, 10));
  const right = b.split('.').map(segment => Number.parseInt(segment, 10));
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
};

/**
 * Authorizes a transition from the currently active descriptor to a proposed one.
 *
 * A downgrade (proposed version below current) is permitted only when the current descriptor's
 * own `rollback_target` names the proposed version AND hash — rollback is an explicit,
 * version/hash-bound act, never an implicit fallback. Anything else about the pair is left to
 * eligibility; this function answers only the direction-of-travel question.
 */
export const authorizeTransition = (
  current: ArtifactDescriptor,
  proposed: ArtifactDescriptor,
): Reason[] => {
  if (current.artifact_id !== proposed.artifact_id) {
    return [
      {
        code: 'MALFORMED_FIELD',
        path: descriptorPath(proposed),
        detail: 'transition across different artifact identities is meaningless',
      },
    ];
  }

  if (compareVersions(proposed.artifact_version, current.artifact_version) >= 0) {
    return [];
  }

  const target = current.rollback_target;
  if (
    target !== null &&
    target.artifact_version === proposed.artifact_version &&
    target.sha256 === proposed.sha256
  ) {
    return [];
  }

  return [
    {
      code: 'DOWNGRADE_NOT_AUTHORIZED',
      path: descriptorPath(proposed),
      detail:
        'downgrade refused: the active descriptor declares no rollback target bound to this exact version and hash',
    },
  ];
};
