-- 0008 single WellaPath rate limiter (ADR A3, contract §4), idempotency keys (contract §1.2) and
-- the per-account TOTP lockout (contract A9).
-- Rate-limit buckets are keyed by a server-side HMAC of the dimension value (normalised email,
-- trusted-proxy IP, account id, family id); no plaintext email or IP is stored.
-- Rollback note: down drops counters, stored idempotent responses and lockouts. Safe: limits
-- restart from zero and clients retry with the same Idempotency-Key.

CREATE TABLE rate_limit_counters (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX rate_limit_counters_expiry_idx ON rate_limit_counters (window_start);

CREATE TABLE idempotency_keys (
  account_id text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  method text NOT NULL,
  route text NOT NULL,
  key uuid NOT NULL,
  request_hash text NOT NULL,
  status_code integer,
  response jsonb,
  response_headers jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, method, route, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE totp_lockouts (
  user_id text PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  consecutive_failures integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);
