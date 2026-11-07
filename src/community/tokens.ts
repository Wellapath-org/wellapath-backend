/**
 * Access tokens, refresh-token families and the per-request session check (ADR A2, contract
 * §3.2).
 *
 * - Access token: EdDSA JWT minted through Better Auth's JWKS (`auth.api.signJWT`), claims
 *   `sub`, `sid` (= refresh family id), `iss`, `aud`, `iat`, `exp` (≤ 15 min), `jti`. Every
 *   request verifies it against the JWKS with issuer, audience and EdDSA pinned, then checks the
 *   family server-side: not revoked, not past its absolute/idle limit, its Better Auth session
 *   still exists, the account is not deleted or suspended. That check is what makes sign-out,
 *   suspension and family revocation immediate.
 * - Refresh token: opaque `wprt_…`, single use, stored as HMAC-SHA-256(pepper_vN, token). Each
 *   refresh marks the presented token used with a compare-and-set and issues a new one in the
 *   same family. Presenting a used token (outside the 10 s same-device race window) or a token
 *   from another device revokes the whole family.
 */
import { randomUUID } from 'crypto';
import { createLocalJWKSet, JSONWebKeySet, jwtVerify, JWTPayload } from 'jose';
import { Pool, PoolClient } from 'pg';
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER, CommunityAuth } from './auth';
import { CommunityEnabledConfig, SessionLifetimes } from './config';
import { Hasher, newRefreshToken } from './crypto';
import { AuthEvents } from './events';
import { ApiError, UUID } from './http';

export type Role = 'member' | 'moderator' | 'admin';
export type AccountStatus = 'active' | 'restricted' | 'suspended';

export type RevokeReason =
  | 'logout'
  | 'reuse_detected'
  | 'expired'
  | 'revoked_by_user'
  | 'suspended'
  | 'role_changed'
  | 'totp_reset'
  | 'totp_lockout'
  | 'account_deleted';

export interface Principal {
  userId: string;
  familyId: string;
  role: Role;
  twoFactorEnabled: boolean;
  email: string;
  status: AccountStatus;
  restrictedUntil: string | null;
  stepUpAt: Date | null;
  accountCreatedAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export const RACE_WINDOW_SECONDS = 10;

const ROLE_RANK: Record<Role, number> = { member: 0, moderator: 1, admin: 2 };
export const hasRole = (actual: Role, required: Role): boolean =>
  ROLE_RANK[actual] >= ROLE_RANK[required];

const unauthenticated = (reason: string): ApiError => new ApiError('unauthenticated', { reason });

/** SQL: the active restriction for `"user" u`, suspension first. */
export const ACTIVE_RESTRICTION_SQL = `
  LEFT JOIN LATERAL (
    SELECT r.kind, r.expires_at FROM account_restrictions r
     WHERE r.user_id = u."id" AND r.lifted_at IS NULL
       AND (r.expires_at IS NULL OR r.expires_at > now())
     ORDER BY (r.kind = 'suspended') DESC, r.expires_at DESC NULLS FIRST
     LIMIT 1
  ) restriction ON true`;

export interface IssuedFamily {
  familyId: string;
  refreshToken: string;
  absoluteExpiresAt: Date;
}

export interface AccessToken {
  token: string;
  expiresAt: Date;
}

export class TokenService {
  private jwks?: ReturnType<typeof createLocalJWKSet>;

  constructor(
    private readonly pool: Pool,
    private readonly auth: CommunityAuth,
    private readonly hasher: Hasher,
    private readonly events: AuthEvents,
    private readonly config: CommunityEnabledConfig,
  ) {}

  lifetimes(role: Role): SessionLifetimes {
    return role === 'member' ? this.config.memberLifetimes : this.config.privilegedLifetimes;
  }

  // ------------------------------------------------------------------ access tokens

  async mintAccess(userId: string, familyId: string): Promise<AccessToken> {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + this.config.accessTokenTtlSeconds;
    const { token } = (await this.auth.api.signJWT({
      body: { payload: { sub: userId, sid: familyId, jti: randomUUID(), iat, exp } },
    })) as { token: string };
    return { token, expiresAt: new Date(exp * 1000) };
  }

