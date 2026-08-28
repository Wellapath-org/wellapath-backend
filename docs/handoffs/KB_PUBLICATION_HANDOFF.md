# Future Handoff — Knowledge Base Publication Tooling

> **Status: FUTURE WORK. Do not implement yet.** This document describes what the Knowledge
> Base team will eventually build against the manifest contract, so that when that task is
> authorized nothing has to be guessed. It instructs no one to start; it changes nothing in
> the `wellapath-knowledge-base` repository.

## Context

- Backend manifest contract v1.0.0: `docs/contracts/manifest.v1.schema.json`
  (source of truth `src/manifest/contract.ts`; semantics in
  `docs/ARTIFACT_MANIFEST_CONTRACT.md`).
- Authoritative KB `develop` at time of writing: `c1b07944ea0b231914943ac17b2265441e53b85c`.
- Current blocked candidates (modeled as fixtures only, never distributable as-is):
  **Vocabulary 2.0** and **Question Flow 1.1** — both `published: false`, `active: false`,
  `eligible_for_environment: false`. Question Flow additionally carries open blockers
  `IM001-CLIN-FLAG-001` and `IM003-SB-001`, clinical approval not granted, IM-003 disabled,
  activation unauthorized.

## What the publication tooling must eventually produce

For each candidate artifact, a descriptor that satisfies the v1 contract with **true** values:

1. **Identity**: stable `artifact_id`, new `artifact_version` (never reuse a version or object
   key for changed content — the existing immutability rule applies unchanged).
2. **Integrity**: `sha256` and `byte_count` computed from the exact object bytes that will be
   uploaded; the backend re-verifies both independently and rejects mismatches.
3. **Origin**: object key matching `<artifact>.<country>.v<version>.json`; upload only to the
   approved origin. No query strings, no credentials, HTTPS only.
4. **Governance**: real `publication_decision_ref`; real approval records (`product`, and
   `clinical` wherever the artifact is clinical/question material) with decision references;
   every known blocker listed with its true status. Absent or vague governance data means the
   backend will refuse eligibility — that is by design, not a bug to work around.
5. **Lineage**: `predecessor` and, when rollback should be possible, a `rollback_target`
   naming the exact prior version **and** hash. The referenced version must remain addressable.

## What the tooling must never do

- Publish, upload or activate anything without the recorded approvals — the contract makes
  such a descriptor permanently ineligible, it does not make the action safe.
- Mutate an existing object or descriptor. Corrections are new versions.
- Embed tokens, signed URLs or credentials anywhere in a manifest.

## Open items this handoff inherits (not for KB to solve alone)

- No Clinical reviewer is assigned; until one is, clinical approvals cannot be granted.
- IM-001 activation authorization, IM-003 enablement and both open blockers are governance
  decisions outside any repository.
- Manifest signing does not exist yet; if required, it is new infrastructure and needs its own
  decision.

**Trigger to start:** an explicit engineering-lead + founder authorization for I3 Step 2 (or
later) that names this handoff. Until then, this file is documentation only.
