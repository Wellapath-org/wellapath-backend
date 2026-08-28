# Artifact Manifest Contract v1.0.0 — I3 Step 1

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
  approval is always required unless a role is explicitly `required: false`;
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

| Team               | Owns                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backend**        | The manifest contract, validation/eligibility code, `/config` compatibility, the frozen baseline and its drift check, rollback semantics on the serving side.             |
| **Knowledge Base** | Producing candidate artifacts and their true metadata (versions, hashes, byte counts, schema versions) and the publication decision trail. See the KB handoff.            |
| **Mobile**         | Downloading, verifying (hash + byte count), caching, last-known-good retention and never constructing URLs. See the Mobile handoff.                                       |
| **Product**        | Product approvals (`approvals.product`), publication decisions.                                                                                                           |
| **Clinical**       | Clinical approvals for clinical/question artifacts. **No clinical reviewer is currently assigned** — until one is, no clinical approval can be granted, so nothing ships. |

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
   blockers in the fixtures; nothing in this repository can or does change them.
8. **`CLAUDE.md` §1 infrastructure drift** — still documents decommissioned AWS
   infrastructure; correction needs founder + engineering-lead approval (tracked since E9.2).

## 10. What would come next (NOT authorized by this step)

Wiring a manifest endpoint, publishing any candidate, uploading anything to R2, or consuming
this contract from Mobile each require their own decision and their own PR. The two handoff
documents describe the future work precisely so that no team needs to guess — **neither team
is instructed to implement anything yet.**
