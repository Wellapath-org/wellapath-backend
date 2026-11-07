# Community on staging: runbook (ADR-001 B1–B5)

**Status:** prepared, **not executed**. Engineering has no staging Neon credentials and has not
touched the Render staging service. Every step below that needs a credential or a dashboard is a
**founder action** (or is done by engineering only after the founder hands over the owner
credential privately). Development was done first; its verified results are in
`POC_COMMUNITY_AUTH_RESULTS.md` ("Development integration (B1–B5)").

Variable **names** only appear here. No value, host or connection string is ever written to this
repository, a PR, a log or a chat.

---

## 0. Prerequisite decision: the staging Supabase database

Staging's ops database is the Supabase free tier. It has paused 5+ times (paused again on
2026-11-07), so staging `/health` answers **503**, which blocks staging deploys and the rollback
test regardless of Community.

| Option                                     | What                                                                  | Effect                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Approved retirement path** (recommended) | Render staging: `DATABASE_ENABLED=false` (as production already runs) | `/health` reports `checks.database: disabled`, 200. Nothing writes the ops tables. Ends the outage. Supabase can then be deleted by a separate change |
| Restore Supabase                           | Un-pause the project                                                  | Fixes it until the next pause                                                                                                                         |

Decide this **before** step 3: verifying Community on a staging service whose `/health` is 503
proves nothing. Community never uses `DB_*` / `DATABASE_ENABLED`; the two are independent.

## 1. Prerequisites

- [ ] **Neon staging owner credential**, provided by the founder **privately** (never in chat,
      PR or repo): owner role, **direct** URL and **pooled** URL of the `staging` branch of the
      WellaPath `wellapath-community` project. Store as a mode-600 file outside any repository,
      e.g. `wellapath-private-data/neon/staging.env` with keys `COMMUNITY_DATABASE_URL`
      (pooled) and `COMMUNITY_DATABASE_URL_DIRECT` (direct). Never `source` it (values contain
      `&`); load it with `DOTENV_CONFIG_PATH=<file> node -r dotenv/config …`.
- [ ] **Compute cap (B3):** staging branch autoscaling **min 0.25 CU, max 0.25–0.5 CU**,
      scale-to-zero on. Record a screenshot/API read of the compute settings (date, min, max,
      suspend timeout) in the ops log.
- [ ] Node 22 (`nvm use 22`) and **PostgreSQL 18 client tools** (B1) on the machine that runs the
      owner steps: macOS `/opt/homebrew/opt/postgresql@18/bin`, Debian/Ubuntu
      `postgresql-client-18`.
- [ ] Backend branch containing `scripts/community/provision-runtime-role.ts` checked out,
      `npm ci && npm run build`.
- [ ] Render staging service `wellapath-backend-staging` deploys an image built from a commit
      that contains the Community code (only after PR #44 is approved and merged into `develop`;
      not before).
- [ ] Decision 0 taken.
- [ ] **Resend sender implemented and approved** (see §3). Until then only §2 (database
      preparation) and the B4 job of §4 can be done on staging; §3 deploy, §5 and §6 wait.

## 2. Owner steps (direct URL, from the operator machine)

```sh
cd wellapath-backend && source ~/.nvm/nvm.sh && nvm use 22
export DOTENV_CONFIG_QUIET=true DOTENV_CONFIG_PATH=<private>/neon/staging.env

# 2.1 Migrate as the OWNER over the DIRECT URL (sslmode forced to verify-full by the tool).
node -r dotenv/config -r ts-node/register src/community/migrate.ts status
node -r dotenv/config -r ts-node/register src/community/migrate.ts up
node -r dotenv/config -r ts-node/register src/community/migrate.ts up     # expect: up: []

# 2.2 Provision the runtime role (B2). The generated password is written ONLY to the new
#     mode-600 file; the file must not exist yet. Do NOT pass --with-readonly on staging.
node -r dotenv/config -r ts-node/register scripts/community/provision-runtime-role.ts \
  --runtime-env-out <private>/neon/staging.runtime.env --verify
#   expect: "community_app CREATED …" and "community_app matches the intended privilege matrix."

# 2.3 Re-run: idempotent, no password generated.
node -r dotenv/config -r ts-node/register scripts/community/provision-runtime-role.ts --verify
```

Pipe any output you paste anywhere through
`sed 's#postgres\(ql\)\?://[^ ]*#<redacted>#g; s#[a-z0-9.-]*neon\.tech#<redacted-host>#g'`.
The tools never print a URL, host or password, but treat that as belt and braces.

Record in `DATABASE_ACCESS_MATRIX.md`: branch `staging`, date, the `--verify` summary (booleans).

## 3. Render staging environment (names only; values from the private files)

| Variable                        | Value source / rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMUNITY_MODE`                | `internal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `COMMUNITY_DATABASE_URL`        | the `COMMUNITY_DATABASE_URL` line of `staging.runtime.env`: **`community_app`**, **pooled** host, **`sslmode=verify-full`** (anything else refuses to boot, B5)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `COMMUNITY_DATABASE_URL_DIRECT` | **Do not set.** Not used at runtime. The owner credential never goes to Render                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `BETTER_AUTH_SECRETS`           | versioned: `1:<≥ 32 random chars>` (generate fresh for staging; never reuse dev/prod)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `COMMUNITY_REFRESH_PEPPERS`     | versioned: `1:<≥ 32 random chars>`, distinct from the auth secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `COMMUNITY_BASE_URL`            | the staging service's public base URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `COMMUNITY_ALLOWLIST`           | comma-separated account ids of the internal testers (empty at first; add ids after their first sign-in)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `TRUST_PROXY_HOPS`              | **unset** until measured (step 5); then the measured integer (1–10). Never `true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Resend sender config            | **BLOCKER, not implemented.** The Docker image sets `NODE_ENV=production`, and an enabled Community refuses to boot under `NODE_ENV=production` while only the test email sinks (`outbox-file`, `memory`) exist. So staging **cannot** run `COMMUNITY_MODE=internal` until the Resend sender is implemented and approved (sender domain with SPF/DKIM, `RESEND_API_KEY` and sender address set in Render only, never echoed). Do **not** work around it by overriding `NODE_ENV` on staging: non-production `NODE_ENV` re-enables development-only surfaces (e.g. `/internal/metrics`) |

