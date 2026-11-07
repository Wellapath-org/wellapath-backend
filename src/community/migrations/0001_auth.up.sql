-- 0001 auth: Better Auth core tables (user, session, account, verification) and the tables of
-- the plugins in use (jwt -> jwks, two-factor -> twoFactor). Column names follow Better Auth's
-- defaults (camelCase, quoted) so the library needs no field mapping. Generated from
-- better-auth 1.7.18 `getMigrations().compileMigrations()` and then hardened by hand.
-- Rollback note: 0001.down drops every auth table. Destructive: only valid on an empty or
-- disposable database (local, test, or a Neon branch), never on production data.

-- Runtime role grants. The migration owner creates tables; the application connects as
-- `community_app`, which gets DML only (no DDL). If the role does not exist (e.g. a developer
-- database), the grants are skipped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'community_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO community_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO community_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO community_app';
  END IF;
END
$$;

CREATE TABLE "user" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "twoFactorEnabled" boolean DEFAULT false,
  "role" text NOT NULL DEFAULT 'member' CHECK ("role" IN ('member', 'moderator', 'admin')),
  -- Set when the account is deleted (NDPA erasure). The row stays as a tombstone so content and
  -- moderation evidence keep a valid foreign key; every PII column is overwritten.
  "deletedAt" timestamptz
);

CREATE TABLE "session" (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "session_userId_idx" ON "session" ("userId");

CREATE TABLE "account" (
  "id" text NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX "account_userId_idx" ON "account" ("userId");

CREATE TABLE "verification" (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE "jwks" (
  "id" text NOT NULL PRIMARY KEY,
  "publicKey" text NOT NULL,
  "privateKey" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "expiresAt" timestamptz,
  "alg" text,
  "crv" text
);

CREATE TABLE "twoFactor" (
  "id" text NOT NULL PRIMARY KEY,
  "secret" text NOT NULL,
  "backupCodes" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "verified" boolean,
  "failedVerificationCount" integer,
  "lockedUntil" timestamptz
);
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" ("secret");
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" ("userId");
