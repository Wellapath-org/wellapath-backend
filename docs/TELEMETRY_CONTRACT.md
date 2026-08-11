# Telemetry Contract v1.0 — Mobile Engineering

> **Status:** finalized 2026-08-11. I1 (Observability & Baseline) · W1 (Privacy-Safe Product Analytics).
> **This is the contract Mobile Engineering implements against.** Nothing here needs to be
> inferred from controller code.

|                  |                                                               |
| ---------------- | ------------------------------------------------------------- |
| Contract version | `1.0`                                                         |
| Endpoint         | `POST /v1/telemetry/events`                                   |
| Staging base URL | `https://wellapath-backend-staging.onrender.com`              |
| Auth             | None (same as `/config`)                                      |
| Content type     | `application/json` only                                       |
| Default state    | **Disabled.** Enabled per environment via `TELEMETRY_ENABLED` |

### Machine-readable artifacts

| Artifact                          | Path                                         |
| --------------------------------- | -------------------------------------------- |
| JSON Schema (draft 2020-12)       | `docs/contracts/telemetry.v1.schema.json`    |
| OpenAPI 3.1                       | `docs/contracts/telemetry.v1.openapi.json`   |
| Event/property allowlist matrix   | `docs/contracts/telemetry.v1.allowlist.json` |
| Generated TypeScript client types | `docs/contracts/telemetry.v1.client.ts`      |

All four are **generated** from `src/telemetry/contract.ts`, which is also what the server
validates against. CI regenerates them and fails if they drift
(`npm run telemetry:contract:check`). Regenerate locally with `npm run telemetry:contract`.

---

## 1. What this contract will never carry

The backend refuses, structurally, to accept any of the following. This is enforced by an
allowlist — a property that is not declared is rejected regardless of what it is called — with a
prohibited-key and prohibited-value-shape layer behind it.

- symptoms, complaints, presenting problems
- answers, answer values, assessment histories or paths
- clinical free text, narratives, notes, comments
- condition predictions, differentials, likelihoods
- scores or scoring contributions
- red flags, rule IDs, rule matches
- urgency or triage categories
- pregnancy or comparable sensitive clinical status
- names, emails, phone numbers, account or user identifiers
- exact coordinates, full addresses, unbounded location data
- authorization headers, cookies, tokens, secrets
- any generic `properties` / `metadata` / `context` / `extra` / `data` container

**Clinical scoring, red-flag evaluation and urgency determination remain entirely on-device.**
This endpoint is write-only observability. It returns no clinical data, influences no clinical
behaviour, and is not consulted by any assessment flow.

---

## 2. Request

```jsonc
{
  "contract_version": "1.0",
  "sent_at": "2026-08-11T09:01:14.639Z",
  "app": {
    "platform": "android",
    "app_version": "1.4.2",
    "app_build": "204",
    "os_version": "14",
  },
  "events": [
    /* 1–20 events */
  ],
}
```

### Envelope

| Field              | Type   | Required | Rules                                | Privacy class |
| ------------------ | ------ | -------- | ------------------------------------ | ------------- |
| `contract_version` | string | yes      | Must be `1.0`                        | operational   |
| `sent_at`          | string | yes      | ISO-8601 **UTC** (`Z`), max 24 chars | operational   |
| `app`              | object | yes      | See below                            | —             |
| `events`           | array  | yes      | 1–20 items                           | —             |

Unknown envelope keys reject the **whole request**.

### `app` context

Sent once per batch, not per event.

| Field         | Type   | Required | Rules                             | Privacy class |
| ------------- | ------ | -------- | --------------------------------- | ------------- |
| `platform`    | enum   | yes      | `ios` \| `android`                | operational   |
| `app_version` | string | yes      | `1.4.2` or `1.4.2-beta.3`, max 24 | operational   |
| `app_build`   | string | yes      | digits only, max 10               | operational   |
| `os_version`  | string | no       | **major[.minor] only**, max 8     | operational   |

> `os_version` deliberately rejects full build strings such as `17.4.1 (21E236)`. Send `17.4`.
> Device model, device ID, install ID, advertising ID, IDFV/ANDROID_ID, carrier, screen metrics
> and timezone are **not accepted** — each is an identifier or a fingerprinting surface.

### Common event fields

Every event carries these three.