Then trigger a deploy of the approved commit and check:

- `/health` 200 (needs decision 0), `/config` byte-identical to production, `/v1/features` 200.
- Startup log has no `Refusing to start` line (B5).

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

## 5. Trusted-proxy hop count (`TRUST_PROXY_HOPS`)

Until measured, the limiter keys on the socket peer plus account/email dimensions with interim
global IP ceilings (safe, coarse; contract F2). The service deliberately never logs client IPs
or `X-Forwarded-For` (the request serializer drops them), so the hop count is measured
**black-box** through the app-wide limiter (`@fastify/rate-limit`, 100 requests/minute keyed on
`request.ip`, which honours `TRUST_PROXY_HOPS`). No code change and no IP logging are needed.

Expected chain: client → Cloudflare → Render proxy → app, i.e. a candidate of **2** (verify; do
not assume).

You need two clients with **different real public IPs** (e.g. laptop on office Wi-Fi and a
phone hotspot). For each candidate `N` in 1, 2, 3:

1. Render staging: set `TRUST_PROXY_HOPS=N`; wait for the restart.
2. **Spoof test** (client A): send 110 requests to `/version` within one minute, each with a
   different spoofed header, e.g.
   `for i in $(seq 1 110); do curl -s -o /dev/null -w '%{http_code}\n' -H "X-Forwarded-For: 198.51.100.$i" https://<staging>/version; done | sort | uniq -c`.
   - Some `429` ⇒ the spoofed value did **not** choose the bucket (N is not too large).
   - No `429` at all ⇒ N is **too large** (the client-written value is trusted). Reject N.
3. **Isolation test**: immediately after client A is limited, client B (other real IP, no
   spoofed header) requests `/version` once.
   - `200` ⇒ buckets are per real client IP: **N is correct**.
   - `429` ⇒ A and B share a bucket (keyed on a Cloudflare/Render edge address): N is **too
     small**.
4. The correct value is the N that gives "some 429" for A **and** "200" for B. Exactly one N
   should satisfy both; if none does, stop and escalate (proxy chain differs from the
   expectation).
5. Leave `TRUST_PROXY_HOPS` at that N, repeat steps 2–3 once more to confirm, and record the
   date, candidate results and final value in the ops log. Re-measure whenever Cloudflare or
   Render routing changes.

## 6. Smoke test on staging (engineering-only, `@example.invalid`)

Same flow as development (`POC_COMMUNITY_AUTH_RESULTS.md`): Dart CLI client end-to-end; bootstrap
one throwaway admin with the bootstrap CLI (owner, direct URL); TOTP enrol + step-up; one audited
moderation action; delete every test account through `POST /v1/community/me/delete` (demote the
admin first). OTPs are read from the test outbox (engineering access only).

## 7. Rollback

- **Instant:** Render staging `COMMUNITY_MODE=disabled` (or unset) and redeploy/restart. The
  service then reads no Community variable, opens no pool and registers no auth or Community
  route; `/config` is unaffected (tested). No data is touched.
- **Credential:** if the runtime credential is suspect, rotate it
  (`provision-runtime-role.ts --rotate-password --runtime-env-out <file>`, owner, direct URL) and
  update the Render variable; the old password stops working at the next connection.
- **Schema:** never run `migrate down` on staging once real testers have data; roll forward.
- **Neon:** the branch can be reset or restored from history (B6 drill on a non-production
  branch before public release).

## 8. Checklist

- [ ] Decision 0 taken (staging `DATABASE_ENABLED=false` recommended) and `/health` is 200
- [ ] Staging owner credential received privately; stored mode 600 outside any repo
- [ ] Staging compute capped at 0.25–0.5 CU (B3), evidence recorded
- [ ] PG18 client tools present (B1)
- [ ] `migrate up` applied, second run `up: []`
- [ ] `provision-runtime-role --verify`: created, matrix matches; second run idempotent
- [ ] `DATABASE_ACCESS_MATRIX.md` updated for `staging` (date + summary)
- [ ] Render env set by name (§3); `COMMUNITY_DATABASE_URL` is `community_app`, pooled,
      `sslmode=verify-full`; no owner URL on Render
- [ ] Deploy of an approved commit; no `Refusing to start`; `/config` byte-identical
- [ ] B4 job from Render Frankfurt: query p95 < 20 ms, connect p95 < 150 ms, recorded
- [ ] `TRUST_PROXY_HOPS` measured, set, verified with spoofed headers
- [ ] Smoke test passed; test accounts deleted
- [ ] Rollback (`COMMUNITY_MODE=disabled`) rehearsed once
- [ ] Resend sender implemented and approved (blocks §3 deploy: enabled Community refuses `NODE_ENV=production` with test sinks)
