# Community on staging: runbook (ADR-001 B1–B5)

**Status:** prepared, **not executed on staging**. Engineering has no staging Neon credentials and
has not touched the Render staging service. Every step below that needs a credential or a
dashboard is a **founder action** (or is done by engineering only after the founder hands over the
owner credential privately). Development was done first: the three-role model, the Resend sender
and the sign-in retention purge are implemented, and the three-role model is **verified on the
Neon `development` branch** (2026-11-07; booleans and denied operations in `DATABASE_ACCESS_MATRIX.md`, engineering repo).

Variable **names** only appear here. No value, host or connection string is ever written to this
repository, a PR, a log or a chat.

### Database roles (three-role model, B2)

| Role                 | Kind                                                                                         | Used by                                                                                   | Credential file (private, mode 600)             |
| -------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `neondb_owner`       | Neon-managed branch owner (CREATEROLE, BYPASSRLS, `neon_superuser`). **Break-glass/admin**   | `provision-runtime-role.ts` only. The ownership model **cannot constrain it**             | `neon/staging.env` (provided by the founder)    |
| `community_owner`    | NOLOGIN. Owns the schema and every table, sequence, function and trigger                     | nobody logs in; reached only by `SET ROLE` from the migrator                              | none                                            |
| `community_migrator` | LOGIN, NOINHERIT. Only membership: `community_owner` WITH INHERIT FALSE, SET TRUE            | `migrate.ts`, `bootstrap-admin.ts`, `pg_dump --role=community_owner`, over the DIRECT URL | `neon/staging.migrator.env` (generated)         |
| `community_app`      | LOGIN runtime role, member of no role; DML per table class; cannot SET ROLE, DDL or TRUNCATE | the backend on Render (POOLED URL, `sslmode=verify-full`)                                 | `neon/staging.runtime.env` (generated) → Render |

Neon roles are **branch-wide**: create no role on a Neon branch beyond these three (in
particular never `community_readonly`; the provisioning script refuses `--with-readonly` against
a non-local host).

## 0. Staging Supabase database: retirement approved

Staging's ops database was the Supabase free tier. It paused 5+ times (again on 2026-11-07), so
staging `/health` answered **503**, blocking staging deploys and the rollback test regardless of
Community. **Retirement is approved:** the founder sets `DATABASE_ENABLED=false` on the Render
staging service (as production already runs). `/health` then reports `checks.database:
disabled` with 200 and nothing writes the ops tables. Deleting the Supabase project is a separate,
later change. Community never uses `DB_*` / `DATABASE_ENABLED`; the two are independent.

## 1. Prerequisites

- [ ] **Neon staging owner credential**, provided by the founder **privately** (never in chat,
      PR or repo) as `wellapath-private-data/neon/staging.env` (mode 600, outside any
      repository) with keys `COMMUNITY_DATABASE_URL` (pooled) and `COMMUNITY_DATABASE_URL_DIRECT`
      (direct), both as `neondb_owner` on the `staging` branch of the `wellapath-community`
      project. Never `source` it (values contain `&`); load it with
      `DOTENV_CONFIG_QUIET=true DOTENV_CONFIG_PATH=<file> node -r dotenv/config …`.
- [ ] **Resend configuration**, provided by the founder as
      `wellapath-private-data/resend/staging.env` (mode 600) with keys `RESEND_API_KEY` and
      `COMMUNITY_EMAIL_FROM` (an address on a Resend-verified sending domain with SPF/DKIM). The
      founder sets both in Render (§3); engineering never prints them. To exercise it locally, load
      it the same way (`DOTENV_CONFIG_PATH=…/resend/staging.env`), never with `source`.
- [ ] **Compute cap (B3):** staging branch autoscaling **min 0.25 CU, max 0.25–0.5 CU**,
      scale-to-zero on. Record a screenshot/API read of the compute settings (date, min, max,
      suspend timeout) in the ops log.
