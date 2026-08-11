# Security Checklist — Internal Beta (E9.2.4)

> **Scope note.** This checklist covers the **backend repository only**. Items marked
> 📩 **Relayed (mobile)** were reported as E8.3 outcomes by the engineering lead and were
> **not verified from this repository** — the Flutter app, its Hive boxes, and its release-build
> logging live in the mobile repo. They are recorded here for completeness of the beta record,
> attributed to their source.
>
> Items marked 🔍 **Verified** were checked directly against this repo's source and the live
> staging service on 2026-07-27.

---

## 1. PHI — No Symptom-Level Data Server-Side

**Non-negotiable:** _"No symptom-level PHI stored server-side under any circumstances."_

### 🔍 Verified — the intake surface is one allowlist-only endpoint

> **⚠️ Updated 2026-08-11 (I1/W1).** This section previously read "the backend has no PHI intake
> surface at all — exactly three routes, all `GET`, no request body parsed anywhere". That is no
> longer true: `POST /v1/telemetry/events` was added for privacy-safe product telemetry. The
> claim has been rewritten rather than left standing, because a security record that overstates
> the posture is worse than one that describes it accurately.

| Check                                        | Result                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Route inventory                              | `GET /health`, `GET /version`, `GET /config`, `GET /internal/metrics`, `POST /v1/telemetry/events` |
| Endpoints reading `request.body`             | **One** — the telemetry endpoint, allowlist-validated (below)                                      |
| Endpoints reading `request.params` / `query` | **None**                                                                                           |
| Runtime database writes                      | **None** — the only runtime query in the whole app is still `SELECT 1` (health check)              |
| CORS methods allowed                         | `GET`, `POST`, `OPTIONS` (`POST` required for telemetry intake; no other method permitted)         |

**Why the telemetry endpoint does not weaken the PHI position.** It is not a general write
surface — it is a closed allowlist:

| Control                            | State                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted events                    | 12, fixed. Unknown event names rejected                                                                                                        |
| Accepted properties                | Explicitly declared per event. Unknown properties rejected                                                                                     |
| Nested objects / arrays in a value | Rejected                                                                                                                                       |
| Generic containers                 | `properties`, `metadata`, `context`, `extra`, `data` … all rejected by name                                                                    |
| Prohibited-key defense             | Centralized list covering symptoms, answers, narratives, conditions, scores, red flags, urgency, pregnancy, identity, coordinates, credentials |
| Prototype-pollution keys           | `__proto__`, `constructor`, `prototype` rejected                                                                                               |
| Body size / batch size             | 32 768 bytes, 20 events                                                                                                                        |
| Raw body persisted or logged       | **Never** — accepted or rejected                                                                                                               |
| Storage                            | **No database table added.** Default sink is structured Pino output                                                                            |
| Default state                      | **Disabled** (`TELEMETRY_ENABLED=false`) unless explicitly enabled per environment                                                             |

No symptom, answer, assessment path, condition, score, red-flag match, urgency, precise location,
identity value or credential can be accepted by this endpoint. See `docs/TELEMETRY_CONTRACT.md`
for the full matrix and `tests/privacy/adversarial.test.ts` for the enforcing tests, which assert
that prohibited payloads are rejected **and** absent from both logs and the sink.

Scoring, red-flag evaluation and urgency determination remain entirely on-device. Telemetry is
write-only and returns no clinical data.

### 🔍 Verified — schema carries no PHI columns

| Table               | Columns                                                         | PHI |
| ------------------- | --------------------------------------------------------------- | --- |
| `artifact_versions` | artifact, version, s3_key, hash, released_at, created_at        | No  |
| `metrics_agg`       | metric_name, metric_value, dimensions (JSONB), period_start/end | No  |
| `audit_logs`        | event_type, actor, target, metadata (JSONB), created_at         | No  |

`metrics_agg` is aggregate-only by design. `audit_logs` records system events, not user data.
Neither table has a column that could hold a symptom, an identifier, or free text from a user.

