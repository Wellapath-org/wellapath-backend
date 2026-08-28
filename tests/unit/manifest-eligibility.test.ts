/**
 * Eligibility, activation and rollback semantics.
 *
 * The central claims: the five states are never synonyms; eligibility is an explicit
 * conjunction that fails closed; a candidate is never selected implicitly; downgrades happen
 * only through an explicit, version/hash-bound rollback target.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ArtifactDescriptor, CandidateManifest } from '../../src/manifest/contract';
import {
  authorizeTransition,
  compareVersions,
  evaluateDescriptor,
  selectActiveDescriptor,
} from '../../src/manifest/eligibility';
import { validateManifest } from '../../src/manifest/validate';

const loadFixture = (name: string): CandidateManifest =>
  JSON.parse(
    readFileSync(join(__dirname, '../fixtures/manifest', name), 'utf8'),
  ) as CandidateManifest;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const context = { environment: 'staging' as const, now: new Date('2026-08-28T00:00:00Z') };

const baseline = loadFixture('baseline.manifest.json');
const activeKb = baseline.artifacts.find(
  descriptor =>
    descriptor.artifact_id === 'knowledge_base' && descriptor.artifact_version === '2.4',
) as ArtifactDescriptor;
const rollbackKb = baseline.artifacts.find(
  descriptor =>
    descriptor.artifact_id === 'knowledge_base' && descriptor.artifact_version === '2.3',
) as ArtifactDescriptor;

describe('the five states are distinct, never synonyms', () => {
  it('a fully governed active artifact holds all five states', () => {
    const { states, reasons } = evaluateDescriptor(activeKb, context);
    expect(states).toEqual({
      present: true,
      published: true,
      approved: true,
      active: true,
      eligible_for_environment: true,
    });
    expect(reasons).toEqual([]);
  });

  it('published + approved does not imply active (the retained rollback target)', () => {
    const { states } = evaluateDescriptor(rollbackKb, context);
    expect(states.present).toBe(true);
    expect(states.published).toBe(true);
    expect(states.approved).toBe(true);
    expect(states.active).toBe(false);
    expect(states.eligible_for_environment).toBe(false);
  });

  it('present does not imply anything else (a bare candidate)', () => {
    const candidate = clone(activeKb);
    candidate.release_status = 'candidate';
    candidate.published_at = null;
    candidate.activation_status = 'inactive';
    candidate.activation_authorized = false;
    candidate.activation_decision_ref = null;
    candidate.approvals.product.status = 'pending';
    candidate.approvals.product.decision_ref = null;
    candidate.approvals.clinical.status = 'pending';
    candidate.approvals.clinical.decision_ref = null;

    const { states } = evaluateDescriptor(candidate, context);
    expect(states.present).toBe(true);
    expect(states.published).toBe(false);
    expect(states.approved).toBe(false);
    expect(states.active).toBe(false);
    expect(states.eligible_for_environment).toBe(false);
  });

  it('activation marked active without authorization is NOT active — fail closed', () => {
    const descriptor = clone(activeKb);
    descriptor.activation_authorized = false;
    descriptor.activation_decision_ref = null;
    const { states, reasons } = evaluateDescriptor(descriptor, context);
    expect(states.active).toBe(false);
    expect(states.eligible_for_environment).toBe(false);
    expect(reasons.map(reason => reason.code)).toContain('ACTIVATION_NOT_AUTHORIZED');
  });

  it('malformed approval data means not approved, never a default', () => {
    const descriptor = clone(activeKb);
    (descriptor.approvals as unknown as Record<string, unknown>).clinical = null;
    const { states, reasons } = evaluateDescriptor(descriptor, context);
    expect(states.approved).toBe(false);
    expect(reasons.map(reason => reason.code)).toContain('APPROVAL_MISSING');
  });

  it('an undeclared approval requirement fails closed', () => {
    const descriptor = clone(activeKb);
    (descriptor.approvals.clinical as unknown as Record<string, unknown>).required = 'yes';
    const { states } = evaluateDescriptor(descriptor, context);
    expect(states.approved).toBe(false);
  });
});

describe('selection — nothing is ever selected implicitly', () => {
  it('selects the single active, eligible descriptor', () => {
    const result = selectActiveDescriptor(baseline, 'knowledge_base', context);
    expect(result.selected?.artifact_version).toBe('2.4');
    expect(result.reasons).toEqual([]);
  });

  it('a missing active artifact selects nothing — a candidate is never promoted', () => {
    const manifest = clone(baseline);
    const kb = manifest.artifacts.find(d => d.artifact_version === '2.4') as ArtifactDescriptor;
    kb.activation_status = 'inactive';
    const result = selectActiveDescriptor(manifest, 'knowledge_base', context);
    expect(result.selected).toBeNull();
    expect(result.reasons.map(reason => reason.code)).toContain('NO_ACTIVE_ARTIFACT');
  });

  it('an unknown artifact line selects nothing', () => {
    const result = selectActiveDescriptor(baseline, 'question_flow', context);
    expect(result.selected).toBeNull();
    expect(result.reasons.map(reason => reason.code)).toContain('NO_ACTIVE_ARTIFACT');
  });

  it('environment mismatch prevents selection even for an otherwise perfect descriptor', () => {
    const result = selectActiveDescriptor(baseline, 'knowledge_base', {
      ...context,
      environment: 'production',
    });
    expect(result.selected).toBeNull();
  });
});

describe('downgrade and rollback semantics', () => {
  it('compares dotted versions numerically, not lexically', () => {
    expect(compareVersions('2.10', '2.4')).toBe(1);
    expect(compareVersions('2.4', '2.4')).toBe(0);
    expect(compareVersions('1.0', '2.0')).toBe(-1);
  });

  it('permits an upgrade without a rollback declaration', () => {
    const upgraded = clone(activeKb);
    upgraded.artifact_version = '2.5';
    expect(authorizeTransition(activeKb, upgraded)).toEqual([]);
  });

  it('permits a downgrade only through the declared version/hash-bound rollback target', () => {
    expect(authorizeTransition(activeKb, rollbackKb)).toEqual([]);
  });

  it('refuses a downgrade to a version the rollback target does not name', () => {
    const older = clone(rollbackKb);
    older.artifact_version = '2.2';
    const reasons = authorizeTransition(activeKb, older);
    expect(reasons.map(reason => reason.code)).toContain('DOWNGRADE_NOT_AUTHORIZED');
  });

  it('refuses a downgrade when the hash does not match the rollback target', () => {
    const tampered = clone(rollbackKb);
    tampered.sha256 = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const reasons = authorizeTransition(activeKb, tampered);
    expect(reasons.map(reason => reason.code)).toContain('DOWNGRADE_NOT_AUTHORIZED');
  });

  it('refuses any downgrade when no rollback target is declared', () => {
    const current = clone(activeKb);
    current.rollback_target = null;
    const reasons = authorizeTransition(current, rollbackKb);
    expect(reasons.map(reason => reason.code)).toContain('DOWNGRADE_NOT_AUTHORIZED');
  });

  it('candidate failure cannot overwrite the last-known-good descriptor: the rollback target is immutable in the manifest', () => {
    // The rollback target must resolve, exactly, to a descriptor in the manifest; changing the
    // referenced descriptor's hash invalidates the whole manifest rather than the target.
    const manifest = clone(baseline);
    const target = manifest.artifacts.find(d => d.artifact_version === '2.3') as ArtifactDescriptor;
    target.sha256 = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.reasons.map(reason => reason.code)).toContain('INVALID_ROLLBACK_TARGET');
  });
});
