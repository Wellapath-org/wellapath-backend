-- 0002 profiles and professional verification.
-- Rollback note: down drops both tables (profile and verification data lost). Reversible only
-- before real users exist; afterwards a forward-fix migration is required instead.

CREATE TABLE profiles (
  user_id text PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  -- Public, pseudonymous identity. Never the email or legal name.
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 40),
  is_pseudonymous boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX profiles_display_name_lower_idx ON profiles (lower(display_name));

CREATE TABLE professional_verifications (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  profession text NOT NULL CHECK (char_length(profession) BETWEEN 2 AND 80),
  specialty text CHECK (specialty IS NULL OR char_length(specialty) BETWEEN 2 AND 80),
  -- A self-declared profession is stored as 'claimed' and is never shown as verified.
  status text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'pending', 'verified', 'revoked')),
  verified_by text REFERENCES "user" ("id"),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- DB-level guarantee: 'verified' needs a verifier and a time, and nobody verifies themselves.
  CONSTRAINT professional_verified_requires_verifier CHECK (
    status <> 'verified'
    OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND verified_by <> user_id)
  )
);
CREATE INDEX professional_verifications_user_idx ON professional_verifications (user_id);
