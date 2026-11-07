-- 0005 in-app notifications (contract §11). Polling only; push is out of scope. A
-- notification carries ids and a notice code only: never an actor id, another member's text or
-- a moderator's reason.
-- Rollback note: down drops notifications; they are derived and safe to lose.

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('reply_to_post', 'comment_reply', 'moderation_notice')),
  post_id uuid,
  comment_id uuid,
  notice text CHECK (notice IS NULL OR notice IN (
    'content_hidden', 'content_removed', 'content_restored', 'account_restricted',
    'account_suspended', 'account_reinstated', 'verification_updated'
  )),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_notice_iff_moderation CHECK ((type = 'moderation_notice') = (notice IS NOT NULL))
);
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
