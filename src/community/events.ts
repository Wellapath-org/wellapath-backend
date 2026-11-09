/**
 * `auth_events` writer (contract §12.3). Append-only table; rows never contain secrets, OTPs,
 * tokens, plaintext emails or raw IPs (email_hmac / ip_hash are keyed HMACs).
 */
import { Pool, PoolClient } from 'pg';
import { Hasher } from './crypto';

export type AuthEvent =
  | 'otp_requested'
  | 'sign_in_succeeded'
  | 'sign_in_failed'
  | 'family_created'
  | 'refresh_rotated'
  | 'refresh_reuse_detected'
  /** A tolerated D-019 refresh race (409, nothing revoked). Migration 0010. */
  | 'refresh_race'
  | 'family_revoked'
  | 'logout'
  | 'sessions_revoked_by_user'
  | 'totp_enrol_started'
  | 'totp_enrolled'
  | 'step_up_succeeded'
  | 'step_up_failed'
  | 'totp_lockout'
  | 'rate_limited'
  | 'data_exported'
  | 'account_deleted'
  /** F-077: first Community access through COMMUNITY_INTERNAL_TESTER_EMAILS. Migration 0011. */
  | 'internal_tester_access_granted';

export interface AuthEventFields {
  accountId?: string | null;
  familyId?: string | null;
  /** Normalised email (hashed here, never stored). */
  email?: string;
  /** Trusted-proxy IP (hashed here, never stored). */
  ip?: string;
  detail?: Record<string, unknown>;
}

export class AuthEvents {
  constructor(
    private readonly pool: Pool,
    private readonly hasher: Hasher,
  ) {}

  async record(
    event: AuthEvent,
    fields: AuthEventFields = {},
    client: Pool | PoolClient = this.pool,
  ): Promise<void> {
    await client.query(
      `INSERT INTO auth_events (event, account_id, family_id, email_hmac, ip_hash, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event,
        fields.accountId ?? null,
        fields.familyId ?? null,
        fields.email ? this.hasher.lookup('email', fields.email) : null,
        fields.ip ? this.hasher.lookup('ip', fields.ip) : null,
        JSON.stringify(fields.detail ?? {}),
      ],
    );
  }
}