> **Standing risk to watch:** `metrics_agg.dimensions` and `audit_logs.metadata` are open
> `JSONB`. Nothing writes to them today, so there is no current exposure — but whatever
> introduces the first write must not pass symptom-level or identifying data into those blobs.
> Flag any future PR that writes to them for PHI review.

### 🔍 Verified — logging

| Control                 | State                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Logger                  | Pino structured logging                                                                                                                      |
| `authorization` header  | Redacted (`src/app.ts`, `src/utils/logger.ts`)                                                                                               |
| `cookie` header         | Redacted (`src/app.ts`, `src/utils/logger.ts`)                                                                                               |
| Log level in production | `info` (debug suppressed)                                                                                                                    |
| `console.log`           | Banned by ESLint rule `no-console: 'error'` — CI fails on any occurrence                                                                     |
| Request bodies logged   | **Never** — redaction covers `req.body` / `body` / `payload`, and the telemetry route parses its own body so a parse failure cannot quote it |
| Query strings logged    | **Stripped** — a custom Pino request serializer logs the path only                                                                           |
| IP addresses logged     | **Not logged** — `remoteAddress` removed from the request serializer                                                                         |

> **Resolved 2026-08-11:** the redaction drift noted here previously (`server.ts` redacting
> `authorization` + `cookie` while `src/utils/logger.ts` redacted only `authorization`) is fixed.
> Both now build their redaction list from `buildLogRedactionPaths()` in
> `src/telemetry/prohibited.ts`, so the two cannot drift apart again.
>
> **Also fixed 2026-08-11 — rate limiting returned 500, not 429.** `@fastify/rate-limit` _throws_
> whatever `errorResponseBuilder` returns. The builder returned a plain object with no top-level
> `statusCode`, so the global error handler fell through to its 500 branch: every rate-limited
> request answered `500 An internal server error occurred` instead of the documented 429
> envelope. This checklist and `PROGRESS.md` both previously recorded the 429 envelope as
> working. The builder now returns a real `Error` carrying `statusCode`; covered by a regression
> test.

### 📩 Relayed (mobile) — E8.3 findings

- Zero PHI in release-build log output — confirmed by the mobile engineer
- All Hive boxes audited, zero PHI stored — confirmed by the mobile engineer

---

## 2. Artifact Integrity

### 🔍 Verified — backend side

| Control                                     | State                                                             |
| ------------------------------------------- | ----------------------------------------------------------------- |
| SHA256 published for every artifact         | Yes — every block in `/config` carries a `hash` field             |
| Hash independently recomputed before wiring | Yes — every release in E7/E8; see `ARTIFACT_RELEASE_PROCESS.md`   |
| Version immutability                        | Enforced by process and by `UNIQUE (artifact, version)` in the DB |
| Prior versions confirmed still live         | Yes — verified at each release; enables rollback                  |
| Artifact URLs built from a single env var   | Yes — `ARTIFACT_BASE_URL`; no hardcoded bucket URLs in route code |

**Frozen beta hashes** (verified live on staging 2026-07-27):

| Artifact           | Version | SHA256                                                             |
| ------------------ | ------- | ------------------------------------------------------------------ |
| `token_dictionary` | 1.1     | `0cc47ad9537c0bd4c6ef3aec8f1931eb9b4c62103a8809d16544f94a90b5c019` |
| `knowledge_base`   | 2.4     | `6c00d8257f8417e86bd5e237630bf8a4623ad72e2e46b1b071dd447c067cec2b` |
| `rules`            | 2.2     | `1d27e854cba95b179577a88f92445400f494a7fe8e6a53a60fcaa98b3870d1c4` |
| `facilities`       | 1.1     | `25684c714367abf2f3c305c8a5597b5f7eb0d11baaf658c5b9e2f8f5e2982398` |

### 📩 Relayed (mobile) — E8.3

- On-device artifact hash integrity check confirmed working

