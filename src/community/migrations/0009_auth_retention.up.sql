-- 0009 sign-in retention (founder-approved 2026-11-07). Unverified/pending authentication records
-- that carry an email address must be gone within 24 hours. Better Auth's email-OTP plugin keeps
-- one `verification` row per pending code whose identifier embeds the address
-- (`sign-in-otp-<email>`); it is deleted on successful sign-in but otherwise lingers. The purge
-- (src/community/purge.ts, run as community_app on a timer and as a CLI) deletes rows whose expiry
-- has passed and any row older than the hard cap, so it needs these two indexes to stay cheap.
-- rate_limit_counters is already indexed on window_start (0008).
-- Rollback note: down drops the two indexes only. Safe: the purge still works (sequential scan).

CREATE INDEX IF NOT EXISTS verification_expires_at_idx ON "verification" ("expiresAt");
CREATE INDEX IF NOT EXISTS verification_created_at_idx ON "verification" ("createdAt");
