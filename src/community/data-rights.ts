/**
 * Per-user export and deletion (ADR-001 R5, NDPA 2023).
 *
 * Deletion policy implemented by the PoC (retention periods still need legal input):
 * - PII is erased: email, name, image, profile, professional claims, sessions, linked accounts,
 *   TOTP secrets, pending OTPs and notifications.
 * - The `user` row stays as a tombstone (`deletedAt` set, email replaced by an unroutable
 *   placeholder) so foreign keys from content, reports and the moderation log stay valid.
 * - Posts and comments are tombstoned: body erased, status `tombstoned`, shown as anonymous.
 * - Moderation evidence is kept: `moderation_actions` is append-only and already snapshots what
 *   was acted on. Content that was reported but not yet actioned is snapshotted into the
 *   `delete_account` audit row before the body is erased, so an open report is not destroyed by
 *   its author deleting their account.
 */
import { Pool, PoolClient } from 'pg';

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

export const exportUser = async (pool: Pool, userId: string): Promise<UserExport | null> => {
  const one = async (sql: string): Promise<Record<string, unknown>[]> =>
    (await pool.query(sql, [userId])).rows;

  const [account] = await one(
    `SELECT "id", "email", "name", "emailVerified", "role", "twoFactorEnabled", "createdAt"
       FROM "user" WHERE "id" = $1 AND "deletedAt" IS NULL`,
  );
  if (!account) return null;
  const [profile] = await one(
    'SELECT display_name, is_pseudonymous, created_at FROM profiles WHERE user_id = $1',
  );
  return {
    format: 'wellapath-community-export',
    version: 1,
    exported_at: new Date().toISOString(),
    account,
    profile: profile ?? null,
    professional_verifications: await one(
      `SELECT profession, specialty, status, verified_at, created_at
         FROM professional_verifications WHERE user_id = $1 ORDER BY id`,
    ),
    posts: await one(
      `SELECT id, space_slug, display_mode, body, status, created_at
         FROM posts WHERE author_id = $1 ORDER BY created_at`,
    ),
    comments: await one(
      `SELECT id, post_id, display_mode, body, status, created_at
         FROM comments WHERE author_id = $1 ORDER BY created_at`,
    ),
    reports_filed: await one(
      `SELECT id, target_type, target_id, reason, note, status, created_at
         FROM reports WHERE reporter_id = $1 ORDER BY created_at`,
    ),
    notifications: await one(
      `SELECT kind, payload, read_at, created_at
         FROM notifications WHERE user_id = $1 ORDER BY created_at`,
    ),
    // Session tokens are credentials and are never exported.
    sessions: await one(
      `SELECT "createdAt", "expiresAt", "userAgent" FROM "session" WHERE "userId" = $1`,
    ),
    restrictions: await one(
      `SELECT kind, reason, created_at, expires_at, lifted_at
         FROM account_restrictions WHERE user_id = $1 ORDER BY id`,
    ),
  };
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
export const deleteUser = async (pool: Pool, userId: string, reason: string): Promise<boolean> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT "id" FROM "user" WHERE "id" = $1 AND "deletedAt" IS NULL FOR UPDATE`,
      [userId],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    const reported = await snapshotOpenReports(client, userId);
    await client.query(
      `INSERT INTO moderation_actions (actor_id, action, target_type, target_id, reason, evidence)
       VALUES ($1, 'delete_account', 'user', $1, $2, $3)`,
      [userId, reason, JSON.stringify({ reported_content: reported })],
    );

    for (const table of ['posts', 'comments']) {
      await client.query(
        `UPDATE ${table} SET body = NULL, status = 'tombstoned', display_mode = 'anonymous',
                updated_at = now()
          WHERE author_id = $1`,
        [userId],
      );
    }

    const { rows: emailRows } = await client.query<{ email: string }>(
      `SELECT "email" FROM "user" WHERE "id" = $1`,
      [userId],
    );
    const email = emailRows[0].email;
    // Pending OTPs are keyed by email in the identifier.
    await client.query(`DELETE FROM "verification" WHERE "identifier" LIKE '%' || $1`, [email]);
    await client.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM professional_verifications WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM profiles WHERE user_id = $1', [userId]);
    await client.query(`DELETE FROM "twoFactor" WHERE "userId" = $1`, [userId]);
    await client.query(`DELETE FROM "account" WHERE "userId" = $1`, [userId]);
    await client.query(`DELETE FROM "session" WHERE "userId" = $1`, [userId]);
    await client.query(
      `UPDATE "user"
          SET "email" = 'deleted+' || "id" || '@deleted.invalid', "name" = 'Deleted user',
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
