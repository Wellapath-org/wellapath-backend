# Ingestion and Registry Foundation — I3 Step 3

> **Amended by I3 Step 3C (2026-08-29).** Review hardening: the envelope version became a closed
> set (§2a) after a future minor and the superseded 1.0.0 draft were both found to be accepted; the
> Git object-id constraint is now recorded as a compatibility decision (§2b); and audit events are
> bounded and reject environment-secret assignments (§9).
>
> **Amended by I3 Step 3B (2026-08-29).** Re-pinned to knowledge base `1f1b8dd0`, which corrected
> the two provenance hazards §1 recorded. The envelope now requires the actor, the ingestion
> authorization and the governance-register digest, and provenance is tracked through three states
> that are never synonyms (§3a). Envelope contract `1.0.0` → `1.1.0`.

> **Status: INACTIVE.** No route accepts an envelope. No module outside `src/manifest/**` imports
> any of this. Nothing here writes to a database, to R2, to the filesystem or to the network, and
> `GET /config` is byte-for-byte unchanged at
> `3b2bbb1cec6b25631bcf499902314c22c19cbab33fe7fcfae0c6288a4f8578ed`.
>
> This step models what governed ingestion would have to prove before anything could be published.
> It publishes nothing, activates nothing and authorizes nothing.

| Item                     | Value                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| Ingestion envelope       | `1.0.0` — `docs/contracts/ingestion-envelope.v1.schema.json`          |
| Audit event              | `1.0.0` — `docs/contracts/audit-event.v1.schema.json`                 |
| Manifest contract in use | `1.1.0` (unchanged by this step)                                      |
| Source of truth          | `src/manifest/ingestion/`, `src/manifest/registry/`                   |
| Producer pinned at       | `wellapath-knowledge-base` `1f1b8dd0bf9cadf8b210aba16bfa516603444130` |

---

## 1. The integration boundary

`src/manifest/ingestion/pins.ts` freezes, by digest over committed bytes, every upstream input the
Backend would consume: the producer's contract pin record and its vendored copy of our schema, the
publication-plan and receipt schemas, both dry-run plans, the compatibility fixtures, the
reconciliation records (v1 and v2), and the governance register.

Pinning runs **both ways.** The producer records digests of three of our files; those are recorded
here as `reciprocal` and verified from our side. Either party changing agreed bytes now shows up as
a mismatch instead of surfacing later as a mysterious disagreement.

**The two hazards recorded at Step 3 are closed.** Both plans now agree with themselves —
`contract_validation.contract_version` reads `1.1.0`, and the descriptors' `references[]` name
contract `1.1.0` at `bbaeadd6` rather than the superseded pair. The stale
`knowledge-base develop at generation` line is gone entirely: the producer removed the branch
citation rather than replacing it with a newer commit, on the grounds that a newer one would go
stale the same way. `source_provenance.repository_branch_state.cited` is `false` and this
implementation refuses a plan block that says otherwise.

**The re-pin advanced as a whole.** Both plan digests, the plan schema, the producer's blocked-
candidate manifest and both negative-fixture corpora moved together; a partial advance — one plan
re-pinned and the other left stale — is a tested refusal, not something that would pass quietly.

## 2. The ingestion envelope

An envelope names an artifact and proves things about it. It carries **no bytes, no URL and no
credential** — the object is identified by immutable identity and verified by digest, so an
envelope cannot leak a secret or be replayed against a live endpoint.

Required: envelope version · manifest contract version · pinned schema digest and byte count ·
provenance (repository, full commit id, plan id and digest, generator and version) · the artifact
descriptor · identity (`artifact_id` + `artifact_version` + `sha256`, all three) · byte count ·
content type · immutable object key · environment · requested operation · publication / activation
/ rollback decision references · attestation · created-at · idempotency key · predecessor ·
rollback identity · a `synthetic` flag.

## 2a. Envelope version is a closed set

`SUPPORTED_ENVELOPE_VERSIONS` lists the versions this implementation understands; membership is
the test, not a major-version comparison. Both directions matter, and the Step 3C review found both
failing open:

- a **future minor** may rely on semantics this code does not implement, so accepting it because
  the major matches is the fail-open pattern the rest of this subsystem exists to avoid;
