/**
 * Structural validation for candidate manifests.
 *
 * Everything here fails closed: unknown fields, unknown enum values, unknown manifest majors,
 * unknown required features and malformed governance data are all explicit rejections with a
 * machine-readable reason — never silently ignored, never defaulted. A manifest that does not
 * validate must not be consulted for eligibility at all.
 */
import {
  ACTIVATION_STATUSES,
  APPROVAL_SCOPES,
  APPROVAL_STATUSES,
  ARTIFACT_APPROVAL_SLOT_SCOPE,
  BLOCKER_STATUSES,
  CandidateManifest,
  ENVIRONMENTS,
  OPTIONAL_DESCRIPTOR_KEYS,
  Reason,
  RELEASE_STATUSES,
  OPTIONAL_APPROVAL_KEYS,
  REQUIRED_APPROVAL_KEYS,
  REQUIRED_DESCRIPTOR_KEYS,
  SUPPORTED_ARTIFACT_SCHEMAS,
  SUPPORTED_CONTENT_TYPES,
  SUPPORTED_MANIFEST_FEATURES,
  SUPPORTED_MANIFEST_MAJOR,
} from './contract';
import { SHA256_PATTERN } from './integrity';
import { validateArtifactUrl, validateObjectKey } from './origin';

export interface ValidationResult {
  valid: boolean;
  reasons: Reason[];
}

const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const COUNTRY_PATTERN = /^[a-z]{2}$/;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIsoDatetime = (value: unknown): boolean =>
  typeof value === 'string' && ISO_DATETIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));

const missing = (path: string, key: string): Reason => ({
  code: 'MISSING_REQUIRED_FIELD',
  path: `${path}.${key}`,
  detail: `required field ${key} is absent`,
});

const malformed = (path: string, detail: string): Reason => ({
  code: 'MALFORMED_FIELD',
  path,
  detail,
});

const validateVersionRef = (value: unknown, path: string): Reason[] => {
  if (value === null) return [];
  if (!isPlainObject(value)) return [malformed(path, 'must be null or an object')];

  const reasons: Reason[] = [];
  for (const key of Object.keys(value)) {
    if (key !== 'artifact_version' && key !== 'sha256') {
      reasons.push({ code: 'UNKNOWN_FIELD', path: `${path}.${key}`, detail: 'unknown field' });
    }
  }
  if (typeof value.artifact_version !== 'string' || !VERSION_PATTERN.test(value.artifact_version)) {
    reasons.push(malformed(`${path}.artifact_version`, 'must be a dotted numeric version string'));
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    reasons.push(malformed(`${path}.sha256`, 'must be a sha256:<64 hex> digest'));
  }
  return reasons;
};

/**
 * Structural and slot-compatibility checks for `decision_scope`.
 *
 * `null` is a legitimate recording of "no scope claimed" and is only a fault once the approval
 * claims to be granted. Anything malformed or unrecognised fails closed rather than being
 * ignored, so an unknown future scope name can never be silently read as authorisation.
 */
const validateDecisionScope = (value: Record<string, unknown>, path: string): Reason[] => {
  const scopePath = `${path}.decision_scope`;
  const granted = value.status === 'granted';

  if (!('decision_scope' in value) || value.decision_scope === null) {
    return granted
      ? [
          {
            code: 'APPROVAL_SCOPE_MISSING',
            path: scopePath,
            detail:
              'a granted approval must declare the scope of the decision it cites; an unscoped decision is not an artifact-publication approval',
          },
        ]
      : [];
  }

  const scope = value.decision_scope;
  if (!Array.isArray(scope) || scope.length === 0) {
    return [malformed(scopePath, 'must be null or a non-empty array of approval scopes')];
  }

  const reasons: Reason[] = [];
  for (const entry of scope) {
    if (typeof entry !== 'string' || !(APPROVAL_SCOPES as readonly string[]).includes(entry)) {
      reasons.push({
        code: 'APPROVAL_SCOPE_UNKNOWN',
        path: scopePath,
        detail: `approval scope ${String(entry)} is not a known scope; unknown scope is never read as authorisation`,
      });
    }
  }
  if (new Set(scope).size !== scope.length) {
    reasons.push(malformed(scopePath, 'approval scopes must be unique'));
  }
  if (reasons.length > 0) return reasons;

  if (granted && !scope.includes(ARTIFACT_APPROVAL_SLOT_SCOPE)) {
    reasons.push({
      code: 'APPROVAL_SCOPE_MISMATCH',
      path: scopePath,
      detail: `the cited decision is scoped to ${scope.join(', ')}, which excludes ${ARTIFACT_APPROVAL_SLOT_SCOPE}; it cannot occupy an artifact-publication approval slot`,
    });
  }
  return reasons;
};