| Field        | Type   | Required | Rules                                   | Privacy class          |
| ------------ | ------ | -------- | --------------------------------------- | ---------------------- |
| `event_name` | enum   | yes      | One of the 12 below                     | operational            |
| `event_id`   | string | yes      | `[A-Za-z0-9_-]{8,64}`, unique per event | ephemeral-pseudonymous |
| `client_ts`  | string | yes      | ISO-8601 UTC; ≤30 days old, ≤24 h ahead | operational            |

---

## 3. Event allowlist and property matrix

`session` below means `assessment_session_id`: an **opaque, ephemeral** ID matching
`[A-Za-z0-9_-]{16,64}`, generated fresh per assessment. It must **not** be derived from device
identity, account identity, or any persistent value, and must not be reused across assessments.

### `app_open`

| Property          | Type    | Required | Allowed values | Privacy     |
| ----------------- | ------- | -------- | -------------- | ----------- |
| `launch_type`     | enum    | yes      | `cold`, `warm` | operational |
| `is_first_launch` | boolean | no       |                | operational |

### `assessment_start`

| Property                | Type   | Required | Allowed values                                     | Privacy                |
| ----------------------- | ------ | -------- | -------------------------------------------------- | ---------------------- |
| `assessment_session_id` | string | yes      | opaque ID, 16–64                                   | ephemeral-pseudonymous |
| `flow_version`          | string | no       | e.g. `1.0`, max 12                                 | operational            |
| `entry_point`           | enum   | no       | `home`, `library`, `facility_locator`, `deep_link` | operational            |

### `assessment_step_view`

| Property                | Type    | Required | Allowed values | Privacy                |
| ----------------------- | ------- | -------- | -------------- | ---------------------- |
| `assessment_session_id` | string  | yes      | opaque ID      | ephemeral-pseudonymous |
| `step_index`            | integer | yes      | 0–200          | operational            |
| `step_count`            | integer | no       | 1–200          | operational            |

> **`question_id` is NOT accepted in v1.0.** See §8 — this is an open item, not an oversight.

### `assessment_complete`

| Property                | Type    | Required | Allowed values                          | Privacy                |
| ----------------------- | ------- | -------- | --------------------------------------- | ---------------------- |
| `assessment_session_id` | string  | yes      | opaque ID                               | ephemeral-pseudonymous |
| `completion_status`     | enum    | yes      | `completed`, `abandoned`, `interrupted` | operational            |
| `duration_ms`           | integer | no       | 0–7 200 000                             | operational            |
| `step_count`            | integer | no       | 0–200                                   | operational            |

> **`urgency_category` is NOT accepted.** See §8.

### `result_view`

| Property                        | Type   | Required | Allowed values     | Privacy                |
| ------------------------------- | ------ | -------- | ------------------ | ---------------------- |
| `assessment_session_id`         | string | yes      | opaque ID          | ephemeral-pseudonymous |
| `presentation_contract_version` | string | no       | e.g. `1.0`, max 12 | operational            |

> No condition, differential, score, explanation, urgency, symptom or narrative. Ever.

### `facility_search`

| Property          | Type    | Required | Allowed values                                | Privacy          |
| ----------------- | ------- | -------- | --------------------------------------------- | ---------------- |
| `search_mode`     | enum    | yes      | `nearby`, `manual_area`, `name`               | operational      |
| `admin_area_code` | enum    | no       | ISO 3166-2:NG, 37 codes (`NG-LA`, `NG-FC`, …) | coarse-geography |
| `result_count`    | integer | no       | 0–500                                         | operational      |

> **State level is the finest geography this contract will ever accept.** No coordinates, no
> address text, no search query text, no location history. `admin_area_code` is optional —
> **omit it** if the client cannot map its area to a code with confidence. See §8.

### `facility_view` · `facility_call` · `directions_open`

| Property      | Type   | Required | Allowed values                                                                                                                                                        | Privacy           |
| ------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `facility_id` | string | yes      | `[A-Za-z0-9_.:-]{1,64}`                                                                                                                                               | content-reference |
| `source`      | enum   | no       | `facility_view`: `search_results`, `map`, `saved`, `emergency_screen`<br>`facility_call` / `directions_open`: `search_results`, `facility_detail`, `emergency_screen` | operational       |

> No phone number — it is already published in the facilities artifact. No origin coordinates,
> no route data. **No `assessment_session_id`** on these events.

### `emergency_action`

| Property      | Type | Required | Allowed values                                                                                          | Privacy     |
| ------------- | ---- | -------- | ------------------------------------------------------------------------------------------------------- | ----------- |
| `action_type` | enum | yes      | `call_emergency_number`, `view_emergency_guidance`, `dismiss_emergency_banner`, `open_nearest_facility` | operational |