- a **superseded minor** was written under weaker rules — 1.0.0 required no actor and no ingestion
  authorization — so honouring its declared version would hand old input the guarantees of the
  current contract without it ever having met them.

This mirrors the producer's own pin record, which lists `supported_contract_versions` rather than
a range.

## 2b. Git object-id policy — a compatibility constraint, not an assumption

`source_commit` must be **40 lowercase hex characters**, because both repositories in this system
use SHA-1 object ids today (`SOURCE_COMMIT_OBJECT_FORMAT = 'sha1'`). Git's SHA-256 object format
produces 64-hex ids; those are **refused** rather than accepted at a length this implementation has
not been reconciled against. **This constraint must be revisited on both sides, together, before
either repository migrates object format.** It is recorded here so it is not mistaken for a
universal statement about Git.

Repository identity is compared exactly. A URL form, an ssh form, a `.git` suffix, a trailing
slash or a case variant is refused as ambiguous rather than normalised — normalisation is where two
different identities quietly become one.

## 2c. What the envelope must supply, and why

The producer's plan states the division of labour explicitly. The plan supplies artifact-byte
identity, hash-bound decision-record provenance and contract provenance. The **envelope** must
supply the three things a plan cannot honestly assert about itself: the source repository and
commit the bytes were taken from, the actor performing the ingestion, and the authorization the
ingestion occurs under.

None of those may be inferred from an artifact hash, a descriptor, a branch name or an object key.
A branch name, tag or symbolic ref (`develop`, `main`, `HEAD`, `latest`, …) is refused outright as
`PROVENANCE_SOURCE_MUTABLE_REFERENCE`: a branch names whatever it points at today, which is the one
property a provenance record must not have.

## 3. Pipeline stages

`received → envelope_validated → contract_validated → provenance_verified → governance_verified →
integrity_verified → staged → published → active`, plus terminal `rejected`.

**No stage implies the next.** The pipeline stops at the first stage that produces a reason, and
every refusal names the stage that produced it plus a stable reason code. Specifically:

- `received` is not `staged` — an envelope arriving proves nothing about it;
- `staged` is not `published` — staging is Backend bookkeeping, not a release;
- `published` is not `active` — publication makes an artifact available, not chosen;
- storage presence is not publication — an object existing in R2 is not a governance event;
- approval is not activation — approvals gate publication; activation is its own decision;
- a merged upstream commit is not publication authorization — merging is not deciding;
- a valid descriptor is not eligible — structure is not governance.

Reaching `integrity_verified` yields `admissible: true`, which means only that every check up to
that point held. It is not staging, publication or activation; those are registry operations with
their own preconditions.

## 3a. Claimed, integrity-bound, verified

Three states, never synonyms:

| State             | Established by                                                            | Establishes                                                                      |
| ----------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `claimed`         | the fields being populated                                                | that the envelope is well formed. Anyone can populate fields.                    |
| `integrity_bound` | the declared digests matching the ones we hold                            | that **the bytes are the bytes** — nothing about approval, producer or authority |
| `verified`        | the producer's identity and authority being cryptographically established | requires trusted-producer infrastructure that **does not exist**                 |

`stage` requires `integrity_bound`. `publish`, `activate` and `rollback` each require `verified`, so
each **fails closed** with `PROVENANCE_NOT_VERIFIED` for production-like input. The synthetic
test-only mode may traverse the transition so the rest of the pipeline can be exercised, and every
evaluation it produces is marked `operative: false` — exercising a transition is not verification.

**No envelope claims trusted source authorization merely because its repository and commit fields
are populated.** That is asserted directly: an envelope whose every provenance field matches the pin
still reports `producer_authority_established: false`.

## 3b. Hash agreement is never governance

The single substitution this subsystem exists to prevent, in the producer's own words: _"a matching
sha256 proves the bytes are the bytes. It proves nothing about who approved them or where they came
from. An ingester that treats hash agreement as governance evidence has skipped the governance check
entirely."_

| A matching digest of…   | establishes            | grants  |
| ----------------------- | ---------------------- | ------- |
| the artifact            | byte identity          | nothing |
| the publication plan    | plan identity          | nothing |
| the governance register | register-byte identity | nothing |

None grants Product approval, Clinical approval, publication authorization or activation
authorization; none proves actor authority; none makes an artifact eligible. **Only a correctly
scoped approval record contributes to `approved`** — a decision scoped `product_display` in an
artifact-publication slot is `APPROVAL_SCOPE_MISMATCH`, exactly as under manifest contract 1.1.0.

