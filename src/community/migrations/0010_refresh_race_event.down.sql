-- Rollback note: restores the previous event list for NEW rows only (NOT VALID). Rows already
-- logged as `refresh_race` stay, because auth_events is append-only and is never rewritten.

ALTER TABLE auth_events DROP CONSTRAINT auth_events_event_check;
ALTER TABLE auth_events ADD CONSTRAINT auth_events_event_check CHECK (event IN (
  'otp_requested', 'sign_in_succeeded', 'sign_in_failed', 'family_created', 'refresh_rotated',
  'refresh_reuse_detected', 'family_revoked', 'logout', 'sessions_revoked_by_user',
  'totp_enrol_started', 'totp_enrolled', 'step_up_succeeded', 'step_up_failed', 'totp_lockout',
  'rate_limited', 'data_exported', 'account_deleted'
)) NOT VALID;