> **No `assessment_session_id` is accepted on this event**, deliberately: correlating an
> emergency action back to an assessment would imply a red-flag match, which is clinical data.
> The triggering symptom, answer, red flag, rule and narrative are all rejected.

### `library_article_view`

| Property          | Type   | Required | Allowed values          | Privacy           |
| ----------------- | ------ | -------- | ----------------------- | ----------------- |
| `article_id`      | string | yes      | `[A-Za-z0-9_.:-]{1,64}` | content-reference |
| `content_version` | string | no       | e.g. `2.4`, max 12      | operational       |

> No session correlation, so an article view cannot be joined to a clinical journey.

### `feedback_submit`

| Property   | Type    | Required | Allowed values                                 | Privacy             |
| ---------- | ------- | -------- | ---------------------------------------------- | ------------------- |
| `rating`   | integer | yes      | 1–5                                            | structured-feedback |
| `category` | enum    | no       | `usability`, `performance`, `content`, `other` | structured-feedback |

> **Free-text feedback must not be routed through this endpoint.** There is no field for it and
> any attempt is rejected. If free-text feedback is a product requirement, it needs its own
> reviewed path — see §8.

---

## 4. Response

### 202 Accepted — the envelope was valid

Returned whenever the envelope validates, **even if every event in it was rejected**.

```json
{
  "contract_version": "1.0",
  "received": 3,
  "accepted": 2,
  "rejected": 1,
  "duplicates": 0,
  "results": [
    { "index": 0, "status": "accepted" },
    { "index": 1, "status": "rejected", "reason": "unknown_event" },
    { "index": 2, "status": "accepted" }
  ]
}
```

`results[i].index` is the position in the array you sent. `status` is `accepted`, `rejected` or
`duplicate`. `reason` is a fixed code. `field` appears only when the rejection relates to an
allowlisted field name — **a key you invented is never echoed back**.

### Error responses

All errors use the service-wide envelope, with an added `reason_code`:

```json
{
  "error": {
    "statusCode": 400,
    "message": "Invalid telemetry envelope",
    "reason_code": "invalid_envelope"
  }
}
```

| Status | Meaning                                                                            | Client action                                                       |
| ------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `400`  | Envelope invalid (bad version, unknown key, malformed JSON, empty/oversized batch) | **Permanent. Do not retry unchanged.** Drop the batch.              |
| `413`  | Body over 32 768 bytes                                                             | **Permanent.** Split into smaller batches.                          |
| `415`  | Content-Type was not `application/json`                                            | **Permanent.** Fix the header.                                      |
| `429`  | Rate limited (60 req/min per client by default)                                    | **Retryable.** Back off, see §5.                                    |
| `503`  | `reason_code: telemetry_disabled`                                                  | **Discard the batch and stop sending for the rest of the session.** |
| `5xx`  | Unexpected server error                                                            | Retryable with backoff, bounded.                                    |

Messages are generic and fixed. They never quote what you sent.

---

## 5. Client behaviour

### Batching

- 1–20 events per request, max 32 768 bytes.
- Batching is optional; a single event per request is valid.
- Prefer flushing on app background, on a timer, or at 20 queued events.

### Timeouts and retries

- **Request timeout:** 10 s.
- **Retry only on `429`, `5xx`, and network/timeout failures.** Never retry `400`, `413`, `415`.
- **Bounded:** at most 3 attempts per batch, exponential backoff starting at 2 s (2 s, 4 s, 8 s)
  with jitter. After that, drop the batch.
- On `429`, honour `retry-after` if present.

### Offline queue

- Queue events on device when offline or when a flush fails.
- **Cap the queue** — 500 events is the recommended ceiling; drop oldest first beyond it.
- `client_ts` must be the time the event **occurred**, not the time it was flushed. Events up to
  **30 days old** are accepted; older ones are rejected as `timestamp_out_of_range`.
- The queue must not be persisted in a way that survives an app uninstall, and must contain
  nothing beyond what this contract allows.
- **Telemetry must never block, delay or alter an assessment, red-flag, scoring, result,
  emergency or facility-locator flow.** Flush off the critical path.

### De-duplication

- Generate a unique `event_id` per event, **once**, at the moment the event occurs — not at
  flush time. Reuse the same ID across retries; that is what makes de-duplication work.
