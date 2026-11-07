-- 0007 auth_events: security audit, append-only with the same protections as
-- moderation_actions (contract §12.3). Never stores secrets, plaintext emails or raw IPs:
-- email_hmac and ip_hash are keyed HMACs.
-- Rollback note: down drops the security audit trail. Disposable databases only.

CREATE TABLE auth_events (
  id bigserial PRIMARY KEY,
  event text NOT NULL CHECK (event IN (
    'otp_requested', 'sign_in_succeeded', 'sign_in_failed', 'family_created', 'refresh_rotated',
    'refresh_reuse_detected', 'family_revoked', 'logout', 'sessions_revoked_by_user',
    'totp_enrol_started', 'totp_enrolled', 'step_up_succeeded', 'step_up_failed', 'totp_lockout',
    'rate_limited', 'data_exported', 'account_deleted'
  )),
  account_id text,
  family_id uuid,
  email_hmac text,
  ip_hash text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_account_idx ON auth_events (account_id, created_at);
CREATE INDEX auth_events_event_idx ON auth_events (event, created_at);

CREATE TRIGGER auth_events_server_time
  BEFORE INSERT ON auth_events
  FOR EACH ROW EXECUTE FUNCTION community_force_server_time();
CREATE TRIGGER auth_events_no_update_delete
  BEFORE UPDATE OR DELETE ON auth_events
  FOR EACH ROW EXECUTE FUNCTION community_reject_change();
CREATE TRIGGER auth_events_no_truncate
  BEFORE TRUNCATE ON auth_events
  FOR EACH STATEMENT EXECUTE FUNCTION community_reject_change();

REVOKE UPDATE, DELETE, TRUNCATE ON auth_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'community_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON auth_events FROM community_app';
  END IF;
END
$$;
