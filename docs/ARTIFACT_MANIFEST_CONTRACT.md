# Artifact Manifest Contract v1.0.0 — I3 Step 1

> **Amended by I3 Step 2B (2026-08-28)** — approval _scope_ is now a first-class part of the
> contract (§3a), and the blocked-candidate fixtures were corrected: `question_flow` 1.1's
> Product approval returned to `pending`, and the candidate labelled "Vocabulary 2.0" was
> resolved to its stable artifact id `token_dictionary` (§9a). Still additive, still inactive,
> still zero change to `/config`.

> **Status: INACTIVE.** This contract is a repository-only foundation: schemas, fixtures,
> validation code and tests. **No route serves it, no route consumes it, and the live
> `GET /config` response is byte-for-byte unchanged.** Activating any part of it requires an
> explicit, recorded engineering-lead decision and is out of scope for this step.

| Item                | Value                                                            |
| ------------------- | ---------------------------------------------------------------- |
| Contract version    | `1.0.0`                                                          |
| Source of truth     | `src/manifest/contract.ts`                                       |
| Published schema    | `docs/contracts/manifest.v1.schema.json` (drift-checked by test) |
| Validation          | `src/manifest/validate.ts`                                       |
| Eligibility         | `src/manifest/eligibility.ts`                                    |
| Integrity           | `src/manifest/integrity.ts`                                      |
| Origin policy       | `src/manifest/origin.ts`                                         |
| Frozen baseline     | `docs/baseline/distribution-baseline.v1.json`                    |
| Baseline narrative  | `docs/DISTRIBUTION_BASELINE.md`                                  |
| Fixtures            | `tests/fixtures/manifest/`                                       |
| KB handoff (future) | `docs/handoffs/KB_PUBLICATION_HANDOFF.md`                        |
| Mobile handoff      | `docs/handoffs/MOBILE_MANIFEST_CONSUMER_HANDOFF.md`              |

---

## 1. Current distribution architecture (what exists today)

The live distribution mechanism is unchanged by this work and is frozen in
`docs/baseline/distribution-baseline.v1.json`:

1. `GET /config` (public, unauthenticated, GET-only, rate-limited) returns a static payload:
   four artifacts (`token_dictionary`, `knowledge_base`, `rules`, `facilities`), each with
   `version`, `url`, `hash`, `release_date`, `country`.
2. The mobile app bootstraps from `/config`, downloads artifacts from the URLs it is given
   (Cloudflare R2 public origin), and verifies the sha256 on device.
3. Releases are manual, PR-reviewed edits to `src/routes/config.ts`, governed by the
   E9.1 freeze and the immutability rule (a version/filename is never reused for changed
   content). Rollback is the same edit in reverse; all prior versions stay addressable on R2.

There is no manifest, no server-side eligibility logic and no automated activation today.
This contract models what a governed replacement must express — it does not replace anything
yet.

## 2. The five states — never synonyms

Every descriptor is evaluated into five **independent** states
(`src/manifest/eligibility.ts`):

| State                      | Meaning                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `present`                  | The descriptor exists and its identity/integrity metadata is structurally sound. Nothing more.             |
| `published`                | `release_status: published` with a non-null `published_at`.                                                |
| `approved`                 | Every **required** approval is exactly `granted` with a non-null `decision_ref`.                           |
| `active`                   | `activation_status: active` **and** activation is explicitly authorized with a decision reference.         |
| `eligible_for_environment` | Everything a given environment requires holds at once (see §3). Without it, `active` cannot be selectable. |

An artifact that exists in storage or in a repository is `present` — and that confers
**nothing else**. Tests assert each state can be true while the others are false.

### State machine

```
draft ──▶ candidate ──▶ published ──▶ deprecated
                            │
                (activation is orthogonal)
                            │
              inactive ◀──▶ active   ← only with explicit authorization,
                                       only while eligible, at most one
                                       active per artifact line
```

`release_status` moves forward only. Activation is a separate, explicitly authorized act on a
published descriptor; deactivation (rollback) is equally explicit. No transition happens
implicitly.

