/**
 * `/v1/auth/*` — WellaPath-owned facade routes A1–A9 over Better Auth (contract §3, ADR A2/A3).
 * Better Auth's HTTP handler is never mounted; every other `/v1/auth/*` path is 404. The Better
 * Auth session token never leaves the server. Nothing here logs an email, OTP, TOTP, backup code
 * or token.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { otpDelivery, OtpDeliverySlot } from '../auth';
import { CommunityContext, MeDto } from '../context';
import { EmailUnavailableError } from '../email';
import { normaliseEmail } from '../crypto';
import { ApiError, conflict, invalidState, tsRequired, validation } from '../http';
import { hasRole, Principal } from '../tokens';

// Same shape Better Auth/zod accepts, so a syntactically invalid email is our 400, not its 400.
const EMAIL =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

const MAX_TOTP_FAILURES = 5;

/** The A3 refresh-token shape, shared by A4 logout. */
const REFRESH_TOKEN = /^wprt_[A-Za-z0-9_-]{43,}$/;
const REFRESH_TOKEN_MAX = 256;
const TOTP_LOCKOUT_SECONDS = 15 * 60;

const apiErrorCode = (error: unknown): string | undefined =>
  (error as { body?: { code?: string } }).body?.code;

const isBetterAuthError = (error: unknown): boolean =>
  typeof (error as { statusCode?: unknown }).statusCode === 'number' &&
  (error as { body?: unknown }).body !== undefined;

const emailSchema = { type: 'string', minLength: 3, maxLength: 254 };