## 3c. The plan's provenance block is informational

The producer's `source_provenance` is carried, checked and never obeyed. It is validated for
structure and for known kinds (an unknown kind is refused, not ignored, because a kind this
implementation does not understand may be making a claim it does not know how to disbelieve), its
governance-register digest must agree with the envelope's and with the pin, and a disagreement is a
`PROVENANCE_CONTRADICTION` refused rather than resolved in favour of either side.

It can never supply what the envelope must supply, never self-certify its producer or its
authorization, and its narrative is never copied into an approval slot.

## 4. Registry invariants

Pure and in-memory. Every operation is a function from a state to a new state; nothing mutates.

- **immutable identity** — the triple `artifact_id` + `artifact_version` + `sha256`. A known
  version reappearing with a different digest is `IDENTITY_COLLISION`; an object key rebound to
  different content is `OBJECT_KEY_MUTABLE`;
- **monotonic revision** — increases by exactly one on an accepted mutation, and never otherwise;
- **at most one active** descriptor per artifact line per environment, by construction;
- **append-only audit**, with each event binding the revision it moved the registry from and to;
- **rejected records carry no envelope payload** — a refusal is recorded, the offending document
  is not;
- **a failed operation returns the prior state object itself.** Not an equal copy — the same
  reference. `expect(result.state).toBe(before)` is the assertion, so "unchanged" is checked
  rather than trusted. The audit event describing a failure is returned to the caller; recording
  it into the registry is a separate, deliberate act.

## 5. Compare-and-swap

Activation requires, simultaneously: the expected current revision · the expected current active
identity · the exact candidate identity and digest · an explicit target environment · publication
authorization · activation authorization · every required approval · no open blocker · compatibility
and integrity success · signing-policy success · an idempotency key.

Refused: stale revision (`REVISION_STALE`) · unexpected current active
(`ACTIVE_IDENTITY_UNEXPECTED`, which is also how a candidate-replacement race loses) · replay with a
changed payload (`REPLAY_PAYLOAD_MISMATCH`) · activating what is only staged
(`ACTIVATION_BEFORE_PUBLICATION`) · re-activating the already-active descriptor
(`DUPLICATE_ACTIVE_SELECTION`) · environment mismatch · missing or ambiguous active state.

## 6. Idempotency and replay

An idempotency key is bound to the canonical digest of what the request asked for. Same key, same
digest → an idempotent no-op that leaves the revision untouched. Same key, different digest →
`REPLAY_PAYLOAD_MISMATCH`; the system never guesses which request was meant.

**The idempotency check runs before the revision check**, deliberately. A client retrying a request
whose response was lost sends the identical request, including the same expected revision — and
that request has already been applied. Checking the revision first would answer `REVISION_STALE`
to a correct retry.

## 7. Last-known-good and rollback

Last-known-good advances **only** on a successful activation, and only to the descriptor that was
genuinely serving before. Rollback is a separate compare-and-swap, never a fallback path of
activation, and requires explicit rollback authorization plus a target bound by version _and_
digest that is already known and immutable. Rolling back does not promote the descriptor being
rolled away from — that is precisely what was found wanting.

**Both real candidates' rollbacks are refused.** `token_dictionary` 2.0 → 1.1 crosses content
schema 2.0 → 1.0, and `question_flow` 1.1 → 1.0 crosses 1.1 → 1.0. No cross-schema rollback policy
has been approved by either repository, so the refusal stands and **no rollback target is
invented**: `ROLLBACK_SCHEMA_INCOMPATIBLE` together with `ROLLBACK_POLICY_UNRESOLVED`. The producer
records the same refusal under its own code `KB_ROLLBACK_SCHEMA_INCOMPATIBLE`; the namespaces are
disjoint by design and a producer code is never written into a descriptor.

## 8. The signing blocker

There is **no signing algorithm, no trusted key source, no custody model, no rotation process and
no verification policy** approved for this system, and none is invented here. The consequence is
that production-like ingestion **fails closed** with `SIGNATURE_POLICY_UNAVAILABLE`, whatever the
producer claims about having signed — a claim is recorded and never trusted.

