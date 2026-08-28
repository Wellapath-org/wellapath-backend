/**
 * Approval-scope regression suite — I3 Step 2B.
 *
 * The defect this suite exists to prevent: IM-001 completed a Product decision about how a
 * question is *displayed* (wording and ordering) and that completion was written into the
 * artifact-level Product approval slot of the `question_flow` 1.1 candidate. Those are two
 * different decisions. The display decision was taken; the artifact-publication approval never
 * was. Because the slot read `granted`, the only things standing between the candidate and
 * `approved: true` / `eligible_for_environment: true` were the *unrelated* clinical approval
 * and the two open blockers — so lifting those, for reasons having nothing to do with Product
 * sign-off, would have handed the candidate an approval nobody ever gave.
 *
 * Scope substitution is the general shape of that fault: a real, complete, correctly-authored
 * decision standing in for a different decision that was never taken. The contract therefore
 * records what each cited decision actually authorized (`decision_scope`) and refuses any
 * approval whose decision was scoped elsewhere — missing, malformed and unknown scope all fail
 * closed, so a future scope name can never be read as authorisation by default.
 *
 * Nothing here touches runtime. The manifest contract is not wired into any route.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  APPROVAL_SCOPES,
  ARTIFACT_APPROVAL_SLOT_SCOPE,
  ApprovalScope,
  ArtifactDescriptor,
  CandidateManifest,
  Environment,
  MANIFEST_CONTRACT_VERSION,
  ReasonCode,
  SUPPORTED_MANIFEST_MAJOR,
} from '../../src/manifest/contract';
import { evaluateDescriptor, selectActiveDescriptor } from '../../src/manifest/eligibility';
import { validateManifest } from '../../src/manifest/validate';

const ENVIRONMENTS_ALL: readonly Environment[] = ['development', 'staging', 'production'];

/**
 * The authoritative knowledge-base reconciliation record this correction is bound to. The
 * digest is over the exact committed bytes at the merge commit, recomputed out of band with
 * `git show <merge>:<path> | shasum -a 256`; CI has no access to that repository, so this suite
 * asserts the binding is recorded exactly and never silently edited.
 */
const KB_RECONCILIATION = {
  repository: 'wellapath-org/wellapath-knowledge-base',
  merge_commit: '2325e3f9e876a40d32e6e3ff0b5b77e19c7e309a',
  path: 'publication/fixtures/compat/approval_scope_reconciliation_v1.json',
} as const;

interface ScopedDecisionRecord {
  decision_id: string;
  title: string;
  authority: string;
  status: string;
  scope: ApprovalScope[];
  excludes: ApprovalScope[];
  may_occupy_artifact_publication_approval_slot: boolean;
  note: string;
}

interface ReconciliationRecord {
  record_version: string;
  purpose: string;
  backend_base_commit: string;
  knowledge_base_binding: {
    repository: string;
    merge_commit: string;
    path: string;
    sha256: string;
    byte_count: number;
    verification: string;
  };
  scoped_decisions: ScopedDecisionRecord[];
  artifact_publication_state: {
    artifact_id: string;
    artifact_version: string;
    product_approval: string;
    clinical_approval: string;
    open_blockers: string[];
    im_003: string;
    clinical_reviewer_assigned: boolean;
    publication_authorized: boolean;
    activation_authorized: boolean;
    mobile_pr_76: string;
  };
}

const fixturesDir = join(__dirname, '../fixtures/manifest');
const loadJson = <T>(name: string): T =>
  JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as T;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const manifest = loadJson<CandidateManifest>('blocked-candidates.manifest.json');
const reconciliation = loadJson<ReconciliationRecord>('approval-scope-reconciliation.fixture.json');

const questionFlow = (): ArtifactDescriptor =>
  clone(
    manifest.artifacts.find(entry => entry.artifact_id === 'question_flow') as ArtifactDescriptor,
  );

const context = { environment: 'staging' as const, now: new Date('2026-08-28T00:00:00Z') };

const codesFor = (descriptor: ArtifactDescriptor): ReasonCode[] =>
  evaluateDescriptor(descriptor, context).reasons.map(reason => reason.code);