  private async keySet(refresh = false): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (!this.jwks || refresh) {
      const set = (await this.auth.api.getJwks()) as unknown as JSONWebKeySet;
      this.jwks = createLocalJWKSet(set);
    }
    return this.jwks;
  }

  private async verifyJwt(token: string, currentDate?: Date): Promise<JWTPayload> {
    const options = {
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      algorithms: ['EdDSA'],
      ...(currentDate ? { currentDate } : {}),
    };
    try {
      return (await jwtVerify(token, await this.keySet(), options)).payload;
    } catch (error) {
      // An unknown `kid` may mean the key was created after the cache was filled.
      if ((error as { code?: string }).code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error;
      return (await jwtVerify(token, await this.keySet(true), options)).payload;
    }
  }

  /**
   * Verifies an access token and runs the server-side session check. `allowExpired` accepts a
   * correctly signed but expired token (sign-out only, contract A4).
   */
  async verifyAccess(token: string, opts: { allowExpired?: boolean } = {}): Promise<Principal> {
    let payload: JWTPayload;
    try {
      payload = await this.verifyJwt(token);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ERR_JWT_EXPIRED') {
        if (!opts.allowExpired) throw new ApiError('token_expired');
        try {
          const claims = JSON.parse(
            Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
          ) as { exp?: number };
          payload = await this.verifyJwt(token, new Date(((claims.exp ?? 0) - 1) * 1000));
        } catch {
          throw unauthenticated('invalid_token');
        }
      } else if (error instanceof ApiError) {
        throw error;
      } else if (code && code.startsWith('ERR_J')) {
        throw unauthenticated('invalid_token');
      } else {
        throw error;
      }
    }
    const { sub, sid, jti } = payload as { sub?: unknown; sid?: unknown; jti?: unknown };
    if (typeof sub !== 'string' || typeof sid !== 'string' || !UUID.test(sid) || !jti) {
      throw unauthenticated('invalid_token');
    }
    return this.principalFor(sub, sid);
  }

  /** Server-side session check for (account, family). */
  async principalFor(userId: string, familyId: string): Promise<Principal> {
    const { rows } = await this.pool.query<{
      revoked_at: Date | null;
      absolute_expires_at: Date;
      idle_expires_at: Date;
      step_up_at: Date | null;
      has_session: boolean;
      role: Role;
      twoFactorEnabled: boolean | null;
      email: string;
      createdAt: Date;
      deletedAt: Date | null;
      restriction_kind: 'restricted' | 'suspended' | null;
      restriction_until: Date | null;
    }>(
      `SELECT f.revoked_at, f.absolute_expires_at, f.idle_expires_at, f.step_up_at,
              (s."id" IS NOT NULL AND s."expiresAt" > now()) AS has_session,
              u."role", u."twoFactorEnabled", u."email", u."createdAt", u."deletedAt",
              restriction.kind AS restriction_kind, restriction.expires_at AS restriction_until
         FROM refresh_token_families f
         JOIN "user" u ON u."id" = f.user_id
         LEFT JOIN "session" s ON s."id" = f.ba_session_id
         ${ACTIVE_RESTRICTION_SQL}
        WHERE f.id = $1 AND f.user_id = $2`,
      [familyId, userId],
    );
    const row = rows[0];
    if (!row || row.revoked_at || row.deletedAt || !row.has_session) {
      throw unauthenticated('session_revoked');
    }
    const now = Date.now();
    if (row.absolute_expires_at.getTime() <= now || row.idle_expires_at.getTime() <= now) {
      throw unauthenticated('session_expired');
    }
    if (row.restriction_kind === 'suspended') throw unauthenticated('session_revoked');
    return {
      userId,
      familyId,
      role: row.role,
      twoFactorEnabled: row.twoFactorEnabled === true,
      email: row.email,
      status: row.restriction_kind ?? 'active',
      restrictedUntil: row.restriction_until ? row.restriction_until.toISOString() : null,
      stepUpAt: row.step_up_at,
      accountCreatedAt: row.createdAt,
    };
  }

