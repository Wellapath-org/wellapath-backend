# Production Provisioning — Audit and Runbook (Build 211 Soft Launch)

> **Status (re-verified 2026-11-07): PROVISIONED and LIVE.** Production is
> `wellapath-backend-production` on Render, serving `https://api.wellapath.org`
> from the `production` branch (created 2026-09-21T14:00:49Z at `6cf642f`;
> fast-forwarded 2026-09-29T12:50:01Z to `fd7190b`, the PR #39 merge — identical
> to `develop`). Live: `/version` `0.3.0`/`production`, `/health` 200 with
> `database: "disabled"`, `/config` facilities **1.2**. Current state, deploy
> mechanics and rollback live in `DEPLOYMENT.md` §3 and §7.
>
> Everything below the line is the **original 2026-09-21 audit and runbook, kept
> as a historical record**. Where it names facilities **v1.1**, read it as the
> state on that date: v1.1 was superseded by v1.2 on 2026-09-29 and **deleted
> from R2** the same day (now 404). §5 and §6 have been updated to the v1.2
> values so the checklist can still be re-run. The "Production source commit"
> row records the audit's recommendation (`2485ce0`); production actually
> launched from `6cf642f`.
>
> _Original header (2026-09-21):_ "BLOCKED on founder/engineering-lead actions.
> Nothing was provisioned." — audit performed for the `0.3.0+211` public
> soft-launch candidate (mobile PR #80). No credential available to the auditing
> session had access to any WellaPath hosting, DNS or database account, so every
> provisioning step below was a founder/engineering-lead action.
>
> **Revised same day:** production launches **database-independent**
> (`DATABASE_ENABLED=false`). The backend stores no user or telemetry data, and the
> only runtime database query in the entire application is the health check's
> `SELECT 1` — verifiable with `grep -rn "server.db\|config.db" src/` (hits: the db
> plugin, the migration script, and `src/routes/health.ts`; no product route).
> A paid production database solely to answer a health check is not justified, so
> **paid Supabase is no longer a soft-launch prerequisite.** A database is
> introduced only alongside an approved product feature that needs persistence —
> see §7. The paid Render and Namecheap DNS requirements are unchanged.

---

## 1. Audit findings (2026-09-21)

| Question                            | Finding                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render account owning staging       | Not accessible from this session — no Render API key, CLI or dashboard session on this machine. `wellapath-backend-staging.onrender.com` is owned by the engineering lead's Render account (per operational history: restores and env changes have been done there)                                                                                                  |
| Existing production Render service  | Unknown — cannot be enumerated without account access. No repository record suggests one exists                                                                                                                                                                                                                                                                      |
| Cloudflare zone for `wellapath.org` | **`wellapath.org` is not on Cloudflare DNS at all.** Authoritative nameservers are `dns1/dns2.registrar-servers.com` (Namecheap BasicDNS). The apex A record (`216.198.79.1`) points at Vercel (marketing site). DNS records must be added at **Namecheap**, not Cloudflare                                                                                          |
| Cloudflare account owning R2        | The artifact bucket behind `pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev` is in a Cloudflare account not accessible from this session (the only accessible Cloudflare account holds unrelated buckets)                                                                                                                                                                |
| Facilities 1.1 production reuse     | **Approved-for-reuse in practice: the object is environment-neutral.** Verified live 2026-09-21: HTTP 200, 1,695,844 bytes, sha256 `25684c714367abf2f3c305c8a5597b5f7eb0d11baaf658c5b9e2f8f5e2982398` — exact match with `/config` and the E9.1 freeze record. Hash-pinned, immutable (v1.0 still 200, untouched)                                                    |
| Separate production artifact bucket | **Not required for launch.** The same immutable, hash-pinned public object serves both environments; the mobile client verifies the sha256 from `/config`. Caveat: `*.r2.dev` URLs are rate-limited by Cloudflare and not recommended for production traffic — a custom domain on the same bucket is the recorded follow-up, not a new bucket                        |
| Production database                 | **Not required for soft launch.** No product feature persists anything; production runs with `DATABASE_ENABLED=false` (§3, §7). The staging free-tier pause history (fourth pause found live 2026-09-21, `/health` 503, `/config` unaffected) remains a **staging** incident and a reason not to couple production health to an idle-prone database it does not need |
| Production source commit            | **`2485ce0ce564e27f562afa7d994d3ebfc388da6d`** (`origin/develop` tip). Full suite verified on this commit 2026-09-21: 653/653 tests, lint, format, `tsc --noEmit`, telemetry contract sync — all clean                                                                                                                                                               |
| Pending PRs required?               | **None.** PR #36 (facilities v2 distribution contract) is open, unmerged, and **must remain excluded** — production launches from `2485ce0`, which predates it. Even if merged later, every #36 gate defaults off                                                                                                                                                    |

## 2. Founder / engineering-lead actions required (in order)

1. **Render**: create `wellapath-backend-production` from
   `Wellapath-org/wellapath-backend`, **pinned to the approved production commit
   (a production branch or tag) — not auto-deploying `develop`**. An always-on
   paid instance is required (a free instance spins down and cannot be a stable
   public origin). Set the environment variables in §3 — notably
   `DATABASE_ENABLED=false`. Point the health check at `/health` (it returns 200
   with the database truthfully reported `disabled`).
2. **Namecheap** (DNS host for `wellapath.org`): **add exactly one record and
   change nothing else** — a CNAME for the host `api` pointing at the Render
   service hostname (which exists only after step 1, so DNS comes second). TLS
   is then issued automatically by Render for the custom domain.
   **Every existing record must be preserved untouched** — verified live
   2026-09-21: the apex A record (`216.198.79.1`) and `www` serve the marketing
   website on **Vercel**, and the MX records (`mx1`/`mx2.hostinger.com`) carry
   company email on **Hostinger**. Do not use any "replace all records" or
   template flow in the registrar panel; a removed apex/`www` record takes the
   website down and a removed MX record silently drops company email.
3. Run the verification checklist in §5 and record results in `PROGRESS.md`.
4. Only then hand the Mobile Engineer the §6 package for compiling build 211.

No database account, project or migration is part of soft-launch provisioning.

## 3. Production environment variables (names and safe state only)

| Variable                             | Production state                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                           | `production`                                                                                                              |
| `PORT`                               | `3000`                                                                                                                    |
| `DATABASE_ENABLED`                   | **`false`** — no DB variable is then required or read, no pool is created, `/health` reports `disabled`                   |
| `DB_HOST` … `DB_PASSWORD` / `DB_SSL` | **Not set.** Required (with strict validation, `DB_PASSWORD` as a Render secret) only when the database is enabled per §7 |
| `ARTIFACT_BASE_URL`                  | `https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev`                                                                     |
| `APP_VERSION`                        | `0.3.0`                                                                                                                   |
| `TELEMETRY_ENABLED`                  | **`false`** (or absent — default is off)                                                                                  |
| `TELEMETRY_SINK`                     | Absent                                                                                                                    |
| `METRICS_ENDPOINT_ENABLED`           | Irrelevant — `/internal/metrics` is hard-disabled in production regardless and answers 404                                |
| Every `FACILITIES_V2_*` variable     | **Absent** (and would be inert at the production commit regardless)                                                       |
| Any Sentry/analytics variable        | **Absent — no such integration exists in this backend**                                                                   |

## 4. Audit code findings — resolved by the production-readiness PR

Status of the go-live code items the audit recorded, as addressed by the
database-independent production-readiness PR (same-day revision):

- **CORS production allowlist** — ✅ fixed. The superseded
  `api-staging.wellapath.org` entry is removed; production grants only
  `https://wellapath.org`. The native mobile client sends no Origin header and
  needs no CORS grant; every other browser origin receives no
  `access-control-allow-origin`. No wildcard was added.
- **`/internal/metrics`** — ✅ fixed. Hard-disabled in production regardless of
  `METRICS_ENDPOINT_ENABLED`: the route is not registered and answers with the
  standard 404 envelope. Non-production behaviour is unchanged. Re-enabling in
  production requires an authenticated monitoring design first.
- **Security headers** — ✅ fixed. `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` on every response
  in every environment; `Strict-Transport-Security: max-age=15552000;
includeSubDomains` in production only (a host-scoped browser commitment made
  only for the hostname this project controls).
- **DB TLS `rejectUnauthorized: false`** — ✅ **unreachable at soft launch**:
  the code path exists only inside the database plugin, which is never
  registered when `DATABASE_ENABLED=false`. For future database-enabled use it
  remains a **blocked decision, not guessed at**: verifying the chain requires
  the database provider's CA certificate configuration (provider-specific
  evidence), to be resolved as part of the §7 enablement work.
