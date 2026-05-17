# WellaPath Backend — Build Progress Log

> **Claude Code: Read this file at the start of every session alongside CLAUDE.md.**
> This log tells you exactly what has been built, what was fixed, and where we left off.
> Never repeat completed steps. Pick up from the CURRENT STATUS section.

---

## Current Status

**Phase:** E2.5 — complete
**Stage:** Backend fully aligned with E2.5. Awaiting E3 mobile engine work. No pending backend tasks.

**Next backend action:** Support mobile team during E3 if any `/config` or artifact changes are needed.

**Completed:**

- PR #2 merged → `develop` (E1.1 backend init + E1.2 core endpoints)
- PR #3 merged → `develop` (Dockerfile fix)
- PR #4 merged → `develop` (E1.3 database foundation)
- PR #5 merged → `develop` (E1.4 security baseline)
- PR #6 merged → `develop` (E1.5 artifact distribution skeleton)
- PR #11 merged → `develop` (E2.5 real artifact wiring — `/config` returns live R2 URLs + sha256 hashes)
- Infrastructure migrated from AWS to Supabase + Cloudflare R2 + Render
- `fix/db-ssl-health-logging` branch pushed — SSL support, health check error logging, env/config cleaned up, README updated

---

## Infrastructure

| Component | Old (AWS)                                               | New                                                           |
| --------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| Database  | RDS PostgreSQL (`wellapath-staging-db.cclsme0gujar...`) | Supabase PostgreSQL (`aws-0-eu-west-1.pooler.supabase.com`)   |
| Artifacts | S3 + CloudFront (`d179u2ex0g66o3.cloudfront.net`)       | Cloudflare R2 (`pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev`) |
| API host  | ECS Fargate (`api-staging.wellapath.org`)               | Render Web Service (`wellapath-backend-staging.onrender.com`) |

---

## Branches

| Branch                              | Status             | PR        |
| ----------------------------------- | ------------------ | --------- |
| `feature/e1-backend-init`           | Merged → `develop` | PR #2 ✅  |
| `fix/dockerfile-remove-prod-npm-ci` | Merged → `develop` | PR #3 ✅  |
| `feature/e1-database-foundation`    | Merged → `develop` | PR #4 ✅  |
| `feature/e1-security-baseline`      | Merged → `develop` | PR #5 ✅  |
| `feature/e1-artifact-skeleton`      | Merged → `develop` | PR #6 ✅  |
| `feature/e2-config-real-artifacts`  | Merged → `develop` | PR #11 ✅ |
| `fix/db-ssl-health-logging`         | Pushed, open       | 3 commits |

---

## What Is Built and Verified ✅

### E1.1 — Backend Project Initialization

- [x] TypeScript + Fastify project structure
- [x] ESLint v9 flat config, Prettier, Husky, Commitlint
- [x] `src/utils/logger.ts` — Pino structured logger
- [x] `src/config/env.ts` — centralized env config with `requireEnv()` validation
- [x] `src/server.ts` — Fastify entry point, `host: '0.0.0.0'`, port 3000, CORS + rate limit
- [x] Dockerfile — multi-stage build, node:20-alpine

### E1.2 — Core Endpoints

- [x] `GET /health` — server + database status
- [x] `GET /version` — app version and environment
- [x] `GET /config` — versioned artifact metadata

### E1.3 — Database Foundation

- [x] `src/plugins/db.ts` — pg Pool plugin on Fastify instance, graceful shutdown
- [x] `src/db/migrate.ts` — idempotent migration script, single transaction
- [x] Tables: `artifact_versions`, `metrics_agg`, `audit_logs`
- [x] `GET /health` updated — includes DB connectivity check (`SELECT 1`)

### E1.4 — Security Baseline

- [x] Global error handler — sanitized 5xx responses, consistent `{ error: { statusCode, message } }` envelope
- [x] CORS tightened — origin allowlist in production, `GET` only
- [x] Rate limit error shaped to match error envelope

### E1.5 — Artifact Distribution Skeleton

- [x] Placeholder artifacts created (`kb.ng.v1.0.json`, `rules.ng.v1.0.json`, `facilities.ng.v1.0.json`)
- [x] `GET /config` returns correct artifact URLs and placeholder hashes

### E2.5 — Real Artifact Wiring

- [x] All 3 artifacts live and verified on Cloudflare R2 CDN:
  - `token_dictionary.ng.v1.0.json`
  - `kb.ng.v1.0.json`
  - `rules.ng.v1.0.json`
- [x] `GET /config` returns real R2 URLs, sha256 hashes, `release_date`, and `country` fields
- [x] Mobile team confirmed artifacts accessible and cacheable on device
- [x] Mobile team unblocked

### Infrastructure Migration (fix/db-ssl-health-logging)

- [x] Database migrated to Supabase — SSL enabled (`DB_SSL=true`, `rejectUnauthorized: false`)
- [x] Artifact CDN migrated to Cloudflare R2
- [x] API hosting migrated to Render Web Service
- [x] `.env.example` updated — AWS vars removed, Supabase + R2 values in place
- [x] `src/config/env.ts` — `awsRegion` removed, `ssl` field added
- [x] `src/plugins/db.ts` — SSL passed to pg Pool
- [x] `src/routes/health.ts` — DB health check errors now logged via `server.log.error`
- [x] `README.md` updated — current stack, live endpoints, local dev setup, non-negotiables

### Staging Verification ✅

| Endpoint     | URL                                                      | Status |
| ------------ | -------------------------------------------------------- | ------ |
| GET /health  | `https://wellapath-backend-staging.onrender.com/health`  | 200 ✅ |
| GET /version | `https://wellapath-backend-staging.onrender.com/version` | 200 ✅ |
| GET /config  | `https://wellapath-backend-staging.onrender.com/config`  | 200 ✅ |

`/config` returning real E2.5 artifact metadata with correct R2 URLs and sha256 hashes.

---

## Key Config Values (Quick Reference)

```
Server port:         3000
Render service:      https://wellapath-backend-staging.onrender.com
Supabase host:       aws-0-eu-west-1.pooler.supabase.com
Supabase port:       6543
R2 base URL:         https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev
DB secret:           via .env locally / Secrets Manager in production
```

---

## What Comes Next

**Backend is complete through E2.5.** No pending backend tasks.

**E3 — Mobile Engine** (mobile team lead)

- Symptom input, scoring logic, and triage engine — executes on-device only
- Backend role: support `/config` or artifact updates if mobile team requires changes during E3

**Backend will be needed again when:**

- New artifact versions are cut (update `artifact_versions` table, upload to R2, update `/config`)
- E3 surfaces any `/config` contract changes required by the mobile engine

---

_Last updated: 2026-05-18 — E2.5 complete, infrastructure migrated to Supabase + R2 + Render, staging verified, mobile team unblocked, README updated, fix/db-ssl-health-logging pushed (3 commits: SSL support + health logging, infra env cleanup, README + PROGRESS docs)_
