-- 0005 in-app notifications (replies, comments, moderation events). Push is out of scope.
-- Rollback note: down drops notifications; they are derived and safe to lose.

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('comment_on_post', 'moderation')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC);