/**
 * Validates one approval record, including the scope of the decision it cites.
 *
 * Scope is checked here as well as in eligibility because a scope substitution is a structural
 * governance fault, not a matter of degree: a decision that was never scoped to artifact
 * publication does not belong in an artifact-publication approval slot at all, so a manifest
 * asserting it is rejected outright rather than merely evaluating to `approved: false`.
 */
const validateApproval = (value: unknown, path: string): Reason[] => {
  if (!isPlainObject(value)) {
    return [{ code: 'APPROVAL_MISSING', path, detail: 'approval record is absent or malformed' }];
  }

  const reasons: Reason[] = [];
  const allowed = [...REQUIRED_APPROVAL_KEYS, ...OPTIONAL_APPROVAL_KEYS];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      reasons.push({ code: 'UNKNOWN_FIELD', path: `${path}.${key}`, detail: 'unknown field' });
    }
  }
  for (const key of REQUIRED_APPROVAL_KEYS) {
    if (!(key in value)) reasons.push(missing(path, key));
  }
  if ('required' in value && typeof value.required !== 'boolean') {
    reasons.push(malformed(`${path}.required`, 'must be a boolean'));
  }
  if ('status' in value) {
    if (
      typeof value.status !== 'string' ||
      !(APPROVAL_STATUSES as readonly string[]).includes(value.status)
    ) {
      reasons.push({
        code: 'APPROVAL_STATUS_UNKNOWN',
        path: `${path}.status`,
        detail: `approval status ${String(value.status)} is not a known status`,
      });
    } else if (value.status === 'granted' && value.decision_ref === null) {
      reasons.push(malformed(`${path}.decision_ref`, 'a granted approval must cite a decision'));
    }
  }
  if ('decision_ref' in value && value.decision_ref !== null) {
    if (typeof value.decision_ref !== 'string' || value.decision_ref.trim() === '') {
      reasons.push(malformed(`${path}.decision_ref`, 'must be null or a non-empty string'));
    }
  }
  if ('approved_at' in value && value.approved_at !== null && !isIsoDatetime(value.approved_at)) {
    reasons.push(malformed(`${path}.approved_at`, 'must be null or an ISO-8601 UTC datetime'));
  }
  reasons.push(...validateDecisionScope(value, path));
  return reasons;
};

const validateBlockers = (value: unknown, path: string): Reason[] => {
  if (!Array.isArray(value)) return [malformed(path, 'must be an array')];

  const reasons: Reason[] = [];
  value.forEach((blocker, index) => {
    const blockerPath = `${path}[${index}]`;
    if (!isPlainObject(blocker)) {
      reasons.push(malformed(blockerPath, 'must be an object'));
      return;
    }
    for (const key of Object.keys(blocker)) {
      if (!['id', 'status', 'reference'].includes(key)) {
        reasons.push({
          code: 'UNKNOWN_FIELD',
          path: `${blockerPath}.${key}`,
          detail: 'unknown field',
        });
      }
    }
    if (typeof blocker.id !== 'string' || blocker.id.trim() === '') {
      reasons.push(malformed(`${blockerPath}.id`, 'must be a non-empty string'));
    }
    if (
      typeof blocker.status !== 'string' ||
      !(BLOCKER_STATUSES as readonly string[]).includes(blocker.status)
    ) {
      reasons.push(malformed(`${blockerPath}.status`, 'must be open or resolved'));
    }
    if ('reference' in blocker && typeof blocker.reference !== 'string') {
      reasons.push(malformed(`${blockerPath}.reference`, 'must be a string when present'));
    }
  });
  return reasons;
};

