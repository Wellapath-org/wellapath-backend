-- 0006 per-session TOTP step-up for privileged roles.
-- Better Auth's two-factor plugin only challenges password/username/phone sign-in, not email-OTP
-- sign-in, so the mandatory-2FA rule for moderators and admins is enforced by the API: a
-- privileged request needs a session whose TOTP step-up is recorded here and still fresh.
-- Rollback note: down drops step-up state; every privileged user must step up again. Safe.

CREATE TABLE session_step_up (
  session_id text PRIMARY KEY REFERENCES "session" ("id") ON DELETE CASCADE,
  verified_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0
);
