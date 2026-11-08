-- 0006 refresh-token families and rotating refresh tokens (ADR A2, contract §3.2).
-- One family per sign-in on a device, bound to device_id and to exactly one Better Auth session
-- (ba_session_id; Better Auth may replace that session, e.g. on TOTP enrolment, and the family
-- follows it). The family id is the access token's `sid`. Refresh tokens are stored only as
-- HMAC-SHA-256(pepper_vN, token). The TOTP step-up for privileged roles lives on the family, so
-- it survives refreshes and dies with the family (contract §2.1).
-- Rollback note: down drops every family: all devices must sign in again. Safe, disruptive.

CREATE TABLE refresh_token_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  ba_session_id text NOT NULL,
  device_id uuid NOT NULL,
  device_label text CHECK (device_label IS NULL OR char_length(device_label) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  step_up_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR revoke_reason IN (
    'logout', 'reuse_detected', 'expired', 'revoked_by_user', 'suspended', 'role_changed',
    'totp_reset', 'totp_lockout', 'account_deleted'
  ))
);
CREATE INDEX refresh_token_families_user_idx ON refresh_token_families (user_id);
CREATE INDEX refresh_token_families_session_idx ON refresh_token_families (ba_session_id);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES refresh_token_families (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  pepper_version integer NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  replaced_by uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