const validateDescriptor = (value: unknown, path: string): Reason[] => {
  if (!isPlainObject(value)) return [malformed(path, 'artifact descriptor must be an object')];

  const reasons: Reason[] = [];

  for (const key of Object.keys(value)) {
    if (!REQUIRED_DESCRIPTOR_KEYS.includes(key) && !OPTIONAL_DESCRIPTOR_KEYS.includes(key)) {
      reasons.push({ code: 'UNKNOWN_FIELD', path: `${path}.${key}`, detail: 'unknown field' });
    }
  }
  for (const key of REQUIRED_DESCRIPTOR_KEYS) {
    if (!(key in value)) reasons.push(missing(path, key));
  }

  if ('artifact_id' in value) {
    if (typeof value.artifact_id !== 'string' || !ARTIFACT_ID_PATTERN.test(value.artifact_id)) {
      reasons.push(malformed(`${path}.artifact_id`, 'must be a stable snake_case identifier'));
    }
  }
  if ('artifact_version' in value) {
    if (
      typeof value.artifact_version !== 'string' ||
      !VERSION_PATTERN.test(value.artifact_version)
    ) {
      reasons.push(
        malformed(`${path}.artifact_version`, 'must be a dotted numeric version string'),
      );
    }
  }
  if ('schema_version' in value) {
    if (typeof value.schema_version !== 'string') {
      reasons.push(malformed(`${path}.schema_version`, 'must be a string'));
    } else if (!SUPPORTED_ARTIFACT_SCHEMAS.includes(value.schema_version)) {
      reasons.push({
        code: 'UNSUPPORTED_ARTIFACT_SCHEMA',
        path: `${path}.schema_version`,
        detail: `artifact schema ${value.schema_version} is not supported`,
      });
    }
  }
  if ('content_type' in value) {
    if (
      typeof value.content_type !== 'string' ||
      !SUPPORTED_CONTENT_TYPES.includes(value.content_type)
    ) {
      reasons.push({
        code: 'CONTENT_TYPE_UNSUPPORTED',
        path: `${path}.content_type`,
        detail: `content type ${String(value.content_type)} is not an expected artifact type`,
      });
    }
  }
  if ('sha256' in value) {
    if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
      reasons.push(malformed(`${path}.sha256`, 'must be a sha256:<64 hex> digest'));
    }
  }
  if ('byte_count' in value) {
    if (
      typeof value.byte_count !== 'number' ||
      !Number.isInteger(value.byte_count) ||
      value.byte_count < 1
    ) {
      reasons.push(malformed(`${path}.byte_count`, 'must be a positive integer'));
    }
  }
  if ('object_key' in value) {
    if (typeof value.object_key !== 'string') {
      reasons.push(malformed(`${path}.object_key`, 'must be a string'));
    } else {
      reasons.push(...validateObjectKey(value.object_key, `${path}.object_key`));
      if ('url' in value) {
        if (typeof value.url !== 'string') {
          reasons.push(malformed(`${path}.url`, 'must be a string when present'));
        } else {
          reasons.push(...validateArtifactUrl(value.url, value.object_key, `${path}.url`));
        }
      }
    }
  }
  if ('release_status' in value) {
    if (
      typeof value.release_status !== 'string' ||
      !(RELEASE_STATUSES as readonly string[]).includes(value.release_status)
    ) {
      reasons.push(malformed(`${path}.release_status`, 'must be a known release status'));
    } else if (value.release_status === 'published' && value.published_at === null) {
      reasons.push(malformed(`${path}.published_at`, 'a published artifact must carry a date'));
    }
  }
  if ('activation_status' in value) {
    if (
      typeof value.activation_status !== 'string' ||
      !(ACTIVATION_STATUSES as readonly string[]).includes(value.activation_status)
    ) {
      reasons.push(malformed(`${path}.activation_status`, 'must be inactive or active'));
    }
  }
  if ('activation_authorized' in value) {
    if (typeof value.activation_authorized !== 'boolean') {
      reasons.push(malformed(`${path}.activation_authorized`, 'must be a boolean'));
    } else if (value.activation_authorized === true && value.activation_decision_ref === null) {
      reasons.push(
        malformed(`${path}.activation_decision_ref`, 'authorization must cite a decision'),
      );
    }
  }
  if (
    'activation_decision_ref' in value &&
    value.activation_decision_ref !== null &&
    typeof value.activation_decision_ref !== 'string'
  ) {
    reasons.push(malformed(`${path}.activation_decision_ref`, 'must be null or a string'));
  }
  if ('target_environments' in value) {
    const environments = value.target_environments;
    if (!Array.isArray(environments) || environments.length === 0) {
      reasons.push(malformed(`${path}.target_environments`, 'must be a non-empty array'));
    } else {
      environments.forEach((environment, index) => {
        if (
          typeof environment !== 'string' ||
          !(ENVIRONMENTS as readonly string[]).includes(environment)
        ) {
          reasons.push(
            malformed(`${path}.target_environments[${index}]`, 'unknown environment name'),
          );
        }
      });
      if (new Set(environments).size !== environments.length) {
        reasons.push(malformed(`${path}.target_environments`, 'environments must be unique'));
      }
    }
  }
  if ('min_app_build' in value) {
    if (
      typeof value.min_app_build !== 'number' ||
      !Number.isInteger(value.min_app_build) ||
      value.min_app_build < 1
    ) {
      reasons.push(malformed(`${path}.min_app_build`, 'must be a positive integer when present'));
    }
  }
  if (
    'publication_decision_ref' in value &&
    value.publication_decision_ref !== null &&
    typeof value.publication_decision_ref !== 'string'
  ) {
    reasons.push(malformed(`${path}.publication_decision_ref`, 'must be null or a string'));
  }
  if ('approvals' in value) {
    if (!isPlainObject(value.approvals)) {
      reasons.push({
        code: 'APPROVAL_MISSING',
        path: `${path}.approvals`,
        detail: 'approvals must be an object with product and clinical records',
      });
    } else {
      for (const key of Object.keys(value.approvals)) {
        if (key !== 'product' && key !== 'clinical') {
          reasons.push({
            code: 'UNKNOWN_FIELD',
            path: `${path}.approvals.${key}`,
            detail: 'unknown field',
          });
        }
      }
      for (const role of ['product', 'clinical']) {
        if (!(role in value.approvals)) {
          reasons.push({
            code: 'APPROVAL_MISSING',
            path: `${path}.approvals.${role}`,
            detail: `${role} approval record is absent`,
          });
        } else {
          reasons.push(...validateApproval(value.approvals[role], `${path}.approvals.${role}`));
        }
      }
    }
  }
  if ('blockers' in value) {
    reasons.push(...validateBlockers(value.blockers, `${path}.blockers`));
  }
  if ('predecessor' in value) {
    reasons.push(...validateVersionRef(value.predecessor, `${path}.predecessor`));
  }
  if ('rollback_target' in value) {
    reasons.push(...validateVersionRef(value.rollback_target, `${path}.rollback_target`));
  }
  if ('created_at' in value && !isIsoDatetime(value.created_at)) {
    reasons.push(malformed(`${path}.created_at`, 'must be an ISO-8601 UTC datetime'));
  }
  if (
    'published_at' in value &&
    value.published_at !== null &&
    !isIsoDatetime(value.published_at)
  ) {
    reasons.push(malformed(`${path}.published_at`, 'must be null or an ISO-8601 UTC datetime'));
  }
  if ('deprecated' in value && typeof value.deprecated !== 'boolean') {
    reasons.push(malformed(`${path}.deprecated`, 'must be a boolean'));
  }
  if ('expires_at' in value && value.expires_at !== null && !isIsoDatetime(value.expires_at)) {
    reasons.push(malformed(`${path}.expires_at`, 'must be null or an ISO-8601 UTC datetime'));
  }
  if ('country' in value) {
    if (typeof value.country !== 'string' || !COUNTRY_PATTERN.test(value.country)) {
      reasons.push(malformed(`${path}.country`, 'must be a two-letter lowercase country code'));
    }
  }
  if ('references' in value) {
    if (
      !Array.isArray(value.references) ||
      value.references.some(reference => typeof reference !== 'string')
    ) {
      reasons.push(malformed(`${path}.references`, 'must be an array of strings when present'));
    }
  }

  return reasons;
};

