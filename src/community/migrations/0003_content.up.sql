-- 0003 spaces, posts, comments (contract §8, §9, §14). Exactly two spaces are seeded; no
-- endpoint creates, renames or deletes a space.
-- Rollback note: down drops all content. Never run on production data; forward-fix instead.

CREATE TABLE spaces (
  id text PRIMARY KEY CHECK (id IN ('general_health', 'pregnancy_maternal')),
  name text NOT NULL,
  -- Clinical-review copy. The seeded text is a placeholder until clinical review signs it off.
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO spaces (id, name, description) VALUES
  ('general_health', 'General Health',
   'Share everyday health experiences and questions with other members. Not medical advice: in an emergency call 112.'),
  ('pregnancy_maternal', 'Pregnancy and Maternal Health',
   'Peer support for pregnancy, birth and the months after. Not medical advice: in an emergency call 112.');

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id text NOT NULL REFERENCES spaces (id),
  -- Accountable pseudonymity: the author is always stored. Pseudonymous is a display mode only.
  author_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  display_mode text NOT NULL CHECK (display_mode IN ('named', 'pseudonymous')),
  body text CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'visible'
    CHECK (status IN ('visible', 'hidden', 'removed', 'deleted_by_author', 'tombstoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT posts_visible_has_body CHECK (status NOT IN ('visible', 'hidden', 'removed') OR body IS NOT NULL),
  CONSTRAINT posts_erased_has_no_body CHECK (status NOT IN ('deleted_by_author', 'tombstoned') OR body IS NULL)
);
CREATE INDEX posts_space_created_idx ON posts (space_id, created_at DESC, id DESC);
CREATE INDEX posts_author_idx ON posts (author_id);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Single level only: there is no parent_comment_id column (contract §9).
  post_id uuid NOT NULL REFERENCES posts (id) ON DELETE RESTRICT,
  author_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  display_mode text NOT NULL CHECK (display_mode IN ('named', 'pseudonymous')),
  body text CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'visible'
    CHECK (status IN ('visible', 'hidden', 'removed', 'deleted_by_author', 'tombstoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comments_visible_has_body CHECK (status NOT IN ('visible', 'hidden', 'removed') OR body IS NOT NULL),
  CONSTRAINT comments_erased_has_no_body CHECK (status NOT IN ('deleted_by_author', 'tombstoned') OR body IS NULL)
);
CREATE INDEX comments_post_idx ON comments (post_id, created_at, id);
CREATE INDEX comments_author_idx ON comments (author_id);
