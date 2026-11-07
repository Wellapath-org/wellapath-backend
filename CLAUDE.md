# WellaPath Backend — Claude Code Instructions

> Read this file and `PROGRESS.md` (Current Status) before touching any code.
> Rewritten 2026-11-07 to match the stack as it actually runs. The original E1 brief
> (AWS ECS/RDS/S3/CloudFront) is superseded; see "History" at the end.

---

## 0. Non-negotiables

- WellaPath is a **CDSS — not a diagnosis engine**. Never represent it as one.
- **No symptom-level PHI stored server-side**, under any circumstances. The backend has no PHI
  intake surface; keep it that way.
- **Scoring and triage logic execute on-device only** — never on the server.
- **All artifact changes are versioned. Never overwrite an existing artifact version.**
- **Red-flag override always takes priority** over scoring output (enforced on-device).
- **No secrets in source.** Credentials live in a local `.env` (never committed) or in the Render
  service environment. This repository is **public** on GitHub.
- **No infrastructure identifiers in tracked files** — no cloud account IDs, ARNs, database
  endpoints or usernames, even for decommissioned infrastructure.
- **No feature additions outside approved scope; no architecture changes** without founder +
  engineering-lead review.
- **Artifact versions served by `/config` are frozen** (E9.1 freeze + distribution baseline). Any
  change, forward or rollback, needs engineering-lead approval and a re-observed baseline.

---

## 1. What this service is

A Fastify + TypeScript service whose product job is `GET /config`: a **hash-locked manifest** of
the clinical and facility artifacts the mobile app downloads from Cloudflare R2 and verifies by
sha256 on-device. It stores no user data.

| Item        | Value                                                                                |
| ----------- | ------------------------------------------------------------------------------------ |
| Repository  | `Wellapath-org/wellapath-backend` (public)                                           |
| Language    | TypeScript (strict), Node.js — CI and Docker use Node 20                             |
| Framework   | Fastify 5, Pino logging, `@fastify/rate-limit`, `@fastify/cors`                      |
| Runtime     | **Render** (Docker web services)                                                     |
| Artifacts   | **Cloudflare R2**, public base `https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev` |
| Database    | **Optional.** Supabase PostgreSQL on staging; **disabled in production**             |
| Dev machine | **macOS** (zsh). Use absolute paths; no Windows/Git Bash steps apply.                |

### Environments

| Environment | Render service                 | Public URL                                       | Deploys from |
| ----------- | ------------------------------ | ------------------------------------------------ | ------------ |
| Staging     | `wellapath-backend-staging`    | `https://wellapath-backend-staging.onrender.com` | `develop`    |
| Production  | `wellapath-backend-production` | `https://api.wellapath.org`                      | `production` |

Full detail — Auto-Deploy settings, how production moves, rollback — is in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Production environment variables are listed (names
and safe values only) in [`docs/PRODUCTION_PROVISIONING.md`](docs/PRODUCTION_PROVISIONING.md) §3.

### Endpoints

| Method | Path                   | Notes                                                          |
| ------ | ---------------------- | -------------------------------------------------------------- |
| GET    | `/health`              | `checks.database` is `ok`, `error`, or `disabled` (production) |
| GET    | `/version`             | `APP_VERSION` + `NODE_ENV`                                     |
| GET    | `/config`              | Hardcoded literal in `src/routes/config.ts`; frozen by tests   |
| POST   | `/v1/telemetry/events` | Off unless `TELEMETRY_ENABLED=true`; answers 503 when off      |
| GET    | `/internal/metrics`    | Hard-disabled (404) in production regardless of configuration  |

---

## 2. Branches

| Branch       | Role                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `develop`    | Integration branch. **Branch off it; open every PR against it.** Staging tracks it.                                               |
| `production` | What production runs. Moved only by fast-forward to an approved `develop` commit — a founder action. Never commit to it directly. |
| `main`       | Stale E1 scaffold. Not deployed; do not use.                                                                                      |

