# Telemetry — Configuration, Deployment and Rollback

> **Status:** current as of 2026-08-11. Companion to `docs/TELEMETRY_CONTRACT.md` (the
> mobile-facing contract) and `docs/DEPLOYMENT.md` (the stack).

---

## 1. What was added

One write endpoint and one metrics endpoint. Nothing else about the service changed.

| Method | Path                   | Purpose                                         | Auth |
| ------ | ---------------------- | ----------------------------------------------- | ---- |
| POST   | `/v1/telemetry/events` | Validated, allowlisted product telemetry intake | None |
| GET    | `/internal/metrics`    | Operational counters and latency histograms     | None |

`/health`, `/version` and `/config` are unchanged and stay unversioned. New API surface is
versioned (`/v1`) from the start so the contract can evolve without breaking a shipped build.

---

## 2. Environment variables

None of these hold a secret. All are set in the Render service environment.

| Variable                        | Required | Default     | Purpose                                                                                                                                                       |
| ------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEMETRY_ENABLED`             | No       | **`false`** | Master switch. Anything other than `true` disables intake.                                                                                                    |
| `TELEMETRY_SINK`                | No       | `log`       | `log` (structured Pino output) or `none` (accept and discard). An unrecognised value falls back to `none` and logs a warning — it does not crash the service. |
| `TELEMETRY_RATE_LIMIT_MAX`      | No       | `60`        | Telemetry requests per minute per client. Independent of the global 100/min.                                                                                  |
| `TELEMETRY_DEDUPE_TTL_SECONDS`  | No       | `3600`      | How long an `event_id` is remembered.                                                                                                                         |
| `TELEMETRY_DEDUPE_MAX_ENTRIES`  | No       | `20000`     | Hard cap on remembered IDs — bounds memory.                                                                                                                   |
| `TELEMETRY_SINK_MAX_RETRIES`    | No       | `2`         | Delivery retries after the first attempt.                                                                                                                     |
| `TELEMETRY_SINK_RETRY_DELAY_MS` | No       | `200`       | Base backoff, multiplied by attempt number.                                                                                                                   |
| `TELEMETRY_SINK_MAX_IN_FLIGHT`  | No       | `50`        | Concurrent deliveries before batches are shed rather than queued.                                                                                             |
| `METRICS_ENDPOINT_ENABLED`      | No       | `true`      | Serves `GET /internal/metrics`.                                                                                                                               |

Out-of-range or unparseable numeric values fall back to the default rather than failing boot.

### Enablement state by environment

| Environment       | `TELEMETRY_ENABLED`                          | `TELEMETRY_SINK` | Rationale                                                                                                                   |
| ----------------- | -------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Local development | `false` unless testing                       | `log`            | Off by default.                                                                                                             |
| **Staging**       | **`true` — enabled 2026-08-11**              | `log`            | Enabled at the I1/W1 staging gate (§9) so Mobile can run live integration tests.                                            |
| **Production**    | **`false`** — must be turned on deliberately | to be decided    | No production environment exists yet. Enabling it there is a separate decision, and a provider choice is an open item (§7). |

**The default is disabled everywhere.** Telemetry has to be switched on for an environment; it
is never on because someone forgot to turn it off.

**Current live state (2026-08-11):** staging telemetry is **enabled** on service
`wellapath-backend-staging`, running backend commit
`5e13379f19c53ec90cee7958dc029d908c342dcd`, sink `log`. **Production telemetry remains
disabled** and was not touched.

---

## 3. Sink / provider architecture

No analytics vendor has been selected, and this step deliberately does not select one. Nothing
is sent to any third party.

Everything downstream of validation talks to a `TelemetrySink` interface
(`src/telemetry/sinks/types.ts`). Two implementations ship:

- **`log`** — writes each validated event as a structured Pino record (`msg: telemetry_event`).
  This is the project's standard observability output, so it adds no infrastructure, no vendor
  and **no database table**.
- **`none`** — accepts and discards. Useful for exercising validation and metrics with no output.

Adopting a provider later is a new file in `src/telemetry/sinks/` plus a case in `factory.ts` and
one environment variable. **The contract, the validator, the route and the mobile client do not
change.**

### Storage and retention

- **No database table was added.** `artifact_versions`, `metrics_agg` and `audit_logs` are
  untouched, and nothing writes to them. The only runtime database query in the service remains
  the health check's `SELECT 1`.
- **Raw request bodies are never persisted or logged**, accepted or rejected.
- With `TELEMETRY_SINK=log`, **the effective telemetry retention period is the Render log
  retention window** — there is no separate store and no separate lifecycle. Telemetry lives
  and expires with the platform logs.
- **Confirmed 2026-08-11: the Render workspace is on the Free plan, so staging log retention is
  7 days.** Telemetry emitted to the log sink is therefore retained for **7 days and no longer**.

  > ### ⚠️ The 7-day rolling window limits baseline and trend analysis
  >
  > This is a real constraint on what W1 can answer, not a formality. Staging telemetry is a
  > **rolling 7-day window**: a metric read on day 10 cannot look back to day 1, because that
  > data no longer exists anywhere. There is no historical store behind the log sink.
  >
  > Consequences to plan around:
  >
  > - Week-over-week comparison, retention curves, cohort analysis and any trend longer than a
  >   week are **not possible** with the current setup.
  > - Anything worth keeping beyond 7 days must be **exported or summarised before it ages out**.
  > - A question asked after the fact ("what did drop-off look like last month?") cannot be
  >   answered retrospectively.
  >
  > This is acceptable for I1, whose goal is a safe observability _baseline_ during internal
  > beta. If longer trends are required, that needs an analytics provider or export path and a
  > deliberate retention decision — tracked in §7.

- Operational metrics are **in-memory and per-instance**. They reset on deploy or restart and are
  not durable — a shorter horizon still than the logs. They are a live signal, not an analytics
  history.
- Event IDs held for de-duplication are in-memory, TTL-bounded (1 h) and count-bounded (20 000).

### Access to telemetry output

Two different surfaces with two different postures — worth keeping distinct:

| Surface                   | Contents                                          | Access                                                                           |
| ------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Render staging log stream | `telemetry_event` records (validated events only) | **Authenticated** — Render workspace members only. Accepted for internal staging |
| `GET /internal/metrics`   | Counters and latency histograms only              | **Unauthenticated and publicly reachable** — see §7, open item                   |

The log stream carries the actual (validated, allowlisted) event data and is behind Render
workspace authentication. The metrics endpoint carries no event data at all — only counts, with
label sets fixed at construction so no event, session, facility, article, IP or user-agent value
can appear — but it is reachable by anyone with the URL. **These are not the same posture and
should not be described as if they were.**

---

## 4. Safe verification procedure

Run against staging after a deploy. None of these send anything prohibited.

```bash
BASE=https://wellapath-backend-staging.onrender.com