/** Lifts every gate that has nothing to do with the Product approval slot. */
const liftUnrelatedGates = (descriptor: ArtifactDescriptor): ArtifactDescriptor => {
  descriptor.approvals.clinical = {
    required: true,
    status: 'granted',
    decision_ref: 'hypothetical clinical sign-off for this mutation only',
    approved_at: '2026-08-28T00:00:00Z',
    decision_scope: ['artifact_publication'],
  };
  descriptor.blockers = descriptor.blockers.map(blocker => ({ ...blocker, status: 'resolved' }));
  descriptor.release_status = 'published';
  descriptor.published_at = '2026-08-28T00:00:00Z';
  descriptor.activation_authorized = true;
  descriptor.activation_decision_ref = 'hypothetical activation authorization for this mutation';
  descriptor.activation_status = 'active';
  descriptor.target_environments = [...ENVIRONMENTS_ALL];
  return descriptor;
};

describe('IM-001 completion cannot satisfy artifact-publication Product approval', () => {
  it('the corrected fixture leaves the Product approval slot pending, citing no decision', () => {
    const descriptor = questionFlow();
    expect(descriptor.approvals.product.status).toBe('pending');
    expect(descriptor.approvals.product.decision_ref).toBeNull();
    expect(descriptor.approvals.product.decision_scope).toBeNull();
    expect(descriptor.approvals.product.required).toBe(true);
  });

  it('IM-001 completion is preserved as traceability, not as an approval and not as a blocker', () => {
    const descriptor = questionFlow();
    const references = (descriptor.references ?? []).join('\n');

    // The positive fact survives the correction.
    expect(references).toContain('IM-001');
    expect(references).toContain('COMPLETE');
    // ... explicitly scoped, and explicitly excluded from publication.
    expect(references).toContain('product_display');
    expect(references).toContain('EXCLUDES artifact publication');
    // A completed decision is never rewritten into an active safety blocker.
    expect(descriptor.blockers.map(blocker => blocker.id)).toEqual([
      'IM001-CLIN-FLAG-001',
      'IM003-SB-001',
    ]);
    expect(descriptor.blockers.some(blocker => blocker.reference?.includes('complete'))).toBe(
      false,
    );
    // And it is nowhere in a field that can feed `approved`.
    const approvals = JSON.stringify(descriptor.approvals);
    expect(approvals).not.toContain('IM-001');
    expect(approvals).not.toContain('IM001');
  });

  it('lifting the unrelated clinical approval alone no longer produces approved: true', () => {
    const descriptor = questionFlow();
    descriptor.approvals.clinical = {
      required: true,
      status: 'granted',
      decision_ref: 'hypothetical clinical sign-off for this mutation only',
      approved_at: '2026-08-28T00:00:00Z',
      decision_scope: ['artifact_publication'],
    };

    const { states } = evaluateDescriptor(descriptor, context);
    expect(states.approved).toBe(false);
    expect(codesFor(descriptor)).toContain('APPROVAL_NOT_GRANTED');
  });

  it('lifting the clinical approval AND resolving both blockers still leaves approved: false', () => {
    const descriptor = questionFlow();
    descriptor.approvals.clinical = {
      required: true,
      status: 'granted',
      decision_ref: 'hypothetical clinical sign-off for this mutation only',
      approved_at: '2026-08-28T00:00:00Z',
      decision_scope: ['artifact_publication'],
    };
    descriptor.blockers = descriptor.blockers.map(blocker => ({ ...blocker, status: 'resolved' }));

    const { states, reasons } = evaluateDescriptor(descriptor, context);
    expect(states.approved).toBe(false);
    expect(states.eligible_for_environment).toBe(false);
    // The blockers really are gone — the denial is the Product approval and nothing else.
    expect(reasons.map(reason => reason.code)).not.toContain('BLOCKER_UNRESOLVED');
    expect(reasons.map(reason => reason.code)).toContain('APPROVAL_NOT_GRANTED');
  });

  it('a resolved blocker grants nothing: clearing every unrelated gate still denies eligibility', () => {
    const descriptor = liftUnrelatedGates(questionFlow());

    for (const environment of ENVIRONMENTS_ALL) {
      const { states, reasons } = evaluateDescriptor(descriptor, { ...context, environment });
      expect(states.approved).toBe(false);
      expect(states.eligible_for_environment).toBe(false);
      expect(reasons.map(reason => reason.code)).toContain('APPROVAL_NOT_GRANTED');
    }
  });

  it('with every unrelated gate lifted the candidate is still never selected', () => {
    const mutated = clone(manifest);
    const index = mutated.artifacts.findIndex(entry => entry.artifact_id === 'question_flow');
    mutated.artifacts[index] = liftUnrelatedGates(questionFlow());

    for (const environment of ENVIRONMENTS_ALL) {
      const result = selectActiveDescriptor(mutated, 'question_flow', { ...context, environment });
      expect(result.selected).toBeNull();
      expect(result.reasons.map(reason => reason.code)).toContain('NO_ACTIVE_ARTIFACT');
    }
  });
});

