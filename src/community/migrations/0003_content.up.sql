-- 0003 spaces, posts, comments. Exactly two spaces are seeded (approved internal MVP scope).
-- Rollback note: down drops all content. Never run on production data; forward-fix instead.

CREATE TABLE spaces (
  slug text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO spaces (slug, name) VALUES
  ('general_health', 'General Health'),
  ('pregnancy_maternal', 'Pregnancy and Maternal Health');

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_slug text NOT NULL REFERENCES spaces (slug),
  -- Accountable pseudonymity: the author is always stored. "Anonymous" is a display mode only.
  author_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  display_mode text NOT NULL DEFAULT 'profile' CHECK (display_mode IN ('profile', 'anonymous')),
  body text CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'visible'
    CHECK (status IN ('visible', 'hidden', 'removed', 'deleted_by_author', 'tombstoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT posts_visible_has_body CHECK (status <> 'visible' OR body IS NOT NULL)
);
CREATE INDEX posts_space_created_idx ON posts (space_slug, created_at DESC);
CREATE INDEX posts_author_idx ON posts (author_id);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts (id) ON DELETE RESTRICT,
  author_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  display_mode text NOT NULL DEFAULT 'profile' CHECK (display_mode IN ('profile', 'anonymous')),
  body text CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'visible'
    CHECK (status IN ('visible', 'hidden', 'removed', 'deleted_by_author', 'tombstoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comments_visible_has_body CHECK (status <> 'visible' OR body IS NOT NULL)
);
CREATE INDEX comments_post_idx ON comments (post_id, created_at);
CREATE INDEX comments_author_idx ON comments (author_id);
