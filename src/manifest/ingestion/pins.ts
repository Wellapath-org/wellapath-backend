/**
 * The frozen integration boundary with the knowledge base.
 *
 * These are the exact upstream inputs the Backend would one day consume, pinned by digest over
 * committed bytes. They are recorded here — in code, drift-checked by tests — rather than
 * described in prose, because a boundary that is only written down in a document drifts silently.
 *
 * Every digest below was recomputed from `git show <commit>:<path>` against a clean checkout of
 * `wellapath-knowledge-base` whose `origin/develop` equalled the pinned commit. Nothing was
 * fetched over the network at runtime and nothing in this repository reads these files: they are
 * identified, not opened.
 *
 * A pin that stops matching is not a test failure to be quieted. It means the producer changed
 * something the consumer had agreed to, and the two must be reconciled before anything is ingested.
 */

/** Digest of a pinned upstream file, over its exact committed bytes. */
export interface PinnedArtifact {
  path: string;
  /** Bare 64-hex sha256 over committed bytes, as `shasum -a 256` reports it. */
  sha256: string;
  byte_count: number;
  purpose: string;
}

/**
 * What the producer recorded about THIS repository. Pinning in both directions means either side
 * changing the agreed bytes shows up as a mismatch, instead of only being caught downstream.
 */
export interface ReciprocalPin {
  backend_commit: string;
  path: string;
  sha256: string;
  recorded_by: string;
}

export interface KbIntegrationPins {
  source_repository: string;
  source_commit: string;
  /** The Backend manifest contract the producer is pinned to. */
  manifest_contract_version: string;
  /** The producer's own pin record, and the schema copy it vendored from us. */
  contract_pin: Record<string, PinnedArtifact>;
  /** Schemas describing the producer's output that a consumer would have to understand. */
  schemas: Record<string, PinnedArtifact>;
  publication_plans: Record<string, PinnedArtifact>;
  compatibility_fixtures: Record<string, PinnedArtifact>;
  governance: Record<string, PinnedArtifact>;
  /** Digests the producer recorded of our files, verified from our side. */
  reciprocal: Record<string, ReciprocalPin>;
  /** The only origin any artifact object may be served from. */
  approved_artifact_origin: string;
  /**
   * The producer's plan-level operation flags. Every one is pinned `const false` in its schema,
   * so a plan claiming an upload, a publication, an activation or a deployment fails the
   * producer's own contract rather than merely being untrue.
   */
  plan_operation_flags: readonly string[];
  /** The producer's closed set of receipt/operation types. Note it contains no `stage`. */
  receipt_operation_types: readonly string[];
  /** Producer-side refusal codes this consumer must never write into a descriptor. */
  producer_only_reason_codes: readonly string[];
}

/**
 * `wellapath-knowledge-base` at the commit this step was written against.
 *
 * Note this is a LATER commit than the one the blocked-candidate fixtures are seeded from
 * (`c1b07944…`, carried inside those descriptors as the authoritative generation commit). The two
 * are different facts: this pin says which producing tree the Backend integrated with; that seed
 * says which tree the candidates were generated from.
 */
