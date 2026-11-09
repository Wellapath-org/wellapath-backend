-- 0011 auth_events gains `internal_tester_access_granted` (F-077, founder-approved 2026-11-09): an
-- internal tester's FIRST Community access through COMMUNITY_INTERNAL_TESTER_EMAILS (one row per
-- account; no email is stored). Forward-fix only; the table stays append-only (its triggers and
-- grants are untouched).
-- Rollback note: down restores the previous CHECK for new rows only (NOT VALID): rows already
-- logged as `internal_tester_access_granted` stay, since auth_events is never rewritten. Safe.

ALTER TABLE auth_events DROP CONSTRAINT auth_events_event_check;
ALTER TABLE auth_events ADD CONSTRAINT auth_events_event_check CHECK (event IN (
  'otp_requested', 'sign_in_succeeded', 'sign_in_failed', 'family_created', 'refresh_rotated',
  'refresh_race', 'refresh_reuse_detected', 'family_revoked', 'logout', 'sessions_revoked_by_user',
  'totp_enrol_started', 'totp_enrolled', 'step_up_succeeded', 'step_up_failed', 'totp_lockout',
  'rate_limited', 'data_exported', 'account_deleted', 'internal_tester_access_granted'
));