- [ ] Node 22 (`nvm use 22`) and **PostgreSQL 18 client tools** (B1) on the machine that runs the
      operator steps: macOS `/opt/homebrew/opt/postgresql@18/bin`, Debian/Ubuntu
      `postgresql-client-18`.
- [ ] Backend branch containing this work checked out, `npm ci && npm run build`.
- [ ] Render staging service `wellapath-backend-staging` deploys an image built from a commit
      that contains the Community code (only after PR #44 is approved and merged into `develop`;
      not before).
- [ ] Decision 0 applied (`DATABASE_ENABLED=false` on staging, founder).

## 2. Operator steps (direct URL, from the operator machine)

```sh
cd wellapath-backend && source ~/.nvm/nvm.sh && nvm use 22
PRIV=<path>/wellapath-private-data/neon
export DOTENV_CONFIG_QUIET=true
run() { node -r dotenv/config -r ts-node/register "$@"; }

# 2.1 As the BRANCH OWNER: create community_owner, community_migrator and community_app,
#     transfer ownership of anything neondb_owner owns in the schema to community_owner, set
#     default privileges FOR ROLE community_owner, sync grants. Each generated password goes
#     ONLY to its new mode-600 file; neither file may exist yet. No --with-readonly on Neon.
DOTENV_CONFIG_PATH=$PRIV/staging.env run scripts/community/provision-runtime-role.ts \
  --runtime-env-out $PRIV/staging.runtime.env --migrator-env-out $PRIV/staging.migrator.env --verify
#   expect: three roles CREATED (or "already existed"), "Three-role model verified …".
#   On an empty branch --verify reports only "append-only triggers missing" until 2.2 has run.

# 2.2 Migrate as the MIGRATOR over the DIRECT URL (the runner SETs ROLE community_owner per
#     transaction and RESETs it after; a -pooler host is refused; sslmode forced to verify-full).
DOTENV_CONFIG_PATH=$PRIV/staging.migrator.env run src/community/migrate.ts status
DOTENV_CONFIG_PATH=$PRIV/staging.migrator.env run src/community/migrate.ts up
DOTENV_CONFIG_PATH=$PRIV/staging.migrator.env run src/community/migrate.ts up   # expect: up: []

# 2.3 Re-run provisioning: idempotent (no password generated, 0 objects transferred), and
#     --verify must report no violation.
DOTENV_CONFIG_PATH=$PRIV/staging.env run scripts/community/provision-runtime-role.ts --verify
```

Pipe any output you paste anywhere through
`sed 's#postgres\(ql\)\?://[^ ]*#<redacted>#g; s#[a-z0-9.-]*neon\.tech#<redacted-host>#g'`.
The tools never print a URL, host or password, but treat that as belt and braces.

Record in `DATABASE_ACCESS_MATRIX.md`: branch `staging`, date, the `--verify` booleans.

## 3. Render staging environment (names only; values from the private files, set by the founder)

