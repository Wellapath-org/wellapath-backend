-- 0004 reports, append-only moderation log, account restrictions.
-- Rollback note: down drops the moderation audit trail. That destroys regulatory evidence, so
-- it is permitted only on disposable databases. On any database holding real reports, roll
-- forward instead.

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  target_type text NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'spam', 'harassment', 'misinformation', 'unsafe_medical_advice', 'self_harm', 'privacy', 'other'
  )),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_status_created_idx ON reports (status, created_at);

CREATE TABLE moderation_actions (
  id bigserial PRIMARY KEY,
  actor_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN (
    'hide_content', 'remove_content', 'restore_content', 'dismiss_report',
    'suspend_account', 'unsuspend_account', 'grant_role', 'verify_professional',
    'revoke_professional', 'delete_account'
  )),
  target_type text NOT NULL CHECK (target_type IN ('post', 'comment', 'user', 'report', 'professional_verification')),
  target_id text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  -- Snapshot of what was acted on, so later deletion of the content does not erase evidence.
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_actions_target_idx ON moderation_actions (target_type, target_id);

-- Append-only, enforced twice:
-- 1. Triggers reject UPDATE, DELETE and TRUNCATE for every role, the table owner included.
-- 2. The runtime role has no UPDATE/DELETE/TRUNCATE privilege at all.
-- created_at is forced to server time so a caller cannot backdate an entry.
CREATE FUNCTION moderation_actions_force_server_time() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER moderation_actions_server_time
  BEFORE INSERT ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION moderation_actions_force_server_time();

CREATE FUNCTION moderation_actions_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'moderation_actions is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER moderation_actions_no_update_delete
  BEFORE UPDATE OR DELETE ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION moderation_actions_reject_change();
CREATE TRIGGER moderation_actions_no_truncate
  BEFORE TRUNCATE ON moderation_actions
  FOR EACH STATEMENT EXECUTE FUNCTION moderation_actions_reject_change();

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
  kind text NOT NULL CHECK (kind IN ('suspended')),
  reason text NOT NULL,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  lifted_at timestamptz,
  lifted_by text REFERENCES "user" ("id")
);
CREATE INDEX account_restrictions_user_idx ON account_restrictions (user_id);
