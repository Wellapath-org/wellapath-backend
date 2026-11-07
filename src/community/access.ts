/**
 * Access-token validation and role checks for Community routes.
 *
 * A request is authenticated by a short-lived Better Auth JWT (`Authorization: Bearer <jwt>`).
 * The signature, issuer, audience and expiry are checked locally against the JWKS, and then the
 * session the token was minted from (`sid`) is looked up: a token whose session was signed out,
 * revoked by suspension, or has expired is rejected even if its own `exp` has not passed. That
 * gives immediate revocation (ADR-001 R3.2) at the cost of one indexed query per request.
 */
import { FastifyReply, FastifyRequest } from 'fastify';
import { createLocalJWKSet, JSONWebKeySet, jwtVerify } from 'jose';
import { Pool } from 'pg';
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER, CommunityAuth } from './auth';

export type Role = 'member' | 'moderator' | 'admin';

export interface CommunityPrincipal {
  userId: string;
  sessionId: string;
  role: Role;
  twoFactorEnabled: boolean;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    community?: CommunityPrincipal;
  }
}

export class CommunityHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ROLE_RANK: Record<Role, number> = { member: 0, moderator: 1, admin: 2 };

export const hasRole = (actual: Role, required: Role): boolean =>
  ROLE_RANK[actual] >= ROLE_RANK[required];

export class AccessTokenVerifier {
  private jwks?: ReturnType<typeof createLocalJWKSet>;

  constructor(
    private readonly auth: CommunityAuth,
    private readonly pool: Pool,
  ) {}

  private async keySet(refresh = false): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (!this.jwks || refresh) {
      const set = (await this.auth.api.getJwks()) as unknown as JSONWebKeySet;
      this.jwks = createLocalJWKSet(set);
    }
    return this.jwks;
  }

  private async verifySignature(token: string): Promise<{ sub: string; sid: string }> {
    const options = {
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      algorithms: ['EdDSA'],
    };
    let result;
    try {
      result = await jwtVerify(token, await this.keySet(), options);
    } catch (error) {
      // An unknown `kid` may mean the key was created after the cache was filled.
      if ((error as { code?: string }).code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error;
      result = await jwtVerify(token, await this.keySet(true), options);
    }
    const { sub, sid } = result.payload as { sub?: unknown; sid?: unknown };
    if (typeof sub !== 'string' || typeof sid !== 'string') {
      throw new CommunityHttpError(401, 'invalid_token', 'Invalid access token');
    }
    return { sub, sid };
  }

  async verify(token: string): Promise<CommunityPrincipal> {
    let claims: { sub: string; sid: string };
    try {
      claims = await this.verifySignature(token);
    } catch (error) {
      if (error instanceof CommunityHttpError) throw error;
      const expired = (error as { code?: string }).code === 'ERR_JWT_EXPIRED';
      throw new CommunityHttpError(
        401,
        expired ? 'token_expired' : 'invalid_token',
        expired ? 'Access token expired' : 'Invalid access token',
      );
    }

    const { rows } = await this.pool.query<{
      role: Role;
      twoFactorEnabled: boolean | null;
      email: string;
      suspended: boolean;
    }>(
      `SELECT u."role", u."twoFactorEnabled", u."email",
              EXISTS (
                SELECT 1 FROM account_restrictions r
                WHERE r.user_id = u."id" AND r.kind = 'suspended' AND r.lifted_at IS NULL
                  AND (r.expires_at IS NULL OR r.expires_at > now())
              ) AS suspended
         FROM "session" s JOIN "user" u ON u."id" = s."userId"
        WHERE s."id" = $1 AND s."userId" = $2 AND s."expiresAt" > now() AND u."deletedAt" IS NULL`,
      [claims.sid, claims.sub],
    );
    const row = rows[0];
    if (!row) throw new CommunityHttpError(401, 'session_revoked', 'Session is no longer valid');
    if (row.suspended) throw new CommunityHttpError(403, 'account_suspended', 'Account suspended');
    return {
      userId: claims.sub,
      sessionId: claims.sid,
      role: row.role,
      twoFactorEnabled: row.twoFactorEnabled === true,
      email: row.email,
    };
  }
}

export const bearerToken = (request: FastifyRequest): string | undefined => {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token || undefined;
};

export const sendError = (reply: FastifyReply, error: CommunityHttpError): FastifyReply =>
  reply
    .status(error.statusCode)
    .send({ error: { statusCode: error.statusCode, code: error.code, message: error.message } });

/**
 * Privileged-action gate: role, then TOTP enrolment, then a fresh TOTP step-up on *this* session.
 * Mandatory for moderator and admin (ADR-001 §4.4).
 */
export const assertPrivileged = async (
  pool: Pool,
  principal: CommunityPrincipal,
  required: Exclude<Role, 'member'>,
  stepUpTtlSeconds: number,
): Promise<void> => {
  if (!hasRole(principal.role, required)) {
    throw new CommunityHttpError(403, 'forbidden', `Requires ${required} role`);
  }
  if (!principal.twoFactorEnabled) {
    throw new CommunityHttpError(
      403,
      'mfa_enrollment_required',
      'Two-factor authentication must be enrolled before privileged actions',
    );
  }
  const { rows } = await pool.query(
    `SELECT 1 FROM session_step_up
      WHERE session_id = $1 AND verified_at > now() - make_interval(secs => $2)`,
    [principal.sessionId, stepUpTtlSeconds],
  );
  if (rows.length === 0) {
    throw new CommunityHttpError(
      403,
      'mfa_step_up_required',
      'Verify a TOTP code for this session before privileged actions',
    );
  }
};
