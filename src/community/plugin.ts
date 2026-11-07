/**
 * Community plugin (PROOF OF CONCEPT — ADR-001). Not approved for release.
 *
 * Registered by `buildApp` only when `COMMUNITY_MODE` is internal | closed_beta | public. It owns
 * its own pg pool on `COMMUNITY_DATABASE_URL`; `/config`, `/health` and `/version` never touch it,
 * so a Community database outage is confined to `/v1/auth/*` and `/v1/community/*`.
 *
 * Isolation: this module imports nothing from the artifact, manifest or telemetry code, and has
 * no input field for symptoms, triage results or assessment history (see the isolation test).
 */
import { AjvCompiler } from '@fastify/ajv-compiler';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { Pool } from 'pg';
import {
  AccessTokenVerifier,
  assertPrivileged,
  bearerToken,
  CommunityHttpError,
  CommunityPrincipal,
  hasRole,
  Role,
  sendError,
} from './access';
import { AUTH_BASE_PATH, CommunityAuth } from './auth';
import { CommunityEnabledConfig } from './config';
import { deleteUser, exportUser } from './data-rights';

export interface CommunityPluginOptions {
  config: CommunityEnabledConfig;
  pool: Pool;
  auth: CommunityAuth;
  verifier: AccessTokenVerifier;
}

/** Whether an authenticated principal may use Community content in the configured mode. */
export const isCommunityAllowed = (
  config: CommunityEnabledConfig,
  principal: CommunityPrincipal,
): boolean =>
  config.mode === 'public' ||
  hasRole(principal.role, 'moderator') ||
  config.allowlist.has(principal.userId);

const MAX_STEP_UP_FAILURES = 5;

/** pg / network errors that mean "the Community database is unreachable". */
const isDatabaseUnavailable = (error: unknown): boolean => {
  const e = error as { code?: string; message?: string };
  return (
    [
      'ECONNREFUSED',
      'ENOTFOUND',
      'ETIMEDOUT',
      'ECONNRESET',
      '57P01',
      '57P03',
      '08006',
      '08001',
    ].includes(e.code ?? '') ||
    /timeout exceeded when trying to connect|Connection terminated/i.test(e.message ?? '')
  );
};

const str = (min: number, max: number): Record<string, unknown> => ({
  type: 'string',
  minLength: min,
  maxLength: max,
});

/** Public (member-facing) author: never the account id or email. */
const memberAuthor = (row: {
  display_mode: string;
  display_name: string | null;
  profession: string | null;
  verification_status: string | null;
  status: string;
}): Record<string, unknown> => {
  if (row.display_mode === 'anonymous' || row.status === 'tombstoned') {
    return { display_name: row.status === 'tombstoned' ? 'Deleted user' : 'Anonymous' };
  }
  return {
    display_name: row.display_name ?? 'Member',
    // Only an admin-verified profession is shown as a badge; a claim is never displayed as one.
    verified_professional:
      row.verification_status === 'verified' ? { profession: row.profession } : null,
  };
};

const AUTHOR_JOIN = `
  LEFT JOIN profiles pr ON pr.user_id = t.author_id
  LEFT JOIN LATERAL (
    SELECT profession, status FROM professional_verifications v
     WHERE v.user_id = t.author_id ORDER BY (v.status = 'verified') DESC, v.id DESC LIMIT 1
  ) pv ON true`;