---

## 3. Transport Security

| Control                 | State                                                                      |
| ----------------------- | -------------------------------------------------------------------------- |
| HTTPS on the API        | 🔍 Yes — Render-terminated TLS on `wellapath-backend-staging.onrender.com` |
| HTTPS on artifact CDN   | 🔍 Yes — Cloudflare R2 public CDN                                          |
| Database connection     | 🔍 Encrypted — `DB_SSL=true`                                               |
| **Certificate pinning** | ⏭️ **Deferred to production — accepted for internal beta**                 |

### Certificate pinning — deferred, noted

Confirmed as a **deliberate deferral**, not an oversight. Accepted for internal beta on the
basis that beta is a controlled, internal audience.

**What deferral means in practice:** without pinning, a client that trusts a hostile root CA
(a corporate MITM proxy, or a compromised device trust store) could serve substituted artifact
content. The on-device SHA256 integrity check is the compensating control — a substituted
artifact fails its hash check. That mitigates artifact tampering; it does not mitigate traffic
interception generally.

**Must be revisited before any external/public release.**

### ⚠️ Production hardening item — database TLS verification

`src/plugins/db.ts` sets `ssl: { rejectUnauthorized: false }`. The connection is encrypted, but
the server certificate chain is **not verified**, so the DB connection is not protected against
an active MITM on the path between Render and Supabase. This was the pragmatic fix for the E4
Supabase connection failure.

Acceptable for staging and internal beta. **Should be tightened before production**, alongside
certificate pinning. No PHI transits this connection (see §1), which limits the impact.

---

## 4. Secrets Management

| Check                                     | Result                                                             |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Hardcoded credentials in `src/`           | 🔍 **None found** (pattern scan for password/secret/api-key/token) |
| `.env` tracked in git                     | 🔍 **No**                                                          |
| `.env` present anywhere in git history    | 🔍 **No** — zero commits have ever touched `.env`                  |
| `.env` in `.gitignore`                    | 🔍 Yes — confirmed active via `git check-ignore`                   |
| Secret-shaped strings in the tracked tree | 🔍 **None found**                                                  |
| Required env vars validated at boot       | 🔍 Yes — `requireEnv()` fails fast on missing values               |
| Production secret storage                 | Render service environment variables                               |

> **Housekeeping (low severity, no exposure):** `.gitignore` has a byte-level defect — the
> `.claude/` entry was appended in UTF-16LE (NUL-interleaved) with no newline after
> `coverage/`. Git currently parses both entries correctly (`git check-ignore` confirms
> `coverage/`, `.claude/`, **and `.env`** are all ignored), so there is no current exposure. The
> file should still be rewritten as clean UTF-8 so the behaviour is not fragile.

---

## 5. Application Hardening

| Control             | State                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| CORS                | 🔍 Origin allowlist in production (`wellapath.org`, `api-staging.wellapath.org`); `GET`, `POST`, `OPTIONS` |
| Rate limiting       | 🔍 100 requests / minute globally, 60 / minute on telemetry; error envelope fixed (see §1)                 |
| Error envelope      | 🔍 Consistent `{ error: { statusCode, message } }` across 404 / 429 / 4xx / 5xx                            |
| Stack trace leakage | 🔍 None — 5xx responses return a generic message; full error logged server-side only                       |
| 404 handling        | 🔍 Custom handler, same envelope — no framework default leakage                                            |
| Dependency surface  | Minimal — Fastify, cors, rate-limit, pino, pg, dotenv                                                      |

> **CORS note:** the production allowlist still contains `api-staging.wellapath.org`, a domain
> from the superseded AWS setup. The live service is on `onrender.com`, and `NODE_ENV` on
> staging is not `production`, so the allowlist is not currently the active branch. Harmless
> today, but the allowlist should be corrected to the real production origins before the app
> ships to a production environment.

---

## 6. CI / Supply Chain