## 3. Eligibility — explicit and fail-closed

A descriptor is `eligible_for_environment` only when **all** of the following are explicitly
true simultaneously:

- `present` (sound identity and integrity metadata: sha256, byte count);
- `published`;
- `approved` — for clinical/question artifacts this includes Clinical approval; Product
  approval is always required unless a role is explicitly `required: false`; and every granted
  approval must cite a decision **scoped to artifact publication** (§3a);
- **zero unresolved blockers** — any blocker not exactly `resolved` blocks;
- activation **authorized** (independent of whether it is currently activated);
- the target environment is explicitly listed in `target_environments`;
- not expired (`expires_at`), not deprecated;
- app-build compatible: if `min_app_build` is declared, an unknown consumer build **fails**.

**Absence, `null`, unknown values or malformed data always mean _not eligible_.** There is no
default-open path: an unknown approval status is a denial, a missing approval record is a
denial, a blocker with an unrecognized status is treated as open.

A descriptor is **distributable** only when it is `eligible_for_environment` **and** `active`.
Selection (`selectActiveDescriptor`) returns nothing when no descriptor qualifies — **a
candidate is never promoted to fill a gap** — and returns nothing (with `MULTIPLE_ACTIVE`)
when two descriptors of one line are simultaneously active, because that is a governance
fault, not a choice.

## 3a. Approval scope — a decision authorizes only what it decided

Added in I3 Step 2B, after a real defect. Both `approvals.product` and `approvals.clinical` are
**artifact-publication approval slots**. A completed decision taken for some _other_ purpose —
however real, however senior its author — is not an approval here.

Every `ApprovalRecord` therefore carries `decision_scope`, drawn from a closed set:
`artifact_publication`, `artifact_activation`, `product_display`, `clinical_content_review`.

| Situation                                             | Result                                       |
| ----------------------------------------------------- | -------------------------------------------- |
| `granted`, scope includes `artifact_publication`      | counts toward `approved`                     |
| `granted`, scope excludes it (e.g. `product_display`) | `APPROVAL_SCOPE_MISMATCH` — not approved     |
| `granted`, scope is `null`, `[]` or absent            | `APPROVAL_SCOPE_MISSING` — not approved      |
| `granted`, scope holds an unrecognized name           | `APPROVAL_SCOPE_UNKNOWN` — not approved      |
| not `granted`                                         | scope is inert; it can never grant by itself |

The check runs in **both** layers. `validateManifest` rejects a scope-substituting manifest
outright — the assertion is structurally wrong, not merely ineffective — and
`evaluateDescriptor` repeats it so that a descriptor evaluated in isolation still fails closed
rather than inheriting a guarantee from a validation pass that may never have run.

**The defect this prevents.** The `question_flow` 1.1 fixture recorded IM-001 — a _complete_
Product decision about display wording and option ordering — in `approvals.product` as
`granted`. As shipped the candidate was still ineligible, but only because the clinical
approval was pending and two blockers were open. Lifting those _unrelated_ conditions produced
`approved: true` and `eligible_for_environment: true` on the strength of a wording decision. A
field that is safe only while something else happens to be blocking is not scoped correctly.

IM-001's completion is still recorded — it is true and it matters — but in
`tests/fixtures/manifest/approval-scope-reconciliation.fixture.json` and in the descriptor's
`references`, neither of which can contribute to `approved`. It is deliberately **not** recorded
as a blocker: the blocker list is the safety channel, and filing a completed decision there
inverts its meaning for anyone scanning it. That record is bound to the authoritative knowledge
base at merge `2325e3f9e876a40d32e6e3ff0b5b77e19c7e309a`,
`publication/fixtures/compat/approval_scope_reconciliation_v1.json`, sha256
`36efa4e908df42b99463c8fe809e11e83e740d20b205f1358c51d17622e194ee` (8,578 bytes).

> The knowledge base encodes the same distinction as a _resolved blocker_. Both encodings keep
> `approvals.product` pending and both are ineligible everywhere, so the governance outcome is
> identical; only the representation differs.

## 4. Integrity verification

