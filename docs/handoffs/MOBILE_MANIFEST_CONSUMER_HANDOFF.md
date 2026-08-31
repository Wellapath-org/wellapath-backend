# Future Handoff — Mobile Manifest Consumer (Download / Cache / Last-Known-Good)

> **Status: FUTURE WORK. Do not implement yet.** This document describes what the Mobile team
> will eventually build against the manifest contract, so nothing has to be guessed when that
> task is authorized. It instructs no one to start; it changes no Mobile behaviour, and
> **Mobile PR #76 remains unauthorized to merge** — nothing here bears on it.

## What does NOT change until further notice

The mobile app keeps consuming `GET /config` exactly as today: four artifacts, fields
`version`, `url`, `hash` (`release_date`, `country` informational). That response is frozen
(`docs/baseline/distribution-baseline.v1.json`) and drift-checked in backend CI. The manifest
contract is additive; when it eventually ships it will be a **new** surface, and `/config`
compatibility for existing clients is a backend obligation.

## What the consumer must eventually implement

Contract: `docs/contracts/manifest.v1.schema.json` · semantics:
`docs/ARTIFACT_MANIFEST_CONTRACT.md`.

1. **Strict parsing, fail closed.** Reject a manifest with an unknown major version, an
   unknown `required_features` entry, unknown fields, or malformed governance data. On
   rejection: keep the last-known-good set — never partially apply.
2. **Never treat existence as eligibility.** Use only descriptors the backend marks
   distributable; never download or activate a candidate because it appears in a manifest.
   The five states (`present` / `published` / `approved` / `active` /
   `eligible_for_environment`) are distinct; only _active and eligible_ is consumable.
3. **Integrity before use.** Verify sha256 **and** byte count of downloaded bytes against the
   descriptor, independent of transport headers. A mismatch discards the download and keeps
   the current artifact.
4. **Origin discipline.** Download only from URLs/keys given by the backend, HTTPS, approved
   origin, no constructed URLs (existing rule, unchanged).
5. **Last-known-good.** Persist the last verified artifact set per artifact line; a failed
   candidate must never evict it. Downgrade only when the backend presents an explicit
   version/hash-bound rollback target.
6. **Compatibility.** Respect `min_app_build`: a build below the minimum ignores the
   descriptor (and reports, if telemetry for this is ever approved — that is a separate
   telemetry-contract change, not authorized here).
7. **Offline behaviour** stays as today: cached artifacts keep working with no network.

## Explicitly out of scope for Mobile

- Any activation decision — activation is a backend/governance act.
- Any change to scoring, red-flag behaviour, question flow or vocabulary handling. Vocabulary
  2.0 and Question Flow 1.1 remain unpublished, inactive and ineligible.
- Any new telemetry fields (the telemetry contract is unchanged).

**Trigger to start:** an explicit authorization naming this handoff, after the backend ships a
manifest surface. Until then, this file is documentation only.