- The server remembers event IDs for **1 hour**, per instance, best-effort. An event re-sent
  after that window, or to a different instance, will be counted twice.
- **Do not depend on exactly-once semantics.** Duplicate suppression is a courtesy, not a
  guarantee. It is safe to retry.

### Contract version negotiation

- Always send `contract_version: "1.0"`.
- The server accepts only versions it knows; anything else returns `400`
  `unsupported_contract_version`.
- **Additive changes** (a new optional property, a new event name) ship as a **minor** bump. A
  client on `1.0` keeps working — it simply does not send the new fields.
- **Breaking changes** (removing or narrowing a field, changing a type) ship as a **major** bump.
  The server will accept both versions for a documented overlap window so shipped builds keep
  working; that window will be announced before any major bump.
- A client that receives `unsupported_contract_version` should stop sending telemetry for the
  session rather than downgrade its payload.

---

## 6. Valid payload examples

**Single event**

```json
{
  "contract_version": "1.0",
  "sent_at": "2026-08-11T09:01:14.639Z",
  "app": { "platform": "ios", "app_version": "1.4.2", "app_build": "204", "os_version": "17.4" },
  "events": [
    {
      "event_name": "app_open",
      "event_id": "a1b2c3d4e5f60718",
      "client_ts": "2026-08-11T09:01:14.100Z",
      "launch_type": "cold",
      "is_first_launch": false
    }
  ]
}
```

**Assessment funnel**

```json
{
  "contract_version": "1.0",
  "sent_at": "2026-08-11T09:12:00.000Z",
  "app": { "platform": "android", "app_version": "1.4.2", "app_build": "204", "os_version": "14" },
  "events": [
    {
      "event_name": "assessment_start",
      "event_id": "evt_0000000000000001",
      "client_ts": "2026-08-11T09:10:00.000Z",
      "assessment_session_id": "s_7f3a9c21b8e04d6f",
      "flow_version": "1.0",
      "entry_point": "home"
    },
    {
      "event_name": "assessment_step_view",
      "event_id": "evt_0000000000000002",
      "client_ts": "2026-08-11T09:10:05.000Z",
      "assessment_session_id": "s_7f3a9c21b8e04d6f",
      "step_index": 0,
      "step_count": 8
    },
    {
      "event_name": "assessment_complete",
      "event_id": "evt_0000000000000003",
      "client_ts": "2026-08-11T09:11:30.000Z",
      "assessment_session_id": "s_7f3a9c21b8e04d6f",
      "completion_status": "completed",
      "duration_ms": 90000,
      "step_count": 8
    }
  ]
}
```

**Facility interaction**

```json
{
  "contract_version": "1.0",
  "sent_at": "2026-08-11T09:20:00.000Z",
  "app": { "platform": "android", "app_version": "1.4.2", "app_build": "204" },
  "events": [
    {
      "event_name": "facility_search",
      "event_id": "evt_0000000000000010",
      "client_ts": "2026-08-11T09:19:00.000Z",
      "search_mode": "nearby",
      "admin_area_code": "NG-LA",
      "result_count": 12
    },
    {
      "event_name": "facility_call",
      "event_id": "evt_0000000000000011",
      "client_ts": "2026-08-11T09:19:40.000Z",
      "facility_id": "fac_lagos_00123",
      "source": "facility_detail"
    }
  ]
}
```

---

## 7. Prohibited payload examples and expected rejection

Each of these is covered by an automated test in `tests/privacy/adversarial.test.ts`.

