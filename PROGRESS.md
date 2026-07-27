# WellaPath Backend — Build Progress Log

> **Claude Code: Read this file at the start of every session alongside CLAUDE.md.**
> This log tells you exactly what has been built, what was fixed, and where we left off.
> Never repeat completed steps. Pick up from the CURRENT STATUS section.

---

## Current Status

**Phase:** E8 — Validation & Calibration (in progress)
**Sprint:** E8.2 calibration in progress; facilities v1.1, rules v2.2, and knowledge_base v2.4 **MERGED AND VERIFIED ON STAGING**
**Stage:** `token_dictionary` at v1.1; `knowledge_base` at v2.4; `rules` at v2.2; `facilities` at v1.1 — all four artifacts on `develop` and verified live on staging.

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
- Husky hooks fixed — `.husky/pre-commit` and `.husky/commit-msg` were tracked in git as non-executable (`100644`); restored via `git update-index --chmod=+x` (plain `chmod` doesn't register because this repo has `core.filemode=false`)
- `node_modules` permission issue resolved — local `node_modules` had a macOS quarantine flag (transferred via WhatsApp rather than installed), blocking script execution; fixed with `rm -rf node_modules && npm ci`

**Next immediate action:** No artifact work outstanding — all four artifacts current and verified on staging. Docs PR #21 (this progress log) is open and needs review/merge so the log lands on `develop` rather than being stranded on a branch. Otherwise awaiting the next artifact release or E8 calibration task from the engineering lead.

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

| PR  | Title                                                                                            | Branch                                           | Status    |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ | --------- |
| #2  | `feat(e1): initialize fastify typescript backend with core endpoints`                            | `feature/e1-backend-init` → `develop`            | Merged ✅ |
| #3  | Dockerfile fix: copy node_modules from builder, remove npm ci from production                    | `fix/dockerfile-remove-prod-npm-ci` → `develop`  | Merged ✅ |
| #4  | `feat(db): add postgresql connection pool, migration script, db health check`                    | `feature/e1-database-foundation` → `develop`     | Merged ✅ |
| #5  | `feat(security): add security baseline — cors, rate limit, error handler`                        | `feature/e1-security-baseline` → `develop`       | Merged ✅ |
| #6  | `feat(artifacts): add placeholder versioned artifacts for e1 skeleton`                           | `feature/e1-artifact-skeleton` → `develop`       | Merged ✅ |
| #15 | `feat(config): add facilities artifact to /config response — e5 complete`                        | `feature/e5-facilities-config` → `develop`       | Merged ✅ |
| #16 | `feat(config): update kb and rules to v2.0 artifacts — e7 complete`                              | `feature/e7-kb-rules-v2` → `develop`             | Merged ✅ |
| #17 | `feat(config): update kb and rules to v2.1 after medical review fixes`                           | `feature/e7-medical-review-fixes` → `develop`    | Merged ✅ |
| #18 | `feat(config): update knowledge_base to v2.2 after red flag mirror fix`                          | `feature/kb-v2.2-update` → `develop`             | Merged ✅ |
| #19 | `feat(config): update knowledge_base to v2.3 — malaria case04 clinical policy fix`               | `feat/kb-v2.3-malaria-explanation` → `develop`   | Merged ✅ |
| #20 | `feat(config): update facilities to v1.1 — 45 lagos facility phone numbers added`                | `feat/facilities-v1.1-lagos-phones` → `develop`  | Merged ✅ |
| #22 | `fix(config): update rules to v2.2 — remove dead rule rf_147`                                    | `fix/rules-v2.2-remove-dead-rule` → `develop`    | Merged ✅ |
| #23 | `feat(config): update knowledge_base to v2.4 — headache token reachability fix e8.2 calibration` | `feat/kb-v2.4-headache-reachability` → `develop` | Merged ✅ |

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

**Current status:** All four artifacts current and verified on staging. One docs PR (#21, this progress log) open and awaiting review.

**Next backend action:** Awaiting the next artifact release or E8 calibration task from the engineering lead.

---

## Session Notes

- Windows 11 machine, VS Code + Claude Code + Git Bash
- Always use Git Bash for git commands — never PowerShell or CMD
- `curl` in PowerShell works for testing endpoints but uses `Invoke-WebRequest` format
- dotenv v17 active — shows injection tip on startup, this is normal not an error

---

_Last updated: 2026-07-27 — three artifact updates shipped: `facilities` v1.1 (45 Lagos facility phone numbers, PR #20), `rules` v2.2 (dead rule `rf_147` removed, 76 → 75, PR #22), and `knowledge_base` v2.4 (E8.2 calibration, `headache` token added at weight 6, PR #23). Every hash independently recomputed against R2 before wiring, every prior version confirmed untouched on R2, full content diffs run on the rules and KB updates, all merged → `develop`, deployed, and verified on staging. All four artifacts (`token_dictionary` v1.1, `knowledge_base` v2.4, `rules` v2.2, `facilities` v1.1) up to date and verified on staging. Docs PR #21 (this log) open and awaiting review._
