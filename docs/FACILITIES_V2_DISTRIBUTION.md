# Facilities 2.0 Distribution — Optional Contract, Gates, Activation and Rollback

> **Status: INACTIVE PREPARATION. Nothing is approved, published, uploaded or activated.**
> The Facilities 2.0 candidate remains `candidate_unapproved` with `may_publish: false`, blocked
> on licence, attribution, coverage and sizing (see `PROGRESS.md`, 2026-08-31). This document
> describes infrastructure that exists so a future, separately authorized activation has a
> reviewed path to run on. It asserts no approval, and following it does not create one.

## 1. What this is

An **optional, default-off** `facilities_v2` manifest entry on `GET /config`, gated so that it
can only ever describe an explicitly approved, publication-authorized, integrity-pinned 2.x
facilities artifact on the approved artifact origin. It is the backend counterpart to Mobile
PR #79 (`feat(mobile): facilities 2.0 consumer preparation`), whose `FacilitiesV2Gate`
additionally requires its own local evaluation flag and, in production, its own production
approval — activation is only possible when **both** repositories' gates open independently.

With no configuration — today's state everywhere — `/config` is **byte-identical** to the frozen
distribution baseline (`docs/baseline/distribution-baseline.v1.json`); the four E9.1 artifacts,
`facilities` v1.1 included, are untouched. That is CI-enforced by the existing baseline drift
suite plus `tests/integration/facilities-v2-config.test.ts`.

Code: `src/manifest/facilities-v2.ts` (parse + gates), resolved once at startup in `src/app.ts`,
rendered by `src/routes/config.ts`. The gate reuses the manifest subsystem's origin allowlist
(`src/manifest/origin.ts`) and digest convention (`src/manifest/integrity.ts`), so an origin can
never be approved for one surface and not the other.

## 2. The optional manifest entry

When — and only when — every gate in §3 passes, `/config` gains one additive top-level key.
Field names match what Mobile's `FacilitiesV2Manifest.tryParse` reads; extra fields are
informational. Existing clients that read `artifacts` are unaffected either way.

```json
"facilities_v2": {
  "schema_version": "2.0",
  "artifact": {
    "artifact_id": "facilities",
    "version": "2.x",
    "status": "approved",
    "may_publish": true,
    "url": "https://<approved-origin>/facilities.<cc>.v2.x.json",
    "sha256": "sha256:<64 hex>",
    "byte_count": 123,
    "country": "<cc>",
    "publication_decision_ref": "<decision id>",
    "source_version": "<optional upstream provenance version>"
  }
}
```

`status` can only ever render as the literal `approved` and `may_publish` only as `true`,
because any other configured value refuses the whole entry — the response never carries a
partially-valid or "downgraded" manifest.

## 3. Configuration and gates

All variables follow the repository's `SCOPE_NAME` convention (`.env.example` documents them).
**Every default is false or absent**; an unset variable can never open a gate.