  // ------------------------------------------------------------------ families

  async createFamily(input: {
    userId: string;
    baSessionId: string;
    deviceId: string;
    deviceLabel?: string | null;
    role: Role;
  }): Promise<IssuedFamily> {
    const life = this.lifetimes(input.role);
    const refreshToken = newRefreshToken();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string; absolute_expires_at: Date }>(
        `INSERT INTO refresh_token_families
           (user_id, ba_session_id, device_id, device_label, absolute_expires_at, idle_expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5),
                 now() + make_interval(secs => least($5, $6)))
         RETURNING id, absolute_expires_at`,
        [
          input.userId,
          input.baSessionId,
          input.deviceId,
          input.deviceLabel ?? null,
          life.absoluteSeconds,
          life.idleSeconds,
        ],
      );
      const familyId = rows[0].id;
      await client.query(
        `INSERT INTO refresh_tokens (family_id, token_hash, pepper_version) VALUES ($1, $2, $3)`,
        [familyId, this.hasher.refreshHash(refreshToken), this.hasher.currentPepperVersion],
      );
      await this.events.record(
        'family_created',
        { accountId: input.userId, familyId, detail: { role: input.role } },
        client,
      );
      await client.query('COMMIT');
      return { familyId, refreshToken, absoluteExpiresAt: rows[0].absolute_expires_at };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Revokes one family and deletes its Better Auth session. Returns false if it was already
   * revoked.
   */
  async revokeFamily(
    familyId: string,
    reason: RevokeReason,
    client: Pool | PoolClient = this.pool,
  ): Promise<boolean> {
    const { rows } = await client.query<{ user_id: string; ba_session_id: string }>(
      `UPDATE refresh_token_families SET revoked_at = now(), revoke_reason = $2
        WHERE id = $1 AND revoked_at IS NULL RETURNING user_id, ba_session_id`,
      [familyId, reason],
    );
    if (!rows[0]) return false;
    await client.query(`DELETE FROM "session" WHERE "id" = $1`, [rows[0].ba_session_id]);
    await this.events.record(
      'family_revoked',
      { accountId: rows[0].user_id, familyId, detail: { reason } },
      client,
    );
    return true;
  }

