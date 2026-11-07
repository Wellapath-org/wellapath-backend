# Deployment — Current Stack

> **Status:** current as of **2026-11-07** (re-verified live). Production is provisioned and
> serving facilities **v1.2**. This document describes the stack as it actually runs today.

---

## 1. Stack Overview

| Layer              | Provider                 | Detail                                                                    |
| ------------------ | ------------------------ | ------------------------------------------------------------------------- |
| Backend production | Render                   | `https://api.wellapath.org` → `wellapath-backend-production.onrender.com` |
| Backend staging    | Render                   | `https://wellapath-backend-staging.onrender.com`                          |
| Database           | Supabase PostgreSQL      | **Staging only.** Production runs with `DATABASE_ENABLED=false`           |
| Artifact storage   | Cloudflare R2            | Public bucket, shared by staging and production (hash-pinned objects)     |
| Artifact CDN       | Cloudflare R2 public CDN | `pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev`                             |
| DNS                | Namecheap BasicDNS       | `api` CNAME → Render production service; Render issues TLS                |
| CI                 | GitHub Actions           | `Backend CI` and `Docker Build Check` (see §8)                            |
| Container          | Docker, `node:20-alpine` | Multi-stage build, exposes port 3000                                      |

Edge note: responses carry `server: cloudflare` / `cf-ray` because Render's own edge is
Cloudflare-fronted (`*.onrender.com` resolves via `cdn.cloudflare.net`). `wellapath.org` itself is
**not** on Cloudflare DNS.

---

## 2. ⚠️ Superseded Infrastructure

