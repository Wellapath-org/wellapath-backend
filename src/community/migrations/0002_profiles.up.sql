-- 0002 profiles and professional verification (contract §7, §14).
-- Rollback note: down drops both tables (profile and verification data lost). Reversible only
-- before real users exist; afterwards a forward-fix migration is required instead.

CREATE TABLE profiles (
  user_id text PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  -- Public display name. Never the email or legal name. Pseudonymity is chosen per post or
  -- comment (display_mode), not on the profile.
  display_name text NOT NULL CHECK (
    char_length(display_name) BETWEEN 3 AND 30
    AND display_name ~ '^[A-Za-z0-9 _.-]+$'
    AND display_name = btrim(display_name)
    AND display_name !~ '  '
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX profiles_display_name_lower_idx ON profiles (lower(display_name));

CREATE TABLE professional_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  profession text NOT NULL CHECK (char_length(profession) BETWEEN 2 AND 80),
  specialty text CHECK (specialty IS NULL OR char_length(specialty) BETWEEN 2 AND 80),
  -- A claim always starts as 'pending'. Only an admin transition sets 'verified'.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'revoked')),
  -- Opaque reference to the out-of-band check (no uploads, contract X4).
  evidence_ref text CHECK (evidence_ref IS NULL OR char_length(evidence_ref) BETWEEN 1 AND 200),
  verified_by text REFERENCES "user" ("id"),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- DB-level guarantee: 'verified' needs a verifier and a time, and nobody verifies themselves.
  CONSTRAINT professional_verified_requires_verifier CHECK (
    status <> 'verified'
    OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND verified_by <> user_id)
  ),
  -- verified_at is non-null iff status is verified (contract §7.1).
  CONSTRAINT professional_verified_at_iff_verified CHECK ((status = 'verified') = (verified_at IS NOT NULL))
);
CREATE INDEX professional_verifications_user_idx ON professional_verifications (user_id);
CREATE INDEX professional_verifications_status_idx ON professional_verifications (status, created_at, id);
-- At most one active (pending or verified) claim per account.
CREATE UNIQUE INDEX professional_verifications_one_active_idx
  ON professional_verifications (user_id) WHERE status IN ('pending', 'verified');
