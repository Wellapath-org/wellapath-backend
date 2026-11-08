-- 0010 auth_events gains `refresh_race` (D-019, founder-approved 2026-11-08): every refresh race is
-- logged, and a tolerated one (409, nothing revoked) needs its own event. Forward-fix only; the
-- table stays append-only (its triggers and grants are untouched).
-- Rollback note: down restores the previous CHECK for new rows only (NOT VALID): rows already
-- logged as `refresh_race` stay, since auth_events is never rewritten. Safe.

ALTER TABLE auth_events DROP CONSTRAINT auth_events_event_check;
ALTER TABLE auth_events ADD CONSTRAINT auth_events_event_check CHECK (event IN (
  'otp_requested', 'sign_in_succeeded', 'sign_in_failed', 'family_created', 'refresh_rotated',
  'refresh_race', 'refresh_reuse_detected', 'family_revoked', 'logout', 'sessions_revoked_by_user',
  'totp_enrol_started', 'totp_enrolled', 'step_up_succeeded', 'step_up_failed', 'totp_lockout',
  'rate_limited', 'data_exported', 'account_deleted'
));