- Never push directly to `develop` or `production`. No force-pushes, no history rewrites.
- Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`, `ci/…`.
- Prefer a separate `git worktree` for task work rather than switching the main checkout.

---

## 3. Commits (commitlint + Husky)

```
type(scope): short description in lowercase
```

- Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `style`, `revert`.
- Subject lowercase, ≤ 100 characters, no trailing full stop. Body lines ≤ 200 characters.
- `pre-commit` runs `lint-staged` (ESLint + Prettier on staged files).

---

## 4. Code style

TypeScript strict · single quotes · semicolons · print width 100 · 2-space indent · trailing
commas · omit parens for single-argument arrows · explicit return types · **no `console.log`**
(use the Pino logger) · no secrets in code. Enforced by ESLint (`eslint.config.js`) and Prettier.

---

## 5. Layout

```
src/
  app.ts            # buildApp(): Fastify instance, CORS, rate limit, plugins, routes (no listen)
  server.ts         # builds the app and listens on 0.0.0.0:PORT
  config/env.ts     # all environment parsing; fails fast on invalid values
  routes/           # health, version, config, telemetry, metrics
  plugins/          # db (only when DATABASE_ENABLED), error-handler, security-headers, metrics
  telemetry/        # privacy-safe telemetry contract v1.0 (disabled by default)
  manifest/         # INACTIVE candidate manifest contract + ingestion/registry (not served)
  db/migrate.ts     # idempotent schema migration (refuses to run while the DB is disabled)
  artifacts/        # E1 placeholder JSON — not served, not a source of truth
tests/              # unit, integration, privacy, regression, performance, baseline (jest)
docs/               # deployment, release process, baseline, telemetry, contracts
```

---

## 6. Local development (macOS)

```bash
npm ci
cp .env.example .env            # never commit .env; never print its contents
# Simplest: no database needed for any product route
DATABASE_ENABLED=false npm run dev
```

Production-profile boot, as used to verify a release or rollback candidate:

```bash
npm run build
NODE_ENV=production DATABASE_ENABLED=false TELEMETRY_ENABLED=false APP_VERSION=0.3.0 \
  ARTIFACT_BASE_URL=https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev PORT=3917 \
  node dist/server.js
```

Use a free port rather than killing whatever holds 3000.

### Environment variables

`NODE_ENV`, `PORT` (default 3000), `DATABASE_ENABLED` (default `true`; exactly `true`/`false`,
anything else refuses startup), `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`/`DB_SSL`
(required only while the database is enabled), `ARTIFACT_BASE_URL` (required), `APP_VERSION`,
the `TELEMETRY_*` set (see `.env.example` and `docs/TELEMETRY_OPERATIONS.md`), and
`METRICS_ENDPOINT_ENABLED` (ignored in production).

---

## 7. Before opening a PR

Run exactly what CI runs (`.github/workflows/ci.yml`):

```bash
npm ci
npm run format:check
npm run lint
npx tsc --noEmit --skipLibCheck
npm run telemetry:contract:check
npm test
```

Also: `npm run build` succeeds; no `.env`, `node_modules/` or `dist/` staged; no secrets or
infrastructure identifiers in the diff; PR targets `develop`.

**`/config` is frozen.** `tests/regression/existing-endpoints.test.ts` and
`tests/baseline/baseline-drift.test.ts` (against `docs/baseline/distribution-baseline.v1.json`)
fail on any change to it. Do not edit those literals to make a test pass — an artifact change
follows `docs/ARTIFACT_RELEASE_PROCESS.md` and `docs/DISTRIBUTION_BASELINE.md`, including a
genuine staging observation.

---

## 8. Artifacts — rules that have bitten before

- The backend **verifies and distributes**; it does not author artifact content or hashes.
  Recompute every sha256 from the R2 object yourself before wiring it.
- **Rollback targets must exist on R2 and be re-verified (HTTP 200 + recomputed sha256) at the
  time they are documented or used.** `facilities` v1.1 was deliberately deleted from R2 on
  2026-09-29 and is **not** a valid rollback target; the facilities rollback target is v1.0
  (PR #40).
- Devices cache artifacts **by version** and do not sweep old versions. Removing an object from
  R2 stops it being served; it does not remove it from devices.

---

## 9. Out of scope for this repo

The Flutter mobile app, the knowledge-base / rules generation pipeline, and artifact source
content live in other repositories. Requests to change them here are flagged and held.

---

## History

Earlier versions of this file (and of `PROGRESS.md`) documented the decommissioned AWS staging
stack, including account identifiers, secret ARNs and a database endpoint/username. Those values
were removed from the tracked files on 2026-11-07, but **they remain in Git history** of this
public repository. Whether to remediate history (rewrite + force-push, which would also
invalidate forks and clones) is a **founder decision**; it has not been done. The underlying AWS
resources are reported decommissioned — confirming that they no longer exist (and that the
referenced secrets were deleted or rotated) is the real mitigation and is also a founder action.