| Variable                                | Value source / rule                                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_ENABLED`                      | `false` (decision 0: Supabase retired on staging)                                                                                                                                                                                    |
| `COMMUNITY_MODE`                        | `internal`                                                                                                                                                                                                                           |
| `COMMUNITY_DATABASE_URL`                | the `COMMUNITY_DATABASE_URL` line of `staging.runtime.env`: **`community_app`**, **pooled** host, **`sslmode=verify-full`** (anything else refuses to boot, B5)                                                                      |
| `COMMUNITY_DATABASE_URL_DIRECT`         | **Do not set.** Neither the owner nor the migrator credential ever goes to Render                                                                                                                                                    |
| `BETTER_AUTH_SECRETS`                   | versioned: `1:<≥ 32 random chars>` (generate fresh for staging; never reuse dev/prod)                                                                                                                                                |
| `COMMUNITY_REFRESH_PEPPERS`             | versioned: `1:<≥ 32 random chars>`, distinct from the auth secrets                                                                                                                                                                   |
| `COMMUNITY_BASE_URL`                    | the staging service's public base URL                                                                                                                                                                                                |
| `COMMUNITY_ALLOWLIST`                   | comma-separated account ids of the internal testers (empty at first; add ids after their first sign-in)                                                                                                                              |
| `COMMUNITY_INTERNAL_TESTER_EMAILS`      | **internal mode only** (F-077): comma-separated exact emails of approved testers; a tester is allowed on first OTP sign-in (verified email, server-side). No wildcards or domains; malformed → boot refused. Requires migration 0011 |
| `COMMUNITY_WEBSITE_ORIGIN`              | leave **unset**: website `/admin` calls the API from its Next server, so no browser grant is needed (C8)                                                                                                                             |
| `COMMUNITY_EMAIL_PROVIDER`              | `resend`. The image runs `NODE_ENV=production`, where an enabled Community refuses the test sinks and boots only with `resend`. Do **not** override `NODE_ENV`                                                                       |
| `RESEND_API_KEY`                        | from `resend/staging.env`. Validated at boot (shape only), never logged or echoed                                                                                                                                                    |
| `COMMUNITY_EMAIL_FROM`                  | from `resend/staging.env`, e.g. `WellaPath <no-reply@…>` on the verified domain                                                                                                                                                      |
| `COMMUNITY_EMAIL_TIMEOUT_MS`            | optional, default 5000 (1000–15000)                                                                                                                                                                                                  |
| `COMMUNITY_AUTH_PURGE_INTERVAL_SECONDS` | optional, default 900 (60–3600): sign-in retention purge                                                                                                                                                                             |
| `CLIENT_IP_SOURCE`                      | `cf-connecting-ip` once §5 verification passes on every hostname. `TRUST_PROXY_HOPS` stays **unset** (mutually exclusive; refused at boot)                                                                                           |

**Resend sender (implemented).** One HTTPS POST to `https://api.resend.com/emails` per OTP
(plain-text + HTML, no clinical content), 5 s timeout, **no retry** (an ambiguous failure must not
deliver two codes), a per-message `Idempotency-Key`. A provider failure answers **503
`community_unavailable`** with `details.reason = "email_unavailable"`; the client retries later.
Logs carry only the provider name and the failure class, never the key or a recipient address.

**Sign-in retention (implemented).** Pending email-OTP `verification` rows (their identifier
contains the address) are purged by the service itself as `community_app`: once expired (codes
live 5 minutes) and after 23 h at the latest, every `COMMUNITY_AUTH_PURGE_INTERVAL_SECONDS`. The
same purge is a CLI (`node dist/community/purge.js`, runtime URL) if a Render cron job is ever
wanted. No full email address appears in the service logs (every line is scrubbed to
`j***@example.com`).

Then trigger a deploy of the approved commit and check:

- `/health` 200 with `database: disabled` (decision 0), `/config` byte-identical to production,
  `/v1/features` 200.
- Startup log has no `Refusing to start` / `Refusing to boot` line (B5, email provider), and shows
  `community_email_provider` `resend`.

## 4. B4 latency gate from Render Frankfurt (one-off job)

Read-only (connects and runs `SELECT current_setting('server_version')`), so it is safe against
the live staging branch. It uses the **runtime** URL in the service environment, i.e. the real
production path (community_app → Neon pooler, TLS verify-full). It can run **before** Community
is switched on: set `COMMUNITY_DATABASE_URL` on the service and leave `COMMUNITY_MODE` unset
(the app then reads no Community variable). It needs an image that contains
`dist/community/latency-gate.js`, i.e. a deployed commit that includes this work.

Exact command (Render dashboard → `wellapath-backend-staging` → **Jobs** → _Run job_, or the
Render API `POST /v1/services/{serviceId}/jobs` with this `startCommand`):

```sh
node dist/community/latency-gate.js --runs 100 --gate
```

- Gates: **query p95 < 20 ms** and **new-connection p95 < 150 ms** on the pooled URL. Exit code
  0 = PASS, 1 = FAIL. The job log prints p50/p95 and PASS/FAIL only (no URL/host).
- The same measurement is available from the full PoC script
  (`npm run community:neon-poc -- --latency-only --gate`); the compiled `dist/` entry exists so
  the job runs inside the production image, which contains `dist/` but not `scripts/`.
