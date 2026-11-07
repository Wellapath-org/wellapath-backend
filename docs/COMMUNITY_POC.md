# Community auth/data (ADR-001) — implementation of contract v1.0-draft

> **Not approved for release. Draft PR, nothing deployed.** With `COMMUNITY_MODE` unset (every
> current environment) the service registers no Community or auth route, does not load Better
> Auth, opens no Community pool, and `GET /config` is byte-identical. Only a constant
> `GET /v1/features` → `{"community":"disabled","community_allowed":false}` exists.

Canonical sources (engineering workspace, not this repo): `COMMUNITY_API_CONTRACT.md` (wins on
conflict), `community_api_v1.openapi.yaml` (copied verbatim, sha-pinned, to
[`docs/community/community_api_v1.openapi.yaml`](community/community_api_v1.openapi.yaml)) and
`ADR_COMMUNITY_AUTH_AND_DATA.md` §8 amendments A1–A4.

## What it is

| Piece             | Where                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point       | `src/community/index.ts`                                                   | `disabled` ⇒ constant `/v1/features` only; enabled ⇒ lazy `import('./enabled')`                                                                                                                                                                                                                                                                                                                                                 |
| Auth facade A1–A9 | `src/community/routes/auth.ts`                                             | `/v1/auth/otp/request`, `/otp/verify`, `/refresh`, `/logout`, `/sessions`, `/sessions/revoke-others`, `/totp/enrol`, `/totp/enrol/confirm`, `/totp/verify`. **Better Auth's own handler is never mounted**; every other `/v1/auth/*` path is 404                                                                                                                                                                                |
| Better Auth       | `src/community/auth.ts`                                                    | Identity/session store only: email-OTP (5 attempts/code), JWT (EdDSA JWKS), two-factor (TOTP), bearer (internal). Limiter **off**, telemetry off, passwords off, no `admin` plugin, versioned `secrets`, no IP/UA tracking                                                                                                                                                                                                      |
| Tokens (A2)       | `src/community/tokens.ts`                                                  | ≤ 15 min EdDSA access JWT (`sub`, `sid` = refresh family id, `iss`, `aud`, `iat`, `exp`, `jti`) + per-request family/session check; opaque single-use `wprt_…` refresh tokens stored as HMAC-SHA-256(pepper_vN); rotation by compare-and-set; reuse or wrong device ⇒ whole family revoked + `auth_events`; 10 s same-device race ⇒ 409 `refresh_race` (F1). Lifetimes: member 30 d / 7 d idle, moderator/admin 12 h / 1 h idle |
| Limiter (A3)      | `src/community/limiter.ts`                                                 | One WellaPath limiter, Postgres fixed-window counters (`rate_limit_counters`), HMAC'd bucket keys, every number from contract §4.2, interim global IP ceilings while `TRUST_PROXY_HOPS` is unset (F2), 429 + `Retry-After` + envelope, 429s on auth audited                                                                                                                                                                     |
| Trusted proxy     | `src/config/trust-proxy.ts`, `src/app.ts`                                  | `TRUST_PROXY_HOPS` = explicit integer hop count (1–10); unset ⇒ socket peer; `true` refused. Applies to the app-wide limiter too (F3)                                                                                                                                                                                                                                                                                           |
| Routes            | `src/community/routes/{me,content,notifications,moderation}.ts`            | Every operation in the OpenAPI file (52), nothing else                                                                                                                                                                                                                                                                                                                                                                          |
| Contract plumbing | `src/community/http.ts`, `context.ts`, `idempotency.ts`                    | Error envelope `{error:{code,message,request_id,details?}}`, `X-Request-Id`, `Cache-Control: no-store`, strict Ajv (reject, never strip), prohibited-key rejection **before** schema validation (+ `community_prohibited_key_rejected` log, key name only), keyset cursors, `Idempotency-Key` (24 h, replay/422/409)                                                                                                            |
| Data rights       | `src/community/data-rights.ts`                                             | Export (contract keys, no secrets) and deletion (PII erased, content tombstoned, evidence kept)                                                                                                                                                                                                                                                                                                                                 |
| Migrations        | `src/community/migrations/0001…0008_*.{up,down}.sql`                       | Reversible; run by `src/community/migrate.ts` as the **owner** role                                                                                                                                                                                                                                                                                                                                                             |
| First admin       | `src/community/bootstrap-admin.ts`                                         | CLI, see below                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Runtime role      | `scripts/community/provision-runtime-role.ts`, `src/community/db-roles.ts` | B2: creates/validates `community_app`, syncs every grant (also re-run by the migration runner)                                                                                                                                                                                                                                                                                                                                  |
| DB TLS policy     | `src/community/db-url.ts`                                                  | B5: runtime URL must say `sslmode=verify-full` for non-local hosts; owner connections are forced to it                                                                                                                                                                                                                                                                                                                          |
| Neon readiness    | `scripts/community/neon-connectivity-poc.ts`                               | A4 PoC script (+ B4 `--latency-only --gate`), see below                                                                                                                                                                                                                                                                                                                                                                         |
| Mobile stand-in   | `poc/mobile_client/`, `poc/scripts/run-mobile-flow.sh`                     | Dart CLI against the facade (refresh token persisted 0600, access token in memory)                                                                                                                                                                                                                                                                                                                                              |