- **`/health` database coupling** — ✅ moot at soft launch: with the database
  disabled, `/health` is 200 whenever the app is up, so a paused external
  database can no longer fail deploys or health checks. When a database is
  enabled later (§7), the liveness/readiness split question returns and still
  needs engineering-lead approval.

## 5. Post-provisioning verification checklist (independent client)

1. `dig api.wellapath.org` resolves; TLS certificate valid for the hostname.
2. `GET /health` → 200 with `checks.database: "disabled"` (not `ok` — the check
   must not pretend it ran); `GET /version` → `0.3.0` / `production`;
   `GET /config` → 200.
3. `/config` body: exactly four artifacts (`token_dictionary` 1.1,
   `knowledge_base` 2.4, `rules` 2.2, `facilities` 1.2), **no `facilities_v2`
   key**, no staging hostname anywhere in the body. (Originally `facilities`
   1.1; updated 2026-11-07.)
4. Download `facilities.ng.v1.2.json` from the URL in `/config`; verify
   1,698,125 bytes and sha256 `94f162e4…b7788`. (v1.1 is retired — 404.)
5. `POST /v1/telemetry/events` → 503 `telemetry_disabled`;
   `GET /internal/metrics` → 404 standard envelope.
6. Rate-limit headers present; security headers present (`strict-transport-security`,
   `x-content-type-options: nosniff`); a probe with a query string does not
   appear in logs; no IP addresses in logs (Render log search).