  /** Revokes every live family of an account (optionally except one). Returns the count. */
  async revokeAllForUser(
    userId: string,
    reason: RevokeReason,
    client: Pool | PoolClient = this.pool,
    exceptFamilyId?: string,
  ): Promise<number> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM refresh_token_families
        WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [userId, exceptFamilyId ?? null],
    );
    let count = 0;
    for (const row of rows) {
      if (await this.revokeFamily(row.id, reason, client)) count += 1;
    }
    if (!exceptFamilyId) {
      // Any Better Auth session not bound to a family (e.g. mid-enrolment) goes too.
      await client.query(`DELETE FROM "session" WHERE "userId" = $1`, [userId]);
    }
    return count;
  }

  /** Better Auth replaced the family's session (TOTP enrolment); follow it. */
  async rebindSession(familyId: string, baSessionId: string): Promise<void> {
    await this.pool.query(`UPDATE refresh_token_families SET ba_session_id = $2 WHERE id = $1`, [
      familyId,
      baSessionId,
    ]);
  }

  /** Bearer headers for server-side `auth.api.*` calls on this family's Better Auth session. */
  async sessionHeaders(familyId: string): Promise<{ headers: Headers; baSessionId: string }> {
    const { rows } = await this.pool.query<{ token: string; id: string }>(
      `SELECT s."token", s."id" FROM refresh_token_families f
         JOIN "session" s ON s."id" = f.ba_session_id
        WHERE f.id = $1 AND f.revoked_at IS NULL`,
      [familyId],
    );
    if (!rows[0]) throw unauthenticated('session_revoked');
    return {
      headers: new Headers({ authorization: `Bearer ${rows[0].token}` }),
      baSessionId: rows[0].id,
    };
  }

  async recordStepUp(familyId: string): Promise<Date> {
    const { rows } = await this.pool.query<{ step_up_at: Date }>(
      `UPDATE refresh_token_families SET step_up_at = now() WHERE id = $1 RETURNING step_up_at`,
      [familyId],
    );
    return rows[0].step_up_at;
  }

  // ------------------------------------------------------------------ refresh

  /** Locates the family of a presented refresh token (for the per-family limit). */
  async familyOf(refreshToken: string): Promise<string | undefined> {
    const candidates = this.hasher.refreshHashCandidates(refreshToken);
    const { rows } = await this.pool.query<{ family_id: string }>(
      `SELECT family_id FROM refresh_tokens WHERE token_hash = ANY($1::text[]) LIMIT 1`,
      [candidates.map(c => c.hash)],
    );
    return rows[0]?.family_id;
  }

  /**
   * The account a presented refresh token belongs to, whatever the state of its family (live,
   * rotated, expired or revoked). Used by A4 to keep a bearer of one account and a refresh token
   * of another from acting on each other's account.
   */
  async accountOfRefreshToken(refreshToken: string): Promise<string | undefined> {
    const candidates = this.hasher.refreshHashCandidates(refreshToken);
    const { rows } = await this.pool.query<{ user_id: string }>(
      `SELECT f.user_id FROM refresh_tokens t
         JOIN refresh_token_families f ON f.id = t.family_id
        WHERE t.token_hash = ANY($1::text[])
        LIMIT 1`,
      [candidates.map(c => c.hash)],
    );
    return rows[0]?.user_id;
  }

  /**
   * Refresh-token sign-out (contract A4, P6). The caller holds no other credential, so the result
   * is never surfaced to it: the route answers the same 204 whatever happens here.
   *
   * - The hash lookup always runs, for every well-formed token.
   * - The family's current (unrotated) token, family live ⇒ the family is revoked as `logout`.
   * - A superseded (already rotated) token of a live family ⇒ reuse (ADR-001 A2): the family is
   *   revoked as `reuse_detected` and `refresh_reuse_detected` is audited, exactly as on refresh.
   *   D-019's 10 s same-device window does not apply: logout carries no `device_id`, so the
   *   same-device condition can never be shown, and revoking is what the caller asked for anyway.
   *   `within_race_window` is recorded so a lost-response retry can be told apart in the audit.
   * - Unknown, expired, or already-revoked family ⇒ nothing changes (`noop`).
   * - `exceptFamilyId`: a family the caller has already signed out by bearer (skipped).
   */
  async revokeByRefreshToken(
    refreshToken: string,
    opts: { ip?: string; exceptFamilyId?: string } = {},
  ): Promise<{
    outcome: 'revoked' | 'reuse_detected' | 'noop';
    userId?: string;
    familyId?: string;
  }> {
    const candidates = this.hasher.refreshHashCandidates(refreshToken);
    const { rows } = await this.pool.query<{
      used_at: Date | null;
      used_recently: boolean;
      family_id: string;
      user_id: string;
      revoked_at: Date | null;
      expired: boolean;
    }>(
      `SELECT t.used_at,
              (t.used_at IS NOT NULL AND t.used_at > now() - make_interval(secs => $2)) AS used_recently,
              f.id AS family_id, f.user_id, f.revoked_at,
              (f.absolute_expires_at <= now() OR f.idle_expires_at <= now()) AS expired
         FROM refresh_tokens t
         JOIN refresh_token_families f ON f.id = t.family_id
        WHERE t.token_hash = ANY($1::text[])
        LIMIT 1`,
      [candidates.map(c => c.hash), RACE_WINDOW_SECONDS],
    );
    const row = rows[0];
    if (!row || row.revoked_at || row.expired || row.family_id === opts.exceptFamilyId) {
      return { outcome: 'noop' };
    }
    const ids = { userId: row.user_id, familyId: row.family_id };
    if (row.used_at) {
      await this.events.record('refresh_reuse_detected', {
        accountId: row.user_id,
        familyId: row.family_id,
        ip: opts.ip,
        detail: { endpoint: 'logout', within_race_window: row.used_recently },
      });
      await this.revokeFamily(row.family_id, 'reuse_detected');
      return { outcome: 'reuse_detected', ...ids };
    }
    // Compare-and-set inside revokeFamily: a concurrent sign-out of the same family wins once.
    if (!(await this.revokeFamily(row.family_id, 'logout'))) return { outcome: 'noop' };
    return { outcome: 'revoked', ...ids };
  }

  /**
   * Rotates a refresh token. Returns the new refresh token and the family's account, or throws
   * the contract error.
   */
  async rotate(
    refreshToken: string,
    deviceId: string,
  ): Promise<{ userId: string; familyId: string; refreshToken: string; absoluteExpiresAt: Date }> {
    const candidates = this.hasher.refreshHashCandidates(refreshToken);
    const { rows } = await this.pool.query<{
      token_id: string;
      used_at: Date | null;
      used_recently: boolean;
      family_id: string;
      user_id: string;
      device_id: string;
      revoked_at: Date | null;
      revoke_reason: string | null;
      expired: boolean;
      role: Role;
    }>(
      `SELECT t.id AS token_id, t.used_at,
              (t.used_at IS NOT NULL AND t.used_at > now() - make_interval(secs => $2)) AS used_recently,
              f.id AS family_id, f.user_id, f.device_id::text AS device_id, f.revoked_at,
              f.revoke_reason,
              (f.absolute_expires_at <= now() OR f.idle_expires_at <= now()) AS expired,
              u."role"
         FROM refresh_tokens t
         JOIN refresh_token_families f ON f.id = t.family_id
         JOIN "user" u ON u."id" = f.user_id
        WHERE t.token_hash = ANY($1::text[])
        LIMIT 1`,
      [candidates.map(c => c.hash), RACE_WINDOW_SECONDS],
    );
    const row = rows[0];
    if (!row) throw unauthenticated('refresh_invalid');
    if (row.revoked_at) {
      throw unauthenticated(
        row.revoke_reason === 'reuse_detected'
          ? 'refresh_reused'
          : row.revoke_reason === 'expired'
            ? 'refresh_expired'
            : 'session_revoked',
      );
    }
    const reuse = async (): Promise<never> => {
      await this.events.record('refresh_reuse_detected', {
        accountId: row.user_id,
        familyId: row.family_id,
        detail: { device_mismatch: row.device_id !== deviceId },
      });
      await this.revokeFamily(row.family_id, 'reuse_detected');
      throw unauthenticated('refresh_reused');
    };
    if (row.device_id !== deviceId) return reuse();
    if (row.expired) {
      await this.revokeFamily(row.family_id, 'expired');
      throw unauthenticated('refresh_expired');
    }
    if (row.used_at) {
      if (row.used_recently) throw new ApiError('conflict', { reason: 'refresh_race' });
      return reuse();
    }

    const life = this.lifetimes(row.role);
    const next = newRefreshToken();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Compare-and-set: exactly one concurrent caller marks the token used.
      const cas = await client.query(
        `UPDATE refresh_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
        [row.token_id],
      );
      if (cas.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new ApiError('conflict', { reason: 'refresh_race' });
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO refresh_tokens (family_id, token_hash, pepper_version) VALUES ($1, $2, $3)
         RETURNING id`,
        [row.family_id, this.hasher.refreshHash(next), this.hasher.currentPepperVersion],
      );
      await client.query(`UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1`, [
        row.token_id,
        inserted.rows[0].id,
      ]);
      const fam = await client.query<{ absolute_expires_at: Date }>(
        `UPDATE refresh_token_families
            SET last_used_at = now(),
                idle_expires_at = least(absolute_expires_at, now() + make_interval(secs => $2))
          WHERE id = $1 RETURNING absolute_expires_at`,
        [row.family_id, life.idleSeconds],
      );
      await this.events.record(
        'refresh_rotated',
        { accountId: row.user_id, familyId: row.family_id },
        client,
      );
      await client.query('COMMIT');
      return {
        userId: row.user_id,
        familyId: row.family_id,
        refreshToken: next,
        absoluteExpiresAt: fam.rows[0].absolute_expires_at,
      };
    } catch (error) {
      if (!(error instanceof ApiError)) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
