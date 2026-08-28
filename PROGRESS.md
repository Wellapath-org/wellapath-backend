# WellaPath Backend — Build Progress Log

> **Claude Code: Read this file at the start of every session alongside CLAUDE.md.**
> This log tells you exactly what has been built, what was fixed, and where we left off.
> Never repeat completed steps. Pick up from the CURRENT STATUS section.

---

## Current Status

**Phase:** I3 — Governed Artifact Delivery · **Step 1 COMPLETE (2026-08-28):** distribution baseline frozen, inactive manifest contract v1.0.0 merged (PR #32 → `develop` `fc40ac3`). I1 phase closure still sits with mobile PR #69 (not re-checked since 2026-08-14).
**Sprint:** I3 Step 1 delivered, reviewed against pinned head, and merged. **Runtime manifest delivery, KB publication tooling, Mobile consumption, candidate publication and activation are all NOT started — each gated on its own authorization.**
**Stage:** Artifacts **frozen for beta** (E9.1) — `token_dictionary` v1.1, `knowledge_base` v2.4, `rules` v2.2, `facilities` v1.1, all re-verified live (hashes and byte counts recomputed from R2 on 2026-08-28). No artifact changes past this point without engineering lead approval.

> ### ✅ I3 Step 1 — baseline freeze + inactive manifest contract (2026-08-28)
>
> **PR #32 merged → `develop`** as merge commit `fc40ac3` (parents `1c0fd16` + head `ed83cda`),
> after independent verification from clean worktrees at both the pinned head and the post-merge
> tip: CI green on both, 387/387 tests, format/lint/tsc/telemetry-contract-sync all clean.
> Everything is **additive and inactive** — zero diff on `src/routes`, `src/app.ts`,
> `src/server.ts`, `src/config`, `.env.example`, `Dockerfile`, `.github`, `package.json`.
>
> | Deliverable          | Where                                                                                          |
> | -------------------- | ---------------------------------------------------------------------------------------------- |
> | Baseline freeze      | `docs/baseline/distribution-baseline.v1.json` + `docs/DISTRIBUTION_BASELINE.md`                |
> | CI drift check       | `tests/baseline/baseline-drift.test.ts` — fails on any `/config` field or hash drift           |
> | Manifest contract v1 | `src/manifest/` (source of truth `contract.ts`), `docs/contracts/manifest.v1.schema.json`      |
> | Contract docs        | `docs/ARTIFACT_MANIFEST_CONTRACT.md` (state machine, eligibility, rollback, audit, gaps)       |
> | Blocked candidates   | `tests/fixtures/manifest/blocked-candidates.manifest.json` — **fixtures only, synthetic**      |
> | Future handoffs      | `docs/handoffs/KB_PUBLICATION_HANDOFF.md`, `docs/handoffs/MOBILE_MANIFEST_CONSUMER_HANDOFF.md` |
>
> Key semantics, all test-enforced (86 new tests, incl. 34 negative fixtures each failing at its
> declared stage with its declared reason code): five distinct states
> (`present`/`published`/`approved`/`active`/`eligible_for_environment`), **fail-closed**
> governance (absent/null/unknown/malformed = not eligible), candidates never selected
> implicitly, duplicate actives select nothing, downgrades only via version+hash-bound rollback
> targets, approved-origin/HTTPS/no-credentials/no-query transport policy, integrity verified
> independently of transport.
>
> **Blocked candidates modeled, not enabled:** Vocabulary 2.0 and Question Flow 1.1 exist only
> as fixtures with provably synthetic hashes bound to authoritative KB commit
> `c1b07944ea0b231914943ac17b2265441e53b85c`; both `published: false`, `active: false`,
> ineligible in every environment. Question Flow carries IM-001 product decisions complete,
> clinical approval NOT granted, `IM001-CLIN-FLAG-001` open, `IM003-SB-001` open (IM-003
> disabled), activation unauthorized. Mobile PR #76 remains unauthorized to merge. No clinical
> reviewer is assigned.
>
> **Proof of non-change:** live staging `/config` body sha256 identical before and after merge
> (`183a15bd…45d3b`); canonical response hash `3b2bbb1c…8578ed` recomputed from a booted app;
> all four artifact hashes/byte counts recomputed from R2 — exact matches; no R2 write (read-only
> GET/HEAD only), no deploy-config, env-var, secret, dependency or auth change.
>
> #### ⚠️ Staging database — third pause observed 2026-08-28
>
> `GET /health` returned **degraded / `checks.database: "error"`** on 2026-08-28 (observed
> during baseline work and still degraded after the merge) — the predicted third Supabase
> free-tier idle pause, now that mobile staging traffic has quietened. `/config` and `/version`
> unaffected throughout, as designed. **Not restored under these tasks** (restoration is a
> manual engineering-lead action). This supersedes the 2026-08-14 note below that said no third
> pause had occurred. The standing remedy is unchanged: upgrade off the free tier or add a
> keep-alive ping before beta.

> ### Status check — 2026-08-14
>
> **Backend: nothing outstanding, nothing changed.** `origin/develop` is unchanged since PR #30
> merged on 2026-08-11 (`1c0fd16`). No backend commits, no open backend PRs except the stale
> #28 below. Staging re-verified today — see the live check below.
>
> **The picture has moved on the mobile side, not here.** Everything in this box below the
> backend line is 📩 **read from the `wellapath-mobile` PR record**, not independently verified
> from this repository. It is recorded because it changes what "I1" means, and because two of
> the items previously tracked here as open are now answered elsewhere.
>
> #### 🔍 Backend — verified live today (2026-08-14)
>
> | Check                                            | Result                             |
> | ------------------------------------------------ | ---------------------------------- |
> | `GET /health`                                    | **200**, `checks.database: "ok"`   |
> | `POST /v1/telemetry/events` (single valid event) | **202**, `accepted: 1`             |
> | `telemetry_enabled` / `telemetry_sink`           | **`true`** / **`log`** — unchanged |
> | Contract version                                 | **1.0** — unchanged                |
> | Production telemetry                             | **Still disabled**                 |
>
> **Operational metrics counters read all zero** before that probe, despite mobile having run
> live staging tests. That is expected, not a fault: the counters are in-memory and per-instance,
> and on the Render Free plan an idle service spins down, so they reset far more often than a
> deploy would suggest. **Treat `/internal/metrics` as a live signal only — it is not a record of
> cumulative traffic.** The 7-day log window remains the only durable record
> (`docs/TELEMETRY_OPERATIONS.md` §3).
>
> #### 📩 Mobile — relayed from `wellapath-mobile`
>
> | PR       | State                         | What it did                                                                                                                                                                                               |
> | -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | #61      | **Merged 2026-08-11**         | Mobile telemetry v1.0 against backend commit `5e13379`. Contract artifacts vendored and verified byte-identical; **no contract mismatch found**, nothing requested from backend beyond staging enablement |
> | #62, #63 | Merged                        | `--dart-define` enablement; `os_version` omitted                                                                                                                                                          |
> | #64      | **Merged 2026-08-13**         | **Low-end Android emulator gate PASSES** (cold −4.2 %, warm +7.9 % mean / −15.4 % median; memory deltas both directions)                                                                                  |
> | #65      | Merged                        | Privacy-safe **Sentry** crash monitoring — **Flutter/Dart only**                                                                                                                                          |
> | #66–#68  | Merged                        | Protected internal-beta CI validation workflow and Sentry receipt runner                                                                                                                                  |
> | #69      | **OPEN** (created 2026-08-14) | I1 closure record. Asserts the **I1 technical engineering gate PASSED**                                                                                                                                   |
>
> #### What this changes for items previously tracked here as open
>
> - **Mobile integration gate — closed.** PR #61 merged 2026-08-11 at 12:41 UTC, ~25 minutes
>   _before_ backend PR #30 merged. The line in the block below saying #61 "is running its final
>   live integration tests" was already stale when written.
> - **Low-end Android gate — emulator PASS** (#64). **Physical low-end handset validation is
>   carried forward before external beta** — not closed.
> - **Crash monitoring — resolved for mobile, still absent for backend.** See the open question
>   below.
>
> #### ⚠️ Still not authorized, per mobile #69
>
> - **External beta: NOT AUTHORIZED.**
> - **Sentry-enabled distribution beyond the authorized internal engineering group: BLOCKED**
>   pending **DPA formal electronic acceptance**. Sentry Terms v3.0 are accepted; the DPA is not.
>   A BAA is unavailable on the Team plan and is **not relied upon**, because PHI is prohibited
>   from Sentry in the first place. Sentry error-event retention is **30 days**, EU region.
> - **I1 is not closed until #69 merges.** #69 is a documentation PR and is still open — do not
>   record the phase as complete on the strength of its title.
>
> #### 🔴 Open question for the engineering lead — backend crash monitoring
>
> Mobile #69 asserts the I1 technical gate passed, and #65 delivered crash monitoring that is
> explicitly **Flutter/Dart only**. **This backend still has no crash or error-reporting
> integration of any kind.** That item was recorded here as an I1-scope gate on 2026-08-11 and
> has not been answered for the backend — it appears to have been satisfied mobile-side and not
> revisited for this service. Either it was deliberately descoped for the backend, in which case
> that decision should be recorded, or it is a genuine gap in the I1 closure. **Backend cannot
> resolve this unilaterally; it needs a decision.**

> ### ✅ I1 / W1 backend staging-enablement gate — PASSED (2026-08-11)
>
> Telemetry contract **v1.0** is live on staging and verified. Recorded in full in
> `docs/TELEMETRY_OPERATIONS.md` §9.
>
> | Field                     | Value                                                              |
> | ------------------------- | ------------------------------------------------------------------ |
> | Deployed backend commit   | **`5e13379`** (`5e13379f19c53ec90cee7958dc029d908c342dcd`, PR #29) |
> | Service                   | `wellapath-backend-staging`                                        |
> | `TELEMETRY_ENABLED`       | **`true`** (staging only)                                          |
> | `TELEMETRY_SINK`          | **`log`** — no vendor, no database                                 |
> | Functional checks         | **25 / 25 passed, 0 failed**                                       |
> | Privacy-log marker search | **PASSED — zero results**                                          |
> | Staging log retention     | **7 days** (Render Free plan)                                      |
> | Production telemetry      | **Remains disabled.** Not touched                                  |
>
> **Privacy verification passed.** A distinctive marker submitted inside a rejected payload
> returned **zero results** across the staging log stream, while accepted `telemetry_event` sink
> entries were present and free of any marker or payload text — confirmed by the engineering
> lead in Render. The pipeline records what it should and does not record what it must not.
>
> Valid three-event batch → `202 accepted: 3`. Prohibited field → rejected per contract.
> Rate limiting → `429`. `/health` `200` with `database: ok`. `/config` frozen artifacts
> unchanged. Core routes stayed `200` throughout.
>
> **Rollback is unchanged: `TELEMETRY_ENABLED=false` plus restart.**
>
> ### Mobile PR #61 — unblocked, and since **merged**
>
> _Written 2026-08-11, superseded by the 2026-08-14 status check above._ At the time this
> recorded PR #61 as "running its final live integration tests"; it had in fact already merged
> that same day at 12:41 UTC. **No contract change was required or requested.**
>
> **I1 remained open** at the time of writing. The backend gate is one gate, not the phase. Then
> outstanding, with current status:
>
> - the **Mobile integration gate** — ✅ closed, PR #61 merged 2026-08-11;
> - the **low-end Android gate** — ✅ emulator PASS, PR #64; physical handset validation carried
>   forward before external beta;
> - a **crash-monitoring provider or approved alternative** — ⚠️ delivered mobile-side (Sentry,
>   Flutter/Dart only, PR #65); **still absent for this backend** — see the open question above;
> - the operational and security backlog in `docs/TELEMETRY_OPERATIONS.md` §7 — 🔴 **still open**,
>   notably protecting or disabling the unauthenticated `/internal/metrics` before external beta,
>   and analytics consent before external beta.
>
> **Do not record I1 as complete until mobile PR #69 merges** and the backend crash-monitoring
> question is answered.

> ### ✅ I1 / W1 Step 1 delivered (2026-08-11): telemetry contract v1.0
>
> The backend-owned privacy-safe product telemetry contract is **finalized and implemented** on
> `feat/i1-telemetry-contract`. `POST /v1/telemetry/events` (allowlist-only, 12 approved events,
> **disabled by default**) plus `GET /internal/metrics`. Contract artifacts for Mobile Engineering
> are generated from a single source of truth (`src/telemetry/contract.ts`) and CI-enforced
> against drift: `docs/contracts/telemetry.v1.{schema,openapi,allowlist}.json` and `.client.ts`,
> documented in `docs/TELEMETRY_CONTRACT.md` and `docs/TELEMETRY_OPERATIONS.md`.
>
> **Mobile instrumentation is unblocked.** 301 tests pass across unit, integration,
> privacy/adversarial, regression and performance suites. **No clinical logic, artifact schema,
> artifact version, offline behaviour or Top-50 behaviour changed** — the E9.1 frozen artifact set
> is asserted literally by the regression suite. No database table was added; no third-party
> analytics provider was introduced.
>
> Excluded and listed as unresolved rather than invented: `urgency_category` (clinical output, no
> approval on record), `question_id` (an adaptive question sequence would let the backend
> partially reconstruct an assessment path), and free-text feedback (prohibited from this
> endpoint entirely). See `docs/TELEMETRY_CONTRACT.md` §8.
>
> **Three defects found and fixed while building it, two pre-existing on `develop`:**
>
> 1. **Rate limiting returned 500, not 429.** `@fastify/rate-limit` _throws_ whatever
>    `errorResponseBuilder` returns; ours returned a plain object with no top-level `statusCode`,
>    so the global error handler took its 500 branch. Every rate-limited request answered
>    `500 An internal server error occurred`. Both this log and `SECURITY_CHECKLIST.md` recorded
>    the 429 envelope as working — it never was. Now returns a real `Error` carrying `statusCode`,
>    with a regression test.
> 2. **Fastify's own request log line carried the full URL including query string** — a leak
>    channel for anything appended to a URL. A custom Pino request serializer now logs the path
>    only, and drops `remoteAddress` (an IP is a personal identifier).
> 3. The `src/utils/logger.ts` vs server redaction drift flagged in `SECURITY_CHECKLIST.md` is
>    **closed** — both now build from one shared list.
>
> Note: `jest` was declared in `package.json` but had never been installed, and the repo had no
> tests. Test tooling (`jest`, `ts-jest`, `@types/jest`) was added and CI now runs `npm test`.

> ### Staging database — status 2026-08-14
>
> `GET /health` returned **200** with `checks.database: "ok"` on 2026-08-11 and again on
> **2026-08-14**, so the 2026-08-03 pause remains cleared and no third pause has occurred.
>
> **The pre-production item stands regardless:** two pauses, two manual restores. Upgrade off the
> Supabase free tier or add a keep-alive ping before beta. Note that recent days have seen steady
> mobile staging traffic, which itself keeps the project from idling — **that is incidental
> protection, not a fix.** Once mobile testing quietens, the idle clock starts again.
>
> #### 🧹 PR #28 is stale and now conflicting — recommend closing it
>
> PR #28 (`docs/progress-2026-08-03`) has been open since 2026-08-03 and is now
> **`CONFLICTING` / `DIRTY`**. It touches only `PROGRESS.md`, which has moved substantially
> since. Its content is also **wrong now**: it describes the 08-03 database pause as ongoing,
> and it predates the whole I1/W1 workstream.
>
> **Recommendation: close it without merging.** Everything it was written to record is already
> captured here — the 08-03 pause, its clearance, and the standing pre-production item.
> Resolving the conflict would mean reconstructing a stale snapshot for no benefit. Backend has
> not closed it because closing someone else's PR is the engineering lead's call.

> **Doc gap notice:** This log was not kept current through E2–E4 — the doc-update commits for those phases (e.g. e2.5 real artifact wiring, the Supabase/R2 infra migration, the DB SSL fix) were made on feature branches after their PRs had already merged, so they never landed on `develop`. Sections below dated E1 reflect the last point this file was accurately in sync with `develop`. Treat `git log origin/develop` as the source of truth for E2–E4 history until this file is backfilled.

**Completed:**

- PR #2 merged → `develop` (E1.1 backend init + E1.2 core endpoints)
- PR #3 merged → `develop` (Dockerfile fix: copy node_modules from builder, remove npm ci from production stage)
- PR #4 merged → `develop` (E1.3 database foundation)
- PR #5 merged → `develop` (E1.4 security baseline)
- PR #6 merged → `develop` (E1.5 artifact distribution skeleton)
- PR #11 merged → `develop` (E2.5 — `/config` updated to return real artifact versions)
- PR #12–#14 merged → `develop` (DB SSL fix, infra migration from AWS to Supabase/R2)
- PR #15 merged → `develop` — E5: facilities artifact added to `/config` response
- PR #16 merged → `develop` — E7: `knowledge_base` and `rules` updated to v2.0 artifacts in `/config` (later found to be an artifact-overwrite error — see PR #17)
- PR #17 merged → `develop` — E7 medical review fixes: `token_dictionary` bumped to v1.1, `knowledge_base` and `rules` corrected to v2.1 with new filenames and hashes
- **Artifact immutability enforced** — PR #16's v2.0 hashes were flagged as reusing an existing version string/filename for changed content, violating the non-negotiable "never overwrite an existing artifact version" rule; engineering lead confirmed it was an error and the correct v2.1 release (new filenames `kb.ng.v2.1.json` / `rules.ng.v2.1.json`) is what shipped in PR #17 — this same immutability check applies to every subsequent artifact update
- PR #18 merged → `develop` — `knowledge_base` updated to v2.2 (red flag mirror fix), new filename `kb.ng.v2.2.json` and hash, released cleanly as a new version (no overwrite)
- **Out-of-scope request correctly declined** — a Case 04 policy instruction (founder decision: Option B, children_under_5 + rainy_season → URGENT not EMERGENCY) arrived addressed to "Mobile Engineer + Data Engineer" asking this backend session to edit `urgency_determiner.dart` (Flutter mobile engine) and regenerate KB source content — neither exists in this repo (Fastify/TypeScript only, no `.dart` files, no KB-generation pipeline). Flagged and held rather than fabricating Dart code or a KB hash; engineering lead confirmed the message was misdirected and that this backend's role was unchanged (wire `/config` once the real data engineer delivers the hash)
- **PR #19 merged → `develop`** — `knowledge_base` updated to v2.3 reflecting the malaria `explanation_template` Case 04 policy fix; before wiring it in, independently fetched `kb.ng.v2.3.json` from R2 and recomputed its SHA256 — confirmed exact match with the hash provided (`cb0e43fc...4e9f8`) before writing it to `config.ts`
- Staging verified: all 4 artifacts returning correct versions and hashes from `/config`, `knowledge_base` v2.3 confirmed
- **PR #20 merged → `develop`** — `facilities` update to v1.1, new filename `facilities.ng.v1.1.json`, new hash, adds 45 Lagos facility phone numbers; before committing, independently fetched the file from R2 and recomputed its SHA256 — confirmed exact match — and confirmed `facilities.ng.v1.0.json` still returns 200 on R2 (untouched, no overwrite). Hash re-verified against R2 a second time immediately before merge. Staging verified post-deploy: `facilities` v1.1 live with matching hash
- **PR #22 merged → `develop`** — `rules` updated to v2.2, new filename `rules.ng.v2.2.json`, new hash, removes dead rule `rf_147` (76 → 75 rules); hash independently verified against R2 before committing, `rules.ng.v2.1.json` confirmed still 200 and unchanged. Full content diff run: exactly one rule removed, all 75 survivors byte-identical, metadata counts internally consistent (13 global + 62 condition-specific = 75). Red-flag safety independently checked — see the rules v2.2 section below. Staging verified post-deploy
- **PR #23 merged → `develop`** — `knowledge_base` updated to v2.4 (E8.2 calibration: literal `headache` token added to `headache` condition at weight 6, Issue #8 Option A); hash independently verified against R2, all prior KB versions (v2.3/v2.2/v2.1) confirmed still 200 and unchanged. Content diff: exactly one condition changed, one symptom token added, other 49 conditions byte-identical. Every KB symptom token validated against live `token_dictionary` v1.1 — zero missing. Staging verified post-deploy
- **PR #24 merged → `develop`** — E9.2 backend documentation: `docs/DEPLOYMENT.md`, `docs/ARTIFACT_RELEASE_PROCESS.md`, `docs/DECISION_LOG.md`, `docs/SECURITY_CHECKLIST.md`, plus a README refresh (its `/config` example was stale — showed v1.0 artifacts and omitted `facilities`)
- **Decision log relocated to `wellapath-docs`** — the engineering lead determined that `DECISION_LOG.md` covers cross-repo decisions (mobile, knowledge-base, backend) and should not sit in one service repo. Created `decision-log.md` in `wellapath-docs` on `feat/e9-decision-log` with the data engineer's SAM/MAM clinical rationale added (**wellapath-docs PR #1**), and removed `docs/DECISION_LOG.md` from this repo with README references repointed. **Note:** the instruction assumed PR #24 was still open — it had already merged on 2026-07-27 at the lead's direction, so the removal was a follow-up PR against `develop` rather than an edit to #24. Lead approved both PRs; **wellapath-docs PR #1 merged → `main`**, then **PR #26 merged → `develop`** (docs first, so the decisions were never absent from both repos at once). Lead confirmed: all eight decisions kept, `main` base is correct for a docs repo, `decision-log.md` kebab-case retained
- **Supabase free-tier pause logged as a pre-production item** — the staging DB outage on 2026-07-29 was the free tier pausing after 7 days of inactivity, not a code defect. Recorded in `docs/DEPLOYMENT.md` §4 and `docs/SECURITY_CHECKLIST.md` with the diagnosis trail (the pooler's `tenant not found` error misdirects toward "deleted project"), the indirect production risk (a sustained `/health` 503 can get the service marked unhealthy and take `/config` down with it), and the two remedies: upgrade off the free tier, or add a weekly keep-alive ping
- **PR #25 merged → `develop`** — CI fix: removed `|| true` from the `tsc --noEmit` step in `.github/workflows/ci.yml`. Type errors previously could not fail CI, so a green "Lint & Build Check" did not prove the project type-checked. Verified `tsc --noEmit --skipLibCheck` exits 0 on `develop` before removing the suppression, and the PR's own green CI run exercised the enforced check
- Husky hooks fixed — `.husky/pre-commit` and `.husky/commit-msg` were tracked in git as non-executable (`100644`); restored via `git update-index --chmod=+x` (plain `chmod` doesn't register because this repo has `core.filemode=false`)
- `node_modules` permission issue resolved — local `node_modules` had a macOS quarantine flag (transferred via WhatsApp rather than installed), blocking script execution; fixed with `rm -rf node_modules && npm ci`

**Next immediate action (2026-08-28):** **None outstanding for backend.** I3 Step 1 is merged (PR #32). Next I3 steps (runtime manifest delivery, KB publication tooling, Mobile consumer) each require explicit authorization — see `docs/handoffs/`. The staging database pause needs the engineering lead's manual restore.

Backend is **not blocking I1 closure**. Waiting on others: mobile PR #69 to merge (phase closure — status not re-checked since 2026-08-14), a decision on **backend crash monitoring** (see the open question in the 2026-08-14 status check above), and the pre-external-beta items in `docs/TELEMETRY_OPERATIONS.md` §7 — chiefly protecting or disabling the unauthenticated `/internal/metrics`, and analytics consent.

**Open, owned by others (backend cannot action):** approval to update `CLAUDE.md` §1 away from decommissioned AWS infrastructure (founder + engineering lead); confirmation that the `headache` / `head_pain` double-count is deliberate (E8.2 calibration owner). Both are now tracked in `decision-log.md` in `wellapath-docs`. The SAM/MAM rationale gap is **closed** — supplied by the data engineer and relocated with the log.

**Pre-production items (before real beta users / production):**

- **Supabase free-tier pause** — upgrade off the free tier, or add a weekly keep-alive ping. Free tier pauses after 7 days idle; this caused a real staging outage on 2026-07-29
- **Certificate pinning** — deferred to production, accepted for internal beta
- **DB TLS `rejectUnauthorized: false`** — encrypted but chain unverified; tighten before production
- **CORS production allowlist** — still references the superseded `api-staging.wellapath.org`

> **Decision log relocated.** `docs/DECISION_LOG.md` no longer lives in this repo. Cross-repo engineering decisions are in `wellapath-docs` → `decision-log.md`.

---

## Branches

| Branch                               | Status             | PR        |
| ------------------------------------ | ------------------ | --------- |
| `feature/e1-backend-init`            | Merged → `develop` | PR #2 ✅  |
| `fix/dockerfile-remove-prod-npm-ci`  | Merged → `develop` | PR #3 ✅  |
| `feature/e1-database-foundation`     | Merged → `develop` | PR #4 ✅  |
| `feature/e1-security-baseline`       | Merged → `develop` | PR #5 ✅  |
| `feature/e1-artifact-skeleton`       | Merged → `develop` | PR #6 ✅  |
| `feature/e5-facilities-config`       | Merged → `develop` | PR #15 ✅ |
| `feature/e7-kb-rules-v2`             | Merged → `develop` | PR #16 ✅ |
| `feature/e7-medical-review-fixes`    | Merged → `develop` | PR #17 ✅ |
| `feature/kb-v2.2-update`             | Merged → `develop` | PR #18 ✅ |
| `feat/kb-v2.3-malaria-explanation`   | Merged → `develop` | PR #19 ✅ |
| `feat/facilities-v1.1-lagos-phones`  | Merged → `develop` | PR #20 ✅ |
| `fix/rules-v2.2-remove-dead-rule`    | Merged → `develop` | PR #22 ✅ |
| `feat/kb-v2.4-headache-reachability` | Merged → `develop` | PR #23 ✅ |
| `docs/e9.2-beta-readiness`           | Merged → `develop` | PR #24 ✅ |
| `ci/enforce-typescript-check`        | Merged → `develop` | PR #25 ✅ |

| Branch                                     | Status                | PR                                               |
| ------------------------------------------ | --------------------- | ------------------------------------------------ |
| `docs/move-decision-log-to-wellapath-docs` | Merged → `develop`    | PR #26 ✅                                        |
| `docs/pre-production-items`                | Merged → `develop`    | PR #27 ✅                                        |
| `docs/progress-2026-08-03`                 | **Open, CONFLICTING** | PR #28 🧹 recommend closing                      |
| `feat/i1-telemetry-contract`               | Merged → `develop`    | PR #29 ✅                                        |
| `docs/i1-telemetry-operations-closure`     | Merged → `develop`    | PR #30 ✅                                        |
| `feat/e9-decision-log` (`wellapath-docs`)  | Merged → `main`       | wellapath-docs PR #1 ✅                          |
| `docs/progress-2026-08-14`                 | Open                  | PR #31 (carried into the 2026-08-28 progress PR) |
| `feat/i3-manifest-contract-foundation`     | Merged → `develop`    | PR #32 ✅ `fc40ac3`                              |

---

## What Is Built and Verified ✅

### E1.1 — Backend Project Initialization

- [x] `npm init -y` — package.json created
- [x] TypeScript installed (`typescript`, `@types/node`, `ts-node`, `nodemon`)
- [x] `tsconfig.json` created with strict mode, commonjs, rootDir `./src`, outDir `./dist`
- [x] Fastify and baseline packages installed:
  - `fastify`, `@fastify/cors`, `@fastify/rate-limit`, `pino`, `pino-pretty`, `dotenv`, `pg`
- [x] Dev tooling installed:
  - `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`
  - `prettier`, `eslint-config-prettier`
  - `husky`, `@commitlint/cli`, `@commitlint/config-conventional`, `lint-staged`
- [x] `eslint.config.js` — ESLint v9 flat config using `module.exports` (NOT export default)
- [x] `.prettierrc` — singleQuote, semi, printWidth 100, tabWidth 2, trailingComma all
- [x] npm scripts added: `dev`, `build`, `start`, `lint`, `lint:fix`, `format`, `format:check`, `test`
- [x] Husky initialized
- [x] Commitlint configured
- [x] Folder structure created: `src/routes/`, `src/controllers/`, `src/services/`, `src/plugins/`, `src/config/`, `src/utils/`
- [x] `.env.example` created with all required variables
- [x] `.gitignore` created — includes `node_modules/`, `dist/`, `.env`, `*.log`
- [x] `src/utils/logger.ts` — Pino structured logger, redacts auth headers, pino-pretty in dev
- [x] `src/config/env.ts` — centralized env config with `requireEnv()` validation
- [x] `src/server.ts` — Fastify entry point, `host: '0.0.0.0'`, port 3000, CORS + rate limit registered
- [x] `Dockerfile` — multi-stage build, node:20-alpine, exposes port 3000, copies node_modules from builder (PR #3)

### E1.2 — Core Endpoints

- [x] `src/routes/health.ts` — GET /health (updated in E1.3 to include DB check)
- [x] `src/routes/version.ts` — GET /version
- [x] `src/routes/config.ts` — GET /config
- [x] `src/routes/index.ts` — registers all three routes

### E1.3 — Database Foundation

- [x] `src/plugins/db.ts` — pg Pool plugin, registered on Fastify instance as `server.db`, graceful shutdown via `onClose` hook
- [x] `src/db/migrate.ts` — idempotent migration script (`CREATE TABLE IF NOT EXISTS`), single transaction, run with `npm run migrate`
- [x] Tables created and verified locally:
  - `artifact_versions` — tracks versioned artifact releases, `UNIQUE (artifact, version)` enforces no-overwrite rule
  - `metrics_agg` — aggregated anonymized usage metrics, no PHI
  - `audit_logs` — system audit trail, no PHI
- [x] `GET /health` updated — includes DB connectivity check via `SELECT 1`, returns `checks.database: ok|error`
- [x] `npm run migrate` confirmed working against AWS RDS staging DB
- [x] DB credentials in `.env` restored to AWS RDS values after local testing

### E1.4 — Security Baseline

- [x] `src/plugins/error-handler.ts` — global error handler plugin, registered on Fastify instance
- [x] `setErrorHandler` — catches all thrown errors, logs server-side, returns `{ error: { statusCode, message } }` envelope; 5xx messages sanitized to generic string
- [x] `setNotFoundHandler` — returns consistent `{ error: { statusCode: 404, message: 'Route not found' } }` envelope matching global format
- [x] CORS tightened — origin allowlist (`wellapath.org`, `api-staging.wellapath.org`) in production; methods restricted to `GET` only
- [x] Rate limit error response shaped to match error envelope: `{ error: { statusCode: 429, message: '...' } }`
- [x] All error paths (`404`, `429`, `4xx`, `5xx`) return consistent `{ error: { statusCode, message } }` format

### E1.5 — Artifact Distribution Skeleton

- [x] `src/artifacts/kb.ng.v1.0.json` — placeholder knowledge base artifact (`version: 1.0.0, status: placeholder, data: []`)
- [x] `src/artifacts/rules.ng.v1.0.json` — placeholder rules artifact
- [x] `src/artifacts/facilities.ng.v1.0.json` — placeholder facilities artifact
- [x] All three artifacts uploaded to S3 (`wellapath-artifacts-staging`) and verified via CloudFront (`https://d179u2ex0g66o3.cloudfront.net`)
- [x] `GET /config` returns correct CloudFront URLs pointing to verified artifacts

### E5 — Facilities Integration

- [x] `src/routes/config.ts` — added `facilities` entry to `/config` artifacts payload (version `1.0`, R2 URL, sha256 hash, `release_date: 2026-07-06`, `country: ng`), matching the shape of `token_dictionary`, `knowledge_base`, and `rules`
- [x] `/config` verified locally returning all 4 artifacts with correct URLs pointing to the R2 bucket (`pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev`)
- [x] Staging verified: all 4 artifacts returned correctly from `/config`
- [x] PR #15 merged → `develop`

### E7 — Knowledge Base & Rules v2.0 → v2.1 (medical review fixes)

- [x] PR #16 — `src/routes/config.ts` updated `knowledge_base` and `rules` to `version: 2.0`, new R2 URLs (`kb.ng.v2.0.json`, `rules.ng.v2.0.json`), new sha256 hashes; `token_dictionary` and `facilities` left untouched
- [x] **Overwrite violation caught before landing further** — a follow-up request to change the v2.0 hashes again while keeping the same version string and filenames was flagged as violating CLAUDE.md's "never overwrite an existing artifact version" non-negotiable; work paused pending engineering lead confirmation
- [x] Engineering lead confirmed the v2.0 release was an error; new v2.1 artifacts uploaded to R2 with corrected content
- [x] PR #17 — `src/routes/config.ts` updated:
  - `token_dictionary`: `1.0` → `1.1`, new URL (`token_dictionary.ng.v1.1.json`), new hash, `release_date: 2026-04-05`
  - `knowledge_base`: `2.0` → `2.1`, new URL (`kb.ng.v2.1.json`), new hash, `release_date: 2026-07-21`
  - `rules`: `2.0` → `2.1`, new URL (`rules.ng.v2.1.json`), new hash, `release_date: 2026-07-21`
  - `facilities` left untouched throughout
- [x] Staging verified: all 4 artifacts (`token_dictionary`, `knowledge_base`, `rules`, `facilities`) returning correct versions and hashes from `/config`
- [x] PR #17 merged → `develop`

### E7 — Knowledge Base v2.2 (red flag mirror fix)

- [x] `src/routes/config.ts` — `knowledge_base` updated to `version: 2.2`, new URL (`kb.ng.v2.2.json`), new hash, `release_date: 2026-07-22`, following a red flag mirror fix; `token_dictionary`, `rules`, and `facilities` left untouched
- [x] Released as a clean new version (new filename, new hash) — consistent with the immutability rule reinforced by the earlier v2.0 catch
- [x] Staging verified: `knowledge_base` v2.2 confirmed
- [x] PR #18 merged → `develop`

### E7 — Knowledge Base v2.3 (Case 04 clinical policy — Option B)

- [x] Founder policy decision: `children_under_5 + rainy_season` compound modifier → **URGENT**, not EMERGENCY (Priority 4c). This is a mobile-engine (`urgency_determiner.dart`) and KB-source change — out of scope for this backend repo; correctly identified and held rather than fabricated (see Completed list above)
- [x] `malaria.ng.v2.0.json` explanation_template updated externally (data engineering pipeline) to reflect URGENT-appropriate caution language for under-5s in rainy season; KB regenerated to `kb.ng.v2.3.json`
- [x] Before wiring into `/config`: independently downloaded `kb.ng.v2.3.json` from R2 and recomputed SHA256 — verified exact match with the hash supplied by the engineering lead
- [x] `src/routes/config.ts` — `knowledge_base` updated to `version: 2.3`, new URL (`kb.ng.v2.3.json`), verified hash, `release_date: 2026-07-23`; `token_dictionary`, `rules`, `facilities` left untouched
- [x] Staging verified post-deploy: `https://wellapath-backend-staging.onrender.com/config` returns `knowledge_base` v2.3 with matching hash
- [x] PR #19 merged → `develop`

### Facilities v1.1 (45 Lagos facility phone numbers) — COMPLETE

- [x] Verified `facilities.ng.v1.1.json` live on R2 (HTTP 200, 1,695,844 bytes) and independently recomputed its SHA256 — exact match with the hash provided (`25684c71...982398`)
- [x] Confirmed `facilities.ng.v1.0.json` still returns 200 on R2 — untouched, new version released cleanly (no overwrite)
- [x] `src/routes/config.ts` — `facilities` updated to `version: 1.1`, new URL (`facilities.ng.v1.1.json`), verified hash, `release_date: 2026-07-26`; `token_dictionary`, `knowledge_base`, `rules` left untouched
- [x] PR #20 opened → `develop`
- [x] CI green (Lint & Build Check, Docker Build), merge state clean; PR #20 merged → `develop` 2026-07-26
- [x] Staging verified post-deploy: `/config` returns `facilities` v1.1 with matching hash; other three artifacts unchanged at v1.1 / v2.3 / v2.1

### Rules v2.2 (dead rule rf_147 removed) — COMPLETE

- [x] Fetched `rules.ng.v2.2.json` from R2 (HTTP 200, 29,082 bytes) and independently recomputed SHA256 — exact match with the hash provided (`1d27e854...70d1c4`)
- [x] Confirmed `rules.ng.v2.1.json` still returns 200 on R2 with its original hash — untouched, no overwrite
- [x] **Content diff verified v2.1 → v2.2**: `rules[]` 76 → 75, exactly one removed (`rf_147`), none added; all 75 surviving rules byte-identical; `_metadata` counts internally consistent (13 global + 62 condition-specific = 75); no dangling `rf_147` references
- [x] **Red flag safety independently verified** (not taken from the release note, since red flag override is a locked non-negotiable): `rf_147` (token `circulatory_collapse`, `override_urgency: emergency`, `applies_to: [road_traffic_injury_minor]`, priority 11) is fully subsumed by `rf_006` (same token, same `emergency` override, `applies_to: [all]`, priority 1). `rf_006` outranks it and matches every condition, so `rf_147` could never have been the winning rule — removal is behaviourally inert and weakens no red flag path. `circulatory_collapse` still escalates to `emergency` for `road_traffic_injury_minor`
- [x] Note: v2.2 is 5 bytes _larger_ than v2.1 despite removing a rule — benign, the added `_metadata` release note outweighs the deleted rule. Flagged and chased down rather than assumed
- [x] `src/routes/config.ts` — `rules` updated to `version: 2.2`, new URL, verified hash, `release_date: 2026-07-26`; other three artifacts left untouched
- [x] Lint, format:check, and build all clean; CI green (Lint & Build, Docker Build); PR #22 merged → `develop` 2026-07-26
- [x] Staging verified post-deploy: `/config` returns `rules` v2.2 with matching hash

### Knowledge Base v2.4 (E8.2 calibration — headache token reachability) — COMPLETE

- [x] Fetched `kb.ng.v2.4.json` from R2 (HTTP 200, 102,118 bytes) and independently recomputed SHA256 — exact match with the hash provided (`6c00d825...cec2b`)
- [x] Confirmed `kb.ng.v2.3.json` still returns 200 with its original hash, and v2.2 / v2.1 also still 200 — all prior versions untouched, no overwrite
- [x] **Content diff verified v2.3 → v2.4**: `conditions[]` 50 → 50, none added or removed; exactly one condition changed (`headache`), whose `symptoms[]` went 4 → 5 with the sole addition `{token: headache, weight: 6}`; all 49 other conditions byte-identical
- [x] `_metadata`: `version` 2.3→2.4, `release_date` → 2026-07-27, patch note added; `token_dictionary_version` 1.0 → 1.1, aligning the KB's declared dependency with the `token_dictionary` v1.1 that `/config` has served since PR #17 (consistency fix, not a behaviour change)
- [x] **Token validity check** (precedent: `rf_004` was removed for referencing a token absent from the dictionary): `headache` confirmed present in `symptom_tokens` of the live `token_dictionary.ng.v1.1.json`; across all 50 conditions, zero symptom tokens missing from the dictionary. Reachability framing confirmed — `headache` was already referenced in `severity_levels` but absent from `symptoms[]`, so it carried no weight
- [x] **Observation raised to calibration owners (non-blocking)**: the `headache` condition now carries both `head_pain` (weight 6) and `headache` (weight 6). If the on-device tokenizer maps one user report of "headache" to both tokens, the condition scores 12 from clinically one symptom on top of `base_weight: 5`. May be intended under Option A; scoring is on-device and out of scope for this repo, so flagged rather than blocked
- [x] `src/routes/config.ts` — `knowledge_base` updated to `version: 2.4`, new URL, verified hash, `release_date: 2026-07-27`; other three artifacts left untouched
- [x] Lint, format:check, and build all clean; CI green; PR #23 merged → `develop` 2026-07-27
- [x] Staging verified post-deploy: `/config` returns `knowledge_base` v2.4 with matching hash

### E9.2 — Backend Documentation (Internal Beta Readiness) — COMPLETE

Delivered in PR #24. Written from what was verified against the repo and live staging on 2026-07-27; anything relayed by the engineering lead rather than confirmed here is marked as such in the documents.

- [x] **E9.2.1 `docs/DEPLOYMENT.md`** — current stack (Render · Supabase PostgreSQL · Cloudflare R2 storage + CDN), endpoints, env vars, DB schema and pool settings, CI, local setup. Includes the **rollback plan**: backend via revert PR or Render previous-deploy rollback; artifact rollback as a `/config`-only change (no re-upload, no mobile release) with available rollback targets listed and confirmed HTTP 200 on R2
- [x] **E9.2.2 `docs/ARTIFACT_RELEASE_PROCESS.md`** — the versioning checklist as actually practised, split by role, with the backend's independent-verification step; each check tied to the incident that motivated it (PR #16 overwrite catch, `rules` v2.2 size anomaly, `rf_004` dead-token rule). Runnable verification commands, scope boundary, full release history
- [x] **E9.2.3 `docs/DECISION_LOG.md`** — all five requested E7–E8 decisions, each marked 🔍 verified-against-artifact or 📩 relayed-from-lead. `increase_urgency` no-op **scope quantified**: of 30 conditions carrying that modifier, **19 already default to urgent/emergency so the modifier is inert**, 11 can still escalate. Cannot cause under-triage
- [x] **E9.2.4 `docs/SECURITY_CHECKLIST.md`** — backend posture verified directly; E8.3 mobile findings recorded as relayed, not independently verified. Key finding is stronger than "no PHI in logs": the backend has **no PHI intake surface at all** — three `GET` routes, zero reads of `request.body`/`params`/`query`, and the only runtime DB query in the app is `SELECT 1`. Also verified: no PHI columns in schema, header redaction, `no-console` CI-enforced, no secrets in source, `.env` never committed in any branch's history. Certificate pinning documented as deferred to production — accepted
- [x] **README refreshed** — its `/config` example was stale (v1.0 artifacts, `facilities` missing entirely); updated to the frozen beta payload, plus a documentation index and a pointer to the superseded-infrastructure note

**Issues found while writing, documented rather than silently fixed:**

- [x] **CI type check could not fail** — fixed separately in PR #25 (see below)
- [ ] `CLAUDE.md` §1 still documents decommissioned AWS infrastructure (ECS/RDS/S3/CloudFront/Secrets Manager, with account IDs and ARNs). Corrected in `DEPLOYMENT.md` §2 rather than edited in place — `CLAUDE.md` is locked build law and needs **founder + engineering lead approval** to change
- [ ] DB TLS uses `rejectUnauthorized: false` — encrypted but chain unverified. Fine for staging; **production gate** alongside certificate pinning
- [ ] CORS production allowlist still references `api-staging.wellapath.org`, a superseded domain. Not the active branch today; correct before production
- [ ] `.gitignore` byte defect — `.claude/` appended in UTF-16LE with no preceding newline. Git still parses it correctly (`git check-ignore` confirms `coverage/`, `.claude/`, and `.env` all ignored), so no exposure — housekeeping only
- [x] **SAM/MAM clinical rationale — RESOLVED.** Supplied by the data engineer and recorded in `decision-log.md` D1 in `wellapath-docs` (see the relocation entry below). Implementation independently verified against the frozen artifacts

### E9.2 — CI Type Check Enforcement (PR #25)

- [x] `.github/workflows/ci.yml` ran `npx tsc --noEmit --skipLibCheck || true` — the trailing `|| true` swallowed the exit code, so **type errors could not fail CI**. A green "Lint & Build Check" did not prove the project type-checked
- [x] Verified `npx tsc --noEmit --skipLibCheck` exits **0** against `develop` before removing the suppression, so the change would not turn CI red on merge
- [x] `|| true` removed; the PR's own green CI run exercised the now-enforced check
- [x] Merged → `develop` 2026-07-27

### Smoke Test Results (verified locally ✅)

| Endpoint     | Status | Response                                                        |
| ------------ | ------ | --------------------------------------------------------------- |
| GET /health  | 200    | `{"status":"ok","timestamp":"...","checks":{"database":"ok"}}`  |
| GET /version | 200    | `{"version":"0.1.0","environment":"development"}`               |
| GET /config  | 200    | Full artifact payload with CloudFront URLs + placeholder hashes |

Rate limiting headers confirmed active (`x-ratelimit-limit: 100`).
CORS headers confirmed active (`vary: Origin`).

---

## Fixes Applied During This Session

| Issue                                                                      | Fix Applied                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EADDRINUSE: address already in use 0.0.0.0:3000`                          | Killed existing process on port 3000 using `netstat -ano \| grep :3000` then `taskkill //PID <pid> //F` (note: Git Bash requires `//PID` not `/PID`)                                                                                                                                                                  |
| `FST_ERR_LOG_INVALID_LOGGER_CONFIG` on server start                        | Fastify v5 no longer accepts a pino instance via the `logger` option. Replaced `loggerInstance: logger` with an inline pino config object on `Fastify({ logger: { level, transport, redact } })`. Standalone `logger.ts` kept for service-level use.                                                                  |
| `.env.example` had leaked markdown content                                 | File was corrupted with markdown prose and extra vars not in spec. Replaced with exact spec content from CLAUDE.md Section 6 Step 9.                                                                                                                                                                                  |
| `.gitignore` missing entries                                               | Was missing `*.env.local`, `.DS_Store`, and trailing slashes on directory entries. Updated to match CLAUDE.md Section 9 exactly.                                                                                                                                                                                      |
| `eslint.config.js` had wrong rules and file glob                           | Existing file used `files: ['**/*.ts']`, `no-console: 'warn'`, and lacked `explicit-function-return-type`. Replaced with spec-exact config: `files: ['src/**/*.ts']`, `no-console: 'error'`, `explicit-function-return-type: 'error'`.                                                                                |
| `npm run lint` used ESLint v8-style `--ext .ts` flag                       | v9 flat config does not use `--ext`. Updated scripts to `eslint .` and `eslint . --fix`.                                                                                                                                                                                                                              |
| `CLAUDE.md` failed `format:check`                                          | Prettier reformatted whitespace and table alignment. Fixed by running `prettier --write CLAUDE.md`.                                                                                                                                                                                                                   |
| Dockerfile was single-stage                                                | Existing file used a single `FROM node:20-alpine` with no build step and wrong `CMD ["node", "index.js"]`. Replaced with spec multi-stage build.                                                                                                                                                                      |
| `node_modules` scripts failed with `Permission denied` / `bad interpreter` | `node_modules` carried a macOS `com.apple.quarantine` flag tagged `WhatsApp` on ~9,410 files — the folder had been transferred as a file rather than installed via npm. Fixed with `rm -rf node_modules && npm ci`.                                                                                                   |
| Husky hooks silently not running (commitlint/lint-staged bypassed)         | `.husky/pre-commit` and `.husky/commit-msg` were tracked in the git index as `100644` (non-executable), and this repo has `core.filemode=false` so a plain local `chmod +x` never registers as a change. Fixed with `git update-index --chmod=+x .husky/pre-commit .husky/commit-msg`, committed and pushed (PR #15). |
| `EADDRINUSE: address already in use 0.0.0.0:3000` (unrelated process)      | An unrelated long-running `next-server` process from another project was already bound to port 3000. Ran the dev server on `PORT=3001` for local verification instead of killing the other process.                                                                                                                   |

---

## Merged PRs

| PR  | Title                                                                                            | Branch                                                 | Status                          |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------- |
| #2  | `feat(e1): initialize fastify typescript backend with core endpoints`                            | `feature/e1-backend-init` → `develop`                  | Merged ✅                       |
| #3  | Dockerfile fix: copy node_modules from builder, remove npm ci from production                    | `fix/dockerfile-remove-prod-npm-ci` → `develop`        | Merged ✅                       |
| #4  | `feat(db): add postgresql connection pool, migration script, db health check`                    | `feature/e1-database-foundation` → `develop`           | Merged ✅                       |
| #5  | `feat(security): add security baseline — cors, rate limit, error handler`                        | `feature/e1-security-baseline` → `develop`             | Merged ✅                       |
| #6  | `feat(artifacts): add placeholder versioned artifacts for e1 skeleton`                           | `feature/e1-artifact-skeleton` → `develop`             | Merged ✅                       |
| #15 | `feat(config): add facilities artifact to /config response — e5 complete`                        | `feature/e5-facilities-config` → `develop`             | Merged ✅                       |
| #16 | `feat(config): update kb and rules to v2.0 artifacts — e7 complete`                              | `feature/e7-kb-rules-v2` → `develop`                   | Merged ✅                       |
| #17 | `feat(config): update kb and rules to v2.1 after medical review fixes`                           | `feature/e7-medical-review-fixes` → `develop`          | Merged ✅                       |
| #18 | `feat(config): update knowledge_base to v2.2 after red flag mirror fix`                          | `feature/kb-v2.2-update` → `develop`                   | Merged ✅                       |
| #19 | `feat(config): update knowledge_base to v2.3 — malaria case04 clinical policy fix`               | `feat/kb-v2.3-malaria-explanation` → `develop`         | Merged ✅                       |
| #20 | `feat(config): update facilities to v1.1 — 45 lagos facility phone numbers added`                | `feat/facilities-v1.1-lagos-phones` → `develop`        | Merged ✅                       |
| #22 | `fix(config): update rules to v2.2 — remove dead rule rf_147`                                    | `fix/rules-v2.2-remove-dead-rule` → `develop`          | Merged ✅                       |
| #23 | `feat(config): update knowledge_base to v2.4 — headache token reachability fix e8.2 calibration` | `feat/kb-v2.4-headache-reachability` → `develop`       | Merged ✅                       |
| #24 | `docs(e9): add deployment, artifact release, decision log, and security docs`                    | `docs/e9.2-beta-readiness` → `develop`                 | Merged ✅                       |
| #25 | `ci(workflow): enforce typescript check by removing exit code suppression`                       | `ci/enforce-typescript-check` → `develop`              | Merged ✅                       |
| #26 | `docs(structure): move decision log to wellapath-docs repo`                                      | `docs/move-decision-log-to-wellapath-docs` → `develop` | Merged ✅                       |
| #27 | `docs(ops): log supabase free-tier pause as pre-production item`                                 | `docs/pre-production-items` → `develop`                | Merged ✅                       |
| #29 | `feat(telemetry): add privacy-safe product telemetry contract v1.0 — i1/w1 step 1`               | `feat/i1-telemetry-contract` → `develop`               | Merged ✅ 2026-08-11, `5e13379` |
| #30 | `docs(telemetry): record passed i1/w1 staging-enablement gate and 7-day retention`               | `docs/i1-telemetry-operations-closure` → `develop`     | Merged ✅ 2026-08-11, `1c0fd16` |
| #32 | `feat(i3): freeze distribution baseline and add inactive manifest contract foundation`           | `feat/i3-manifest-contract-foundation` → `develop`     | Merged ✅ 2026-08-28, `fc40ac3` |

> **PR #28 is open and CONFLICTING** — see the staging-database section above. Recommend closing
> it unmerged; its content is stale and already superseded here.

> PRs #7–#14 (E2.5 real artifact wiring, DB SSL fix, AWS → Supabase/R2 infra migration) also merged to `develop` but were not logged here — see git history until this table is backfilled.

---

## E1 Exit Criteria

### Code tasks ✅ complete

- [x] `/health`, `/version`, `/config` endpoints implemented and verified
- [x] Database connected, migration script verified against RDS staging
- [x] Security baseline in place (CORS, rate limiting, error envelope)
- [x] Placeholder artifacts in S3, verified via CloudFront

### Deployment tasks — pending founder decision

- [ ] Backend deployed to ECS staging with all three endpoints live
- [ ] HTTPS working on `api-staging.wellapath.org`
- [ ] Mobile app can fetch `/config` from staging
- [ ] Staging environment stable

---

## Key Config Values (Quick Reference)

```
Server port:         3000 (must match ECS security group)
ECS cluster:         wellapath-staging
ECR repo:            812527292522.dkr.ecr.us-east-1.amazonaws.com/wellapath-backend
CloudFront:          https://d179u2ex0g66o3.cloudfront.net
API domain:          https://api-staging.wellapath.org
RDS endpoint:        wellapath-staging-db.cclsme0gujar.us-east-1.rds.amazonaws.com
DB secret ARN:       arn:aws:secretsmanager:us-east-1:812527292522:secret:wellapath/staging/db-dgHN1G
App secret ARN:      arn:aws:secretsmanager:us-east-1:812527292522:secret:wellapath/staging/app-0rFlFx
```

---

## What Comes Next

**E1 — System Spine** ✅ all code tasks complete (PRs #2–#6)
**E2–E4** — real artifact wiring, DB SSL fix, and Supabase/R2 infra migration complete on `develop` (PRs #7–#14; not individually logged here — see doc gap notice above)
**E5 — Facilities Integration** ✅ backend complete (PR #15) — facilities artifact live in `/config`, verified on staging
**E7 — Knowledge Base & Rules** ✅ complete (PR #16, corrected by #17, updated by #18, updated by #19) — `token_dictionary` at v1.1, `rules` at v2.1, `knowledge_base` at v2.3 (Case 04 clinical policy fix) in `/config`, verified on staging
**Facilities v1.1** ✅ complete (PR #20) — 45 Lagos facility phone numbers, hash verified against R2, merged and verified live on staging
**Rules v2.2** ✅ complete (PR #22) — dead rule `rf_147` removed (76 → 75), hash and full content diff verified against R2, red flag safety independently confirmed, merged and verified live on staging

**Knowledge Base v2.4** ✅ complete (PR #23) — E8.2 calibration, `headache` token added at weight 6 for reachability; hash, full content diff, and token-dictionary validity all verified against R2, merged and verified live on staging

**E9.2 — Backend Documentation** ✅ complete (PR #24) — deployment, artifact release process, decision log, and security checklist delivered; README refreshed
**E9.2 — CI type check enforcement** ✅ complete (PR #25) — `|| true` removed so type errors can fail CI

**I1 / W1 — Privacy-Safe Product Analytics** ✅ backend complete (PR #29 contract, PR #30 closure) — telemetry contract v1.0 live on staging, staging-enablement gate passed 25/25, privacy-log gate passed. Phase closure itself sits with mobile PR #69 (still open as of 2026-08-14; not re-checked since).

**I3 — Governed Artifact Delivery** ✅ **Step 1 complete** (PR #32, merged 2026-08-28 as `fc40ac3`) — distribution baseline frozen with a CI drift check, inactive candidate manifest contract v1.0.0 (fail-closed eligibility, five distinct states, version+hash-bound rollback, origin/integrity policy), blocked candidates modeled as synthetic fixtures only, KB and Mobile handoffs written. Live `/config` proven unchanged; nothing uploaded or deployed.

**Current status:** Artifacts frozen for beta and re-verified against R2 (2026-08-28). All assigned E9, I1/W1 and I3 Step 1 backend items complete and merged. Staging database paused again (third occurrence, 2026-08-28) — awaiting manual restore by the engineering lead.

**Next backend action:** None outstanding. Later I3 steps (runtime manifest delivery, KB publication tooling, Mobile consumer) are each gated on explicit authorization — see `docs/handoffs/`. Also standing by for: the next artifact release (engineering lead approval required under the E9.1 freeze), a decision on backend crash monitoring, and the staging database restore.

---

## Session Notes

- Windows 11 machine, VS Code + Claude Code + Git Bash
- Always use Git Bash for git commands — never PowerShell or CMD
- `curl` in PowerShell works for testing endpoints but uses `Invoke-WebRequest` format
- dotenv v17 active — shows injection tip on startup, this is normal not an error

---

\_Last updated: 2026-07-27 — E9 Internal Beta Readiness. Three artifact updates shipped earlier in the day: `facilities` v1.1 (PR #20), `rules` v2.2 (PR #22), `knowledge_base` v2.4 (PR #23) — every hash independently recomputed against R2 before wiring, every prior version confirmed untouched, full content diffs run on the rules and KB updates, all verified live on staging. Artifacts now **frozen for beta** at `token_dictionary` v1.1 · `knowledge_base` v2.4 · `rules` v2.2 · `facilities` v1.1. E9.2 backend documentation delivered and merged (PR #24), CI type-check enforcement fixed (PR #25). All assigned E9 backend items complete; backend is not a blocker on the pre-tag sequence.

2026-07-29 — decision log relocated out of this repo to `wellapath-docs` (`decision-log.md`, PR #1 there) per the engineering lead, with the data engineer's SAM/MAM clinical rationale added and its implementation verified against the frozen artifacts. `docs/DECISION_LOG.md` removed here and references repointed. Remaining open decisions are owned by the founder and the E8.2 calibration owner and are tracked in `wellapath-docs`.

**Staging incident (2026-07-29) — RESOLVED:** `GET /health` returned 503 `database: error`; the Supabase pooler reported `tenant/user ... not found`, which read like a deleted project but was the **free tier pausing after 7 days of inactivity**. Engineering lead restored it manually; `/health` now returns 200 with `database: ok`. `/config` and `/version` were unaffected throughout, so the mobile bootstrap path never broke. **Logged as a pre-production item** — upgrade off the free tier or add a weekly keep-alive ping before real beta users; see `docs/DEPLOYMENT.md` §4 and `docs/SECURITY_CHECKLIST.md`.

2026-08-11 — **I1/W1 telemetry contract v1.0 delivered and staging gate passed.** Backend contract merged (PR #29, `5e13379`), staging enabled (`TELEMETRY_ENABLED=true`, sink `log`), 25/25 functional checks passed, privacy-marker log search returned zero results with sink entries present, closure recorded (PR #30, `1c0fd16`). Three defects fixed en route, two pre-existing: rate limiting answered 500 instead of 429; request logs carried the full URL including query string; logger redaction drift closed. Staging log retention confirmed at **7 days** (Render Free plan).

2026-08-14 — **status check, no backend change.** `develop` unchanged since PR #30. Staging re-verified: `/health` 200 `database: ok`, telemetry accepting (`202`), production telemetry still disabled. Mobile has moved on: PR #61 merged 2026-08-11 (no contract mismatch, nothing requested of backend), low-end Android **emulator gate PASS** (PR #64, physical handset carried forward), Sentry crash monitoring added **Flutter/Dart only** (PR #65), and closure PR #69 opened today asserting the **I1 technical gate PASSED** — but **external beta is NOT AUTHORIZED** and Sentry distribution beyond the internal engineering group is **BLOCKED pending DPA acceptance**. **Open for the engineering lead: this backend still has no crash/error reporting** — an I1-scope item answered mobile-side and not revisited here. PR #28 is stale and conflicting; recommend closing it unmerged.

2026-08-28 — **I3 Step 1 delivered and merged.** Baseline frozen from `origin/develop` tip `1c0fd16` with repository/deployed/inferred/unavailable evidence kept apart and a CI drift check; inactive manifest contract v1.0.0 added (`src/manifest/`, schema drift-checked against the TS source of truth); Vocabulary 2.0 and Question Flow 1.1 modeled as synthetic, permanently ineligible fixtures bound to KB commit `c1b07944`; 86 new tests (387 total). PR #32 reviewed against pinned head `ed83cda` (clean-worktree validation, hash recomputation of the schema, handoffs, canonical `/config` and all four R2 artifacts) and merged as `fc40ac3`; post-merge CI green and staging `/config` byte-identical. **Staging DB paused for the third time** — observed degraded `/health` before and after the merge; left for the engineering lead to restore. Nothing runtime-facing changed; no upload, no deployment, no new env var or dependency.\_