## Environment variables (none is read when `COMMUNITY_MODE` is unset)

| Variable                                             | Meaning                                                                                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMUNITY_MODE`                                     | `disabled` (default) / `internal` / `closed_beta` / `public`. A typo refuses to boot. `public` is not permitted until the PUBLIC gate                                                                             |
| `COMMUNITY_DATABASE_URL`                             | Community Postgres, **runtime role** (`community_app`), pooled URL on Neon. Never the `DB_*` database. A non-local host without an explicit `sslmode=verify-full` refuses to boot (B5; the value is never echoed) |
| `COMMUNITY_DATABASE_URL_DIRECT`                      | **Not used at runtime.** Owner role, direct (non-pooled) URL, for `community:migrate`, `community:provision-runtime-role` and dumps only. Never set it on Render                                                  |
| `BETTER_AUTH_SECRETS`                                | `"<version>:<secret>,…"` (≥ 32 chars each, newest = highest version). Encrypts the JWKS private key and TOTP secrets. `BETTER_AUTH_SECRET` (single) is accepted as version 1                                      |
| `COMMUNITY_REFRESH_PEPPERS`                          | `"<version>:<secret>,…"`, **required**, distinct from the auth secrets. Keys the refresh-token HMAC (and, derived, the email/IP/bucket HMACs)                                                                     |
| `COMMUNITY_ALLOWLIST`                                | Comma-separated account ids allowed in `internal` / `closed_beta` (moderators/admins are implicitly allowed)                                                                                                      |
| `COMMUNITY_BASE_URL`                                 | Public base URL (Better Auth origin checks)                                                                                                                                                                       |
| `COMMUNITY_EMAIL_SINK`, `COMMUNITY_EMAIL_OUTBOX_DIR` | **Test sinks only** (`outbox-file` / `memory`). The Resend sender is not implemented; an enabled Community refuses to boot under `NODE_ENV=production`                                                            |
| `COMMUNITY_ACCESS_TOKEN_TTL_SECONDS`                 | Default and maximum 900                                                                                                                                                                                           |
| `COMMUNITY_STEP_UP_TTL_SECONDS`                      | TOTP step-up freshness, default and maximum 12 h                                                                                                                                                                  |
| `COMMUNITY_OTP_REQUEST_MIN_MS`                       | Response-time padding of `otp/request`, default 400 ms                                                                                                                                                            |
| `TRUST_PROXY_HOPS`                                   | App-wide. Measured hop count; unset until measured on staging                                                                                                                                                     |

## Running the tests

```sh
# Node 22 (A1): engines ">=22", .nvmrc, CI and Docker all say 22.
source ~/.nvm/nvm.sh && nvm use
npm test                                   # no Community DB: DB suites are SKIPPED (and say so)

# With a disposable LOCAL PostgreSQL 18 (B1: same major as Neon). Owner with CREATEROLE (like
# Neon's owner); community_app created by the provisioning script (or pre-created NOINHERIT):
#   initdb -D <scratch> -U postgres --auth=trust; pg_ctl -D <scratch> -o "-p 55818" start
#   psql -h 127.0.0.1 -p 55818 -U postgres -c "CREATE ROLE community_owner LOGIN CREATEROLE"
#   psql ... -c "CREATE DATABASE wellapath_community_test OWNER community_owner"
#   COMMUNITY_DATABASE_URL_DIRECT=postgres://community_owner@127.0.0.1:55818/wellapath_community_test \
#     npm run community:provision-runtime-role -- --runtime-env-out <scratch>/local.runtime.env --verify
export COMMUNITY_TEST_DATABASE_URL=postgres://community_owner@127.0.0.1:55818/wellapath_community_test
export COMMUNITY_TEST_APP_DATABASE_URL=postgres://community_app@127.0.0.1:55818/wellapath_community_test
export PG_DUMP_BIN=/opt/homebrew/opt/postgresql@18/bin/pg_dump
npx jest --runInBand                       # everything, serially (DB suites share one database)
```

The DB suites drop and recreate the schema: point them only at a disposable database. They never
read `DB_*`. Secrets in tests are random per process.

## Runbook notes

- **Roles (B2).** The owner role owns the schema and runs migrations (`npm run community:migrate
-- up` with `COMMUNITY_DATABASE_URL_DIRECT` = the **direct, owner** URL). `community_app` is the
  runtime role, provisioned once per branch with `npm run community:provision-runtime-role --
