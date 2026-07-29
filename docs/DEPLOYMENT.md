# Deployment — Current Stack

> **Status:** current as of 2026-07-27 (E9.1 artifact freeze).
> This document describes the stack as it actually runs today.

---

## 1. Stack Overview

| Layer            | Provider                 | Detail                                           |
| ---------------- | ------------------------ | ------------------------------------------------ |
| Backend runtime  | Render                   | `https://wellapath-backend-staging.onrender.com` |
| Database         | Supabase PostgreSQL      | Connection pooler, SSL required                  |
| Artifact storage | Cloudflare R2            | Public bucket                                    |
| Artifact CDN     | Cloudflare R2 public CDN | `pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev`    |
| CI               | GitHub Actions           | Lint & Build Check, Docker Build Check           |
| Container        | Docker, `node:20-alpine` | Multi-stage build, exposes port 3000             |

---

## 2. ⚠️ Superseded Infrastructure — Read This First

`CLAUDE.md` Section 1 ("Repo & Environment Context") still documents the **original AWS
staging infrastructure**. That infrastructure is **no longer in use**. It was replaced during
the E2–E4 infra migration (PRs #12–#14).

| Component  | `CLAUDE.md` says (superseded) | Actually in use now                      |
| ---------- | ----------------------------- | ---------------------------------------- |
| Runtime    | AWS ECS Fargate               | **Render**                               |
| Database   | AWS RDS PostgreSQL            | **Supabase PostgreSQL**                  |
| Artifacts  | AWS S3                        | **Cloudflare R2**                        |
| CDN        | AWS CloudFront                | **Cloudflare R2 public CDN**             |
| Secrets    | AWS Secrets Manager           | **Render environment vars**              |
| Registry   | AWS ECR                       | Not in use                               |
| API domain | `api-staging.wellapath.org`   | `wellapath-backend-staging.onrender.com` |

Any AWS account ID, ARN, RDS endpoint, ECS cluster name, or CloudFront domain appearing in
`CLAUDE.md` or in the older sections of `PROGRESS.md` is **historical only**. Do not use those
values. This gap is called out here rather than silently corrected because `CLAUDE.md` is a
locked build-law document — updating it requires founder + engineering lead review.

---

## 3. Backend — Render

**Service URL:** `https://wellapath-backend-staging.onrender.com`

**Deploy trigger:** merges to `develop` are picked up automatically. Observed propagation
time from merge to live `/config` during E8 releases was **15–30 seconds**.

**Server binding:** the app listens on `0.0.0.0` at `config.port` (`PORT` env var, default
`3000`). Binding to `0.0.0.0` rather than `localhost` is required for the container to be
reachable — see `src/server.ts`.

### Endpoints

| Method | Path       | Purpose                                          | Auth |
| ------ | ---------- | ------------------------------------------------ | ---- |
| GET    | `/health`  | Liveness + database connectivity check           | None |
| GET    | `/version` | Deployed app version and environment             | None |
| GET    | `/config`  | Versioned artifact metadata for mobile bootstrap | None |

`/config` is the mobile app's bootstrap call. **The app must always consume artifact URLs from
this response — never construct R2 URLs directly.** This is what makes artifact rollback
possible (see §7).

---

## 4. Database — Supabase PostgreSQL

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
by `requireEnv()` and the process fails fast if any is missing.

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
from it, so a bucket change is a single env-var change.

### Frozen versions (E9.1 artifact freeze, 2026-07-27)

| Artifact           | Version | File                            |
| ------------------ | ------- | ------------------------------- |
| `knowledge_base`   | 2.4     | `kb.ng.v2.4.json`               |
| `rules`            | 2.2     | `rules.ng.v2.2.json`            |
| `token_dictionary` | 1.1     | `token_dictionary.ng.v1.1.json` |
| `facilities`       | 1.1     | `facilities.ng.v1.1.json`       |

**No artifact changes past this point without engineering lead approval.**

All prior versions remain on R2 and return HTTP 200. This is deliberate and is what makes
artifact rollback possible.

> The placeholder artifacts still committed under `src/artifacts/` (`kb.ng.v1.0.json` etc.) are
> **E1 skeleton leftovers**. They are not served and are not the source of truth. Real artifacts
> live only on R2.

---

## 6. Environment Variables

See `.env.example` for the template. Never commit `.env`.

| Variable            | Required | Purpose                                    |
| ------------------- | -------- | ------------------------------------------ |
| `NODE_ENV`          | No       | Defaults to `development`                  |
| `PORT`              | No       | Defaults to `3000`                         |
| `DB_HOST`           | **Yes**  | Supabase pooler host                       |
| `DB_PORT`           | No       | Defaults to `5432` — set `6543` for pooler |
| `DB_NAME`           | **Yes**  | Database name                              |
| `DB_USER`           | **Yes**  | Database user                              |
| `DB_PASSWORD`       | **Yes**  | Database password                          |
| `DB_SSL`            | No       | `true` required for Supabase               |
| `ARTIFACT_BASE_URL` | **Yes**  | R2 public base URL                         |
| `APP_VERSION`       | No       | Defaults to `0.1.0`                        |

Secrets are set in the Render service environment. No credentials appear in source.

---

## 7. Rollback

### Backend rollback

1. Revert the offending merge commit on `develop` via a revert PR, **or** use Render's
   "Rollback to previous deploy" on the service dashboard for an immediate revert.
2. Confirm `GET /version` and `GET /config` return the expected values.

### Artifact rollback

Because every prior artifact version remains on R2 and the mobile app reads artifact URLs from
`/config` rather than constructing them, **rolling an artifact back is a `/config` change only —
no re-upload and no mobile release**.

1. Edit the relevant block in `src/routes/config.ts` back to the previous version string, URL,
   hash, and `release_date`.
2. Verify the previous file still returns HTTP 200 on R2 and that its SHA256 matches the hash
   being restored.
3. Open a PR, merge to `develop`, and confirm staging `/config` serves the restored version.

Rollback targets currently available on R2 (all verified HTTP 200):

| Artifact         | Current | Previous versions available |
| ---------------- | ------- | --------------------------- |
| `knowledge_base` | 2.4     | 2.3, 2.2, 2.1               |
| `rules`          | 2.2     | 2.1                         |
| `facilities`     | 1.1     | 1.0                         |

> Rolling an artifact back is a **clinical** change, not just a technical one. It requires
> engineering lead approval, exactly like a forward release.

---

## 8. CI

Two GitHub Actions workflows run on every PR and push to `develop` / `main`:

| Workflow             | Job                | Steps                                            |
| -------------------- | ------------------ | ------------------------------------------------ |
| `Backend CI`         | Lint & Build Check | `npm ci`, `format:check`, `lint`, `tsc --noEmit` |
| `Docker Build Check` | Docker Build       | Buildx build of the production image             |

> **⚠️ Known CI gap:** in `.github/workflows/ci.yml` the TypeScript step is
> `npx tsc --noEmit --skipLibCheck || true`. The trailing `|| true` means **type errors cannot
> fail the build** — a green "Lint & Build Check" does not prove the project type-checks.
> Local `npm run build` does fail on type errors and has been run before every artifact PR in
> E7–E8, so nothing has slipped through, but the CI signal is weaker than it appears.
> Logged here for the engineering lead; fixing it is a one-character change but is a CI
> behaviour change and so is not bundled into a documentation PR.

---

## 9. Local Development

```bash
git clone https://github.com/Wellapath-org/wellapath-backend.git
cd wellapath-backend
git checkout develop
npm install
cp .env.example .env      # fill DB_USER / DB_PASSWORD from the team lead
npm run dev               # starts on PORT (default 3000)
npm run migrate           # idempotent — safe to re-run
```

If port 3000 is already bound by another project, run with `PORT=3001 npm run dev` rather than
killing the other process.
