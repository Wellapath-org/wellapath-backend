# Community auth/data — proof of concept (ADR-001)

> **PoC only. Not approved for release.** Nothing here is deployed. With `COMMUNITY_MODE` unset
> (every current environment) the service registers no Community or auth route, does not load
> Better Auth, opens no Community pool, and `GET /config` is byte-identical.

## What it is

- `src/community/` — a Fastify plugin with Better Auth 1.7.18 mounted at `/v1/auth/*`
  (email OTP, bearer, JWT, two-factor/TOTP plugins) and Community routes at `/v1/community/*`.
- `GET /v1/features` — `{community: disabled|internal|closed_beta|public, community_allowed}`.
  Registered in every mode; constant in `disabled`.
- `src/community/migrations/NNNN_*.{up,down}.sql` — numbered, reversible migrations, run by
  `src/community/migrate.ts` as the migration-owner role.
- `poc/mobile_client/` — a Dart CLI standing in for the Flutter app; `poc/scripts/run-mobile-flow.sh`
  runs it against a locally started server.

## Environment variables (Community only — none are read when `COMMUNITY_MODE` is unset)

| Variable                             | Meaning                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `COMMUNITY_MODE`                     | `disabled` (default) / `internal` / `closed_beta` / `public`. Typos refuse to boot |
| `COMMUNITY_DATABASE_URL`             | Community Postgres, **runtime role** (`community_app`). Never the `DB_*` database  |
| `BETTER_AUTH_SECRET`                 | ≥ 32 chars. Encrypts JWKS private keys and TOTP secrets (see rotation below)       |
| `COMMUNITY_BASE_URL`                 | Public base URL (origin checks)                                                    |
| `COMMUNITY_ALLOWLIST`                | Comma-separated account ids allowed in `internal` / `closed_beta`                  |
| `COMMUNITY_EMAIL_SINK`               | `outbox-file` or `memory` — **test sinks only**; no real email provider in the PoC |
| `COMMUNITY_EMAIL_OUTBOX_DIR`         | Directory for the outbox file sink                                                 |
| `COMMUNITY_ACCESS_TOKEN_TTL_SECONDS` | Access-token (JWT) lifetime, default 900                                           |
| `COMMUNITY_SESSION_TTL_SECONDS`      | Session (refresh credential) lifetime, default 30 days                             |
| `COMMUNITY_STEP_UP_TTL_SECONDS`      | TOTP step-up freshness for privileged actions, default 12 h                        |

An enabled Community under `NODE_ENV=production` **refuses to boot** (the PoC has no production
email sender).

## Test / development separation

- The jest setup sets `COMMUNITY_MODE=''`, so a developer `.env` cannot switch Community on.
- Database suites read only `COMMUNITY_TEST_DATABASE_URL` (owner) and
  `COMMUNITY_TEST_APP_DATABASE_URL` (runtime role). Unset → those suites are **skipped** and say
  so; they never fall back to `DB_*`. They drop and recreate the schema, so point them only at a
  disposable database. Run them with `npm run test:community` (serial).
- Secrets: tests generate a random `BETTER_AUTH_SECRET` per process; the run script generates
  one per run; CI uses throwaway passwords on a job-scoped Postgres container. No secret is
  committed or shared between environments.

## Runbook notes

- **Roles.** Create `community_owner` (owns the schema, runs migrations) and `community_app`
  (DML only). Migration 0001 grants `community_app` DML via default privileges; 0004 revokes
  UPDATE/DELETE/TRUNCATE on `moderation_actions` and adds append-only triggers.
- **First admin.** No admin exists to grant the first role through the audited API, so the
  first admin is set by the migration owner with SQL and recorded in the ops log.
- **Secret rotation.** Rotating `BETTER_AUTH_SECRET` without Better Auth's versioned
  `secrets` / `BETTER_AUTH_SECRETS` breaks JWT signing (JWKS private key) and every TOTP
  enrolment. Adopt versioned secrets before any real data exists.
- **Backup.** `pg_dump -Fc --no-owner -d <direct, non-pooled URL> -f community.dump`.
- **Node.** Better Auth is ESM-only; this CommonJS build loads it through `require(esm)`, which
  needs Node ≥ 20.19 (verified: 20.18.0 fails with `ERR_REQUIRE_ESM`, 20.20.2 and 24.18 work).