- If the service plan does not offer one-off jobs, run the same command from a Render Shell, or
  from any short-lived Render service in **Frankfurt** built from the same image. A run from
  anywhere else does not satisfy B4.
- Record the job id, timestamp, runs, p50/p95 for both metrics and PASS/FAIL in
  `POC_COMMUNITY_AUTH_RESULTS.md`.

## 5. Security client IP (`CLIENT_IP_SOURCE`), SEC-001 / SEC-002

Every security control keys on ONE address: the app-wide limiter (and the telemetry route limit),
every Community per-IP limit, and the IP HMAC in audit events. It comes from
`src/config/client-ip.ts`:

- `CLIENT_IP_SOURCE` unset or `socket`: `request.ip` (the socket peer). Behind Render that is the
  proxy, so every client shares one bucket, and Community uses the interim **global** ceilings
  (contract F2). Safe but coarse; this is SEC-001.
- `CLIENT_IP_SOURCE=cf-connecting-ip` (**Render only**): the `CF-Connecting-IP` header that Render's
  Cloudflare edge sets to the connecting client. It must be exactly one valid IPv4 or IPv6 address.
  A missing, duplicated, comma-separated or malformed value keys on `unattributed:<socket>` (never
  refused: Render's health checks bypass Cloudflare). `X-Forwarded-For`, `Forwarded`,
  `X-Real-IP` and `True-Client-IP` are never read.

**Identity (SEC-026).** IPv4 keys on the full address; IPv6 keys on its canonical **/64**
(`2001:db8:1:2::/64`), so rotating addresses inside one /64 cannot open fresh buckets. IPv4-mapped IPv6
is the IPv4 identity. Limits and audit `ip_hash` use the same identity.

**Unattributed traffic (SEC-027).**

- **What it is:** with `cf-connecting-ip`, a request whose header is missing, empty or malformed is
  _unattributed_. It keys on `unattributed:<socket>`, which the client cannot choose.
- **Limits:** it gets the conservative interim/global Community ceilings, and the app-wide 100/min
  as one shared bucket (never worse than today).
- **Counting and logging:**
  - It is counted in `security.client_ip_unattributed_total{missing,malformed}`, next to
    `client_ip_attributed_total` (non-production `/internal/metrics`).
  - At most once a minute, the app logs a `warn` line `event=security_client_ip_unattributed` with
    `missing`, `malformed` and `attributed` counts. The line never contains an IP.
- **Alerting (production):** Render's health checks are expected to produce a small, steady
  `missing` count. Alert on the log line when `missing + malformed` rises well above that baseline,
  or exceeds about 20% of `attributed`. A sustained jump means the edge header has stopped arriving
  and per-client limits are degraded.

**Why not an `X-Forwarded-For` hop count (`TRUST_PROXY_HOPS`)?**

- Cloudflare **appends** to a client-supplied `X-Forwarded-For`, so its left side is attacker-controlled.
- A hop count is only safe if every path has the same number of appending proxies.
- That number cannot be found from outside without running, at least briefly, with a value that permits spoofing.
- `TRUST_PROXY_HOPS` must stay **unset** on Render. The app refuses to boot with both set.

**Verification (per environment, per hostname; no spoofable window).** Run
`staging-e2e/xff-probe.mjs` (engineering workspace) with `PROBE_BASE=https://<host>`. It sends
only `GET /health` with documentation-range addresses, reads the app-wide limiter's
`x-ratelimit-remaining`, and prints bucket counts only. It never prints a real IP. Pass criteria with
`CLIENT_IP_SOURCE=cf-connecting-ip` live:

| Check                                                                                                                 | Pass                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeated requests, no forged header                                                                                   | One bucket (remaining decreases by 1 per request)                                                                                                 |
| Forged `X-Forwarded-For` (single and 7-entry lists, each position varied), `Forwarded`, `X-Real-IP`, `True-Client-IP` | Never a fresh bucket: the same bucket as the client                                                                                               |
| Forged `CF-Connecting-IP`                                                                                             | Rejected at the edge (403), or overwritten (same bucket as the client). **A fresh bucket ⇒ STOP: the header is attacker-controlled on that path** |
| A second client on a different network (e.g. a phone hotspot)                                                         | A different bucket from the first client                                                                                                          |

Record date, host, result table and the edge colo in the ops log, never the IPs. Repeat whenever
Render, Cloudflare or DNS routing changes (for example if `wellapath.org` DNS moves to a
WellaPath-owned Cloudflare zone, which would put a second Cloudflare in front: re-verify).

## 6. Smoke test on staging (engineering-only)

Same flow as development (`POC_COMMUNITY_AUTH_RESULTS.md`): sign in with an email OTP; bootstrap
one throwaway admin with the bootstrap CLI (`staging.migrator.env`, direct URL, it SETs ROLE
`community_owner`); TOTP enrol + step-up; one audited moderation action; delete every test account
through `POST /v1/community/me/delete` (demote the admin first). Staging sends **real email**
through Resend (there is no outbox under `NODE_ENV=production`), so the test addresses must be
inboxes the tester can read (a founder-controlled mailbox with plus-addressing), not
`@example.invalid`. After the run, confirm 0 live test accounts; pending OTP rows disappear by
themselves through the retention purge.

## 7. Rollback

- **Instant:** Render staging `COMMUNITY_MODE=disabled` (or unset) and redeploy/restart. The
  service then reads no Community variable, opens no pool and registers no auth or Community
  route; `/config` is unaffected (tested). No data is touched.
- **Credential:** if the runtime credential is suspect, rotate it
  (`provision-runtime-role.ts --rotate-password --runtime-env-out <file>`, branch owner, direct
  URL) and update the Render variable; the old password stops working at the next connection.
  The migrator: `--rotate-migrator-password --migrator-env-out <file>` (not on Render, no deploy).
  `neondb_owner`: Neon console → Roles → Reset password.
- **Email:** `RESEND_API_KEY` suspect ⇒ revoke it in Resend, create a new one, update Render.
- **Schema:** never run `migrate down` on staging once real testers have data; roll forward.
- **Neon:** the branch can be reset or restored from history (B6 drill on a non-production
  branch before public release).

## 8. Checklist

- [ ] Decision 0 applied (staging `DATABASE_ENABLED=false`, founder) and `/health` is 200
- [ ] `neon/staging.env` received privately; stored mode 600 outside any repo
- [ ] `resend/staging.env` received privately (`RESEND_API_KEY`, `COMMUNITY_EMAIL_FROM`); sending
      domain verified in Resend (SPF/DKIM)
- [ ] Staging compute capped at 0.25–0.5 CU (B3), evidence recorded
- [ ] PG18 client tools present (B1)
- [ ] `provision-runtime-role --verify` (as `neondb_owner`): three roles, `staging.runtime.env` and
      `staging.migrator.env` written (mode 600); no role other than the three created
- [ ] `migrate up` as `community_migrator` applied, second run `up: []`
- [ ] Re-run `--verify`: 0 objects transferred, no violation
- [ ] `DATABASE_ACCESS_MATRIX.md` updated for `staging` (date + booleans)
- [ ] Render env set by name (§3); `COMMUNITY_DATABASE_URL` is `community_app`, pooled,
      `sslmode=verify-full`; no owner or migrator URL on Render; `COMMUNITY_EMAIL_PROVIDER=resend`
- [ ] Deploy of an approved commit; no `Refusing to start` / `Refusing to boot`; `/config`
      byte-identical
- [ ] B4 job from Render Frankfurt: query p95 < 20 ms, connect p95 < 150 ms, recorded
- [ ] `CLIENT_IP_SOURCE=cf-connecting-ip` set and §5 verification passed on every hostname (`TRUST_PROXY_HOPS` unset)
- [ ] Smoke test passed (real inbox); test accounts deleted
- [ ] Rollback (`COMMUNITY_MODE=disabled`) rehearsed once
