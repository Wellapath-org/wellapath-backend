# Distribution Baseline Freeze — I3 Step 1

> **The machine-readable freeze is `docs/baseline/distribution-baseline.v1.json`.** This page
> explains what it records, how evidence classes are separated, and how the drift check works.

## What was frozen, and from where

| Item                     | Value                                                             |
| ------------------------ | ----------------------------------------------------------------- |
| Repository commit        | `1c0fd1676f926cb78f0c72a108788a1746cb180f` (`origin/develop` tip) |
| Authoritative KB commit  | `c1b07944ea0b231914943ac17b2265441e53b85c` (relayed by task)      |
| Frozen on                | 2026-08-28 (UTC)                                                  |
| Live service observed    | `wellapath-backend-staging.onrender.com`                          |
| Artifact origin observed | R2 public origin (the one `/config` serves)                       |

The freeze records: the exact `/config` response and its canonical sha256; every artifact's
version, hash, **byte count** and storage key; the object-key convention; authentication
(none), caching (none set anywhere — recorded as a gap), rate limiting, error/fallback
behaviour, environment-specific behaviour, the rollback mechanism, and the fields Mobile
consumes (marked **inferred**, since the mobile repository is not verifiable from here).

## Evidence classes — kept strictly apart

The freeze never blends what it knows with how it knows it:

- **`repository_baseline`** — read from source at the recorded commit. Reproducible by anyone
  at that commit.
- **`deployed_observation`** — what the live staging service and R2 objects actually returned
  on the recorded date, with recomputed sha256 digests. Point-in-time facts. Notably: the live
  `/config` matched the repository byte-for-byte, all four artifact hashes recomputed to exact
  matches, all recorded rollback targets returned HTTP 200 — and `/health` was **degraded**
  (`database: error`, consistent with the known Supabase free-tier idle pause; `/config` was
  unaffected, as designed).
- **`inferred`** — conclusions not directly proven (e.g. which fields Mobile reads).
- **`unavailable_evidence`** — what could not be verified from this repository (mobile source,
  R2 account configuration, Render env values, production state, KB repo content).

No secrets, signed URLs, credentials or private routing values appear in the freeze — a test
asserts this.

## The drift check

`tests/baseline/baseline-drift.test.ts` runs in every `npm test` / CI run. It:

1. builds the **real** application and requests `GET /config`;
2. compares the response **field-for-field** against the frozen `repository_baseline.response`;
3. recomputes the canonical sha256 (keys sorted recursively, no whitespace) and compares it to
   the frozen `response_canonical_sha256`;
4. checks the frozen invariants (no cache headers, no authentication);
5. cross-checks the deployed observation against the repository hashes;
6. scans the freeze itself for secret material.

Any change to `/config` — a key, a value, a hash, an artifact — fails CI. That alarm is the
point: the baseline cannot drift silently. (The pre-existing E9.1 regression suite,
`tests/regression/existing-endpoints.test.ts`, independently asserts the same frozen values
literally; the two checks back each other up.)

To **intentionally** move the baseline (requires engineering-lead approval under the E9.1
freeze): change `/config`, regenerate the affected `repository_baseline` values, update the
canonical hash, bump `baseline_version`, and record the decision reference in the PR.