7. Restart the service from the Render dashboard; verify recovery. Confirm
   "Rollback to previous deploy" is available and that env vars are recorded in
   a secure location for configuration recovery.
8. Staging non-regression: staging service and env untouched. (The
   2026-09-21 staging body sha256 was `183a15bd…45d3b`; since PR #39 staging
   and production serve an identical body, `bbf8024c…2d7b` on 2026-11-07.)

## 6. Mobile handoff package (to be filled only after §5 passes)

- Production API base URL: `https://api.wellapath.org` (pending DNS)
- Artifact base URL: `https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev`
- `/config` response fingerprint: record live body sha256 at verification time
- Facilities identity (current, since 2026-09-29): v1.2,
  `facilities.ng.v1.2.json`, sha256
  `94f162e492fa91f7d9d3cf2ca33fcf0598a031a2510aa900aa717a581bdb7788`,
  1,698,125 bytes. (The 2026-09-21 package named v1.1, which is now retired.)
- Required non-secret build flags: production API base URL only; no telemetry
  flag (backend intake is disabled), no Sentry DSN for the backend
- Rollback: per `DEPLOYMENT.md` §7 — facilities rollback target is **v1.0**
  (PR #40), never v1.1. Render "Rollback to previous deploy" must not go to a
  deploy older than `fd7190b` (those name the deleted v1.1). Contact —
  engineering lead

**Do not compile build 211 against staging, and do not build or upload it until
this handoff is issued with live verification results.**

## 7. Introducing a database later — the migration path

No current product feature requires persistence: the three schema tables
(`artifact_versions`, `metrics_agg`, `audit_logs`) hold no user data and are
written by no route, and the database implementation is **preserved, not
removed** — `src/plugins/db.ts` and `src/db/migrate.ts` are intact and fully
exercised whenever the database is enabled (staging is unchanged and keeps it
enabled by default).

A production database is introduced **only alongside an approved product
feature that needs it**, and the enablement PR must carry, together:

1. The approved feature and the founder/engineering-lead approval reference.
2. The schema it needs, reviewed against the no-PHI non-negotiable.
3. A data retention policy for every new table.
4. A privacy assessment (what is stored, why, for how long, who can read it).
5. A named operational owner for the database (provisioning, backups, restore
   drills, pause/idle behaviour, incident response).
6. The DB TLS decision from §4 resolved with provider CA evidence — production
   must not launch a database on `rejectUnauthorized: false`.

Mechanically, enablement is then: provision the project (paid tier — the
staging pause history is the evidence), set `DATABASE_ENABLED=true` plus the
`DB_*` variables (password as a secret), run `npm run migrate` (idempotent,
refused while disabled), restart, and confirm `/health` flips from
`database: "disabled"` to a real `database: "ok"`. Rollback of enablement is
configuration-only: `DATABASE_ENABLED=false` plus restart. Misconfiguration
fails closed: enabled-with-missing-variables refuses startup, and any
`DATABASE_ENABLED` value other than `true`/`false` refuses startup rather than
guessing.