export const KB_INTEGRATION_PINS: KbIntegrationPins = {
  source_repository: 'wellapath-org/wellapath-knowledge-base',
  source_commit: '77beffec2f7c8612a3760af30659a299ce2820a3',
  manifest_contract_version: '1.1.0',

  contract_pin: {
    pin_record: {
      path: 'contracts/backend/PIN.json',
      sha256: '29276e80cded3959532136d4dfe491fe0497280c771d11a9a4d01ec04c6337a9',
      byte_count: 6136,
      purpose:
        "The producer's pin record. Declares contract 1.1.0, supported major 1, our merge commit bbaeadd6, and fail-closed policy on every kind of drift.",
    },
    vendored_manifest_schema: {
      path: 'contracts/backend/manifest.v1.schema.json',
      sha256: '948299bc1ca87592e372d4ce889bdd2424a6cfc3d34c7660453dfe7d60d5038a',
      byte_count: 7806,
      purpose:
        "The producer's vendored copy of our published manifest schema. Verified byte-identical to ours at bbaeadd6.",
    },
    vendored_legacy_schema: {
      path: 'contracts/backend/legacy/manifest.v1.0.0.schema.json',
      sha256: '66fa3a94f17c2765eb1eca29208d2494c4c1b7be57eae61856bdb34761082ce9',
      byte_count: 6375,
      purpose:
        'Our superseded 1.0.0 schema, retained by the producer as legacy test material. Not the active contract.',
    },
  },

  schemas: {
    publication_plan_v1: {
      path: 'schema/publication_plan.v1.schema.json',
      sha256: 'a4069eb582d4c4d34da626dd6ffbb37a44287ddf0d2a20775bbd5ee603906d81',
      byte_count: 27055,
      purpose:
        'Shape of a publication plan. Pins every operation flag and the eligibility fields to const false, so a plan cannot claim an act it did not perform.',
    },
    publication_receipt_v1: {
      path: 'schema/publication_receipt.v1.schema.json',
      sha256: 'ff99738d1205140fbca40375d8eb26e566d9be428acca94873ab8cde8d750311',
      byte_count: 12164,
      purpose:
        'Shape of an upload / publication-decision / activation / rollback receipt. Requires a signing block that must state the signing gap in words.',
    },
  },

  publication_plans: {
    'token_dictionary.ng.v2.0.dryrun': {
      path: 'publication/plans/token_dictionary.ng.v2.0.dryrun.json',
      sha256: '7f70788658d4d49e77e858465f931a0913e16c261e32045ebf6433829d2864aa',
      byte_count: 23091,
      purpose:
        'Dry-run publication plan for the token_dictionary 2.0 candidate. Records that it is not publishable, not activatable and ineligible in every environment.',
    },
    'question_flow.ng.v1.1.dryrun': {
      path: 'publication/plans/question_flow.ng.v1.1.dryrun.json',
      sha256: '947c810cca92acb2dce4916272d7d7eca432cc879e3a36f289fb850f1bd99413',
      byte_count: 43104,
      purpose:
        'Dry-run publication plan for the question_flow 1.1 candidate. Records its open blockers and absent authorizations.',
    },
  },

  compatibility_fixtures: {
    kb_blocked_candidates: {
      path: 'publication/fixtures/compat/kb_blocked_candidates.manifest.json',
      sha256: 'c6ea18ec68cf3b46d5722ad0c00cbe4c53cf3d3ba7746097138c963eeb82d354',
      byte_count: 6248,
      purpose:
        'The producer-side manifest of the same two blocked candidates, with real digests rather than synthetic ones.',
    },
    approval_scope_reconciliation_v1: {
      path: 'publication/fixtures/compat/approval_scope_reconciliation_v1.json',
      sha256: '36efa4e908df42b99463c8fe809e11e83e740d20b205f1358c51d17622e194ee',
      byte_count: 8578,
      purpose:
        'The I3 Step 2A reconciliation that identified the approval-scope substitution. Pinned unchanged since Step 2B.',
    },
    approval_scope_reconciliation_v2: {
      path: 'publication/fixtures/compat/approval_scope_reconciliation_v2.json',
      sha256: 'c06082f8e4814537d5a1617b981ca3ef05904dd14b0d73cb345cd2582b6d00fd',
      byte_count: 10044,
      purpose:
        'The reconciliation re-issued against Backend manifest contract 1.1.0, after the approval-scope correction merged.',
    },
    legacy_contract_compatibility_v1: {
      path: 'publication/fixtures/compat/legacy_contract_compatibility_v1.json',
      sha256: 'f0aecedd6ea3e9f99a1466a17fb626e304d93db5a15fb971ee71b48c0c839a59',
      byte_count: 10792,
      purpose:
        'Producer-side record of how contract 1.0.0 documents are judged under 1.1.0. Digest filled from the pinned commit.',
    },
    negative_fixtures_compat: {
      path: 'publication/fixtures/compat/negative_fixtures.compat.json',
      sha256: 'b739ea8efced80e114eea171913bad9d9e49e8635247c53a94201a1434e2fcc3',
      byte_count: 15932,
      purpose: 'Producer-side negative fixtures mirroring the Backend contract refusals.',
    },
    kb_stage_fixtures_v1: {
      path: 'publication/fixtures/negative/kb_stage_fixtures_v1.json',
      sha256: '5bc3806ce4984bccd8ee5189b321efbf84caed464e1df47910304d5b4d5b0a78',
      byte_count: 17155,
      purpose: 'Producer-side stage-level negative fixtures.',
    },
  },

  reciprocal: {
    blocked_candidates_fixture: {
      backend_commit: 'bbaeadd6075eb37fd51acbe04101f939e52c7d48',
      path: 'tests/fixtures/manifest/blocked-candidates.manifest.json',
      sha256: '5b0622e8efc57b09cd65c9d4964f740565c9863b9ba28729dba035c58fc3bbb7',
      recorded_by: 'publication/fixtures/compat/approval_scope_reconciliation_v2.json',
    },
    kb_publication_handoff: {
      backend_commit: 'bbaeadd6075eb37fd51acbe04101f939e52c7d48',
      path: 'docs/handoffs/KB_PUBLICATION_HANDOFF.md',
      sha256: '45fe9d886fb6d13ec3087cd11610eb38074a3b38edf20b1bd180bc024681887c',
      recorded_by: 'contracts/backend/PIN.json',
    },
    manifest_schema: {
      backend_commit: 'bbaeadd6075eb37fd51acbe04101f939e52c7d48',
      path: 'docs/contracts/manifest.v1.schema.json',
      sha256: '948299bc1ca87592e372d4ce889bdd2424a6cfc3d34c7660453dfe7d60d5038a',
      recorded_by: 'contracts/backend/PIN.json',
    },
  },

  approved_artifact_origin: 'https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev',

  plan_operation_flags: [
    'upload_performed',
    'publication_performed',
    'activation_performed',
    'deployment_performed',
    'storage_write_performed',
    'network_access_performed',
    'canonical_bytes_modified',
  ],

  receipt_operation_types: ['upload', 'publication_decision', 'activation', 'rollback'],

  producer_only_reason_codes: [
    'KB_DECISION_RECORD_MISSING',
    'KB_DECISION_SCOPE_EXCEEDED',
    'KB_DECISION_SET_IS_NOT_AUTHORIZATION',
    'KB_DECISION_AUTHORITY_WRONG',
    'KB_PUBLICATION_AUTHORIZATION_MISSING',
    'KB_ACTIVATION_AUTHORIZATION_MISSING',
    'KB_SAFETY_BLOCKER_OPEN',
    'KB_ROLLBACK_SCHEMA_INCOMPATIBLE',
    'KB_STATE_COLLAPSE',
  ],

  governance: {
    kb_baseline_manifest: {
      path: 'publication/fixtures/compat/kb_baseline.manifest.json',
      sha256: '72749a8b01bf95fc1dde22dc889c79fc68b97d284a329007bf85db6df13a5163',
      byte_count: 4950,
      purpose:
        "The producer's synthetic baseline manifest — the only place upstream that emits a non-null decision_scope.",
    },
    decision_register_v1: {
      path: 'publication/governance/decision_register_v1.json',
      sha256: '0848fbd3f6a577e936c322523bfb47419b40a4e774e76f56f0620e8b93705735',
      byte_count: 13421,
      purpose:
        'Derived transcription of the IM-001 / IM-003 decision records and the two open blockers, each bound to its source by path and digest.',
    },
  },
};
