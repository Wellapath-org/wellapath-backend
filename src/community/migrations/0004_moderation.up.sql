-- 0004 reports, append-only moderation log, account restrictions (contract §10, §12, §14).
-- Rollback note: down drops the moderation audit trail. That destroys regulatory evidence, so
-- it is permitted only on disposable databases. On any database holding real reports, roll
-- forward instead.

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  target_type text NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'spam', 'harassment', 'misinformation', 'unsafe_medical_advice', 'self_harm_or_emergency',
    'personal_information', 'other'
  )),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_status_created_idx ON reports (status, created_at, id);
CREATE INDEX reports_target_idx ON reports (target_type, target_id);
-- Duplicate detection (contract C9): one open report per reporter per target.
CREATE UNIQUE INDEX reports_one_open_per_reporter_idx
  ON reports (reporter_id, target_type, target_id) WHERE status = 'open';

CREATE TABLE moderation_actions (
  id bigserial PRIMARY KEY,
  actor_account_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN (
    'dismiss_report', 'reveal_identity', 'hide_content', 'restore_content', 'remove_content',
    'restrict_account', 'suspend_account', 'reinstate_account', 'change_role', 'reset_totp',
    'verify_professional', 'revoke_professional', 'withdraw_professional', 'delete_account'
  )),
  target_type text NOT NULL CHECK (target_type IN ('post', 'comment', 'account', 'report', 'professional_verification')),
  target_id text NOT NULL,
  -- Moderator/admin reasons are 10-500 chars. User-originated rows use fixed server reasons.
  reason text NOT NULL CHECK (
    char_length(reason) BETWEEN 10 AND 500
    OR (action IN ('delete_account', 'withdraw_professional') AND char_length(reason) BETWEEN 1 AND 500)
  ),
  -- Server-side snapshot of what was acted on. Never returned by the API.
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_actions_target_idx ON moderation_actions (target_type, target_id);
CREATE INDEX moderation_actions_actor_idx ON moderation_actions (actor_account_id);

-- Append-only, enforced twice:
-- 1. Triggers reject UPDATE, DELETE and TRUNCATE for every role, the table owner included.
-- 2. The runtime role has no UPDATE/DELETE/TRUNCATE privilege at all.
-- created_at is forced to server time so a caller cannot backdate an entry. The functions are
-- shared with auth_events (0007).
CREATE FUNCTION community_force_server_time() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE FUNCTION community_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER moderation_actions_server_time
  BEFORE INSERT ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION community_force_server_time();
CREATE TRIGGER moderation_actions_no_update_delete
  BEFORE UPDATE OR DELETE ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION community_reject_change();
CREATE TRIGGER moderation_actions_no_truncate
  BEFORE TRUNCATE ON moderation_actions
  FOR EACH STATEMENT EXECUTE FUNCTION community_reject_change();

REVOKE UPDATE, DELETE, TRUNCATE ON moderation_actions FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'community_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON moderation_actions FROM community_app';
  END IF;
END
$$;

CREATE TABLE account_restrictions (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('restricted', 'suspended')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  lifted_at timestamptz,
  lifted_by text REFERENCES "user" ("id")
);
CREATE INDEX account_restrictions_user_idx ON account_restrictions (user_id);