--runtime-env-out <private path> --verify` (idempotent; the generated password goes only to
  that mode-600 file). Privileges: DML on ordinary tables, **SELECT + INSERT only** on
  `moderation_actions` and `auth_events` (also trigger-protected for every role), SELECT only on
  `spaces` and `community_schema_migrations`, USAGE/SELECT on sequences, no DDL, TRUNCATE,
  REFERENCES, TRIGGER, TEMP or CREATE anywhere, no role attributes, no memberships. `migrate up`
  re-applies every grant and **fails** on a table not classified in `src/community/db-roles.ts`
  (which then has no runtime privilege). Optional `--with-readonly` defines `community_readonly`
  (NOLOGIN, column-limited SELECT, no auth/session/token tables, no email, no reasons/evidence,
  no author/reporter ids). Full matrix: `DATABASE_ACCESS_MATRIX.md` (engineering repo). Keep the
  owner credential out of Render.
- **TLS (B5).** Runtime: `COMMUNITY_DATABASE_URL` must carry `sslmode=verify-full` for any
  non-local host or the service refuses to start. Owner tools (`community:migrate`,
  `community:bootstrap-admin`, `community:provision-runtime-role`, the Neon script) **force**
  `sslmode=verify-full` for non-local hosts in their connection config, so a console-issued URL
  with `sslmode=require` works unedited. Local hosts (localhost, 127.0.0.0/8, ::1, sockets) are
  exempt.
- **First admin (bootstrap CLI).** There is no bootstrap endpoint. As the migration owner:

  ```sh
  COMMUNITY_OWNER_DATABASE_URL=<direct owner URL> \
    npm run community:bootstrap-admin -- --email founder@example.org
  # or COMMUNITY_BOOTSTRAP_ADMIN_EMAIL=founder@example.org
  ```

  It refuses if any admin exists, creates (or promotes) the account **with no password** (accounts
  are email-OTP only), revokes its sessions and writes a `change_role` audit row (`via:
bootstrap-cli`). Record the printed account id in the ops log. The admin then signs in with an
  email OTP and **must enrol TOTP** (`/v1/auth/totp/enrol` + `/confirm`) before any privileged
  action. Every later admin/moderator is granted through `POST
/v1/community/admin/accounts/{id}/role` (admin + TOTP step-up, audited, revokes the target's
  sessions).

- **Privileged accounts.** Individual accounts only. Gate order on every `/mod` and `/admin`
  route: role → TOTP enrolled (`mfa_enrollment_required`) → step-up on this session within 12 h
  (`mfa_step_up_required`). 5 consecutive TOTP failures revoke the session and lock TOTP for
  15 minutes. Lost authenticator: backup code, then admin `totp-reset`, then re-enrol.
- **Secret rotation.** Add a new version to `BETTER_AUTH_SECRETS` / `COMMUNITY_REFRESH_PEPPERS`
  (newest first); keep the old one until every family issued under it has expired (30 days).
- **Backup (B1).** `pg_dump -Fc --no-owner -d <direct, non-pooled URL> -f community.dump` with
  **PostgreSQL 18** client tools (`pg_dump`/`pg_restore` 18.x; the Neon server is 18.6 and an
  older `pg_dump` refuses to dump it). macOS: `/opt/homebrew/opt/postgresql@18/bin`; Debian/
  Ubuntu: `postgresql-client-18` (`/usr/lib/postgresql/18/bin`). CI uses `postgres:18`.
- **Data rights while disabled.** With the kill switch off, export/deletion go through the ops
  runbook (SQL as the owner role, recorded in the ops log).

## Neon connectivity PoC (A4, B1, B4)

Run 2026-11-07 against the WellaPath Neon `development` branch from the engineer's Mac (6/6 PASS,
see `POC_COMMUNITY_AUTH_RESULTS.md`); not yet from Render Frankfurt. Full mode (destructive,
throwaway branch only):

```sh
COMMUNITY_DATABASE_URL=<branch pooled URL, community_app, sslmode=verify-full> \
COMMUNITY_DATABASE_URL_DIRECT=<branch direct URL, owner role> \
COMMUNITY_RESTORE_CHECK_URL=<empty scratch database, direct URL> \
NEON_POC_CONFIRM_BRANCH=yes PG_BIN=<PostgreSQL 18 client bin dir> \
  npm run community:neon-poc -- --runs 50 --out neon-connectivity-report.md
```

It reports connect/query latency p50/p95 (pooled and direct), a 100-query pooled-connection
exercise, a migration down/up round trip **on the branch** (destructive there, hence the
confirmation variable), failure handling (Community DB host unresolvable ⇒ `/config` 200 and
byte-identical, `/v1/features` `disabled`, auth 503) and `pg_dump` → `pg_restore` (v18 tools)
with per-table row counts compared. Connection strings are never printed.

**B4 latency gate (read-only, safe on staging):** `npm run community:neon-poc -- --latency-only
--gate --runs 100 --out neon-latency.md` with only `COMMUNITY_DATABASE_URL` (runtime role) set.
Exits 1 unless pooled query p95 < 20 ms and new-connection p95 < 150 ms. Run it from Render
Frankfurt; see `docs/COMMUNITY_STAGING_RUNBOOK.md`.