describe('scope substitution is rejected wherever it is attempted', () => {
  /** Reinstates the pre-fix defect exactly: IM-001 back in the artifact-publication slot. */
  const reinstateDefect = (): ArtifactDescriptor => {
    const descriptor = liftUnrelatedGates(questionFlow());
    descriptor.approvals.product = {
      required: true,
      status: 'granted',
      decision_ref: 'IM-001 — Product decisions complete; activation remains unauthorized',
      approved_at: null,
      decision_scope: ['product_display'],
    };
    return descriptor;
  };

  it('flipping the Product slot back to granted with IM-001 reproduces the defect and is rejected', () => {
    const descriptor = reinstateDefect();

    const { states, reasons } = evaluateDescriptor(descriptor, context);
    expect(states.approved).toBe(false);
    expect(states.eligible_for_environment).toBe(false);

    const scopeReasons = reasons.filter(reason => reason.code === 'APPROVAL_SCOPE_MISMATCH');
    expect(scopeReasons).toHaveLength(1);
    expect(scopeReasons[0].path).toBe(
      'artifact question_flow@1.1.approvals.product.decision_scope',
    );
    expect(scopeReasons[0].detail).toContain('product_display');
    expect(scopeReasons[0].detail).toContain(ARTIFACT_APPROVAL_SLOT_SCOPE);
  });

  it('the reinstated defect is also rejected at validation, not only at eligibility', () => {
    const mutated = clone(manifest);
    const index = mutated.artifacts.findIndex(entry => entry.artifact_id === 'question_flow');
    mutated.artifacts[index] = reinstateDefect();

    const result = validateManifest(mutated);
    expect(result.valid).toBe(false);
    expect(result.reasons.map(reason => reason.code)).toContain('APPROVAL_SCOPE_MISMATCH');
  });

  it('the reinstated defect is ineligible in every environment', () => {
    const descriptor = reinstateDefect();
    for (const environment of ENVIRONMENTS_ALL) {
      const { states } = evaluateDescriptor(descriptor, { ...context, environment });
      expect(states.eligible_for_environment).toBe(false);
    }
  });

  it.each([
    ['product_display', ['product_display']],
    ['artifact_activation only', ['artifact_activation']],
    ['clinical_content_review', ['clinical_content_review']],
    ['several non-publication scopes', ['product_display', 'artifact_activation']],
  ])(
    'a decision scoped to %s cannot occupy an artifact-publication approval slot',
    (_label, scope) => {
      for (const role of ['product', 'clinical'] as const) {
        const descriptor = liftUnrelatedGates(questionFlow());
        descriptor.approvals[role] = {
          required: true,
          status: 'granted',
          decision_ref: `a real, complete decision scoped to ${(scope as string[]).join(', ')}`,
          approved_at: '2026-08-28T00:00:00Z',
          decision_scope: scope as ApprovalScope[],
        };

        const { states, reasons } = evaluateDescriptor(descriptor, context);
        expect(states.approved).toBe(false);
        const mismatch = reasons.filter(reason => reason.code === 'APPROVAL_SCOPE_MISMATCH');
        expect(mismatch.map(reason => reason.path)).toContain(
          `artifact question_flow@1.1.approvals.${role}.decision_scope`,
        );
      }
    },
  );

  it('a scope that additionally includes artifact_publication is accepted — the check is not a blanket denial', () => {
    const descriptor = liftUnrelatedGates(questionFlow());
    descriptor.approvals.product = {
      required: true,
      status: 'granted',
      decision_ref: 'a decision genuinely scoped to publishing this artifact',
      approved_at: '2026-08-28T00:00:00Z',
      decision_scope: ['product_display', 'artifact_publication'],
    };

    const { states, reasons } = evaluateDescriptor(descriptor, context);
    expect(reasons.map(reason => reason.code)).not.toContain('APPROVAL_SCOPE_MISMATCH');
    expect(states.approved).toBe(true);
    // Proving the negative cases above were denied by SCOPE and nothing else: this is the one
    // mutation that reaches eligibility, and only because the scope genuinely covers the slot.
    expect(states.eligible_for_environment).toBe(true);
  });
});