The original E1 brief targeted an **AWS staging stack** (ECS Fargate, RDS, S3, CloudFront,
Secrets Manager, ECR). That infrastructure is **no longer in use**; it was replaced during the
E2–E4 infra migration (PRs #12–#14).

| Component | Superseded (AWS) | Actually in use now                                  |
| --------- | ---------------- | ---------------------------------------------------- |
| Runtime   | ECS Fargate      | **Render**                                           |
| Database  | RDS PostgreSQL   | **Supabase PostgreSQL** (staging); none (production) |
| Artifacts | S3               | **Cloudflare R2**                                    |
| CDN       | CloudFront       | **Cloudflare R2 public CDN**                         |
| Secrets   | Secrets Manager  | **Render environment variables**                     |
| Registry  | ECR              | Not in use                                           |

`CLAUDE.md` was rewritten on 2026-11-07 to the current stack, and the AWS account ID, secret
ARNs and database endpoint/username were removed from `CLAUDE.md` and `PROGRESS.md`. **They are
still present in Git history** of this public repository. History remediation is a founder
decision and has not been performed.

---

## 3. Backend — Render

### Services

| Service                        | URL                                              | Branch       | Auto-Deploy                                                                                              |
| ------------------------------ | ------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------- |
| `wellapath-backend-staging`    | `https://wellapath-backend-staging.onrender.com` | `develop`    | **On Commit** (confirmed from the Render console by the founder, 2026-09-29)                             |
| `wellapath-backend-production` | `https://api.wellapath.org`                      | `production` | Recorded **Off** during the 2026-09-29 activation — **re-confirm in the dashboard before relying on it** |

Both are Docker web services. Production runs `NODE_ENV=production`, `DATABASE_ENABLED=false`,
`TELEMETRY_ENABLED=false`, `APP_VERSION=0.3.0` (full list: `PRODUCTION_PROVISIONING.md` §3).

### Verified production state (2026-11-07)

| Check                       | Result                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `origin/production`         | `fd7190b` (PR #39 merge, facilities v1.2) — **identical to `origin/develop`**               |
| `GET /version`              | `{"version":"0.3.0","environment":"production"}`                                            |
| `GET /health`               | 200, `checks.database: "disabled"`                                                          |
| `GET /config`               | token_dictionary 1.1 · knowledge_base 2.4 · rules 2.2 · **facilities 1.2**                  |
| `/config` body sha256       | `bbf8024c04e946d41c22be4b6b858fe0ae83ffa1720ee6802776234272fe2d7b` (staging body identical) |
| Every artifact URL it names | HTTP 200, sha256 recomputed, **all four match**                                             |

### How production has moved

From the GitHub repository activity log and PR metadata:

| When (UTC)           | Event                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------- |
| 2026-09-21T14:00:49Z | `production` branch **created** at `6cf642f` (PR #38 merge, database-independent hardening) |
| 2026-09-29T12:49:17Z | PR #39 (facilities v1.2 activation) merged to `develop` → `fd7190b`                         |
| 2026-09-29T12:50:01Z | `production` **fast-forward pushed** `6cf642f → fd7190b` (no merge commit, same tree)       |
| 2026-09-29T13:07:34Z | Production `/config` verified serving facilities 1.2 (private activation record)            |

So production moves by **fast-forwarding `production` to an already-merged, staging-verified
`develop` commit**, followed by a Render production deploy. There is no PR into `production`.
Note: the local `production` ref in a developer checkout may be stale — always compare against
`origin/production` after `git fetch`.

**Server binding:** the app listens on `0.0.0.0` at `config.port` (`PORT`, default `3000`) — see
`src/server.ts`.

### Endpoints

| Method | Path                   | Purpose                                          | Auth | Production                  |
| ------ | ---------------------- | ------------------------------------------------ | ---- | --------------------------- |
| GET    | `/health`              | Liveness (+ database check when enabled)         | None | 200, `database: "disabled"` |
| GET    | `/version`             | Deployed app version and environment             | None | `0.3.0` / `production`      |
| GET    | `/config`              | Versioned artifact metadata for mobile bootstrap | None | Live                        |
| POST   | `/v1/telemetry/events` | Privacy-safe product telemetry intake (I1/W1)    | None | 503 `telemetry_disabled`    |
| GET    | `/internal/metrics`    | Operational counters and latency histograms      | None | **404 — hard-disabled**     |

The telemetry endpoints are documented in [`TELEMETRY_CONTRACT.md`](TELEMETRY_CONTRACT.md) and
[`TELEMETRY_OPERATIONS.md`](TELEMETRY_OPERATIONS.md).

`/config` is the mobile app's bootstrap call. **The app must always consume artifact URLs from
this response — never construct R2 URLs directly.** This is what makes artifact rollback a
backend-only change (see §7).

---

## 4. Database — Supabase PostgreSQL (staging only)

> **Production runs with `DATABASE_ENABLED=false`** — no pool, no `DB_*` variables, `/health`
> reports `database: "disabled"`. Everything below describes **staging**. The free-tier pause
> item is therefore a staging concern; a production database is introduced only per
> `PRODUCTION_PROVISIONING.md` §7.

Connection is via the **Supabase connection pooler** (port `6543`, not the direct `5432`).

Configured entirely through environment variables (`src/config/env.ts`):

| Variable      | Notes                          |
| ------------- | ------------------------------ |
| `DB_HOST`     | Supabase pooler host           |
| `DB_PORT`     | `6543` (pooler)                |
| `DB_NAME`     | `postgres`                     |
| `DB_USER`     | Required — never committed     |
| `DB_PASSWORD` | Required — never committed     |
| `DB_SSL`      | `true` — Supabase requires SSL |

`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `ARTIFACT_BASE_URL` are validated at boot
by `requireEnv()` and the process fails fast if any is missing. The `DB_*` validation applies
while the database is enabled, which is the default; with `DATABASE_ENABLED=false` the
database section is skipped entirely (see §6 and `docs/PRODUCTION_PROVISIONING.md`).

**SSL note:** the pool sets `ssl: { rejectUnauthorized: false }` when `DB_SSL=true`
(`src/plugins/db.ts`). This was the fix for the Supabase connection failure in E4. It encrypts
the connection but does not verify the server certificate chain. Acceptable for staging;
flagged in `SECURITY_CHECKLIST.md` as a production hardening item.

**Pool settings:** `max: 10`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 2000`.
The pool is closed cleanly on the Fastify `onClose` hook.

### ⚠️ Free-tier inactivity pause — pre-production item

**The Supabase free tier pauses a project after 7 days of inactivity.** This is not theoretical:
it happened on **2026-07-29** during E9 beta readiness. Symptoms were:

- `GET /health` returning **503** with `{"checks":{"database":"error"}}`, persistently
- The Supabase pooler rejecting connections with
  `XX000 (ENOTFOUND) tenant/user postgres.<project-ref> not found` — which reads like a deleted
  project, but was in fact a paused one
- Resolved by manually restoring the project from the Supabase dashboard

**Why it matters more in production than it did here.** `/config` and `/version` do not touch the
database, so the mobile bootstrap path stayed up throughout. The real exposure is indirect: if the
platform health check is pointed at `/health`, a persistent 503 can cause the service to be marked
unhealthy and restarted or removed from routing — which _would_ take `/config` down and break
first launch for real users.

**Before production, do one of:**

1. **Upgrade off the free tier** — removes the pause behaviour entirely. Preferred.
2. **Add a weekly keep-alive ping** to the database (a scheduled job issuing `SELECT 1` more often
   than every 7 days) so the project never idles into a pause.

Option 1 is the durable fix; option 2 is a mitigation that keeps working only for as long as the
scheduler does.

### Schema

Created by `npm run migrate` (`src/db/migrate.ts`) — idempotent (`CREATE TABLE IF NOT EXISTS`),
wrapped in a single transaction with rollback on failure.

| Table               | Purpose                             | PHI |
| ------------------- | ----------------------------------- | --- |
| `artifact_versions` | Versioned artifact release ledger   | No  |
| `metrics_agg`       | Aggregated anonymised usage metrics | No  |
| `audit_logs`        | System audit trail                  | No  |

`artifact_versions` carries `UNIQUE (artifact, version)`, which enforces the no-overwrite rule
at the database level.

> **Note:** the `artifact_versions.s3_key` column name is a leftover from the AWS era. It now
> holds the R2 object key. Renaming it is deferred — it is a schema change, out of scope for
> a documentation task.

---

## 5. Artifacts — Cloudflare R2

**Public base URL:** `https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev`
Injected via the `ARTIFACT_BASE_URL` env var; `src/routes/config.ts` builds every artifact URL
from it, so a bucket change is a single env-var change. The bucket is named
`wellapath-artifacts-staging` but serves **both** environments — the objects are immutable and
hash-pinned, so this is a naming oddity, not a staging/production mix.

### Served versions (E9.1 freeze, moved once for facilities on 2026-09-29)

| Artifact           | Version | File                            | sha256 (prefix) | Bytes     |
| ------------------ | ------- | ------------------------------- | --------------- | --------- |
| `token_dictionary` | 1.1     | `token_dictionary.ng.v1.1.json` | `0cc47ad9…`     | 8,820     |
| `knowledge_base`   | 2.4     | `kb.ng.v2.4.json`               | `6c00d825…`     | 102,118   |
| `rules`            | 2.2     | `rules.ng.v2.2.json`            | `1d27e854…`     | 29,082    |
| `facilities`       | **1.2** | `facilities.ng.v1.2.json`       | `94f162e4…`     | 1,698,125 |

Facilities moved **1.1 → 1.2** under decision reference FACILITIES-V1.2-ACTIVATION-2026-09-29
(PR #39): v1.2 removes 45 NHFR-derived telephone numbers that had no established redistribution
permission. **No artifact changes past this point without engineering lead approval.**

### Retired: `facilities.ng.v1.1.json`

**Deliberately deleted from R2 on 2026-09-29 at 13:41Z** by the founder, after v1.2 was verified
in production and the mobile post-activation check passed — so that the 45 unlicensed numbers are
no longer publicly served. The URL has returned **404** ever since (re-checked 2026-11-07). A
checksum-verified evidence copy is held privately outside Git. **v1.1 is not a rollback target.**

Not every prior version is still a usable rollback target — see §7 for the verified list. Prior
versions are kept on R2 only where they are safe to serve.

> The placeholder artifacts still committed under `src/artifacts/` (`kb.ng.v1.0.json` etc.) are
> **E1 skeleton leftovers**. They are not served and are not the source of truth. Real artifacts
> live only on R2.

---

## 6. Environment Variables

See `.env.example` for the template. Never commit `.env`.

| Variable            | Required | Purpose                                                                                                                                                                    |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`          | No       | Defaults to `development`                                                                                                                                                  |
| `PORT`              | No       | Defaults to `3000`                                                                                                                                                         |
| `DATABASE_ENABLED`  | No       | Defaults to `true`. Must be exactly `true`/`false`; `false` makes every `DB_*` variable optional and unread, creates no pool, and `/health` reports `database: "disabled"` |
| `DB_HOST`           | **Yes**† | Supabase pooler host                                                                                                                                                       |
| `DB_PORT`           | No       | Defaults to `5432` — set `6543` for pooler                                                                                                                                 |
| `DB_NAME`           | **Yes**† | Database name                                                                                                                                                              |
| `DB_USER`           | **Yes**† | Database user                                                                                                                                                              |
| `DB_PASSWORD`       | **Yes**† | Database password                                                                                                                                                          |
| `DB_SSL`            | No       | `true` required for Supabase                                                                                                                                               |
| `ARTIFACT_BASE_URL` | **Yes**  | R2 public base URL                                                                                                                                                         |
| `APP_VERSION`       | No       | Defaults to `0.1.0`                                                                                                                                                        |

† Required only while the database is enabled (the default). With
`DATABASE_ENABLED=false` none of the `DB_*` variables is read; see
`docs/PRODUCTION_PROVISIONING.md` §7 for the enablement path.

Telemetry adds a further set of optional variables (`TELEMETRY_ENABLED`, `TELEMETRY_SINK`, and
tuning knobs), all defaulting safely with intake **off**. They are documented in
[`TELEMETRY_OPERATIONS.md`](TELEMETRY_OPERATIONS.md) §2 and templated in `.env.example`. None
holds a secret.

Secrets are set in the Render service environment. No credentials appear in source.

---

## 7. Rollback

Rolling anything back is a **clinical** change, not just a technical one. It requires
engineering-lead approval and a decision reference, exactly like a forward release.

### 7.1 What a device does (why versions matter)

The mobile app caches each artifact **keyed by version** (e.g. `artifact_facilities_v1.2`) and
sweeps nothing; the only delete is the same version's entry on a hash failure. Consequences:

- Pointing `/config` at an older version makes devices download (or reuse a cached copy of) that
  version. Their cached newer copy stays on the device.
- Rolling forward again later reuses the cached newer copy — safe because it is hash-pinned.
- **A version string must never be reused for different bytes**: a device that already cached
  that version would never re-download it, and one that did would fail the hash check.
- Deleting an object from R2 stops new downloads; it does **not** remove it from devices.
- If `/config` names a URL that returns 404, a fresh install cannot obtain that artifact. That is
  why a rollback target must be proven reachable _at the time of rollback_.

### 7.2 Verified rollback targets (re-checked 2026-11-07 09:36Z)

Every object `/config` has ever named was fetched from R2 and its sha256 recomputed against the
hash in `src/routes/config.ts` history.

| Artifact           | Current | **Valid rollback targets** (HTTP 200 + hash match) | **Not valid**                                                                                              |
| ------------------ | ------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `facilities`       | 1.2     | **1.0** (`1c7b9391…009e`, 1,695,059 B) — PR #40    | **1.1 — HTTP 404**, deliberately retired 2026-09-29 (and would re-serve the unlicensed numbers)            |
| `knowledge_base`   | 2.4     | 2.3 (`cb0e43fc…`), 2.2 (`80c39e7e…`)               | **2.1 — R2 bytes (`f90d5df6…`) ≠ hash `/config` served (`e5d9fd82…`)**; 2.0 — same (known PR #16 incident) |
| `rules`            | 2.2     | 2.1 (`57da3ff5…`)                                  | 2.0 — R2 bytes (`99d55356…`) ≠ served hash (`b969b084…`) (PR #16 incident)                                 |
| `token_dictionary` | 1.1     | 1.0 (`773006de…`)                                  | —                                                                                                          |

The `kb` v2.1 mismatch traces to knowledge-base commit `2a8ffaf` (2026-07-22), which edited
`kb.ng.v2.1.json` in place; R2 now holds those edited bytes. Any device that cached v2.1 under the
original hash holds different content from what the URL now returns. It is recorded here, not
repaired: repairing it is a data-engineering decision. Clinical compatibility of any older
target with the current token dictionary must be re-validated before use.

### 7.3 Facilities rollback to v1.0 — tested procedure

The rollback is prepared as **PR #40** (`chore/facilities-rollback-to-v1-0`, draft, **base
`develop`**, head `3262156`). It changes only `src/routes/config.ts` (facilities block → v1.0),
`docs/baseline/distribution-baseline.v1.json` (genuine v1.0 staging observation of 2026-09-29),
and the two frozen-value test files.

**Dry run, 2026-11-07 (no deployment):** at head `3262156`, `npm ci` → `npm test` **25/25 suites,
676/676 tests** → `npm run build` → booted with the production profile below on a local port →
`GET /config` returned facilities **1.0** with token_dictionary 1.1 / kb 2.4 / rules 2.2
unchanged (only the four facilities fields differ from production) → every artifact URL
downloaded and re-hashed: **all four match**; v1.0 has 5,344 records, 0 populated phones,
924 `emergency_capable`. Expected rollback `/config` body sha256:
**`ee0df0f24ecf401c49d4379da002c96cce1628feb2745c93db74d7e42d81e48b`**.

Steps (founder / engineering lead perform steps 4–7):

1. **Approve** and record a decision reference. Confirm the reason: v1.2 is defective for clients.
   Do **not** use v1.1.
2. **Re-verify the target on R2 now:**
   ```bash
   B=https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev
   curl -s -o v10.json -w '%{http_code} %{size_download}\n' "$B/facilities.ng.v1.0.json?cb=$RANDOM"
   shasum -a 256 v10.json   # must be 1c7b939199ab4465156f4cb336910eea120fcaa70f8b1c0743fc9f7a7c03009e
   ```
3. **Re-verify PR #40 against current `develop`:**
   `gh pr view 40 --json baseRefName,mergeable,files` → base `develop`, `MERGEABLE`, only the four
   files above. If `develop` has moved and the PR is no longer clean, merge `develop` into the
   branch (no rebase, no force-push), then repeat the dry run:
   ```bash
   npm ci && npm test && npm run build
   NODE_ENV=production DATABASE_ENABLED=false TELEMETRY_ENABLED=false APP_VERSION=0.3.0 \
     ARTIFACT_BASE_URL=https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev PORT=3917 \
     node dist/server.js &
   curl -s http://127.0.0.1:3917/config > rb.json   # then download each URL and compare sha256
   ```
   If any other `/config` field has changed since 2026-09-29, the baseline's
   `deployed_observation` must be **re-observed** on staging, not edited.
4. **Merge PR #40 to `develop`** (mark ready first). Staging auto-deploys `develop`.
5. **Verify staging**: several cache-busted `GET /config` reads all show facilities 1.0 and
   `facilities.ng.v1.0.json`; download every URL and recompute sha256.
6. **Move production by fast-forward only** to the verified `develop` commit —
   `git push origin <develop-sha>:production` (never `--force`) — then trigger the Render
   production deploy if Auto-Deploy is off.
7. **Verify production**: `/version` → `0.3.0`/`production`; `/config` facilities 1.0; all four
   artifact hashes recompute; body sha256 should equal the expected value above (if any other
   field changed in the meantime, compare field-by-field instead). Record the result in
   `PROGRESS.md`.

To roll **forward** to v1.2 again: revert the PR #40 merge on `develop` via a revert PR, then
repeat steps 5–7.

### 7.4 Backend (code) rollback

Operator runbook (boundary table, Render dashboard commit identification, checklist):
`OPERATIONS_RENDER_ROLLBACK.md`.

- **Do not use Render "Rollback to previous deploy" to any production deploy older than
  `fd7190b`.** Those deploys (e.g. `6cf642f`) serve facilities **v1.1**, whose URL is now 404 —
  fresh installs would fail to obtain facilities. The same applies to reverting PR #39.
- For a code defect that is unrelated to artifacts: revert the offending commit on `develop` via a
  revert PR, verify staging, fast-forward `production`, deploy, verify `/version` and `/config`.
- Render "Rollback to previous deploy" remains acceptable only to a deploy whose `/config` names
  objects that are verified 200 + hash-matching at that moment.

### 7.5 Artifact rollback — any other artifact

1. Choose a target from the **valid** column in §7.2 and re-verify it (HTTP 200, recompute
   sha256) immediately before acting. A target that was valid when documented may not be now.
2. Edit only that block in `src/routes/config.ts` (version, url, hash, release_date), update the
   frozen literals in the regression test and the baseline per `docs/DISTRIBUTION_BASELINE.md`,
   with a genuine staging observation.
3. PR to `develop` → staging verify → fast-forward `production` → deploy → production verify.

---

## 8. CI

Two GitHub Actions workflows run on every PR and push to `develop` / `main`:

| Workflow             | Job                | Steps                                                                                                   |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `Backend CI`         | Lint & Build Check | `npm ci`, `format:check`, `lint`, `tsc --noEmit --skipLibCheck`, `telemetry:contract:check`, `npm test` |
| `Docker Build Check` | Docker Build       | Buildx build of the production image (not pushed)                                                       |

The type-check step **fails the build on type errors** — the earlier `|| true` was removed in
PR #25. `npm test` includes the `/config` regression suite and the distribution-baseline drift
check, so any change to `/config` fails CI until the baseline is deliberately moved.

Neither workflow deploys. Deployment is entirely Render's (§3). CI does not run on the
`production` branch; `production` only ever receives commits that already passed on `develop`.

---

## 9. Local Development (macOS)

```bash
git clone https://github.com/Wellapath-org/wellapath-backend.git
cd wellapath-backend
git checkout develop
npm ci
cp .env.example .env               # never commit .env
DATABASE_ENABLED=false npm run dev # no database needed for any product route
```

With the database enabled (staging-like), fill `DB_USER` / `DB_PASSWORD` from the engineering
lead and run `npm run migrate` (idempotent; refuses to run while the database is disabled).

If port 3000 is already bound by another project, run with `PORT=3001 npm run dev` rather than
killing the other process.
