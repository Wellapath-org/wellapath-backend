/**
 * Per-user export and deletion (ADR-001 R5, NDPA 2023, contract §7 M7/M8).
 *
 * Deletion policy (retention periods still need legal input, PoC P11):
 * - PII is erased: email (unroutable placeholder), name, image, profile, professional claims,
 *   notifications.
 * - Every session, refresh family, refresh token, TOTP secret, lockout and pending OTP is
 *   deleted.
 * - The `user` row stays as a tombstone (`deletedAt`) so foreign keys from content, reports and
 *   the moderation log stay valid.
 * - Posts and comments are tombstoned: body NULL, status `tombstoned`, display mode
 *   pseudonymous. They are never shown to members again.
 * - Moderation evidence is kept: `moderation_actions` is append-only and already snapshots what
 *   was acted on. Content under an OPEN report is snapshotted into the `delete_account` row
 *   before its body is erased, so an open report is not destroyed by its author leaving.
 * - The same email can later create a new, unrelated account.
 */
import { Pool, PoolClient } from 'pg';
import { ts } from './http';
import { TokenService } from './tokens';

export interface UserExport {
  format: 'wellapath-community-export';
  version: 1;
  exported_at: string;
  account: Record<string, unknown>;
  profile: Record<string, unknown> | null;
  professional_verifications: Record<string, unknown>[];
  posts: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  reports_filed: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  restrictions: Record<string, unknown>[];
}

const isoRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? ts(v) : v;
  return out;
};

export const exportUser = async (pool: Pool, userId: string): Promise<UserExport | null> => {
  const all = async (sql: string): Promise<Record<string, unknown>[]> =>
    (await pool.query(sql, [userId])).rows.map(isoRow);

  const [account] = await all(
    `SELECT "id", "email", "role", "twoFactorEnabled" AS two_factor_enabled,
            "createdAt" AS created_at
       FROM "user" WHERE "id" = $1 AND "deletedAt" IS NULL`,
  );
  if (!account) return null;
  const [profile] = await all(
    'SELECT display_name, created_at, updated_at FROM profiles WHERE user_id = $1',
  );
  return {
    format: 'wellapath-community-export',
    version: 1,
    exported_at: new Date().toISOString(),
    account,
    profile: profile ?? null,
    professional_verifications: await all(
      `SELECT id, profession, specialty, status, verified_at, created_at
         FROM professional_verifications WHERE user_id = $1 ORDER BY created_at`,
    ),
    // Own content, including non-visible items, with bodies where they still exist.
    posts: await all(
      `SELECT id, space_id, display_mode, body, status, created_at, updated_at
         FROM posts WHERE author_id = $1 ORDER BY created_at`,
    ),
    comments: await all(
      `SELECT id, post_id, display_mode, body, status, created_at, updated_at
         FROM comments WHERE author_id = $1 ORDER BY created_at`,
    ),
    reports_filed: await all(
      `SELECT id, target_type, target_id, reason, note, status, created_at
         FROM reports WHERE reporter_id = $1 ORDER BY created_at`,
    ),
    notifications: await all(
      `SELECT id, type, post_id, comment_id, notice, read_at, created_at
         FROM notifications WHERE user_id = $1 ORDER BY created_at`,
    ),
    // Device label and timestamps only: no tokens, no hashes.
    sessions: await all(
      `SELECT device_label, created_at, last_used_at, absolute_expires_at, revoked_at
         FROM refresh_token_families WHERE user_id = $1 ORDER BY created_at`,
    ),
    // The user's own restrictions; the restricting moderator's identity is not exported.
    restrictions: await all(
      `SELECT kind, reason, created_at, expires_at, lifted_at
         FROM account_restrictions WHERE user_id = $1 ORDER BY id`,
    ),
  };
};

/**
 * The Better Auth email-OTP purposes (better-auth 1.7.18 `emailOTP`, `toOTPIdentifier`): each
 * pending code is one `verification` row with identifier `<type>-otp-<lower-cased email>`.
 * (`change-email` rows are keyed by account id + the NEW address, and that flow is not exposed.)
 */
export const OTP_TYPES = ['sign-in', 'email-verification', 'forget-password'] as const;

/** The exact `verification` identifiers that can hold a pending code for [email]. */
export const otpIdentifiers = (email: string): string[] => {
  const forms = [...new Set([email, email.toLowerCase()])];
  return OTP_TYPES.flatMap(type => forms.map(form => `${type}-otp-${form}`));
};

const snapshotOpenReports = async (
  client: PoolClient,
  userId: string,
): Promise<Record<string, unknown>[]> => {
  const { rows } = await client.query(
    `SELECT r.id AS report_id, r.target_type, r.target_id, r.reason, r.created_at AS reported_at,
            COALESCE(p.body, c.body) AS body
       FROM reports r
       LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
       LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id
      WHERE r.status = 'open' AND (p.author_id = $1 OR c.author_id = $1)`,
    [userId],
  );
  return rows;
};

/** Erases a user's PII and tombstones their content. Returns false if no such live user. */
export const deleteUser = async (
  pool: Pool,
  tokens: TokenService,
  userId: string,
): Promise<boolean> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ email: string }>(
      `SELECT "email" FROM "user" WHERE "id" = $1 AND "deletedAt" IS NULL FOR UPDATE`,
      [userId],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const email = rows[0].email;

    const reported = await snapshotOpenReports(client, userId);
    await client.query(
      `INSERT INTO moderation_actions
         (actor_account_id, action, target_type, target_id, reason, evidence)
       VALUES ($1, 'delete_account', 'account', $1, 'user-requested account deletion', $2)`,
      [userId, JSON.stringify({ author_account_id: userId, reported_content: reported })],
    );

    for (const table of ['posts', 'comments']) {
      await client.query(
        `UPDATE ${table} SET body = NULL, status = 'tombstoned', display_mode = 'pseudonymous',
                updated_at = now()
          WHERE author_id = $1`,
        [userId],
      );
    }

    await tokens.revokeAllForUser(userId, 'account_deleted', client);
    await client.query('DELETE FROM refresh_token_families WHERE user_id = $1', [userId]);
    // Pending OTPs: exact identifiers only (SEC-008). A LIKE pattern built from the address
    // would treat `_` / `%` in it as wildcards and delete other users' pending codes.
    await client.query(`DELETE FROM "verification" WHERE "identifier" = ANY($1::text[])`, [
      otpIdentifiers(email),
    ]);
    await client.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM professional_verifications WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM profiles WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM idempotency_keys WHERE account_id = $1', [userId]);
    await client.query('DELETE FROM totp_lockouts WHERE user_id = $1', [userId]);
    await client.query(`DELETE FROM "twoFactor" WHERE "userId" = $1`, [userId]);
    await client.query(`DELETE FROM "account" WHERE "userId" = $1`, [userId]);
    await client.query(`DELETE FROM "session" WHERE "userId" = $1`, [userId]);
    await client.query(
      `UPDATE "user"
          SET "email" = 'deleted+' || "id" || '@deleted.invalid', "name" = '',
              "image" = NULL, "emailVerified" = false, "twoFactorEnabled" = false,
              "role" = 'member', "deletedAt" = now(), "updatedAt" = now()
        WHERE "id" = $1`,
      [userId],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