| Control                           | State                                     |
| --------------------------------- | ----------------------------------------- |
| Lint enforced in CI               | 🔍 Yes — `npm run lint`                   |
| Format enforced in CI             | 🔍 Yes — `npm run format:check`           |
| Docker build verified in CI       | 🔍 Yes                                    |
| Commit message enforcement        | 🔍 Commitlint via Husky                   |
| Pre-commit lint/format            | 🔍 Husky + lint-staged                    |
| Direct pushes to `develop`/`main` | Prohibited by policy — all changes via PR |
| **Type checking enforced in CI**  | ⚠️ **No — see below**                     |

### ⚠️ CI gap — TypeScript check cannot fail the build

`.github/workflows/ci.yml` runs:

```yaml
- name: Run TypeScript build check
  run: npx tsc --noEmit --skipLibCheck || true
```

The trailing `|| true` swallows the exit code, so **type errors cannot fail CI**. A green
"Lint & Build Check" does not prove the project type-checks.

**Actual exposure is low:** `npm run build` (which does fail on type errors) has been run
locally before every artifact PR in E7–E8, and all passed. But the CI signal is weaker than it
looks, and a future contributor would reasonably trust it.

Not fixed here — removing `|| true` changes CI gating behaviour and does not belong in a
documentation PR. **Recommend a follow-up `ci` PR before beta sign-off.**

---

## 7. Summary

### Confirmed for internal beta

- 🔍 No PHI intake surface exists server-side — three `GET` routes, no body/param/query reads, no runtime writes
- 🔍 No PHI columns in the schema
- 🔍 Auth and cookie headers redacted; `console.log` banned and CI-enforced
- 🔍 Every artifact hash independently verified; version immutability upheld across all E7/E8 releases
- 🔍 No secrets in source or in git history
- 🔍 HTTPS on API and CDN; error envelope leaks no internals
- 📩 Mobile E8.3: zero PHI in logs, zero PHI in Hive boxes, on-device hash checks working

### Accepted risks carried into beta

| Item                                           | Severity | Disposition                                     |
| ---------------------------------------------- | -------- | ----------------------------------------------- |
| Certificate pinning not implemented            | Medium   | Deferred to production — accepted               |
| DB TLS `rejectUnauthorized: false`             | Medium   | Tighten before production                       |
| **Supabase free tier pauses after 7d idle**    | Medium   | **Upgrade tier or add weekly ping before prod** |
| CI type check cannot fail (`\|\| true`)        | Low      | ✅ Fixed — PR #25                               |
| CORS allowlist references superseded domain    | Low      | Correct before production                       |
| `.gitignore` UTF-16 byte defect                | Low      | Housekeeping — no current exposure              |
| Open `JSONB` columns could carry PHI in future | Low      | Review any PR that writes to them               |

**None of the above blocks internal beta.** The remaining medium items are all production gates
and are tracked as such.

### Availability — Supabase free-tier pause (observed 2026-07-29)

Not a confidentiality or integrity issue, but an **availability** one, recorded here because it
is a production gate.

The staging Supabase project paused after 7 days of inactivity, causing `GET /health` to return
503 (`database: error`) until it was manually restored. The pooler reported
`tenant/user ... not found`, which reads like a deleted project rather than a paused one — worth
knowing, because the error message misdirects diagnosis.

`/config` and `/version` were unaffected throughout (neither touches the database; the only
runtime query in the app is the health check's `SELECT 1`), so no client-facing path was broken.
**The risk to guard against in production is indirect:** if the platform health check targets
`/health`, a sustained 503 can cause the service to be marked unhealthy and restarted or dropped
from routing — which would take `/config` down and break first launch for real users.

**Pre-production requirement:** upgrade off the free tier (durable fix) or add a weekly
keep-alive ping (mitigation). See `DEPLOYMENT.md` §4.

---

_Backend items verified 2026-07-27 against `develop` and live staging. Mobile items (§1, §2)
relayed from E8.3 and not independently verified from this repository._