export async function communityPlugin(
  server: FastifyInstance,
  options: CommunityPluginOptions,
): Promise<void> {
  const { config, pool, auth, verifier } = options;

  // Fastify's default Ajv silently *strips* properties not in a schema. Community bodies must
  // instead be *rejected* when they carry anything unexpected (e.g. an attempt to attach
  // assessment output to a post), so this scope gets its own strict validator.
  const buildStrict = AjvCompiler()(
    {},
    {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
        allErrors: false,
      },
    },
  );
  server.setValidatorCompiler(buildStrict);

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof CommunityHttpError) return sendError(reply, error);
    if (isDatabaseUnavailable(error)) {
      request.log.error(
        { code: (error as { code?: string }).code },
        'Community database unavailable',
      );
      return sendError(
        reply,
        new CommunityHttpError(
          503,
          'community_unavailable',
          'Community is temporarily unavailable',
        ),
      );
    }
    // Everything else goes to the app-wide handler (sanitised envelope, no echo of input).
    throw error;
  });

  // ---------------------------------------------------------------- Better Auth (/v1/auth/*)
  server.route({
    method: ['GET', 'POST'],
    url: `${AUTH_BASE_PATH}/*`,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const url = new URL(request.url, config.baseUrl);
      const hasBody = request.method !== 'GET' && request.body !== undefined;
      const response = await auth.handler(
        new Request(url.toString(), {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
          ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      const text = response.body ? await response.text() : '';
      if (response.status >= 500) {
        request.log.error({ status: response.status }, 'Auth handler error');
      }
      return reply.send(text || null);
    },
  });

  // ------------------------------------------------------------------------- helpers
  const authenticate = async (request: FastifyRequest): Promise<CommunityPrincipal> => {
    const token = bearerToken(request);
    if (!token) throw new CommunityHttpError(401, 'unauthenticated', 'Missing access token');
    const principal = await verifier.verify(token);
    request.community = principal;
    return principal;
  };

  const isAllowed = (principal: CommunityPrincipal): boolean =>
    isCommunityAllowed(config, principal);

  /** Authenticated and allowed to use Community content in the current mode. */
  const member = async (request: FastifyRequest): Promise<CommunityPrincipal> => {
    const principal = await authenticate(request);
    if (!isAllowed(principal)) {
      throw new CommunityHttpError(
        403,
        'community_not_allowed',
        'Community is not enabled for this account',
      );
    }
    return principal;
  };

  const privileged = async (
    request: FastifyRequest,
    role: Exclude<Role, 'member'>,
  ): Promise<CommunityPrincipal> => {
    const principal = await authenticate(request);
    await assertPrivileged(pool, principal, role, config.stepUpTtlSeconds);
    return principal;
  };

  const audit = async (
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    reason: string,
    evidence?: unknown,
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO moderation_actions (actor_id, action, target_type, target_id, reason, evidence)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        actorId,
        action,
        targetType,
        targetId,
        reason,
        evidence === undefined ? null : JSON.stringify(evidence),
      ],
    );
  };

  const notify = async (userId: string, kind: string, payload: unknown): Promise<void> => {
    await pool.query('INSERT INTO notifications (user_id, kind, payload) VALUES ($1, $2, $3)', [
      userId,
      kind,
      JSON.stringify(payload),
    ]);
  };

  // ----------------------------------------------------------------------- self
  server.get('/v1/community/me', async request => {
    const principal = await authenticate(request);
    const { rows } = await pool.query(
      'SELECT display_name, is_pseudonymous FROM profiles WHERE user_id = $1',
      [principal.userId],
    );
    return {
      id: principal.userId,
      role: principal.role,
      two_factor_enabled: principal.twoFactorEnabled,
      community_allowed: isAllowed(principal),
      profile: rows[0] ?? null,
    };
  });

  server.post(
    '/v1/community/me/profile',
    {
      schema: {
        body: {
          type: 'object',
          required: ['display_name'],
          additionalProperties: false,
          properties: { display_name: { ...str(2, 40), pattern: '^[A-Za-z0-9 _.-]+$' } },
        },
      },
    },
    async (request, reply) => {
      const principal = await member(request);
      const { display_name } = request.body as { display_name: string };
      try {
        await pool.query(
          `INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
          [principal.userId, display_name],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new CommunityHttpError(409, 'display_name_taken', 'Display name is taken');
        }
        throw error;
      }
      return reply.status(200).send({ display_name });
    },
  );

  server.post(
    '/v1/community/me/professional',
    {
      schema: {
        body: {
          type: 'object',
          required: ['profession'],
          additionalProperties: false,
          properties: { profession: str(2, 80), specialty: str(2, 80) },
        },
      },
    },
    async (request, reply) => {
      const principal = await member(request);
      const body = request.body as { profession: string; specialty?: string };
      // Always 'claimed': the status is not an input, and the DB forbids self-verification.
      const { rows } = await pool.query(
        `INSERT INTO professional_verifications (user_id, profession, specialty, status)
         VALUES ($1, $2, $3, 'claimed') RETURNING id, status`,
        [principal.userId, body.profession, body.specialty ?? null],
      );
      return reply.status(201).send(rows[0]);
    },
  );

  server.get('/v1/community/me/export', async (request, reply) => {
    const principal = await authenticate(request);
    const data = await exportUser(pool, principal.userId);
    if (!data) throw new CommunityHttpError(404, 'not_found', 'Account not found');
    return reply
      .header('content-disposition', 'attachment; filename="wellapath-community-export.json"')
      .send(data);
  });

  server.post(
    '/v1/community/me/delete',
    {
      schema: {
        body: {
          type: 'object',
          required: ['confirm'],
          additionalProperties: false,
          properties: { confirm: { const: 'DELETE MY ACCOUNT' } },
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticate(request);
      await deleteUser(pool, principal.userId, 'user-requested account deletion');
      return reply.status(200).send({ deleted: true });
    },
  );

  server.get('/v1/community/notifications', async request => {
    const principal = await member(request);
    const { rows } = await pool.query(
      `SELECT id, kind, payload, read_at, created_at FROM notifications
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [principal.userId],
    );
    return { notifications: rows };
  });

  // ---------------------------------------------------------------------- TOTP step-up
  server.post(
    '/v1/community/mfa/step-up',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { code: { type: 'string', pattern: '^[0-9]{6}$' }, backup_code: str(4, 64) },
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticate(request);
      if (!principal.twoFactorEnabled) {
        throw new CommunityHttpError(403, 'mfa_enrollment_required', 'Enrol TOTP first');
      }
      const body = request.body as { code?: string; backup_code?: string };
      if (!body.code && !body.backup_code) {
        throw new CommunityHttpError(400, 'code_required', 'Provide code or backup_code');
      }
      const { rows } = await pool.query<{ token: string }>(
        `SELECT "token" FROM "session" WHERE "id" = $1`,
        [principal.sessionId],
      );
      if (!rows[0])
        throw new CommunityHttpError(401, 'session_revoked', 'Session is no longer valid');
      const headers = new Headers({ authorization: `Bearer ${rows[0].token}` });

      let ok = false;
      try {
        if (body.code) {
          await auth.api.verifyTOTP({ body: { code: body.code }, headers });
        } else {
          await auth.api.verifyBackupCode({ body: { code: body.backup_code as string }, headers });
        }
        ok = true;
      } catch {
        ok = false;
      }

      if (!ok) {
        const { rows: counted } = await pool.query<{ failed_attempts: number }>(
          `INSERT INTO session_step_up (session_id, failed_attempts) VALUES ($1, 1)
           ON CONFLICT (session_id) DO UPDATE SET failed_attempts = session_step_up.failed_attempts + 1
           RETURNING failed_attempts`,
          [principal.sessionId],
        );
        if (counted[0].failed_attempts >= MAX_STEP_UP_FAILURES) {
          // Too many wrong codes on one session: revoke it. The user must sign in again.
          await pool.query(`DELETE FROM "session" WHERE "id" = $1`, [principal.sessionId]);
          throw new CommunityHttpError(401, 'session_revoked', 'Too many failed codes; signed out');
        }
        throw new CommunityHttpError(401, 'invalid_code', 'Invalid code');
      }
      await pool.query(
        `INSERT INTO session_step_up (session_id, verified_at, failed_attempts) VALUES ($1, now(), 0)
         ON CONFLICT (session_id) DO UPDATE SET verified_at = now(), failed_attempts = 0`,
        [principal.sessionId],
      );
      return reply.status(200).send({ step_up: 'verified', ttl_seconds: config.stepUpTtlSeconds });
    },
  );

  // ----------------------------------------------------------------------- content
  server.get('/v1/community/spaces', async request => {
    await member(request);
    const { rows } = await pool.query('SELECT slug, name FROM spaces ORDER BY slug');
    return { spaces: rows };
  });

  const assertSpace = async (slug: string): Promise<void> => {
    const { rows } = await pool.query('SELECT 1 FROM spaces WHERE slug = $1', [slug]);
    if (rows.length === 0) throw new CommunityHttpError(404, 'not_found', 'Space not found');
  };

  server.get('/v1/community/spaces/:slug/posts', async request => {
    const principal = await member(request);
    const { slug } = request.params as { slug: string };
    await assertSpace(slug);
    const { rows } = await pool.query(
      `SELECT t.id, t.body, t.display_mode, t.status, t.created_at, t.author_id = $2 AS is_mine,
              pr.display_name, pv.profession, pv.status AS verification_status
         FROM posts t ${AUTHOR_JOIN}
        WHERE t.space_slug = $1 AND t.status = 'visible'
        ORDER BY t.created_at DESC LIMIT 50`,
      [slug, principal.userId],
    );
    return {
      posts: rows.map(r => ({
        id: r.id,
        body: r.body,
        created_at: r.created_at,
        is_mine: r.is_mine,
        author: memberAuthor(r),
      })),
    };
  });

  server.post(
    '/v1/community/spaces/:slug/posts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body'],
          // additionalProperties:false — there is no field through which assessment data,
          // symptoms or triage output could be attached to a post.
          additionalProperties: false,
          properties: { body: str(1, 5000), display_mode: { enum: ['profile', 'anonymous'] } },
        },
      },
    },
    async (request, reply) => {
      const principal = await member(request);
      const { slug } = request.params as { slug: string };
      await assertSpace(slug);
      const body = request.body as { body: string; display_mode?: string };
      const { rows } = await pool.query(
        `INSERT INTO posts (space_slug, author_id, display_mode, body)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [slug, principal.userId, body.display_mode ?? 'profile', body.body],
      );
      return reply.status(201).send(rows[0]);
    },
  );

  server.get('/v1/community/posts/:id', async request => {
    const principal = await member(request);
    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      `SELECT t.id, t.body, t.display_mode, t.status, t.created_at, t.author_id = $2 AS is_mine,
              pr.display_name, pv.profession, pv.status AS verification_status
         FROM posts t ${AUTHOR_JOIN}
        WHERE t.id::text = $1 AND t.status = 'visible'`,
      [id, principal.userId],
    );
    if (!rows[0]) throw new CommunityHttpError(404, 'not_found', 'Post not found');
    const comments = await pool.query(
      `SELECT t.id, t.body, t.display_mode, t.status, t.created_at,
              pr.display_name, pv.profession, pv.status AS verification_status
         FROM comments t ${AUTHOR_JOIN}
        WHERE t.post_id = $1 AND t.status = 'visible' ORDER BY t.created_at`,
      [rows[0].id],
    );
    const post = rows[0];
    return {
      id: post.id,
      body: post.body,
      created_at: post.created_at,
      is_mine: post.is_mine,
      author: memberAuthor(post),
      comments: comments.rows.map(c => ({
        id: c.id,
        body: c.body,
        created_at: c.created_at,
        author: memberAuthor(c),
      })),
    };
  });

  server.post(
    '/v1/community/posts/:id/comments',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: { body: str(1, 2000), display_mode: { enum: ['profile', 'anonymous'] } },
        },
      },
    },
    async (request, reply) => {
      const principal = await member(request);
      const { id } = request.params as { id: string };
      const body = request.body as { body: string; display_mode?: string };
      const post = await pool.query<{ id: string; author_id: string }>(
        `SELECT id, author_id FROM posts WHERE id::text = $1 AND status = 'visible'`,
        [id],
      );
      if (!post.rows[0]) throw new CommunityHttpError(404, 'not_found', 'Post not found');
      const { rows } = await pool.query(
        `INSERT INTO comments (post_id, author_id, display_mode, body)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [post.rows[0].id, principal.userId, body.display_mode ?? 'profile', body.body],
      );
      if (post.rows[0].author_id !== principal.userId) {
        await notify(post.rows[0].author_id, 'comment_on_post', {
          post_id: post.rows[0].id,
          comment_id: rows[0].id,
        });
      }
      return reply.status(201).send(rows[0]);
    },
  );

  server.post('/v1/community/posts/:id/delete', async (request, reply) => {
    const principal = await member(request);
    const { id } = request.params as { id: string };
    const { rowCount } = await pool.query(
      `UPDATE posts SET status = 'deleted_by_author', body = NULL, updated_at = now()
        WHERE id::text = $1 AND author_id = $2 AND status IN ('visible', 'hidden')`,
      [id, principal.userId],
    );
    if (!rowCount) throw new CommunityHttpError(404, 'not_found', 'Post not found');
    return reply.status(200).send({ deleted: true });
  });

  server.post(
    '/v1/community/reports',
    {
      schema: {
        body: {
          type: 'object',
          required: ['target_type', 'target_id', 'reason'],
          additionalProperties: false,
          properties: {
            target_type: { enum: ['post', 'comment'] },
            target_id: { type: 'string', format: 'uuid' },
            reason: {
              enum: [
                'spam',
                'harassment',
                'misinformation',
                'unsafe_medical_advice',
                'self_harm',
                'privacy',
                'other',
              ],
            },
            note: str(1, 1000),
          },
        },
      },
    },
    async (request, reply) => {
      const principal = await member(request);
      const body = request.body as {
        target_type: 'post' | 'comment';
        target_id: string;
        reason: string;
        note?: string;
      };
      const table = body.target_type === 'post' ? 'posts' : 'comments';
      const exists = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [body.target_id]);
      if (exists.rows.length === 0)
        throw new CommunityHttpError(404, 'not_found', 'Target not found');
      const { rows } = await pool.query(
        `INSERT INTO reports (reporter_id, target_type, target_id, reason, note)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
        [principal.userId, body.target_type, body.target_id, body.reason, body.note ?? null],
      );
      return reply.status(201).send(rows[0]);
    },
  );

  // -------------------------------------------------------------------- moderator
  const reasonBody = {
    body: {
      type: 'object',
      required: ['reason'],
      additionalProperties: false,
      properties: { reason: str(1, 1000) },
    },
  };

  server.get('/v1/community/mod/reports', async request => {
    await privileged(request, 'moderator');
    const { rows } = await pool.query(
      `SELECT r.id, r.target_type, r.target_id, r.reason, r.note, r.status, r.created_at,
              r.reporter_id,
              COALESCE(p.body, c.body) AS target_body,
              COALESCE(p.display_mode, c.display_mode) AS target_display_mode,
              u."id" AS author_id, u."email" AS author_email, pr.display_name AS author_display_name
         FROM reports r
         LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
         LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id
         LEFT JOIN "user" u ON u."id" = COALESCE(p.author_id, c.author_id)
         LEFT JOIN profiles pr ON pr.user_id = u."id"
        WHERE r.status = 'open' ORDER BY r.created_at`,
    );
    return { reports: rows };
  });

  server.get('/v1/community/mod/posts/:id', async request => {
    await privileged(request, 'moderator');
    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      `SELECT p.id, p.body, p.status, p.display_mode, p.created_at,
              u."id" AS author_id, u."email" AS author_email, pr.display_name AS author_display_name
         FROM posts p JOIN "user" u ON u."id" = p.author_id
         LEFT JOIN profiles pr ON pr.user_id = u."id"
        WHERE p.id::text = $1`,
      [id],
    );
    if (!rows[0]) throw new CommunityHttpError(404, 'not_found', 'Post not found');
    return rows[0];
  });

  for (const kind of ['posts', 'comments'] as const) {
    server.post(
      `/v1/community/mod/${kind}/:id/hide`,
      { schema: reasonBody },
      async (request, reply) => {
        const actor = await privileged(request, 'moderator');
        const { id } = request.params as { id: string };
        const { reason } = request.body as { reason: string };
        const { rows } = await pool.query(
          `UPDATE ${kind} SET status = 'hidden', updated_at = now()
          WHERE id::text = $1 AND status = 'visible'
        RETURNING id, author_id, body, display_mode`,
          [id],
        );
        if (!rows[0]) throw new CommunityHttpError(404, 'not_found', 'Content not found');
        const targetType = kind === 'posts' ? 'post' : 'comment';
        await audit(actor.userId, 'hide_content', targetType, rows[0].id, reason, {
          body: rows[0].body,
          author_id: rows[0].author_id,
          display_mode: rows[0].display_mode,
        });
        await pool.query(
          `UPDATE reports SET status = 'actioned' WHERE target_type = $1 AND target_id = $2 AND status = 'open'`,
          [targetType, rows[0].id],
        );
        await notify(rows[0].author_id, 'moderation', {
          action: 'hide_content',
          target_type: targetType,
          target_id: rows[0].id,
        });
        return reply.status(200).send({ status: 'hidden' });
      },
    );
  }

  server.post(
    '/v1/community/mod/users/:id/suspend',
    { schema: reasonBody },
    async (request, reply) => {
      const actor = await privileged(request, 'moderator');
      const { id } = request.params as { id: string };
      const { reason } = request.body as { reason: string };
      if (id === actor.userId)
        throw new CommunityHttpError(400, 'self_action', 'Cannot suspend yourself');
      const target = await pool.query<{ role: Role }>(
        `SELECT "role" FROM "user" WHERE "id" = $1 AND "deletedAt" IS NULL`,
        [id],
      );
      if (!target.rows[0]) throw new CommunityHttpError(404, 'not_found', 'User not found');
      if (target.rows[0].role !== 'member' && actor.role !== 'admin') {
        throw new CommunityHttpError(
          403,
          'forbidden',
          'Only an admin can suspend a moderator or admin',
        );
      }
      await pool.query(
        `INSERT INTO account_restrictions (user_id, kind, reason, created_by) VALUES ($1, 'suspended', $2, $3)`,
        [id, reason, actor.userId],
      );
      // Revoke every session immediately (ADR-001 R3.2).
      const revoked = await pool.query(`DELETE FROM "session" WHERE "userId" = $1`, [id]);
      await audit(actor.userId, 'suspend_account', 'user', id, reason, {
        sessions_revoked: revoked.rowCount,
      });
      await notify(id, 'moderation', { action: 'suspend_account' });
      return reply.status(200).send({ suspended: true, sessions_revoked: revoked.rowCount });
    },
  );

  // ------------------------------------------------------------------------- admin
  server.post(
    '/v1/community/admin/users/:id/role',
    {
      schema: {
        body: {
          type: 'object',
          required: ['role', 'reason'],
          additionalProperties: false,
          properties: { role: { enum: ['member', 'moderator', 'admin'] }, reason: str(1, 1000) },
        },
      },
    },
    async (request, reply) => {
      const actor = await privileged(request, 'admin');
      const { id } = request.params as { id: string };
      const { role, reason } = request.body as { role: Role; reason: string };
      const { rows } = await pool.query<{ previous: Role }>(
        `WITH prev AS (SELECT "role" FROM "user" WHERE "id" = $1 AND "deletedAt" IS NULL)
         UPDATE "user" u SET "role" = $2, "updatedAt" = now() FROM prev
          WHERE u."id" = $1 RETURNING prev."role" AS previous`,
        [id, role],
      );
      if (!rows[0]) throw new CommunityHttpError(404, 'not_found', 'User not found');
      await audit(actor.userId, 'grant_role', 'user', id, reason, {
        from: rows[0].previous,
        to: role,
      });
      return reply.status(200).send({ id, role });
    },
  );

  server.post(
    '/v1/community/admin/verifications/:id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['status', 'reason'],
          additionalProperties: false,
          properties: {
            status: { enum: ['pending', 'verified', 'revoked'] },
            reason: str(1, 1000),
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await privileged(request, 'admin');
      const { id } = request.params as { id: string };
      const { status, reason } = request.body as { status: string; reason: string };
      const verified = status === 'verified';
      const { rows } = await pool
        .query(
          `UPDATE professional_verifications
            SET status = $2, verified_by = CASE WHEN $3 THEN $4 ELSE NULL END,
                verified_at = CASE WHEN $3 THEN now() ELSE NULL END, updated_at = now()
          WHERE id::text = $1 RETURNING id, user_id, profession, status`,
          [id, status, verified, actor.userId],
        )
        .catch(error => {
          if ((error as { code?: string }).code === '23514') {
            throw new CommunityHttpError(
              400,
              'self_verification',
              'Cannot verify your own profession',
            );
          }
          throw error;
        });
      if (!rows[0]) throw new CommunityHttpError(404, 'not_found', 'Verification not found');
      await audit(
        actor.userId,
        verified ? 'verify_professional' : 'revoke_professional',
        'professional_verification',
        String(rows[0].id),
        reason,
        { user_id: rows[0].user_id, profession: rows[0].profession, status },
      );
      return reply.status(200).send(rows[0]);
    },
  );
}
