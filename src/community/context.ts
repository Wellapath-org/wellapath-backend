/**
 * Shared request helpers for the Community route modules: authentication, the allowlist gate,
 * the privileged (role → TOTP enrolled → fresh step-up) gate, rate limiting, idempotent creates,
 * DTO builders and the audit/notification writers.
 */
import { FastifyReply, FastifyRequest } from 'fastify';
import { Pool, PoolClient } from 'pg';
import { CommunityAuth } from './auth';
import { CommunityEnabledConfig } from './config';
import { Hasher } from './crypto';
import { EmailSender } from './email';
import { AuthEvents } from './events';
import { ApiError, envelope, invalidState, tsRequired } from './http';
import { idempotencyKey, IdempotencyStore, StoredResult } from './idempotency';
import { LimitCheck, LimitName, RateLimiter, rateLimitHeaders } from './limiter';
import { hasRole, Principal, Role, TokenService } from './tokens';

export type Db = Pool | PoolClient;

export interface ProfessionalVerificationDto {
  id: string;
  profession: string;
  specialty: string | null;
  status: 'pending' | 'verified' | 'revoked';
  verified_at: string | null;
  created_at: string;
}

export interface ProfileDto {
  display_name: string;
  professional: ProfessionalVerificationDto | null;
}

export interface MeDto {
  account_id: string;
  email: string;
  role: Role;
  status: 'active' | 'restricted' | 'suspended';
  restricted_until: string | null;
  two_factor_enabled: boolean;
  community_allowed: boolean;
  created_at: string;
  profile: ProfileDto | null;
}

export type PublicAuthor =
  | {
      display_mode: 'named';
      display_name: string;
      badge: { profession: string; specialty: string | null } | null;
    }
  | { display_mode: 'pseudonymous'; display_name: null; badge: null };

export interface ModerationActionDto {
  id: string;
  actor_account_id: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string;
  created_at: string;
}

/** SQL joins giving `pr.display_name`, `pv.profession`, `pv.specialty` for author `t.author_id`. */
export const AUTHOR_JOIN = `
  LEFT JOIN profiles pr ON pr.user_id = t.author_id
  LEFT JOIN professional_verifications pv ON pv.user_id = t.author_id AND pv.status = 'verified'`;

export const publicAuthor = (row: {
  display_mode: string;
  display_name: string | null;
  badge_profession?: string | null;
  badge_specialty?: string | null;
}): PublicAuthor => {
  if (row.display_mode !== 'named' || !row.display_name) {
    return { display_mode: 'pseudonymous', display_name: null, badge: null };
  }
  return {
    display_mode: 'named',
    display_name: row.display_name,
    badge: row.badge_profession
      ? { profession: row.badge_profession, specialty: row.badge_specialty ?? null }
      : null,
  };
};

export const verificationDto = (row: {
  id: string;
  profession: string;
  specialty: string | null;
  status: 'pending' | 'verified' | 'revoked';
  verified_at: Date | null;
  created_at: Date;
}): ProfessionalVerificationDto => ({
  id: row.id,
  profession: row.profession,
  specialty: row.specialty,
  status: row.status,
  verified_at: row.verified_at ? row.verified_at.toISOString() : null,
  created_at: tsRequired(row.created_at),
});

export const moderationActionDto = (row: {
  id: string | number;
  actor_account_id: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string;
  created_at: Date;
}): ModerationActionDto => ({
  id: String(row.id),
  actor_account_id: row.actor_account_id,
  action: row.action,
  target_type: row.target_type,
  target_id: row.target_id,
  reason: row.reason,
  created_at: tsRequired(row.created_at),
});

export interface CommunityServices {
  config: CommunityEnabledConfig;
  pool: Pool;
  auth: CommunityAuth;
  email: EmailSender;
  hasher: Hasher;
  events: AuthEvents;
  tokens: TokenService;
  limiter: RateLimiter;
  idempotency: IdempotencyStore;
}