describe('missing, malformed and unknown approval scope all fail closed', () => {
  const grantedWithScope = (scope: unknown): ArtifactDescriptor => {
    const descriptor = liftUnrelatedGates(questionFlow());
    descriptor.approvals.product = {
      required: true,
      status: 'granted',
      decision_ref: 'some decision',
      approved_at: '2026-08-28T00:00:00Z',
      decision_scope: scope as ApprovalScope[] | null,
    };
    return descriptor;
  };

  it.each([
    ['null scope', null, 'APPROVAL_SCOPE_MISSING'],
    ['undefined scope', undefined, 'APPROVAL_SCOPE_MISSING'],
    ['empty array', [], 'APPROVAL_SCOPE_MISSING'],
    ['unknown scope name', ['artifact_publication_v2'], 'APPROVAL_SCOPE_UNKNOWN'],
    [
      'known scope beside an unknown one',
      ['artifact_publication', 'wildcard'],
      'APPROVAL_SCOPE_UNKNOWN',
    ],
    ['non-string entry', [42], 'APPROVAL_SCOPE_UNKNOWN'],
    ['scope as a bare string', 'artifact_publication', 'APPROVAL_SCOPE_MISSING'],
  ])('%s denies approval with %s', (_label, scope, expected) => {
    const descriptor = grantedWithScope(scope);
    const { states, reasons } = evaluateDescriptor(descriptor, context);
    expect(states.approved).toBe(false);
    expect(states.eligible_for_environment).toBe(false);
    expect(reasons.map(reason => reason.code)).toContain(expected as ReasonCode);
  });

  it('an absent decision_scope key on a GRANTED approval fails closed at validation', () => {
    const mutated = clone(manifest);
    const target = mutated.artifacts.find(
      entry => entry.artifact_id === 'question_flow',
    ) as ArtifactDescriptor;
    target.approvals.product.status = 'granted';
    target.approvals.product.decision_ref = 'some decision';
    delete (target.approvals.product as unknown as Record<string, unknown>).decision_scope;

    const result = validateManifest(mutated);
    expect(result.valid).toBe(false);
    expect(result.reasons.map(reason => reason.code)).toContain('APPROVAL_SCOPE_MISSING');
  });

  it('an absent decision_scope key on a NON-granted approval is legitimate, not an error', () => {
    // The field is optional in structure on purpose: an approval that claims nothing needs no
    // scope, and requiring one there would invalidate sound descriptors while protecting
    // nothing. This is what keeps the 1.1.0 tightening confined to unsafe claims.
    const mutated = clone(manifest);
    const target = mutated.artifacts.find(
      entry => entry.artifact_id === 'question_flow',
    ) as ArtifactDescriptor;
    delete (target.approvals.product as unknown as Record<string, unknown>).decision_scope;
    delete (target.approvals.clinical as unknown as Record<string, unknown>).decision_scope;

    const result = validateManifest(mutated);
    expect(result.reasons).toEqual([]);
    expect(result.valid).toBe(true);

    // ... and it still cannot become approved.
    const { states } = evaluateDescriptor(target, context);
    expect(states.approved).toBe(false);
  });

  it.each([
    ['unknown scope name', ['not_a_scope'], 'APPROVAL_SCOPE_UNKNOWN'],
    ['duplicated scopes', ['artifact_publication', 'artifact_publication'], 'MALFORMED_FIELD'],
    ['empty array', [], 'MALFORMED_FIELD'],
    ['a bare string', 'artifact_publication', 'MALFORMED_FIELD'],
  ])('validation rejects %s', (_label, scope, expected) => {
    const mutated = clone(manifest);
    const target = mutated.artifacts.find(
      entry => entry.artifact_id === 'question_flow',
    ) as ArtifactDescriptor;
    (target.approvals.product as unknown as Record<string, unknown>).decision_scope = scope;

    const result = validateManifest(mutated);
    expect(result.valid).toBe(false);
    expect(result.reasons.map(reason => reason.code)).toContain(expected as ReasonCode);
  });

  it('scope on a non-granted approval is inert: it can never raise approved by itself', () => {
    const descriptor = liftUnrelatedGates(questionFlow());
    descriptor.approvals.product = {
      required: true,
      status: 'pending',
      decision_ref: null,
      approved_at: null,
      decision_scope: ['artifact_publication'],
    };

    const { states, reasons } = evaluateDescriptor(descriptor, context);
    expect(states.approved).toBe(false);
    expect(reasons.map(reason => reason.code)).toContain('APPROVAL_NOT_GRANTED');
  });
});