| What you send                                                             | Result                  | `reason`                   |
| ------------------------------------------------------------------------- | ----------------------- | -------------------------- |
| `{"event_name":"symptom_entered", ...}`                                   | event rejected          | `unknown_event`            |
| `assessment_step_view` + `"question_id":"q_017"`                          | event rejected          | `prohibited_field`         |
| `assessment_step_view` + `"answer":"severe headache"`                     | event rejected          | `prohibited_field`         |
| `assessment_complete` + `"urgency_category":"EMERGENCY"`                  | event rejected          | `prohibited_field`         |
| `result_view` + `"condition":"malaria"`                                   | event rejected          | `prohibited_field`         |
| `result_view` + `"score":87`                                              | event rejected          | `prohibited_field`         |
| `emergency_action` + `"red_flag":"rf_006"`                                | event rejected          | `prohibited_field`         |
| `feedback_submit` + `"free_text":"..."`                                   | event rejected          | `prohibited_field`         |
| `facility_search` + `"latitude":6.52,"longitude":3.37`                    | event rejected          | `prohibited_field`         |
| `facility_view` + `"facility_id":"6.5243793,3.3792057"`                   | event rejected          | `prohibited_value_shape`   |
| any event + `"email":"a@b.com"` / `"name"` / `"phone_number"`             | event rejected          | `prohibited_field`         |
| any event + `"access_token":"..."`                                        | event rejected          | `prohibited_field`         |
| any event + `"metadata":{...}` / `"properties":{...}` / `"context":{...}` | event rejected          | `prohibited_container`     |
| any event + `"__proto__":{...}` / `"constructor":{...}`                   | event rejected          | `unsafe_key`               |
| any event + an undeclared key like `"my_field":1`                         | event rejected          | `unknown_property`         |
| any property holding an object or array                                   | event rejected          | `nested_value_not_allowed` |
| `patient_name` at envelope level                                          | **whole request** `400` | `prohibited_field`         |

Rejected content is **not logged, not persisted, and not forwarded to any sink** — proven by the
same test file, which asserts the absence of distinctive markers from both the captured log
output and the sink.

### Complete rejection reason codes

`malformed_json`, `payload_too_large`, `unsupported_content_type`, `invalid_envelope`,
`unsupported_contract_version`, `empty_batch`, `batch_too_large`, `telemetry_disabled`,
`rate_limited`, `unknown_event`, `unknown_property`, `missing_required_property`,
`invalid_type`, `invalid_enum_value`, `invalid_format`, `value_too_long`, `value_out_of_range`,
`timestamp_out_of_range`, `nested_value_not_allowed`, `prohibited_field`,
`prohibited_container`, `prohibited_value_shape`, `unsafe_key`, `payload_too_complex`.

---

## 8. Excluded and unresolved fields

Per the I1/W1 brief: any field whose safety or product meaning is unclear is **excluded and
listed**, not invented. Each of these requires a named owner's decision before it can enter a
future contract version.

| Field                                        | Status                                         | What is needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `urgency_category` on `assessment_complete`  | **Excluded**                                   | The brief excludes it by default unless already approved in repository documentation. It is not — no approval exists in this repo. It is a clinical output. Needs explicit founder + engineering lead approval, recorded in `wellapath-docs/decision-log.md`, before it could be added.                                                                                                                                                                                                                                                               |
| `question_id` on `assessment_step_view`      | **Excluded**                                   | If the question flow is adaptive, the sequence of question IDs within one session is answer-derived, and storing it would let the backend partially reconstruct an assessment path — which the locked architecture forbids. Needs written confirmation from the mobile/clinical owner that question IDs are **branch-independent**. If they are not, the alternative is to accept `question_id` **without** `assessment_session_id`, giving per-question volume with no path reconstruction. `step_index` covers the drop-off funnel in the meantime. |
| Free-text feedback body                      | **Excluded — permanently, from this endpoint** | The brief forbids collecting free text through the analytics endpoint. If the product needs it, it requires its own reviewed intake path with its own privacy review. Not an analytics field.                                                                                                                                                                                                                                                                                                                                                         |
| `admin_area_code` value mapping              | **Accepted, mapping unconfirmed**              | The field is allowlisted against the 37 ISO 3166-2:NG codes. What is unconfirmed is how the mobile client derives it from the facilities artifact's own area field. Until the facilities owner confirms that mapping, **omit the field** — it is optional. Sending a wrong-but-valid code is worse than sending nothing.                                                                                                                                                                                                                              |
| `article_category` on `library_article_view` | **Excluded**                                   | No approved category value set exists. `article_id` covers the need.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Network type / connectivity                  | **Excluded**                                   | Not requested by the brief and no product owner has asked for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## 9. Next step for Mobile Engineering

Mobile instrumentation is **unblocked**. The inputs for the next prompt are listed in the
completion report; in short:

1. Read `docs/contracts/telemetry.v1.openapi.json` and `docs/contracts/telemetry.v1.client.ts`.
2. Implement emission for the 12 events above, honouring §5 for batching, retry, offline queue
   and de-duplication.
3. Point staging builds at `POST https://wellapath-backend-staging.onrender.com/v1/telemetry/events`.
4. Do not emit any excluded field in §8. If a product requirement seems to need one, raise it
   as a decision rather than sending it — the server will reject it and count it as a
   prohibited-field attempt.