export class CommunityContext {
  constructor(readonly s: CommunityServices) {}

  get pool(): Pool {
    return this.s.pool;
  }

  /** The client IP for rate limiting: only Fastify's trusted-proxy-derived `request.ip`. */
  ip(request: FastifyRequest): string {
    return request.ip;
  }

  isAllowed(principal: Pick<Principal, 'role' | 'userId'>): boolean {
    const { config } = this.s;
    return (
      config.mode === 'public' ||
      hasRole(principal.role, 'moderator') ||
      config.allowlist.has(principal.userId)
    );
  }

  /** Bearer access token → principal. Counts the per-account default limit unless disabled. */
  async authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { allowExpired?: boolean; defaultLimit?: boolean } = {},
  ): Promise<Principal> {
    const header = request.headers.authorization;
    if (!header) throw new ApiError('unauthenticated', { reason: 'missing_token' });
    if (!header.startsWith('Bearer ')) {
      throw new ApiError('unauthenticated', { reason: 'invalid_token' });
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) throw new ApiError('unauthenticated', { reason: 'missing_token' });
    const principal = await this.s.tokens.verifyAccess(token, { allowExpired: opts.allowExpired });
    request.principal = principal;
    if (opts.defaultLimit !== false) {
      await this.limit(reply, [{ name: 'authenticated_default', key: principal.userId }]);
    }
    return principal;
  }

  /** Authenticated and allowlisted for Community content in the current mode. */
  async member(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { defaultLimit?: boolean } = {},
  ): Promise<Principal> {
    const principal = await this.authenticate(request, reply, opts);
    if (!this.isAllowed(principal)) throw new ApiError('community_not_allowed');
    return principal;
  }

  /** A member write: allowlisted and not restricted (read-only). */
  assertNotRestricted(principal: Principal): void {
    if (principal.status === 'restricted') {
      throw new ApiError('account_restricted', { until: principal.restrictedUntil });
    }
  }

  /** Privileged gate (contract §2.1): role, then TOTP enrolled, then a fresh step-up. */
  async privileged(
    request: FastifyRequest,
    reply: FastifyReply,
    role: Exclude<Role, 'member'>,
  ): Promise<Principal> {
    const principal = await this.authenticate(request, reply);
    if (!hasRole(principal.role, role)) throw new ApiError('forbidden');
    if (!principal.twoFactorEnabled) throw new ApiError('mfa_enrollment_required');
    const fresh =
      principal.stepUpAt !== null &&
      principal.stepUpAt.getTime() > Date.now() - this.s.config.stepUpTtlSeconds * 1000;
    if (!fresh) throw new ApiError('mfa_step_up_required');
    return principal;
  }

  /** Applies limits; sets RateLimit-* headers on success. Auth endpoints audit every 429. */
  async limit(
    reply: FastifyReply,
    checks: LimitCheck[],
    audit?: { endpoint: string; email?: string; accountId?: string; ip?: string },
  ): Promise<void> {
    const state = await this.s.limiter.consume(
      checks,
      audit
        ? async (name: LimitName): Promise<void> =>
            this.s.events.record('rate_limited', {
              accountId: audit.accountId,
              email: audit.email,
              ip: audit.ip,
              detail: { dimension: name, endpoint: audit.endpoint },
            })
        : undefined,
    );
    for (const [k, v] of Object.entries(rateLimitHeaders(state))) reply.header(k, v);
  }

  /**
   * Runs a create under the Idempotency-Key protocol (contract §1.2). Rate limits are applied
   * only to fresh requests, so a replay neither counts nor creates a duplicate notification.
   */
  async idempotent(
    request: FastifyRequest,
    reply: FastifyReply,
    principal: Principal,
    route: string,
    opts: { required: boolean; limits: LimitCheck[] },
    run: () => Promise<StoredResult>,
  ): Promise<FastifyReply> {
    const key = idempotencyKey(request, opts.required);
    const outcome = await this.s.idempotency.begin(
      principal.userId,
      request.method,
      route,
      key,
      request.body ?? null,
    );
    if (outcome.kind === 'replay') {
      for (const [k, v] of Object.entries(outcome.result.headers ?? {})) reply.header(k, v);
      reply.header('idempotent-replayed', 'true');
      return reply.status(outcome.result.status).send(outcome.result.body);
    }
    try {
      await this.limit(reply, opts.limits);
      const result = await run();
      if (outcome.kind === 'fresh') await outcome.complete(result);
      for (const [k, v] of Object.entries(result.headers ?? {})) reply.header(k, v);
      return reply.status(result.status).send(result.body);
    } catch (error) {
      if (outcome.kind === 'fresh') {
        if (error instanceof ApiError) {
          await outcome.complete({ status: error.statusCode, body: envelope(request, error) });
        } else {
          await outcome.abandon().catch(() => undefined);
        }
      }
      throw error;
    }
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.s.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------ DTO builders

  async profile(userId: string, db: Db = this.s.pool): Promise<ProfileDto | null> {
    const { rows } = await db.query<{ display_name: string }>(
      'SELECT display_name FROM profiles WHERE user_id = $1',
      [userId],
    );
    if (!rows[0]) return null;
    const claim = await db.query(
      `SELECT id, profession, specialty, status, verified_at, created_at
         FROM professional_verifications
        WHERE user_id = $1 AND status IN ('pending', 'verified')
        ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return {
      display_name: rows[0].display_name,
      professional: claim.rows[0] ? verificationDto(claim.rows[0]) : null,
    };
  }

  async me(principal: Principal): Promise<MeDto> {
    return {
      account_id: principal.userId,
      email: principal.email,
      role: principal.role,
      status: principal.status,
      restricted_until: principal.status === 'restricted' ? principal.restrictedUntil : null,
      two_factor_enabled: principal.twoFactorEnabled,
      community_allowed: this.isAllowed(principal),
      created_at: tsRequired(principal.accountCreatedAt),
      profile: await this.profile(principal.userId),
    };
  }

  async requireProfile(userId: string, db: Db = this.s.pool): Promise<void> {
    const { rows } = await db.query('SELECT 1 FROM profiles WHERE user_id = $1', [userId]);
    if (!rows[0]) throw invalidState('profile_required');
  }

  // ------------------------------------------------------------------ writers

  /** Writes one append-only `moderation_actions` row and returns its DTO. */
  async audit(
    db: Db,
    row: {
      actor: string;
      action: string;
      targetType: string;
      targetId: string;
      reason: string;
      evidence?: unknown;
    },
  ): Promise<ModerationActionDto> {
    const { rows } = await db.query(
      `INSERT INTO moderation_actions
         (actor_account_id, action, target_type, target_id, reason, evidence)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, actor_account_id, action, target_type, target_id, reason, created_at`,
      [
        row.actor,
        row.action,
        row.targetType,
        row.targetId,
        row.reason,
        row.evidence === undefined ? null : JSON.stringify(row.evidence),
      ],
    );
    return moderationActionDto(rows[0]);
  }

  async notify(
    db: Db,
    userId: string,
    type: 'reply_to_post' | 'comment_reply' | 'moderation_notice',
    fields: { postId?: string | null; commentId?: string | null; notice?: string | null },
  ): Promise<void> {
    await db.query(
      `INSERT INTO notifications (user_id, type, post_id, comment_id, notice)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, fields.postId ?? null, fields.commentId ?? null, fields.notice ?? null],
    );
  }
}

/** Trims a free-text field and enforces the contract's after-trim length. */
export const trimmed = (value: string, field: string, min: number, max: number): string => {
  const v = value.trim();
  if (v.length < min) throw new ApiError('validation_failed', { field, rule: 'min_length' });
  if (v.length > max) throw new ApiError('validation_failed', { field, rule: 'max_length' });
  return v;
};
