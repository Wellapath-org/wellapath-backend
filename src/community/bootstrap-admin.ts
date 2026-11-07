/**
 * First-admin bootstrap (contract §12.2, PoC P10). There is no bootstrap HTTP endpoint: no admin
 * exists yet to grant the role through the audited API, so the first admin is created by the
 * migration OWNER from this CLI and recorded in the ops log.
 *
 *   COMMUNITY_OWNER_DATABASE_URL=postgres://community_owner@… \
 *     npx ts-node src/community/bootstrap-admin.ts --email founder@example.org
 *   (or COMMUNITY_BOOTSTRAP_ADMIN_EMAIL=… instead of --email)
 *
 * - Refuses if any admin already exists: later admins are granted through
 *   `POST /v1/community/admin/accounts/{id}/role` (audited, TOTP-gated).
 * - No password exists or is ever set: accounts are email-OTP only. The new admin signs in with
 *   an email OTP and must enrol TOTP (`/v1/auth/totp/enrol` + `/confirm`) before ANY privileged
 *   action is allowed.
 * - Writes an append-only `moderation_actions` `change_role` row (actor = the bootstrapped
 *   account itself, evidence `{from, to, via: "bootstrap-cli"}`), in the same transaction.
 * - Revokes any existing sessions of that account so privileged lifetimes apply at next sign-in.
 */
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { forceVerifyFull } from './db-url';

export interface BootstrapResult {
  accountId: string;
  created: boolean;
  previousRole: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Better Auth–compatible opaque id (32 chars, [A-Za-z0-9]). */
const newAccountId = (): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(32);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
};

export const bootstrapAdmin = async (pool: Pool, rawEmail: string): Promise<BootstrapResult> => {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new Error('A valid --email is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise concurrent bootstraps.
    await client.query(`LOCK TABLE "user" IN SHARE ROW EXCLUSIVE MODE`);
    const admins = await client.query(
      `SELECT 1 FROM "user" WHERE "role" = 'admin' AND "deletedAt" IS NULL LIMIT 1`,
    );
    if (admins.rowCount) {
      throw new Error(
        'An admin already exists. Grant further admins through the audited admin API (X1).',
      );
    }
    const existing = await client.query<{ id: string; role: string }>(
      `SELECT "id", "role" FROM "user" WHERE "email" = $1 AND "deletedAt" IS NULL`,
      [email],
    );
    let accountId: string;
    let previousRole: string | null = null;
    if (existing.rows[0]) {
      accountId = existing.rows[0].id;
      previousRole = existing.rows[0].role;
      await client.query(
        `UPDATE "user" SET "role" = 'admin', "updatedAt" = now() WHERE "id" = $1`,
        [accountId],
      );
    } else {
      accountId = newAccountId();
      await client.query(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "role", "createdAt", "updatedAt")
         VALUES ($1, '', $2, true, 'admin', now(), now())`,
        [accountId, email],
      );
    }
    await client.query(
      `UPDATE refresh_token_families SET revoked_at = now(), revoke_reason = 'role_changed'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [accountId],
    );
    await client.query(`DELETE FROM "session" WHERE "userId" = $1`, [accountId]);
    await client.query(
      `INSERT INTO moderation_actions (actor_account_id, action, target_type, target_id, reason, evidence)
       VALUES ($1, 'change_role', 'account', $1, $2, $3)`,
      [
        accountId,
        'bootstrap: first admin created by the migration owner (ops log)',
        JSON.stringify({ from: previousRole, to: 'admin', via: 'bootstrap-cli' }),
      ],
    );
    await client.query('COMMIT');
    return { accountId, created: !existing.rows[0], previousRole };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/* istanbul ignore next -- CLI entry point */
if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--email');
  const email = flag >= 0 ? args[flag + 1] : process.env.COMMUNITY_BOOTSTRAP_ADMIN_EMAIL;
  const url = process.env.COMMUNITY_OWNER_DATABASE_URL;
  if (!url) {
    process.stderr.write('Missing COMMUNITY_OWNER_DATABASE_URL (migration owner role)\n');
    process.exit(1);
  }
  if (!email) {
    process.stderr.write('Usage: bootstrap-admin --email <address>\n');
    process.exit(1);
  }
  // B5: owner connections to a non-local host always use sslmode=verify-full.
  const pool = new Pool({
    connectionString: forceVerifyFull(url, 'COMMUNITY_OWNER_DATABASE_URL'),
  });
  bootstrapAdmin(pool, email)
    .then(result => {
      // The email is not echoed; record the account id in the ops log.
      process.stdout.write(
        `bootstrap-admin: account ${result.accountId} is now admin (${result.created ? 'created' : `was ${result.previousRole}`}). ` +
          'Sign in with an email OTP, then enrol TOTP before any privileged action.\n',
      );
    })
    .catch(error => {
      process.stderr.write(`bootstrap-admin failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