/** Detects cycles in predecessor / rollback relationships within one artifact line. */
const findRelationshipCycles = (manifest: CandidateManifest): Reason[] => {
  const reasons: Reason[] = [];
  const byId = new Map<string, Map<string, { index: number; targets: string[] }>>();

  manifest.artifacts.forEach((descriptor, index) => {
    const versions = byId.get(descriptor.artifact_id) ?? new Map();
    const targets: string[] = [];
    if (descriptor.predecessor) targets.push(descriptor.predecessor.artifact_version);
    if (descriptor.rollback_target) targets.push(descriptor.rollback_target.artifact_version);
    versions.set(descriptor.artifact_version, { index, targets });
    byId.set(descriptor.artifact_id, versions);
  });

  for (const [artifactId, versions] of byId) {
    const visiting = new Set<string>();
    const done = new Set<string>();

    const visit = (version: string, trail: string[]): void => {
      if (done.has(version)) return;
      if (visiting.has(version)) {
        reasons.push({
          code: 'RELATIONSHIP_CYCLE',
          path: `artifacts(${artifactId})`,
          detail: `predecessor/rollback relationship cycle: ${[...trail, version].join(' -> ')}`,
        });
        return;
      }
      visiting.add(version);
      const node = versions.get(version);
      if (node) {
        for (const target of node.targets) {
          if (versions.has(target)) visit(target, [...trail, version]);
        }
      }
      visiting.delete(version);
      done.add(version);
    };

    for (const version of versions.keys()) visit(version, []);
  }

  return reasons;
};