- Every descriptor declares `sha256:<64 hex>` over the exact object bytes and a `byte_count`.
- `verifyArtifactBytes` (`src/manifest/integrity.ts`) verifies fetched bytes against **both**,
  independent of anything the transport (ETag, Content-Length, CDN) claims.
- Hash mismatch and byte-count mismatch are each hard rejections with distinct reason codes.
- Known gap (recorded, not solved here): manifests are not signed; integrity relies on TLS to
  an approved origin plus the declared sha256. See §9.

## 5. Origin and transport policy

Enforced by `src/manifest/origin.ts`:

- Artifacts are identified by an **immutable object key**
  (`<artifact>.<country>.v<version>.json`); a key is never reused for changed content.
- A URL, when present, must be **HTTPS**, on an **approved origin** (currently the R2 public
  origin already used by `/config`), and must resolve to exactly `/<object_key>`.
- **No credentials in URLs. No query strings or fragments at all** (the safe set of query
  parameters for an immutable public object is empty — so all are refused rather than
  scanned). **No authorization tokens anywhere in a manifest** — the strict unknown-field
  rejection leaves no field for one to hide in.
- Expected content type is declared per descriptor and currently limited to
  `application/json`.
- Logs: the existing pipeline already strips query strings and redacts via the shared
  prohibited-key list; manifest code introduces no new logging.

## 6. Rollback and last-known-good (backend semantics)

- Every previously published version remains **immutable and addressable** (R2 keys are never
  rewritten — existing rule, unchanged).
- Active selection is **explicit**: exactly one authorized-and-activated descriptor per
  artifact line.
- `rollback_target` is **version- and hash-bound** and must resolve exactly to a descriptor in
  the same manifest; a dangling or hash-mismatched target invalidates the manifest.
- **Downgrades are refused** unless the currently active descriptor's `rollback_target` names
  the proposed version and hash (`authorizeTransition`). There is no implicit fallback.
- A failed candidate **cannot overwrite** the last-known-good descriptor: descriptors are
  immutable records; recovery is re-activating the rollback target, never editing bytes.
- Rollback does not require changing clinical artifact bytes — it is a selection change only.
- Audit: every publication and activation carries `publication_decision_ref` /
  `activation_decision_ref`; a state change without a decision reference is structurally
  invalid. (Runtime audit _logging_ is future work — see §9.)

## 7. Compatibility and downgrade rules (all tested)

Rejected, each with its own reason code and negative fixture:

unknown manifest major · unknown required feature · unknown/unsupported artifact schema ·
hash mismatch · byte-count mismatch · incompatible or unknown app build · downgrade without a
matching rollback target · missing active artifact silently selecting a candidate · duplicate
artifact id+version · predecessor/rollback cycles (including self-reference) · environment
mismatch · expired descriptor · unapproved/blocked artifact · malformed governance fields of
any kind.

## 8. Responsibilities

| Team               | Owns                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backend**        | The manifest contract, validation/eligibility code, `/config` compatibility, the frozen baseline and its drift check, rollback semantics on the serving side.                    |
| **Knowledge Base** | Producing candidate artifacts and their true metadata (versions, hashes, byte counts, schema versions) and the publication decision trail. See the KB handoff.                   |
| **Mobile**         | Downloading, verifying (hash + byte count), caching, last-known-good retention and never constructing URLs. See the Mobile handoff.                                              |
| **Product**        | Product approvals (`approvals.product`) **scoped to artifact publication**, and publication decisions. Product display decisions are a different scope and never fill this slot. |
| **Clinical**       | Clinical approvals for clinical/question artifacts. **No clinical reviewer is currently assigned** — until one is, no clinical approval can be granted, so nothing ships.        |

## 9. Unresolved decisions and known gaps (recorded, not invented around)

1. **Backend crash/error monitoring** — still open from I1 (PROGRESS.md); unrelated to this
   contract but repeated here because it gates I-phase closure.
2. **No manifest signing / no signed integrity chain** — current architecture cannot provide
   it without new infrastructure; recorded as a gap rather than invented.
