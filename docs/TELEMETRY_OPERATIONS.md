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
| **Staging**       | **`true`**                                   | `log`            | Where the contract is exercised during internal beta.                                                                       |
| **Production**    | **`false`** — must be turned on deliberately | to be decided    | No production environment exists yet. Enabling it there is a separate decision, and a provider choice is an open item (§7). |

**The default is disabled everywhere.** Telemetry has to be switched on for an environment; it
is never on because someone forgot to turn it off.

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
- With `TELEMETRY_SINK=log`, retained telemetry is exactly the Render platform log retention for
  the service — no separate store, no separate lifecycle. **Confirm the current Render log
  retention window before beta** and record it here; it is the de facto retention period.
- Operational metrics are **in-memory and per-instance**. They reset on deploy or restart and are
  not durable. They are a live signal, not an analytics history.
- Event IDs held for de-duplication are in-memory, TTL-bounded (1 h) and count-bounded (20 000).

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

## 7. Unresolved before external beta

| Item                                                      | Owner                          | Note                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider selection**                                    | Engineering lead + founder     | The `log` sink is sufficient for internal beta. A real provider is a vendor and data-processing decision, not a code decision. Nothing is sent externally until one is approved and configured.                                                                        |
| **Log retention window**                                  | Engineering lead               | With the `log` sink, Render's log retention _is_ the telemetry retention period. Confirm and record it above.                                                                                                                                                          |
| **Production enablement**                                 | Founder + engineering lead     | Currently `false`. Turning it on in production is a separate decision.                                                                                                                                                                                                 |
| **`urgency_category`, `question_id`, free-text feedback** | See `TELEMETRY_CONTRACT.md` §8 | Excluded from v1.0. Each needs a named decision before any future version.                                                                                                                                                                                             |
| **`admin_area_code` mapping**                             | Facilities artifact owner      | Field is allowlisted; the client-side mapping from the facilities artifact is unconfirmed. Omit the field until confirmed.                                                                                                                                             |
| **Unauthenticated `/internal/metrics`**                   | Engineering lead               | The snapshot is counters only and contains no PHI or identifiers, and every other endpoint on this service is unauthenticated. Still worth a deliberate decision on whether to restrict it before production. Can be turned off with `METRICS_ENDPOINT_ENABLED=false`. |

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