interface TokenPairDto {
  token_type: 'Bearer';
  access_token: string;
  expires_in: number;
  access_token_expires_at: string;
  refresh_token: string;
  refresh_token_expires_at: string;
  account_created: boolean;
  account: MeDto;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const registerAuthRoutes = (server: FastifyInstance, ctx: CommunityContext): void => {
  const { s } = ctx;

  const parseEmail = (raw: string): string => {
    const email = raw.trim().toLowerCase();
    if (email.length > 254 || !EMAIL.test(email)) throw validation('email', 'format');
    return email;
  };

  const tokenPair = async (
    userId: string,
    familyId: string,
    refreshToken: string,
    refreshExpiresAt: Date,
    accountCreated: boolean,
  ): Promise<TokenPairDto> => {
    const access = await s.tokens.mintAccess(userId, familyId);
    const principal = await s.tokens.principalFor(userId, familyId);
    return {
      token_type: 'Bearer',
      access_token: access.token,
      expires_in: s.config.accessTokenTtlSeconds,
      access_token_expires_at: access.expiresAt.toISOString(),
      refresh_token: refreshToken,
      refresh_token_expires_at: tsRequired(refreshExpiresAt),
      account_created: accountCreated,
      account: await ctx.me(principal),
    };
  };

  // ------------------------------------------------------------------ A1 otp/request
  server.post(
    '/v1/auth/otp/request',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: { email: emailSchema },
        },
      },
    },
    async (request, reply) => {
      const started = Date.now();
      const email = parseEmail((request.body as { email: string }).email);
      const key = normaliseEmail(email);
      const ip = ctx.ip(request);
      // Limits are checked BEFORE any account lookup, identically for unknown emails.
      await ctx.limit(
        reply,
        [
          { name: 'otp_request_email_15m', key, hidden: true },
          { name: 'otp_request_email_24h', key, hidden: true },
          { name: 'otp_request_ip', key: ip },
        ],
        { endpoint: 'otp_request', email: key, ip },
      );
      const { rows } = await s.pool.query<{ id: string; suspended: boolean }>(
        `SELECT u."id", EXISTS (
            SELECT 1 FROM account_restrictions r
             WHERE r.user_id = u."id" AND r.kind = 'suspended' AND r.lifted_at IS NULL
               AND (r.expires_at IS NULL OR r.expires_at > now())
          ) AS suspended
           FROM "user" u WHERE u."email" = $1 AND u."deletedAt" IS NULL`,
        [email],
      );
      const suppressed = rows[0]?.suspended === true;
      const delivery: OtpDeliverySlot = { attempted: false };
      if (!suppressed) {
        await otpDelivery.run(delivery, () =>
          s.auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } }),
        );
      }
      const failed = delivery.error !== undefined;
      await s.events.record('otp_requested', {
        accountId: rows[0]?.id ?? null,
        email: key,
        ip,
        detail: { outcome: suppressed ? 'suppressed' : failed ? 'email_unavailable' : 'sent' },
      });
      // Pad the response so the outcome (sent / suppressed / new) is not observable.
      const elapsed = Date.now() - started;
      if (elapsed < s.config.otpRequestMinMs) await sleep(s.config.otpRequestMinMs - elapsed);
      if (failed) {
        // No retry here (a retry after an ambiguous failure could deliver two codes); the client
        // retries later. Logged without the address, key or provider response.
        const error = delivery.error;
        request.log.warn(
          {
            event: 'community_email_unavailable',
            provider: s.email.name,
            reason: error instanceof EmailUnavailableError ? error.reason : 'sender_error',
            status: error instanceof EmailUnavailableError ? error.status : undefined,
          },
          'Community OTP email could not be sent',
        );
        throw new ApiError('community_unavailable', { reason: 'email_unavailable' });
      }
      return reply.status(202).send({});
    },
  );

  // ------------------------------------------------------------------ A2 otp/verify
  server.post(
    '/v1/auth/otp/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'code', 'device_id'],
          additionalProperties: false,
          properties: {
            email: emailSchema,
            code: { type: 'string', pattern: '^[0-9]{6}$' },
            device_id: { type: 'string', format: 'uuid' },
            device_label: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        email: string;
        code: string;
        device_id: string;
        device_label?: string;
      };
      const email = parseEmail(body.email);
      const key = normaliseEmail(email);
      const ip = ctx.ip(request);
      await ctx.limit(
        reply,
        [
          { name: 'otp_verify_email', key, hidden: true },
          { name: 'otp_verify_ip', key: ip },
        ],
        { endpoint: 'otp_verify', email: key, ip },
      );
      const existing = await s.pool.query(
        `SELECT 1 FROM "user" WHERE "email" = $1 AND "deletedAt" IS NULL`,
        [email],
      );
      let signedIn: { token: string; user: { id: string } };
      try {
        // No request headers are passed: Better Auth records no client IP / user agent.
        signedIn = (await s.auth.api.signInEmailOTP({ body: { email, otp: body.code } })) as {
          token: string;
          user: { id: string };
        };
      } catch (error) {
        if (!isBetterAuthError(error)) throw error;
        const suspended = apiErrorCode(error) === 'ACCOUNT_SUSPENDED';
        await s.events.record('sign_in_failed', {
          email: key,
          ip,
          detail: { reason: suspended ? 'suspended' : 'invalid_code' },
        });
        throw new ApiError(suspended ? 'account_suspended' : 'invalid_code');
      }
      const { rows } = await s.pool.query<{ id: string; role: 'member' | 'moderator' | 'admin' }>(
        `SELECT s."id", u."role" FROM "session" s JOIN "user" u ON u."id" = s."userId"
          WHERE s."token" = $1`,
        [signedIn.token],
      );
      if (!rows[0]) throw new ApiError('internal_error');
      const family = await s.tokens.createFamily({
        userId: signedIn.user.id,
        baSessionId: rows[0].id,
        deviceId: body.device_id.toLowerCase(),
        deviceLabel: body.device_label ?? null,
        role: rows[0].role,
      });
      const accountCreated = existing.rowCount === 0;
      await s.events.record('sign_in_succeeded', {
        accountId: signedIn.user.id,
        familyId: family.familyId,
        email: key,
        ip,
        detail: { account_created: accountCreated },
      });
      return reply.send(
        await tokenPair(
          signedIn.user.id,
          family.familyId,
          family.refreshToken,
          family.absoluteExpiresAt,
          accountCreated,
        ),
      );
    },
  );

  // ------------------------------------------------------------------ A3 refresh
  server.post(
    '/v1/auth/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refresh_token', 'device_id'],
          additionalProperties: false,
          properties: {
            // C6 (approved): only the type is checked here. A malformed token is a bad refresh
            // token like an unknown one, so TokenService.rotate answers 401 refresh_invalid.
            refresh_token: { type: 'string' },
            device_id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      // The refresh token is the credential; any Authorization header is ignored.
      const body = request.body as { refresh_token: string; device_id: string };
      const ip = ctx.ip(request);
      await ctx.limit(reply, [{ name: 'refresh_ip', key: ip }], { endpoint: 'refresh', ip });
      const familyId = await s.tokens.familyOf(body.refresh_token);
      if (familyId) {
        await ctx.limit(reply, [{ name: 'refresh_family', key: familyId }], {
          endpoint: 'refresh',
          ip,
        });
      }
      const rotated = await s.tokens.rotate(body.refresh_token, body.device_id.toLowerCase(), {
        ip,
      });
      return reply.send(
        await tokenPair(
          rotated.userId,
          rotated.familyId,
          rotated.refreshToken,
          rotated.absoluteExpiresAt,
          false,
        ),
      );
    },
  );

  // ------------------------------------------------------------------ A4 logout
  /**
   * Sign out this device (contract A4, P6 approved 2026-11-07). Two credentials are accepted:
   *
   * - No `Authorization` header: `{ refresh_token }` is required and is the credential. Every
   *   well-formed token gets the same 204 (same headers, empty body), whether it revoked a family,
   *   tripped reuse detection or matched nothing, so the route is no token or account oracle.
   * - A bearer access token (an expired-but-validly-signed one is accepted, for this route only):
   *   - body token of the SAME account (or none, or unknown): the bearer's family is revoked, and
   *     another live family of that account whose current token is in the body is revoked too;
   *     anything else in the body is ignored.
   *   - body token of a DIFFERENT account (founder, 2026-11-08): neither credential extends
   *     authority over the other account. The bearer's account is left untouched (audited as a
   *     `logout` noop, reason `cross_account_refresh_token`, without the other account's ids) and
   *     the token is processed exactly as a no-bearer logout would process it.
   *   The response is the same 204 in every case, so no account relationship is disclosed.
   *
   * Only the body's shape (and whether a bearer was sent) can produce a 400, never stored state.
   * A bearer that is not a validly signed access token is still 401: that is the caller's own
   * credential being wrong, and it says nothing about any refresh token.
   */
  server.post('/v1/auth/logout', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined | null;
    const hasBearer = request.headers.authorization !== undefined;
    if (body !== undefined && body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) throw validation('body', 'type');
      for (const k of Object.keys(body)) {
        if (k !== 'refresh_token') throw validation(k, 'unknown_field');
      }
    }
    const presented = body?.refresh_token;
    if (presented === undefined) {
      if (!hasBearer) throw validation('refresh_token', 'required');
    } else if (typeof presented !== 'string') {
      throw validation('refresh_token', 'type');
    } else if (presented.length > REFRESH_TOKEN_MAX) {
      throw validation('refresh_token', 'max_length');
    } else if (!REFRESH_TOKEN.test(presented)) {
      throw validation('refresh_token', 'pattern');
    }
    const ip = ctx.ip(request);

    let principal: Principal | undefined;
    if (hasBearer) {
      try {
        principal = await ctx.authenticate(request, reply, {
          allowExpired: true,
          defaultLimit: false,
        });
      } catch (error) {
        // Idempotent: a family that is already gone is already signed out.
        const reason = error instanceof ApiError ? error.details?.reason : undefined;
        if (reason !== 'session_revoked' && reason !== 'session_expired') throw error;
      }
      if (principal) {
        await ctx.limit(reply, [{ name: 'session_routes_account', key: principal.userId }], {
          endpoint: 'logout',
          accountId: principal.userId,
        });
      }
    }
    if (!principal) {
      // No account is known before the lookup (no bearer, or a bearer whose family is already
      // gone): limit on the trusted-proxy IP (visible) and the token's hash (hidden), before
      // touching any token state.
      await ctx.limit(reply, [{ name: 'logout_ip', key: ip }], { endpoint: 'logout', ip });
    }
    if (typeof presented === 'string') {
      await ctx.limit(
        reply,
        [{ name: 'logout_token', key: s.hasher.refreshHash(presented) as string, hidden: true }],
        { endpoint: 'logout', ip },
      );
    }

    // Resolve the body token's account BEFORE revoking anything, so a token of another account
    // never costs the bearer's account a session (and the bearer never reaches the other account).
    const tokenAccount =
      principal && typeof presented === 'string'
        ? await s.tokens.accountOfRefreshToken(presented)
        : undefined;
    const crossAccount =
      principal !== undefined && tokenAccount !== undefined && tokenAccount !== principal.userId;

    let revoked = false;
    if (principal && !crossAccount) {
      await s.tokens.revokeFamily(principal.familyId, 'logout');
      await s.events.record('logout', {
        accountId: principal.userId,
        familyId: principal.familyId,
        ip,
        detail: { outcome: 'revoked', credential: 'bearer' },
      });
      revoked = true;
    } else if (principal) {
      // Only the bearer's own ids: nothing about the other account goes in this row.
      await s.events.record('logout', {
        accountId: principal.userId,
        familyId: principal.familyId,
        ip,
        detail: { outcome: 'noop', reason: 'cross_account_refresh_token' },
      });
    }

    if (typeof presented === 'string') {
      // Cross-account: exactly the no-bearer path (nothing excepted).
      const result = await s.tokens.revokeByRefreshToken(presented, {
        ip,
        exceptFamilyId: crossAccount ? undefined : principal?.familyId,
      });
      if (result.outcome === 'revoked') {
        await s.events.record('logout', {
          accountId: result.userId,
          familyId: result.familyId,
          ip,
          detail: { outcome: 'revoked', credential: 'refresh_token' },
        });
      }
      // reuse_detected is audited (refresh_reuse_detected + family_revoked) by the token service.
      if (result.outcome !== 'noop') revoked = true;
    }
    if (!revoked) {
      // Nothing was signed out on the token's side. No account id: none has been proved.
      await s.events.record('logout', { ip, detail: { outcome: 'noop' } });
    }
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ A5 / A6 sessions
  const sessionRoute = async (
    request: FastifyRequest,
    reply: FastifyReply,
    endpoint: string,
  ): Promise<Principal> => {
    const principal = await ctx.authenticate(request, reply, { defaultLimit: false });
    await ctx.limit(reply, [{ name: 'session_routes_account', key: principal.userId }], {
      endpoint,
      accountId: principal.userId,
    });
    return principal;
  };

  server.get('/v1/auth/sessions', async (request, reply) => {
    const principal = await sessionRoute(request, reply, 'sessions');
    const { rows } = await s.pool.query(
      `SELECT id, device_label, created_at, last_used_at, idle_expires_at
         FROM refresh_token_families
        WHERE user_id = $1 AND revoked_at IS NULL
          AND absolute_expires_at > now() AND idle_expires_at > now()
        ORDER BY created_at DESC, id DESC`,
      [principal.userId],
    );
    return reply.send({
      items: rows.map(r => ({
        session_id: r.id,
        device_label: r.device_label,
        created_at: tsRequired(r.created_at),
        last_used_at: tsRequired(r.last_used_at),
        expires_at: tsRequired(r.idle_expires_at),
        current: r.id === principal.familyId,
      })),
      next_cursor: null,
    });
  });

  server.post(
    '/v1/auth/sessions/revoke-others',
    { schema: { body: { type: 'object', additionalProperties: false, properties: {} } } },
    async (request, reply) => {
      const principal = await sessionRoute(request, reply, 'sessions_revoke_others');
      const revoked = await s.tokens.revokeAllForUser(
        principal.userId,
        'revoked_by_user',
        s.pool,
        principal.familyId,
      );
      await s.events.record('sessions_revoked_by_user', {
        accountId: principal.userId,
        familyId: principal.familyId,
        detail: { revoked },
      });
      return reply.send({ revoked });
    },
  );

  // ------------------------------------------------------------------ TOTP helpers
  const privilegedRole = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Principal> => {
    const principal = await ctx.authenticate(request, reply, { defaultLimit: false });
    if (!hasRole(principal.role, 'moderator')) throw new ApiError('forbidden');
    return principal;
  };

  const assertNotLocked = async (principal: Principal): Promise<void> => {
    const { rows } = await s.pool.query<{ wait: string }>(
      `SELECT ceil(extract(epoch FROM (locked_until - now())))::text AS wait
         FROM totp_lockouts WHERE user_id = $1 AND locked_until > now()`,
      [principal.userId],
    );
    if (rows[0]) {
      const wait = String(Math.max(1, Number.parseInt(rows[0].wait, 10)));
      throw new ApiError(
        'rate_limited',
        { retry_after_seconds: Number.parseInt(wait, 10) },
        'Too many failed two-factor codes',
        { 'retry-after': wait },
      );
    }
  };

  /** 5 consecutive failures ⇒ this family revoked + 15 min account lockout (contract A9). */
  const totpFailure = async (principal: Principal, endpoint: string): Promise<never> => {
    const { rows } = await s.pool.query<{ consecutive_failures: number }>(
      `INSERT INTO totp_lockouts (user_id, consecutive_failures) VALUES ($1, 1)
       ON CONFLICT (user_id) DO UPDATE
         SET consecutive_failures = totp_lockouts.consecutive_failures + 1
       RETURNING consecutive_failures`,
      [principal.userId],
    );
    await s.events.record('step_up_failed', {
      accountId: principal.userId,
      familyId: principal.familyId,
      detail: { endpoint },
    });
    if (rows[0].consecutive_failures >= MAX_TOTP_FAILURES) {
      await s.pool.query(
        `UPDATE totp_lockouts SET consecutive_failures = 0,
                locked_until = now() + make_interval(secs => $2)
          WHERE user_id = $1`,
        [principal.userId, TOTP_LOCKOUT_SECONDS],
      );
      await s.tokens.revokeFamily(principal.familyId, 'totp_lockout');
      await s.events.record('totp_lockout', {
        accountId: principal.userId,
        familyId: principal.familyId,
        detail: { lockout_seconds: TOTP_LOCKOUT_SECONDS },
      });
      throw new ApiError('unauthenticated', { reason: 'session_revoked' });
    }
    throw new ApiError('invalid_code');
  };

  const totpSuccess = async (principal: Principal): Promise<Date> => {
    await s.pool.query(`UPDATE totp_lockouts SET consecutive_failures = 0 WHERE user_id = $1`, [
      principal.userId,
    ]);
    return s.tokens.recordStepUp(principal.familyId);
  };

  const stepUpExpiry = (at: Date): string =>
    new Date(at.getTime() + s.config.stepUpTtlSeconds * 1000).toISOString();

  // ------------------------------------------------------------------ A7 totp/enrol
  server.post(
    '/v1/auth/totp/enrol',
    { schema: { body: { type: 'object', additionalProperties: false, properties: {} } } },
    async (request, reply) => {
      const principal = await privilegedRole(request, reply);
      await ctx.limit(reply, [{ name: 'totp_enrol_account', key: principal.userId }], {
        endpoint: 'totp_enrol',
        accountId: principal.userId,
      });
      if (principal.twoFactorEnabled) throw conflict('totp_already_enrolled');
      const { headers } = await s.tokens.sessionHeaders(principal.familyId);
      const result = (await s.auth.api.enableTwoFactor({ body: {}, headers })) as {
        totpURI: string;
      };
      const uri = new URL(result.totpURI);
      await s.events.record('totp_enrol_started', {
        accountId: principal.userId,
        familyId: principal.familyId,
      });
      return reply.send({
        otpauth_uri: result.totpURI,
        secret_base32: uri.searchParams.get('secret') ?? '',
        digits: 6,
        period: 30,
      });
    },
  );

  // ------------------------------------------------------------------ A8 totp/enrol/confirm
  server.post(
    '/v1/auth/totp/enrol/confirm',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          additionalProperties: false,
          properties: { code: { type: 'string', pattern: '^[0-9]{6}$' } },
        },
      },
    },
    async (request, reply) => {
      const principal = await privilegedRole(request, reply);
      await assertNotLocked(principal);
      await ctx.limit(reply, [{ name: 'totp_attempts_account', key: principal.userId }], {
        endpoint: 'totp_enrol_confirm',
        accountId: principal.userId,
      });
      if (principal.twoFactorEnabled) throw invalidState('already_in_state');
      const pending = await s.pool.query(
        `SELECT 1 FROM "twoFactor" WHERE "userId" = $1 AND "verified" IS NOT TRUE`,
        [principal.userId],
      );
      if (pending.rowCount === 0) throw invalidState('not_enrolled');
      const { headers, baSessionId } = await s.tokens.sessionHeaders(principal.familyId);
      let responseHeaders: Headers | undefined;
      try {
        const result = (await s.auth.api.verifyTOTP({
          body: { code: (request.body as { code: string }).code },
          headers,
          returnHeaders: true,
        })) as { headers: Headers };
        responseHeaders = result.headers;
      } catch (error) {
        if (!isBetterAuthError(error)) throw error;
        return totpFailure(principal, 'totp_enrol_confirm');
      }
      // Better Auth replaces the session when it enables 2FA; the family follows it.
      // The bearer plugin may expose the signed form `<token>.<signature>`; the row holds <token>.
      const newToken = responseHeaders?.get('set-auth-token')?.split('.')[0];
      const replacement = await s.pool.query<{ id: string }>(
        newToken
          ? `SELECT "id" FROM "session" WHERE "token" = $1`
          : `SELECT "id" FROM "session" WHERE "userId" = $1 AND "id" <> $2
              ORDER BY "createdAt" DESC LIMIT 1`,
        newToken ? [newToken] : [principal.userId, baSessionId],
      );
      if (replacement.rows[0] && replacement.rows[0].id !== baSessionId) {
        await s.tokens.rebindSession(principal.familyId, replacement.rows[0].id);
      }
      const stepUpAt = await totpSuccess(principal);
      const codes = (await s.auth.api.viewBackupCodes({
        body: { userId: principal.userId },
      })) as { backupCodes: string[] };
      await s.events.record('totp_enrolled', {
        accountId: principal.userId,
        familyId: principal.familyId,
      });
      return reply.send({
        backup_codes: codes.backupCodes,
        step_up_expires_at: stepUpExpiry(stepUpAt),
      });
    },
  );

  // ------------------------------------------------------------------ A9 totp/verify (step-up)
  server.post(
    '/v1/auth/totp/verify',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string', pattern: '^[0-9]{6}$' },
            backup_code: { type: 'string', minLength: 8, maxLength: 32 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { code?: string; backup_code?: string };
      if ((body.code === undefined) === (body.backup_code === undefined)) {
        throw validation(body.code === undefined ? 'code' : 'backup_code', 'required');
      }
      const principal = await privilegedRole(request, reply);
      await assertNotLocked(principal);
      if (!principal.twoFactorEnabled) throw new ApiError('mfa_enrollment_required');
      await ctx.limit(reply, [{ name: 'totp_attempts_account', key: principal.userId }], {
        endpoint: 'totp_verify',
        accountId: principal.userId,
      });
      const { headers } = await s.tokens.sessionHeaders(principal.familyId);
      try {
        if (body.code !== undefined) {
          await s.auth.api.verifyTOTP({ body: { code: body.code }, headers });
        } else {
          await s.auth.api.verifyBackupCode({
            body: { code: body.backup_code as string, disableSession: true },
            headers,
          });
        }
      } catch (error) {
        if (!isBetterAuthError(error)) throw error;
        return totpFailure(principal, 'totp_verify');
      }
      const stepUpAt = await totpSuccess(principal);
      await s.events.record('step_up_succeeded', {
        accountId: principal.userId,
        familyId: principal.familyId,
        detail: { method: body.code !== undefined ? 'totp' : 'backup_code' },
      });
      return reply.send({ step_up: 'verified', step_up_expires_at: stepUpExpiry(stepUpAt) });
    },
  );
};