The `synthetic_test_only` trust mode exists so the pipeline can be exercised end to end. It is a
function argument, never ambient state; it is never read from an environment variable; it is
refused in staging and production; it requires the envelope to declare `synthetic: true`; and the
result it produces is marked `operative: false` and `verified: false`. A test asserts that no
application file references it.

This is a recorded gap, not a defect to work around. It closes when an algorithm, a key source, a
custody model, a rotation process and a verification policy are each separately decided.

## 9. Audit events

Bounded as well as redacted. `AUDIT_FIELD_MAX_LENGTH` (512) and `AUDIT_REASON_CODES_MAX` (64) cap
what a single event may carry, because an audit record is a fixed-shape statement about a
transition, not a place to park a document — and without a bound, a megabyte of arbitrary content
in a reference field passes the redaction scan simply by not looking like a credential. The scan
also rejects an environment-variable assignment carrying a secret-shaped name, which the
forbidden-field-name check catches only when it appears as a key.

Eight types: `envelope_received`, `rejection`, `staging`, `publication`, `activation`, `rollback`,
`idempotent_replay`, `conflict`. Each binds event version and id · prior and resulting revision ·
authority reference · environment · artifact identity and digest · decision references · operation ·
outcome and reason codes · timestamp · correlation key.

Event ids are derived from event content, so the same inputs always produce the same trail. The
builder **refuses to emit** an event containing a credentialed URL, a signed URL, a bearer token,
key material, an AWS key id, a JWT, or any field named like a secret or a payload. Synthetic
examples for every type are in `tests/fixtures/ingestion/audit-events.examples.json`, generated by
the real builder so they cannot drift from it.

## 10. What the real candidates do

Both are refused **before staging**, and each disqualifying condition is proven independently by
lifting every earlier gate:

| Condition                                     | Code                           |
| --------------------------------------------- | ------------------------------ |
| Product artifact-publication approval pending | `APPROVAL_NOT_GRANTED`         |
| Clinical approval pending                     | `APPROVAL_NOT_GRANTED`         |
| Publication not performed                     | `PUBLICATION_NOT_PERFORMED`    |
| Publication authorization absent              | `PUBLICATION_NOT_AUTHORIZED`   |
| Activation authorization absent               | `ACTIVATION_NOT_AUTHORIZED`    |
| Open blocker (`question_flow` only)           | `BLOCKER_UNRESOLVED`           |
| Signature policy unavailable                  | `SIGNATURE_POLICY_UNAVAILABLE` |
| Cross-schema rollback                         | `ROLLBACK_SCHEMA_INCOMPATIBLE` |

`question_flow` 1.1 retains both open blockers (`IM001-CLIN-FLAG-001`, `IM003-SB-001`) and IM-003
remains disabled. No fixture was altered to manufacture eligibility.

## 11. Future persistence responsibilities

Not built, and deliberately so. Whoever wires this to storage must provide: durable append-only
audit retention with a defined retention period; a persisted registry whose revision is monotonic
_across processes_, not merely within one; a compare-and-swap that is atomic at the storage layer
(a transaction or a conditional write — the in-memory model's atomicity does not survive being
split across two statements); idempotency-key retention at least as long as any client will retry;
and a migration path that cannot lose last-known-good. None of that is designed here.

## 12. Future operator authorization requirements

Before any of this may run against a real artifact, all of the following must exist:

1. an explicit publication authorization bound to the exact artifact, version and digest;
2. a separate explicit activation authorization;
3. an assigned Clinical reviewer and a recorded Clinical approval — **none is assigned today**;
4. adjudication of both open blockers;
5. an approved signing algorithm, key source, custody model, rotation process and verification
   policy;
6. an approved cross-schema rollback policy, or a schema-compatible exact rollback target;
7. an upload path that does not exist yet, isolated from this code, requiring explicit environment
   and authorization inputs and holding no usable credentials in tests.

## 13. Exact conditions required before runtime wiring

Runtime wiring is a separate, authorized step. It must not begin until items 1–7 above are
satisfied **and** an engineering-lead decision records: which route (if any) accepts an envelope
and how it is authenticated; how operator authority is established and recorded; what happens to
`/config` when a manifest becomes active, and how that transition is rolled back; the persistence
design in §11; and the retention and access policy for the audit trail.

Nothing in this step asks the knowledge base or Mobile to implement anything.