3. **No Cache-Control headers** on `/config` or R2 objects — cache duration is undefined at
   the contract level today; a governed manifest should eventually pin explicit caching.
4. **Runtime audit logging** of activation/rollback events — contract fields exist; no runtime
   emits them yet (nothing is active).
5. **Who authorizes environment promotion** (staging → production) — decision reference
   fields exist; the decision _process_ is not defined in any locked document available here.
6. **Clinical reviewer assignment** — open; blocks any clinical approval, by design.
7. **IM-001 / IM-003** — activation remains unauthorized; `IM001-CLIN-FLAG-001` and
   `IM003-SB-001` remain open; Mobile PR #76 remains unauthorized to merge. Modeled as open
   blockers in the fixtures; nothing in this repository can or does change them. IM-001's
   _display_ decisions are complete, and are recorded as scoped traceability only — see §3a.
   **Artifact-publication Product approval for `question_flow` 1.1 has never been granted and
   is `pending`.**
8. **`CLAUDE.md` §1 infrastructure drift** — still documents decommissioned AWS
   infrastructure; correction needs founder + engineering-lead approval (tracked since E9.2).

## 9a. Resolved in I3 Step 2B — artifact identity of "Vocabulary 2.0"

Recorded in §9 of Step 1 as a possible mismatch; **now resolved from evidence, not naming
intuition.** "Vocabulary 2.0" is a human-facing workstream label. The artifact's stable id is
**`token_dictionary`**, unchanged across the version boundary: lineage `token_dictionary` 1.0 →
1.1 → candidate 2.0, where **1.1 is the version `GET /config` serves today**.

Evidence, all from the authoritative knowledge base at merge `2325e3f9`:

- its generator `tools/build_vocabulary_v2.py` declares `ARTIFACT_ID = "token_dictionary"` and
  writes `candidate/token_dictionary.ng.v2.0.json` — the tool named for the vocabulary emits the
  token dictionary;
- **no `"artifact_id": "vocabulary"` exists anywhere** in that repository, and no
  `vocabulary.ng.*` object has ever existed in its history;
- `schema/token_dictionary.v2.schema.json` is titled _"WellaPath Symptom Vocabulary
  (token_dictionary) — schema 2.0"_ and is a strict superset of the published v1.1 shape: the six
  legacy token arrays remain present and required;
- its own `kb_blocked_candidates.manifest.json` calls itself "the real Vocabulary 2.0 and
  Question Flow 1.1 candidates" and then emits `artifact_id: "token_dictionary"` at 2.0;
- content purpose is identical — the same 295 controlled tokens, proven lossless by a projection
  back to v1.1 that must reproduce it byte for byte;
- the intended Mobile consumer is unchanged (`red_flag_evaluator.dart` reads
  `symptom_tokens` and `red_flag_tokens`, both byte-identical to v1.1);
- the rename was **declined deliberately and in writing** (`docs/I2_W2_VOCABULARY_FOUNDATION.md`
  §3, `docs/VOCABULARY_VERSION_NEGOTIATION.md`): renaming would break `/config`, the Mobile
  consumer and a backend regression test for a cosmetic gain. The KB handoff explicitly
  recommends the backend adopt `token_dictionary`.

**Action taken:** the blocked-candidate fixture now uses `token_dictionary` /
`token_dictionary.ng.v2.0.json` and records its real predecessor (1.1, sha256
`0cc47ad9…c019` — the digest `/config` serves). Its synthetic seed digest was recomputed for the
corrected identity. `/config` artifact ids, versions, hashes, URLs and every active descriptor
are **untouched**, and `token_dictionary` 2.0 remains an unpublished, inactive, unapproved
candidate, ineligible in every environment — including when it shares a manifest with the live
1.1, which is now regression-tested.

## 10. What would come next (NOT authorized by this step)

Wiring a manifest endpoint, publishing any candidate, uploading anything to R2, or consuming
this contract from Mobile each require their own decision and their own PR. The two handoff
documents describe the future work precisely so that no team needs to guess — **neither team
is instructed to implement anything yet.**