/** Rollback targets are operational pointers and must resolve, exactly, inside the manifest. */
const validateRollbackTargets = (manifest: CandidateManifest): Reason[] => {
  const reasons: Reason[] = [];

  manifest.artifacts.forEach((descriptor, index) => {
    const target = descriptor.rollback_target;
    if (target === null) return;

    const path = `artifacts[${index}].rollback_target`;
    if (
      target.artifact_version === descriptor.artifact_version ||
      target.sha256 === descriptor.sha256
    ) {
      reasons.push({
        code: 'RELATIONSHIP_CYCLE',
        path,
        detail: 'rollback target references the descriptor itself',
      });
      return;
    }

    const resolved = manifest.artifacts.find(
      candidate =>
        candidate.artifact_id === descriptor.artifact_id &&
        candidate.artifact_version === target.artifact_version,
    );
    if (!resolved) {
      reasons.push({
        code: 'INVALID_ROLLBACK_TARGET',
        path,
        detail: `no descriptor for ${descriptor.artifact_id}@${target.artifact_version} exists in the manifest`,
      });
    } else if (resolved.sha256 !== target.sha256) {
      reasons.push({
        code: 'INVALID_ROLLBACK_TARGET',
        path,
        detail: 'rollback target sha256 does not match the referenced descriptor',
      });
    }
  });

  return reasons;
};