| Variable                                 | Default | Gate                                                                                                                                            |
| ---------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACILITIES_V2_DISTRIBUTION_ENABLED`     | `false` | Master switch. Only the literal `true` (case-insensitive) enables anything.                                                                     |
| `FACILITIES_V2_STATUS`                   | absent  | Must be **exactly** `approved`. `candidate_unapproved` and every variant/casing refuse.                                                         |
| `FACILITIES_V2_MAY_PUBLISH`              | absent  | Must be **exactly** `true`. The source's publication authorization; `false` refuses outright.                                                   |
| `FACILITIES_V2_SCHEMA_VERSION`           | absent  | Dotted numeric; major must be in the supported set `[2]`.                                                                                       |
| `FACILITIES_V2_ARTIFACT_VERSION`         | absent  | Dotted numeric 2.x.                                                                                                                             |
| `FACILITIES_V2_SHA256`                   | absent  | `sha256:<64 lowercase hex>` over the exact artifact bytes.                                                                                      |
| `FACILITIES_V2_BYTE_COUNT`               | absent  | Positive decimal integer (safe-integer range).                                                                                                  |
| `FACILITIES_V2_URL`                      | absent  | HTTPS, on `APPROVED_ARTIFACT_ORIGINS`, no credentials/query/fragment, immutable object key at the bucket root, `facilities` artifact line only. |
| `FACILITIES_V2_PUBLICATION_DECISION_REF` | absent  | Required authorization marker — the recorded publication decision. Blank refuses.                                                               |
| `FACILITIES_V2_SOURCE_VERSION`           | absent  | Optional upstream source/provenance version, echoed as `source_version`.                                                                        |
| `FACILITIES_V2_PRODUCTION_APPROVED`      | `false` | **Additional** gate required when `NODE_ENV=production`. Staging approval never implies it.                                                     |

Failure semantics, all test-enforced:

- Gates are evaluated **once at startup**, all of them, unconditionally — the current candidate's
  governance state fails independently on `FACILITIES_V2_STATUS` **and**
  `FACILITIES_V2_MAY_PUBLISH`, and a seeded randomized sweep asserts no variable combination can
  expose an unapproved manifest.
- An enabled-but-invalid declaration is **refused, never repaired or downgraded**: `/config`
  keeps serving exactly the frozen v1.1 response, and the refusal is logged as reason codes and
  variable names only. Configured values (URLs, digests, anything mistakenly pasted into a
  variable) never reach the logs.
- A refused or absent v2 declaration cannot affect v1.1 availability — the route renders the
  v1.1 artifact set from the same unchanged literals in every case.

## 4. What is deliberately NOT here

- No new endpoint, no request input of any kind. `/config` remains a static `GET`; it reads no
  body, query, params or headers. No location, search text, facility selection or health data
  can reach this backend through this feature — there is nowhere for it to land.
- No server-side facility search, no download or proxying of the dataset through the API — the
  backend serves metadata; artifact bytes go client ↔ CDN as for every other artifact.
- No telemetry change of any kind; no new events, no enablement.
- No caching or signing change: the backend still sets no cache headers on `/config`
  (CDN/client behaviour unchanged), and manifests remain unsigned — the recorded signing gap
  (`docs/INGESTION_AND_REGISTRY.md` §12.5) is untouched and still blocks real publication.

## 5. Future controlled activation sequence (staging) — NOT authorized, NOT executed

Recorded so the eventual activation follows a reviewed path. Every step is owned by someone and
gated; none has happened. This sequence must not begin until the preconditions in
`docs/INGESTION_AND_REGISTRY.md` §§11–13 and the blockers in `PROGRESS.md` (licence,
attribution, coverage, mobile sizing) are cleared in writing.

1. **Source authorization** — Data/Knowledge Base obtains the dataset licence or written reuse
   permission and records attribution. This flips the KB-side `may_publish` truthfully; nothing
   on the backend precedes it.
2. **FAC decisions** — Product, Clinical and Engineering approve the outstanding FAC decisions
   (including FAC-D002 emergency-fallback wording and the missing-states/coverage question),
   each with a recorded decision reference and correct `decision_scope`.
3. **Candidate status** — the candidate moves `candidate_unapproved → approved` through the
   approved publication workflow in the knowledge base, with the governance evidence the
   ingestion contract requires.
4. **Upload** — artifact and manifest are uploaded to the approved R2 location under a new
   immutable object key (`facilities.<cc>.v2.x.json`). No existing object is overwritten.
   Independent hash re-computation against R2, per `docs/ARTIFACT_RELEASE_PROCESS.md`.
5. **Staging metadata** — backend staging configuration receives the approved values
   (`FACILITIES_V2_STATUS=approved`, `FACILITIES_V2_MAY_PUBLISH=true`, version, schema, URL,
   sha256, byte count, decision ref). Engineering-lead approval required — this changes a frozen
   surface, so the distribution baseline freeze is re-versioned in the same change.
6. **Staging gate** — `FACILITIES_V2_DISTRIBUTION_ENABLED=true` on staging only. Verify
   `/config`: v1.1 unchanged, `facilities_v2` present and exact.
7. **Mobile evaluation** — Mobile enables `FACILITIES_V2_EVALUATION` for an authorized internal
   build only (Mobile PR #79's gate). No external distribution.
8. **Verification** — hash validation, full download, parsing, offline fallback and rollback are
   exercised end-to-end on staging, with results recorded.
9. **Production** — remains blocked: `FACILITIES_V2_PRODUCTION_APPROVED` stays unset until a
   separate, explicit production approval exists. Staging success grants nothing.

## 6. Rollback

Rollback is **configuration-only**: set `FACILITIES_V2_DISTRIBUTION_ENABLED=false` (or clear
it) and restart. `/config` immediately returns to the exact v1.1 baseline; Mobile's loader
resolves `fallbackToV1` on the absent manifest, and its v2 cache is namespaced away from v1.1,
so **no mobile rebuild, release or data migration is required**. v1.1 metadata is never
modified by any v2 state, so there is nothing to restore.

Rollback checklist (execute top to bottom, record evidence for each line):

| Step                                                                     | Required evidence                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 1. Set `FACILITIES_V2_DISTRIBUTION_ENABLED=false` in the environment     | Who, when (UTC), environment, change reference              |
| 2. Restart / redeploy the service                                        | Deploy ID and completion time                               |
| 3. Verify `/config` has no `facilities_v2` key                           | Response body capture + canonical sha256                    |
| 4. Verify `/config` matches the frozen baseline byte-for-byte            | Hash comparison against `distribution-baseline` record      |
| 5. Verify `facilities` v1.1 hash/URL unchanged                           | The v1.1 `sha256:25684c71…982398` line from the response    |
| 6. Verify mobile fallback on an internal build (locator serves v1.1)     | Test run reference                                          |
| 7. Record the reason for rollback and notify engineering lead            | Decision-log entry reference                                |
| 8. Leave all other `FACILITIES_V2_*` values in place for the post-mortem | Config snapshot reference (values redacted where sensitive) |

The R2 objects are immutable and are **not** deleted on rollback.

## 7. Dependencies that remain open (owned elsewhere)

Licence / written reuse permission for the source dataset · dataset attribution · the three
missing states (Adamawa, Kebbi, Sokoto) vs. the "nationwide" claim · mobile download/cache/memory
sizing against the low-end Android budget (~18× v1.1) · FAC decisions incl. FAC-D002 ·
phone/opening-hours public-use authorization · KB publication workflow run · engineering-lead
approval under the E9.1 freeze · manifest signing (recorded gap) · separate production approval.

**None of these exists today, and nothing in this document or its implementation claims
otherwise.**