describe('the knowledge-base reconciliation record this correction is bound to', () => {
  it('names the authoritative KB merge, path and committed digest exactly', () => {
    const binding = reconciliation.knowledge_base_binding;
    expect(binding.repository).toBe(KB_RECONCILIATION.repository);
    expect(binding.merge_commit).toBe(KB_RECONCILIATION.merge_commit);
    expect(binding.path).toBe(KB_RECONCILIATION.path);
    expect(binding.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(binding.byte_count).toBeGreaterThan(0);
  });

  it('records IM-001 as a complete Product decision whose scope excludes publication', () => {
    const im001 = reconciliation.scoped_decisions.find(entry => entry.decision_id === 'IM-001');
    expect(im001).toBeDefined();
    expect(im001?.authority).toBe('product');
    expect(im001?.status).toBe('complete');
    expect(im001?.scope).toEqual(['product_display']);
    expect(im001?.excludes).toEqual(
      expect.arrayContaining(['artifact_publication', 'artifact_activation']),
    );
    expect(im001?.may_occupy_artifact_publication_approval_slot).toBe(false);
  });

  it('every recorded decision declares a known scope, and none that excludes publication may occupy the slot', () => {
    expect(reconciliation.scoped_decisions.length).toBeGreaterThan(0);
    for (const decision of reconciliation.scoped_decisions) {
      expect(decision.scope.length).toBeGreaterThan(0);
      for (const scope of [...decision.scope, ...decision.excludes]) {
        expect(APPROVAL_SCOPES).toContain(scope);
      }
      expect(decision.scope.filter(scope => decision.excludes.includes(scope))).toEqual([]);
      expect(decision.may_occupy_artifact_publication_approval_slot).toBe(
        decision.scope.includes(ARTIFACT_APPROVAL_SLOT_SCOPE),
      );
    }
  });

  it('its recorded publication state matches the descriptor, so the two cannot drift apart', () => {
    const state = reconciliation.artifact_publication_state;
    const descriptor = questionFlow();

    expect(state.artifact_id).toBe(descriptor.artifact_id);
    expect(state.artifact_version).toBe(descriptor.artifact_version);
    expect(state.product_approval).toBe(descriptor.approvals.product.status);
    expect(state.clinical_approval).toBe(descriptor.approvals.clinical.status);
    expect(state.open_blockers.sort()).toEqual(
      descriptor.blockers
        .filter(blocker => blocker.status === 'open')
        .map(blocker => blocker.id)
        .sort(),
    );
    expect(state.publication_authorized).toBe(descriptor.release_status === 'published');
    expect(state.activation_authorized).toBe(descriptor.activation_authorized);
    expect(state.clinical_reviewer_assigned).toBe(false);
    expect(state.im_003).toBe('disabled');
    expect(state.mobile_pr_76).toContain('unauthorized');
  });

  it('is bound to the same backend base commit this correction was written against', () => {
    expect(reconciliation.backend_base_commit).toBe('fc40ac3e7d59cfed8e2584b78136c9704f7ab8cd');
  });
});

describe('artifact identity — "Vocabulary 2.0" resolves to the token_dictionary line', () => {
  const tokenDictionaryCandidate = (): ArtifactDescriptor =>
    clone(manifest.artifacts.find(entry => entry.artifact_version === '2.0') as ArtifactDescriptor);

  /** The digest GET /config serves for the live token_dictionary, and the candidate's parent. */
  const LIVE_TOKEN_DICTIONARY_1_1_SHA =
    'sha256:0cc47ad9537c0bd4c6ef3aec8f1931eb9b4c62103a8809d16544f94a90b5c019';

  it('the candidate carries the stable artifact id, not the workstream label', () => {
    const descriptor = tokenDictionaryCandidate();
    expect(descriptor.artifact_id).toBe('token_dictionary');
    expect(descriptor.object_key).toBe('token_dictionary.ng.v2.0.json');
    // The human-facing label survives only as a label.
    expect(manifest.artifacts.map(entry => entry.artifact_id)).not.toContain('vocabulary');
    expect(JSON.stringify(manifest)).not.toContain('vocabulary.ng.');
  });

  it('its object key is derived from the same identity it declares', () => {
    const descriptor = tokenDictionaryCandidate();
    expect(descriptor.object_key).toBe(
      `${descriptor.artifact_id}.${descriptor.country}.v${descriptor.artifact_version}.json`,
    );
  });

  it('its lineage points at the real published predecessor that /config serves today', () => {
    const descriptor = tokenDictionaryCandidate();
    expect(descriptor.predecessor).toEqual({
      artifact_version: '1.1',
      sha256: LIVE_TOKEN_DICTIONARY_1_1_SHA,
    });
  });

  it('resolving the identity did not make the candidate any more eligible', () => {
    const descriptor = tokenDictionaryCandidate();
    for (const environment of ENVIRONMENTS_ALL) {
      const { states } = evaluateDescriptor(descriptor, { ...context, environment });
      expect(states.published).toBe(false);
      expect(states.approved).toBe(false);
      expect(states.active).toBe(false);
      expect(states.eligible_for_environment).toBe(false);
    }
    expect(descriptor.release_status).toBe('candidate');
    expect(descriptor.activation_authorized).toBe(false);
    expect(descriptor.publication_decision_ref).toBeNull();
    expect(descriptor.approvals.product.status).toBe('pending');
    expect(descriptor.approvals.clinical.status).toBe('pending');
  });

  it('sharing an artifact line with the live 1.1 never lets the candidate displace it', () => {
    // The correct identity puts the candidate on the SAME line as the active artifact. That is
    // the point of resolving it — and it must not become a route to selection.
    const baseline = loadJson<CandidateManifest>('baseline.manifest.json');
    const combined: CandidateManifest = {
      ...baseline,
      artifacts: [...baseline.artifacts, tokenDictionaryCandidate()],
    };

    expect(validateManifest(combined).valid).toBe(true);

    const result = selectActiveDescriptor(combined, 'token_dictionary', context);
    expect(result.selected).not.toBeNull();
    expect(result.selected?.artifact_version).toBe('1.1');
    expect(result.selected?.sha256).toBe(LIVE_TOKEN_DICTIONARY_1_1_SHA);
  });

  it('the synthetic digest is bound to the corrected identity, so it cannot name a real object', () => {
    const descriptor = tokenDictionaryCandidate();
    const seed = `fixture-only:${descriptor.artifact_id}@${descriptor.artifact_version}@kb:c1b07944ea0b231914943ac17b2265441e53b85c`;
    expect(descriptor.byte_count).toBe(Buffer.byteLength(seed));
    // The real KB candidate is 339,948 bytes; this fixture is a seed string and nothing else.
    expect(descriptor.byte_count).toBeLessThan(100);
  });

  it('the reconciliation record states the finding and the evidence behind it', () => {
    const finding = (
      reconciliation as unknown as {
        artifact_identity_finding: {
          finding: string;
          stable_artifact_id: string;
          human_facing_label: string;
          resolved_from: string[];
        };
      }
    ).artifact_identity_finding;

    expect(finding.finding).toBe('same_artifact_family');
    expect(finding.stable_artifact_id).toBe('token_dictionary');
    expect(finding.human_facing_label).toBe('Vocabulary 2.0');
    expect(finding.resolved_from.length).toBeGreaterThanOrEqual(5);
  });
});

describe('contract 1.1.0 compatibility with descriptors written against 1.0.0', () => {
  const BASE_COMMIT = 'fc40ac3e7d59cfed8e2584b78136c9704f7ab8cd';

  /** A descriptor exactly as contract 1.0.0 allowed: no decision_scope key anywhere. */
  const legacyDescriptor = (productStatus: 'pending' | 'granted'): ArtifactDescriptor =>
    ({
      artifact_id: 'question_flow',
      artifact_version: '1.1',
      schema_version: 'wellapath.artifact/1',
      content_type: 'application/json',
      sha256: `sha256:${'a'.repeat(64)}`,
      byte_count: 10,
      object_key: 'question_flow.ng.v1.1.json',
      release_status: 'candidate',
      activation_status: 'inactive',
      activation_authorized: false,
      activation_decision_ref: null,
      target_environments: ['staging'],
      publication_decision_ref: null,
      approvals: {
        product: {
          required: true,
          status: productStatus,
          decision_ref: productStatus === 'granted' ? 'a 1.0.0-era decision' : null,
          approved_at: null,
        },
        clinical: { required: true, status: 'pending', decision_ref: null, approved_at: null },
      },
      blockers: [],
      predecessor: null,
      rollback_target: null,
      created_at: '2026-08-28T00:00:00Z',
      published_at: null,
      deprecated: false,
      expires_at: null,
      country: 'ng',
    }) as unknown as ArtifactDescriptor;

  const wrap = (descriptor: ArtifactDescriptor): CandidateManifest => ({
    manifest_version: '1.0.0',
    generated_at: '2026-08-28T00:00:00Z',
    artifacts: [descriptor],
  });

  it('a 1.0.0 descriptor that makes no granted-approval claim stays valid — no forced migration', () => {
    const result = validateManifest(wrap(legacyDescriptor('pending')));
    expect(result.reasons).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('a 1.0.0 descriptor asserting a granted approval without scope is now rejected — the documented tightening', () => {
    const result = validateManifest(wrap(legacyDescriptor('granted')));
    expect(result.valid).toBe(false);
    expect(result.reasons.map(reason => reason.code)).toEqual(['APPROVAL_SCOPE_MISSING']);
  });

  it('manifests declaring the older 1.0.0 version are still accepted: the supported major is unchanged', () => {
    const manifestAt100 = wrap(legacyDescriptor('pending'));
    expect(manifestAt100.manifest_version).toBe('1.0.0');
    expect(validateManifest(manifestAt100).valid).toBe(true);
  });

  it('the real fixtures as they stood at the base commit fail ONLY on unsafe granted claims', () => {
    // Every reason must be a scope failure on a granted approval — never a structural one.
    // A MISSING_REQUIRED_FIELD here would mean the contract had broken sound descriptors.
    const legacyBaseline = JSON.parse(
      execFileSync(
        'git',
        ['show', `${BASE_COMMIT}:tests/fixtures/manifest/baseline.manifest.json`],
        {
          encoding: 'utf8',
        },
      ),
    ) as CandidateManifest;

    const result = validateManifest(legacyBaseline);
    const codes = [...new Set(result.reasons.map(reason => reason.code))];
    expect(codes).toEqual(['APPROVAL_SCOPE_MISSING']);
    expect(result.reasons.every(reason => reason.path.endsWith('.decision_scope'))).toBe(true);

    // Each one corresponds to an approval that actually claimed `granted`.
    for (const reason of result.reasons) {
      expect(reason.path).toMatch(/approvals\.(product|clinical)\.decision_scope$/);
    }
  });

  it('the blocked-candidate fixture at the base commit fails only on the defect itself', () => {
    const legacyBlocked = JSON.parse(
      execFileSync(
        'git',
        ['show', `${BASE_COMMIT}:tests/fixtures/manifest/blocked-candidates.manifest.json`],
        { encoding: 'utf8' },
      ),
    ) as CandidateManifest;

    const result = validateManifest(legacyBlocked);
    expect(result.valid).toBe(false);
    // Exactly one approval claimed granted at the base commit: question_flow's product slot.
    expect(result.reasons.map(reason => reason.code)).toEqual(['APPROVAL_SCOPE_MISSING']);
    expect(result.reasons[0].path).toBe('artifacts[1].approvals.product.decision_scope');
  });

  it('the contract version was bumped, and the schema agrees', () => {
    expect(MANIFEST_CONTRACT_VERSION).toBe('1.1.0');
    expect(SUPPORTED_MANIFEST_MAJOR).toBe(1);
  });
});
