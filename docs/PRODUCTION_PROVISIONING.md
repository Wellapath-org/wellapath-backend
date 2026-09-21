# Production Provisioning — Audit and Runbook (Build 211 Soft Launch)

> **Status: BLOCKED on founder/engineering-lead actions. Nothing was provisioned.**
> Audit performed 2026-09-21 for the `0.3.0+211` public soft-launch candidate
> (mobile PR #80). This document records what exists, what is missing, the exact
> steps to provision production, and the verification checklist to run afterwards.
> No credential available to the auditing session had access to any WellaPath
> hosting, DNS or database account, so every provisioning step below is a
> founder/engineering-lead action.

---

## 1. Audit findings (2026-09-21)

| Question                            | Finding                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render account owning staging       | Not accessible from this session — no Render API key, CLI or dashboard session on this machine. `wellapath-backend-staging.onrender.com` is owned by the engineering lead's Render account (per operational history: restores and env changes have been done there)                                                                           |
| Existing production Render service  | Unknown — cannot be enumerated without account access. No repository record suggests one exists                                                                                                                                                                                                                                               |
| Cloudflare zone for `wellapath.org` | **`wellapath.org` is not on Cloudflare DNS at all.** Authoritative nameservers are `dns1/dns2.registrar-servers.com` (Namecheap BasicDNS). The apex A record (`216.198.79.1`) points at Vercel (marketing site). DNS records must be added at **Namecheap**, not Cloudflare                                                                   |
| Cloudflare account owning R2        | The artifact bucket behind `pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev` is in a Cloudflare account not accessible from this session (the only accessible Cloudflare account holds unrelated buckets)                                                                                                                                         |
| Facilities 1.1 production reuse     | **Approved-for-reuse in practice: the object is environment-neutral.** Verified live 2026-09-21: HTTP 200, 1,695,844 bytes, sha256 `25684c714367abf2f3c305c8a5597b5f7eb0d11baaf658c5b9e2f8f5e2982398` — exact match with `/config` and the E9.1 freeze record. Hash-pinned, immutable (v1.0 still 200, untouched)                             |
| Separate production artifact bucket | **Not required for launch.** The same immutable, hash-pinned public object serves both environments; the mobile client verifies the sha256 from `/config`. Caveat: `*.r2.dev` URLs are rate-limited by Cloudflare and not recommended for production traffic — a custom domain on the same bucket is the recorded follow-up, not a new bucket |
| Production database                 | A **separate** Supabase project is required (staging's must not be shared). It must be on a **paid tier** — the free-tier 7-day idle pause has now occurred **four times** on staging (fourth found live 2026-09-21), and on Render a paused DB fails deploys because `/health` returns 503                                                   |
| Production source commit            | **`2485ce0ce564e27f562afa7d994d3ebfc388da6d`** (`origin/develop` tip). Full suite verified on this commit 2026-09-21: 653/653 tests, lint, format, `tsc --noEmit`, telemetry contract sync — all clean                                                                                                                                        |
| Pending PRs required?               | **None.** PR #36 (facilities v2 distribution contract) is open, unmerged, and **must remain excluded** — production launches from `2485ce0`, which predates it. Even if merged later, every #36 gate defaults off                                                                                                                             |

## 2. Founder / engineering-lead actions required (in order)

1. **Supabase**: create a production project (paid tier or with a keep-alive
   decision recorded), run `npm run migrate` against it, and record the pooler
   host. Schema is three no-PHI tables; the migration is idempotent.
2. **Render**: create `wellapath-backend-production` from
   `Wellapath-org/wellapath-backend`, **pinned to a production branch or tag at
   `2485ce0` — not auto-deploying `develop`**. An always-on paid instance is
   required (a free instance spins down and cannot be a stable public origin).
   Set the environment variables in §3. Point the health check at `/health`.
3. **Namecheap** (DNS host for `wellapath.org`): add
   `api.wellapath.org` → CNAME → the Render service hostname. TLS is then
   issued automatically by Render for the custom domain.
4. Run the verification checklist in §5 and record results in `PROGRESS.md`.
5. Only then hand the Mobile Engineer the §6 package for compiling build 211.

## 3. Production environment variables (names and safe state only)

| Variable                                      | Production state                                                   |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `NODE_ENV`                                    | `production`                                                       |
| `PORT`                                        | `3000`                                                             |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` | Production Supabase pooler values — set in Render, never committed |
| `DB_PASSWORD`                                 | Secret — set in Render only                                        |
| `DB_SSL`                                      | `true`                                                             |
| `ARTIFACT_BASE_URL`                           | `https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev`              |
| `APP_VERSION`                                 | `0.3.0`                                                            |
| `TELEMETRY_ENABLED`                           | **`false`** (or absent — default is off)                           |
| `TELEMETRY_SINK`                              | Absent                                                             |
| Every `FACILITIES_V2_*` variable              | **Absent** (and would be inert at `2485ce0` regardless)            |
| Any Sentry/analytics variable                 | **Absent — no such integration exists in this backend**            |

## 4. Code changes needed before or shortly after go-live (each needs its own approval)

- **CORS production allowlist** (`src/app.ts`) still lists the superseded
  `api-staging.wellapath.org`. Low practical impact for a mobile-only client,
  but it is a staging marker in production configuration. One-line fix; needs a
  reviewed PR.
- **`/internal/metrics` is unauthenticated** — recorded pre-external-beta item.
  Protect or disable before public traffic.
- **DB TLS `rejectUnauthorized: false`** — recorded production hardening item.
- **`/health` couples liveness to the database** — with a paid production DB the
  trigger is removed, but the coupling remains; the liveness/readiness split is
  offered and still unauthorized.
- **No HSTS / `X-Content-Type-Options` headers** are set by the app (observed on
  staging 2026-09-21). Consider `@fastify/helmet` — runtime change, needs review.

## 5. Post-provisioning verification checklist (independent client)

1. `dig api.wellapath.org` resolves; TLS certificate valid for the hostname.
2. `GET /health` → 200 `database: ok`; `GET /version` → `0.3.0` /
   `production`; `GET /config` → 200.
3. `/config` body: exactly four artifacts (`token_dictionary` 1.1,
   `knowledge_base` 2.4, `rules` 2.2, `facilities` 1.1), **no `facilities_v2`
   key**, no staging hostname anywhere in the body.
4. Download `facilities.ng.v1.1.json` from the URL in `/config`; verify
   1,695,844 bytes and sha256 `25684c71…982398`.
5. `POST /v1/telemetry/events` → rejected/disabled (telemetry off).
6. Rate-limit headers present; a probe with a query string does not appear in
   logs; no IP addresses in logs (Render log search).
7. Restart the service from the Render dashboard; verify recovery. Confirm
   "Rollback to previous deploy" is available and that env vars are recorded in
   a secure location for configuration recovery.
8. Staging non-regression: staging `/config` body sha256 still
   `183a15bd…45d3b`; staging service and env untouched.

## 6. Mobile handoff package (to be filled only after §5 passes)

- Production API base URL: `https://api.wellapath.org` (pending DNS)
- Artifact base URL: `https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev`
- `/config` response fingerprint: record live body sha256 at verification time
- Facilities identity: v1.1, `facilities.ng.v1.1.json`, sha256
  `25684c714367abf2f3c305c8a5597b5f7eb0d11baaf658c5b9e2f8f5e2982398`,
  1,695,844 bytes
- Required non-secret build flags: production API base URL only; no telemetry
  flag (backend intake is disabled), no Sentry DSN for the backend
- Rollback: Render "Rollback to previous deploy" (service owner), artifact
  rollback via `/config` PR per `DEPLOYMENT.md` §7; contact — engineering lead

**Do not compile build 211 against staging, and do not build or upload it until
this handoff is issued with live verification results.**