# 1. The pre-existing endpoints must be unchanged.
curl -s $BASE/health  | jq .
curl -s $BASE/version | jq .
curl -s $BASE/config  | jq '.artifacts | to_entries[] | {key, version: .value.version}'
#    Expect the E9.1 frozen set: token_dictionary 1.1, knowledge_base 2.4, rules 2.2, facilities 1.1

# 2. Telemetry accepts a valid event.
curl -s -X POST $BASE/v1/telemetry/events \
  -H 'content-type: application/json' \
  -d '{"contract_version":"1.0","sent_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
       "app":{"platform":"android","app_version":"1.4.2","app_build":"204"},
       "events":[{"event_name":"app_open","event_id":"verify_'"$(date +%s)"'_aaaaaaaa",
                  "client_ts":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","launch_type":"cold"}]}' | jq .
#    Expect 202 with accepted: 1

# 3. Telemetry rejects an unknown event (fail-closed check).
curl -s -X POST $BASE/v1/telemetry/events \
  -H 'content-type: application/json' \
  -d '{"contract_version":"1.0","sent_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
       "app":{"platform":"android","app_version":"1.4.2","app_build":"204"},
       "events":[{"event_name":"symptom_entered","event_id":"verify_x_aaaaaaaa",
                  "client_ts":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}]}' | jq '.results'
#    Expect status "rejected", reason "unknown_event"

# 4. Operational metrics.
curl -s $BASE/internal/metrics | jq '.telemetry_enabled, .metrics.telemetry.events_accepted_total'
```

**Do not verify with a payload containing real or realistic clinical content.** The point of the
rejection test is the reason code, not the content — use `symptom_entered` as an event _name_,
never a symptom _value_.

---

## 5. Monitoring checks

From `GET /internal/metrics`:

| Signal                                                         | Where                                                                         | What it means                                                                                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted volume by event                                       | `telemetry.events_accepted_total`                                             | Instrumentation is live and shaped as expected.                                                                                                                                                      |
| Rejections by reason                                           | `telemetry.events_rejected_total`                                             | A spike in `unknown_property` or `unknown_event` usually means a mobile build ahead of the server contract.                                                                                          |
| **`prohibited_field` / `prohibited_container` / `unsafe_key`** | `telemetry.events_rejected_total`                                             | **Investigate any non-zero value.** The defenses held, but something tried to send prohibited data — that is a client bug or a misunderstanding of the contract, and it should be traced to a build. |
| Endpoint latency                                               | `telemetry.request_duration_ms`                                               | Histogram with fixed buckets.                                                                                                                                                                        |
| Delivery health                                                | `telemetry.sink_failures_total`, `sink_retries_total`, `events_dropped_total` | Sustained failures mean the sink is unhealthy. **No user-facing impact** — but the data is being lost.                                                                                               |
| Duplicates                                                     | `telemetry.events_duplicate_total`                                            | Healthy in small numbers (offline-queue resends). A large ratio suggests the client is regenerating `event_id` on retry.                                                                             |
| Backend health                                                 | `http.requests_total`, `http.server_errors_total`, `http.request_duration_ms` | Per route pattern, per status class.                                                                                                                                                                 |

**Every label set is closed at construction time**, so no event ID, session ID, facility ID,
article ID, IP address or user agent can appear as a metric label. Unrecognised values fold into
`other`.

---

## 6. Rollback and disable

Three levels, cheapest first.

### Level 1 — disable intake (seconds, no deploy)

Set `TELEMETRY_ENABLED=false` in the Render service environment and restart.

- The endpoint returns `503` with `reason_code: telemetry_disabled`.
- The payload is not even parsed.
- Mobile clients discard the batch and stop sending for the session (per contract §5).
- **`/health`, `/version` and `/config` are unaffected.** The mobile bootstrap path does not
  touch telemetry.

### Level 2 — stop delivery, keep validation

Set `TELEMETRY_SINK=none`. Events are still validated and counted; nothing is emitted. Useful to
isolate whether a problem is intake or delivery.

### Level 3 — full code rollback

Revert the merge commit via a revert PR, or use Render's "Rollback to previous deploy". Confirm
`GET /version` and `GET /config` afterwards.

**No rollback step involves an artifact.** No clinical, knowledge-base, rules, vocabulary,
question, results or facility artifact was touched by this work, so artifact rollback
(`docs/DEPLOYMENT.md` §7) is not part of any telemetry rollback.

---

## 7. Unresolved — open operational and security backlog

**None of the items below is complete.** They are recorded here so they are picked up at the
gate named against each, and none of them is a telemetry contract failure — contract v1.0
behaved exactly as specified throughout the staging verification in §9.

### Security / access

| Item                                                       | Gate                     | Owner                      | Note                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Protect or disable unauthenticated `/internal/metrics`** | **Before external beta** | Engineering lead           | Confirmed reachable with no credentials. Counters only — no PHI, no identifiers, closed label sets — so there is no data exposure today, but it is an unauthenticated public surface. Restrict it, or set `METRICS_ENDPOINT_ENABLED=false`. Distinct from log access, which is authenticated. |
| **Analytics consent**                                      | **Before external beta** | Founder + engineering lead | Internal beta is a controlled, informed audience. Collecting product telemetry from external users raises a consent question that has not been answered. Must be resolved before anyone outside the team is measured.                                                                         |

### Observability accuracy

| Item                                                                         | Gate                                     | Owner            | Note                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ---------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Make `rate_limited` and `malformed_json` counters operationally accurate** | Later hardening                          | Backend          | Both rejections occur in Fastify hooks _before_ the telemetry service runs, so `events_rejected_total.rate_limited` and `.malformed_json` never increment and always read `0`. The events are visible only in `http.requests_total['/v1/telemetry/events\|4xx']`. An operator could wrongly read `0` as "no rate limiting occurred".                                                          |
| **Classify `question_id` as a privacy-prohibited attempt**                   | Future **backward-compatible** hardening | Backend          | Today `question_id` is refused as `unknown_property`. The refusal is correct and fail-closed, but the field is excluded for a _privacy_ reason, so it does not trip the prohibited-attempt metric operators are told to investigate. Reclassifying is a metrics / reason-code change only — **it must not change whether the field is accepted, and must not alter contract v1.0 behaviour.** |
| **Build-commit attestation**                                                 | **I6 / W9 release hardening**            | Backend          | `/version` returns the static `APP_VERSION`, not a git SHA, so no endpoint can attest which commit is live. Deployed-commit confirmation currently depends on reading the Render dashboard.                                                                                                                                                                                                   |
| **Crash-monitoring provider or approved alternative**                        | **Before I1 closes**                     | Engineering lead | The service has no crash/error-reporting integration. I1 is an observability phase; this is part of its scope and is not yet resolved.                                                                                                                                                                                                                                                        |

### Data, retention and provider

| Item                                                       | Gate                                | Owner                      | Note                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ----------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider / export and retention approach beyond 7 days** | When trends >7 days are needed      | Engineering lead + founder | **Resolved for now, not permanently:** staging retention is 7 days (§3). If any baseline or trend longer than a week is required, it needs an analytics provider or an export path plus a deliberate retention decision. Nothing is sent externally until one is approved. |
| **Production enablement**                                  | Before production                   | Founder + engineering lead | Currently `false`. Turning it on in production is a separate decision.                                                                                                                                                                                                     |
| **Confirm `admin_area_code` mapping**                      | Before the field is emitted         | Facility / data owner      | The field is allowlisted against the 37 ISO 3166-2:NG codes. What is unconfirmed is how the mobile client derives it from the facilities artifact. **Mobile omits the field until the owner approves the mapping.**                                                        |
| **Supabase free-tier pause**                               | **Pre-production reliability gate** | Engineering lead           | Unrelated to telemetry, still open. Two pauses to date (2026-07-29, 2026-08-03), both manually restored. Upgrade off the free tier or add a keep-alive ping. See `DEPLOYMENT.md` §4 and `SECURITY_CHECKLIST.md`.                                                           |

### Settled — do not reopen

These are decided for contract v1.0 and are **not** open items:

- `urgency_category` — **remains excluded** (clinical output, no approval on record).
- `question_id` — **remains excluded** (assessment-path reconstruction risk). The backlog item
  above concerns only how its rejection is _classified_, not whether it is accepted.
- Free-text feedback — **remains excluded** from this endpoint entirely.
- `admin_area_code` — allowlisted but **omitted by Mobile** pending mapping approval.

See `TELEMETRY_CONTRACT.md` §8. Changing any of these requires a named decision and a contract
version bump.

---

## 8. Guarantees this implementation makes

Each is covered by an automated test; see the completion report for the mapping.

- Every accepted event and property is explicitly allowlisted. Unknown events and unknown
  properties fail closed.
- No arbitrary `properties` / `metadata` / `context` / `extra` / `data` object is accepted.
- Raw request bodies never appear in application logs, error logs or crash reports —
  accepted or rejected.
- Rejected payloads are represented only by fixed reason codes and, where safe, allowlisted
  field names. Client-supplied keys and values are never echoed.
- Query strings are stripped from logged paths, and IP addresses are not logged.
- Sink failure, sink hang or provider outage cannot block or alter any assessment, red-flag,
  scoring, result, emergency or locator flow — delivery is fire-and-forget, bounded and shed
  under pressure.
- Operational metrics carry no PHI and no high-cardinality identifier.
- The feature can be disabled by environment configuration with no deploy.

---

## 9. Staging-enablement gate — PASSED (2026-08-11)

The I1/W1 staging-enablement gate is **closed and passed**. Recorded here so the verified state
is durable rather than living only in a session transcript.

| Field                   | Value                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| Service                 | `wellapath-backend-staging`                                                  |
| Deployed backend commit | **`5e13379f19c53ec90cee7958dc029d908c342dcd`** (PR #29), confirmed in Render |
| Telemetry contract      | **v1.0** — unchanged by this gate                                            |
| `TELEMETRY_ENABLED`     | **`true`** (staging only)                                                    |
| `TELEMETRY_SINK`        | **`log`** — approved provider-neutral sink. No vendor, no database           |
| Production              | **Telemetry remains disabled.** Not touched                                  |
| Functional checks       | **25 / 25 passed, 0 failed**                                                 |
| Staging log retention   | **7 days** (Render Free plan) — see §3                                       |

### Verified behaviour

| Check                                            | Result                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Valid three-event batch                          | `202`, `accepted: 3, rejected: 0, duplicates: 0`                                                                  |
| Prohibited clinical field (`condition`)          | Rejected, `reason: prohibited_field`                                                                              |
| Excluded field (`question_id`)                   | Rejected, `reason: unknown_property` — see §7 classification item                                                 |
| Envelope-level prohibited field (`patient_name`) | `400 invalid_envelope`                                                                                            |
| Unknown event (`symptom_entered`)                | Rejected, `reason: unknown_event`                                                                                 |
| Rate limiting                                    | `429` returned (55×`202` / 15×`429` across 70 requests), standard error envelope                                  |
| `/health`                                        | `200`, `checks.database: "ok"`                                                                                    |
| `/config` frozen artifacts                       | Unchanged — `token_dictionary` 1.1 · `knowledge_base` 2.4 · `rules` 2.2 · `facilities` 1.1, full hashes identical |
| Core routes during telemetry `429`               | `/config`, `/health`, `/version` all `200`                                                                        |
| Operational metrics                              | Counters updated correctly; label sets fixed; no session, event, facility, article, IP or user-agent label        |

### Privacy verification — passed

A distinctive marker was deliberately submitted **inside a rejected payload**, then searched for
across the staging log stream:

- **Sensitive-marker log search returned ZERO results.** Confirmed by the engineering lead in
  Render.
- **Accepted `telemetry_event` sink entries were present**, containing no sensitive marker and no
  payload text — so the sink works _and_ the rejected content never reached it.
- The marker was absent from every HTTP response.

That combination is the point: the pipeline demonstrably records what it should and demonstrably
does not record what it must not.

### Rollback — unchanged

**`TELEMETRY_ENABLED=false` plus restart** (§6, Level 1). Verified before enablement: the
endpoint returned `503` with `reason_code: telemetry_disabled` and the payload was not parsed.
`/health`, `/version` and `/config` are unaffected either way.

> **Do not disable staging telemetry while Mobile PR #61 is running its live integration tests.**