/**
 * Validates a raw parsed JSON document as a candidate manifest. The manifest is usable only
 * when `valid` is true; a rejected manifest must not be consulted for eligibility.
 */
export const validateManifest = (value: unknown): ValidationResult => {
  if (!isPlainObject(value)) {
    return {
      valid: false,
      reasons: [{ code: 'MANIFEST_MALFORMED', path: '$', detail: 'manifest must be an object' }],
    };
  }

  const reasons: Reason[] = [];
  const allowedTop = ['manifest_version', 'generated_at', 'required_features', 'artifacts'];
  for (const key of Object.keys(value)) {
    if (!allowedTop.includes(key)) {
      reasons.push({ code: 'UNKNOWN_FIELD', path: `$.${key}`, detail: 'unknown field' });
    }
  }
  for (const key of ['manifest_version', 'generated_at', 'artifacts']) {
    if (!(key in value)) reasons.push(missing('$', key));
  }

  if ('manifest_version' in value) {
    const version = value.manifest_version;
    const match = typeof version === 'string' ? SEMVER_PATTERN.exec(version) : null;
    if (!match) {
      reasons.push({
        code: 'MANIFEST_VERSION_UNSUPPORTED',
        path: '$.manifest_version',
        detail: `manifest version ${String(version)} is not a semantic version`,
      });
    } else if (Number.parseInt(match[1], 10) !== SUPPORTED_MANIFEST_MAJOR) {
      reasons.push({
        code: 'MANIFEST_VERSION_UNSUPPORTED',
        path: '$.manifest_version',
        detail: `manifest major ${match[1]} is not supported (supported: ${SUPPORTED_MANIFEST_MAJOR})`,
      });
    }
  }
  if ('generated_at' in value && !isIsoDatetime(value.generated_at)) {
    reasons.push(malformed('$.generated_at', 'must be an ISO-8601 UTC datetime'));
  }
  if ('required_features' in value) {
    if (
      !Array.isArray(value.required_features) ||
      value.required_features.some(feature => typeof feature !== 'string')
    ) {
      reasons.push(malformed('$.required_features', 'must be an array of strings when present'));
    } else {
      for (const feature of value.required_features) {
        if (!SUPPORTED_MANIFEST_FEATURES.includes(feature)) {
          reasons.push({
            code: 'UNKNOWN_REQUIRED_FEATURE',
            path: '$.required_features',
            detail: `required feature ${feature} is not supported by this implementation`,
          });
        }
      }
    }
  }

  if ('artifacts' in value) {
    if (!Array.isArray(value.artifacts)) {
      reasons.push(malformed('$.artifacts', 'must be an array'));
    } else {
      value.artifacts.forEach((descriptor, index) => {
        reasons.push(...validateDescriptor(descriptor, `artifacts[${index}]`));
      });

      const seen = new Map<string, number>();
      value.artifacts.forEach((descriptor, index) => {
        if (!isPlainObject(descriptor)) return;
        const identity = `${String(descriptor.artifact_id)}@${String(descriptor.artifact_version)}`;
        const first = seen.get(identity);
        if (first !== undefined) {
          reasons.push({
            code: 'DUPLICATE_IDENTITY',
            path: `artifacts[${index}]`,
            detail: `duplicate identity ${identity} (first declared at artifacts[${first}])`,
          });
        } else {
          seen.set(identity, index);
        }
      });
    }
  }

  // Relationship checks only make sense on a structurally sound manifest.
  if (reasons.length === 0) {
    const manifest = value as unknown as CandidateManifest;
    reasons.push(...findRelationshipCycles(manifest));
    reasons.push(...validateRollbackTargets(manifest));
  }

  return { valid: reasons.length === 0, reasons };
};
