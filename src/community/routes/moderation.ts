/**
 * `/v1/community/mod/*` (moderator+) and `/v1/community/admin/*` (admin) — contract §12.
 *
 * Every route passes the privileged gate (role → TOTP enrolled → fresh step-up on this session).
 * Every mutation requires a 10–500 char reason and writes exactly one append-only
 * `moderation_actions` row in the same transaction as the state change (actor from the token,
 * server timestamp). The report queue and moderator content view carry NO author identity: the
 * accountable identity is only returned by the audited `POST /mod/identity/reveal`, and email is
 * never returned by any moderator endpoint.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PoolClient } from 'pg';
import {
  AUTHOR_JOIN,
  CommunityContext,
  Db,
  ModerationActionDto,
  moderationActionDto,
  publicAuthor,
} from '../context';
import {
  ApiError,
  cursorTs,
  invalidState,
  notFound,
  page,
  parsePage,
  requireAccountId,
  requireUuid,
  tsRequired,
  validation,
} from '../http';
import { Principal, Role } from '../tokens';

const REASON = { type: 'string', minLength: 10, maxLength: 500 };
const reasonOnly = {
  body: {
    type: 'object',
    required: ['reason'],
    additionalProperties: false,
    properties: { reason: REASON },
  },
};
const restrictBody = {
  body: {
    type: 'object',
    required: ['reason'],
    additionalProperties: false,
    properties: { reason: REASON, until: { type: 'string', format: 'date-time' } },
  },
};

const REPORT_STATUSES = ['open', 'actioned', 'dismissed'];
const ACTION_TYPES = [
  'dismiss_report',
  'reveal_identity',
  'hide_content',
  'restore_content',
  'remove_content',
  'restrict_account',
  'suspend_account',
  'reinstate_account',
  'change_role',
  'reset_totp',
  'verify_professional',
  'revoke_professional',
  'withdraw_professional',
  'delete_account',
];
const TARGET_TYPES = ['post', 'comment', 'account', 'report', 'professional_verification'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const reasonOf = (request: FastifyRequest): string => {
  const reason = (request.body as { reason: string }).reason.trim();
  if (reason.length < 10) throw validation('reason', 'min_length');
  return reason;
};

/** ModContent (contract §12.1): no author account id. */
export const modContent = async (
  db: Db,
  kind: 'post' | 'comment',
  id: string,
): Promise<Record<string, unknown> | undefined> => {
  const { rows } = await db.query(
    kind === 'post'
      ? `SELECT t.id, t.space_id, NULL::uuid AS post_id, t.body, t.display_mode, t.status,
                t.created_at, t.updated_at, pr.display_name, pv.profession AS badge_profession,
                pv.specialty AS badge_specialty,
                (SELECT count(*)::int FROM reports r WHERE r.target_type = 'post'
                    AND r.target_id = t.id AND r.status = 'open') AS open_report_count
           FROM posts t ${AUTHOR_JOIN} WHERE t.id = $1`
      : `SELECT t.id, p.space_id, t.post_id, t.body, t.display_mode, t.status,
                t.created_at, t.updated_at, pr.display_name, pv.profession AS badge_profession,
                pv.specialty AS badge_specialty,
                (SELECT count(*)::int FROM reports r WHERE r.target_type = 'comment'
                    AND r.target_id = t.id AND r.status = 'open') AS open_report_count
           FROM comments t JOIN posts p ON p.id = t.post_id ${AUTHOR_JOIN} WHERE t.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    id: r.id,
    kind,
    space_id: r.space_id,
    post_id: r.post_id,
    body: r.body,
    author: publicAuthor(r),
    status: r.status,
    open_report_count: r.open_report_count,
    created_at: tsRequired(r.created_at),
    updated_at: tsRequired(r.updated_at),
  };
};

export const registerModerationRoutes = (server: FastifyInstance, ctx: CommunityContext): void => {
  const { s } = ctx;

  /** Mutating privileged route: gate, optional Idempotency-Key, 300/h per actor, one tx. */
  const mutate = async (
    request: FastifyRequest,
    reply: FastifyReply,
    role: Exclude<Role, 'member'>,
    route: string,
    run: (actor: Principal, client: PoolClient) => Promise<Record<string, unknown>>,
  ): Promise<FastifyReply> => {
    const actor = await ctx.privileged(request, reply, role);
    return ctx.idempotent(
      request,
      reply,
      actor,
      route,
      { required: false, limits: [{ name: 'privileged_mutation_hour', key: actor.userId }] },
      async () => ({
        status: 200,
        body: await ctx.tx(async client => {
          const result = await run(actor, client);
          // SEC-025: the last statement before COMMIT. The request may have waited inside the
          // transaction (on a target row, or on the FK check against the actor's own row) while
          // the actor was demoted, suspended, deleted or had 2FA reset. Re-check now, so such a
          // change is seen (401/403) and the whole action, its audit row included, rolls back.
          // LOAD-BEARING: this is airtight only because every handler has already written a row
          // with an FK to the actor (its audit row), whose KEY SHARE on the actor's user row
          // blocks every authority-removing path (X1 demotion, suspension, X2, deletion: all
          // take FOR UPDATE on that row) until we commit. Keep the audit write before this
          // re-check, and keep `loadTarget` / `adminTarget` at FOR UPDATE (see there).
          await ctx.reauthorize(client, actor, role);
          return result;
        }),
      }),
    );
  };

  const reportItem = async (r: Row): Promise<Record<string, unknown>> => ({
    id: r.id,
    target_type: r.target_type,
    target_id: r.target_id,
    reason: r.reason,
    note: r.note,
    status: r.status,
    created_at: tsRequired(r.created_at),
    target: await modContent(s.pool, r.target_type, r.target_id),
  });

  // D1
  server.get('/v1/community/mod/reports', async (request, reply) => {
    await ctx.privileged(request, reply, 'moderator');
    const query = (request.query ?? {}) as Record<string, unknown>;
    const status = (query.status as string | undefined) ?? 'open';
    if (!REPORT_STATUSES.includes(status)) throw validation('status', 'enum');
    const list = `reports:${status}`;
    const q = parsePage(query, list, { p: 'int', t: 'timestamp', id: 'uuid' });
    const open = status === 'open';
    // open: self_harm_or_emergency first, then oldest first. Others: newest first.
    const { rows } = await s.pool.query(
      `SELECT * FROM (
         SELECT r.*, ${cursorTs('r.created_at')} AS cursor_ts,
                CASE WHEN $4 AND r.reason = 'self_harm_or_emergency' THEN 0 ELSE 1 END AS prio
           FROM reports r WHERE r.status = $1) x
        WHERE $2::timestamptz IS NULL OR (
          CASE WHEN $4 THEN (x.prio, x.created_at, x.id) > ($5::int, $2::timestamptz, $3::uuid)
               ELSE (x.created_at, x.id) < ($2::timestamptz, $3::uuid) END)
        ORDER BY CASE WHEN $4 THEN x.prio END ASC,
                 CASE WHEN $4 THEN x.created_at END ASC, CASE WHEN $4 THEN x.id END ASC,
                 CASE WHEN NOT $4 THEN x.created_at END DESC, CASE WHEN NOT $4 THEN x.id END DESC
        LIMIT $6`,
      [status, q.cursor?.t ?? null, q.cursor?.id ?? null, open, q.cursor?.p ?? 1, q.limit + 1],
    );
    const result = page(
      rows,
      q.limit,
      r => r,
      r => ({ p: r.prio, t: r.cursor_ts, id: r.id }),
      list,
    );
    return reply.send({
      items: await Promise.all(result.items.map(reportItem)),
      next_cursor: result.next_cursor,
    });
  });

  // D2
  server.get('/v1/community/mod/reports/:report_id', async (request, reply) => {
    await ctx.privileged(request, reply, 'moderator');
    const id = requireUuid((request.params as { report_id: string }).report_id);
    const { rows } = await s.pool.query(`SELECT * FROM reports WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound();
    return reply.send(await reportItem(rows[0]));
  });

  // D3
  server.post(
    '/v1/community/mod/reports/:report_id/dismiss',
    { schema: reasonOnly },
    async (request, reply) =>
      mutate(
        request,
        reply,
        'moderator',
        'POST /mod/reports/{id}/dismiss',
        async (actor, client) => {
          const id = requireUuid((request.params as { report_id: string }).report_id);
          const { rows } = await client.query(`SELECT * FROM reports WHERE id = $1 FOR UPDATE`, [
            id,
          ]);
          if (!rows[0]) throw notFound();
          if (rows[0].status !== 'open') throw invalidState('already_in_state');
          await client.query(
            `UPDATE reports SET status = 'dismissed', updated_at = now() WHERE id = $1`,
            [id],
          );
          const action = await ctx.audit(client, {
            actor: actor.userId,
            action: 'dismiss_report',
            targetType: 'report',
            targetId: id,
            reason: reasonOf(request),
            evidence: { target_type: rows[0].target_type, target_id: rows[0].target_id },
          });
          return { ...action, target_status: 'dismissed' };
        },
      ),
  );

  // D4 / D5
  for (const kind of ['post', 'comment'] as const) {
    server.get(`/v1/community/mod/${kind}s/:${kind}_id`, async (request, reply) => {
      await ctx.privileged(request, reply, 'moderator');
      const id = requireUuid((request.params as Record<string, string>)[`${kind}_id`]);
      const content = await modContent(s.pool, kind, id);
      if (!content) throw notFound();
      return reply.send(content);
    });
  }

  // D6 — the ONLY route that returns an accountable identity. A read that is audited.
  server.post(
    '/v1/community/mod/identity/reveal',
    {
      schema: {
        body: {
          type: 'object',
          required: ['target_type', 'target_id', 'reason'],
          additionalProperties: false,
          properties: {
            target_type: { enum: ['post', 'comment'] },
            target_id: { type: 'string', maxLength: 64 },
            reason: REASON,
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await ctx.privileged(request, reply, 'moderator');
      await ctx.limit(reply, [{ name: 'identity_reveal_hour', key: actor.userId }]);
      const body = request.body as { target_type: 'post' | 'comment'; target_id: string };
      const targetId = requireUuid(body.target_id);
      const identity = await ctx.tx(async client => {
        const table = body.target_type === 'post' ? 'posts' : 'comments';
        const { rows } = await client.query<Row>(
          `SELECT u."id", u."role", u."createdAt", pr.display_name,
                  EXISTS (SELECT 1 FROM account_restrictions r WHERE r.user_id = u."id"
                     AND r.kind = 'suspended' AND r.lifted_at IS NULL
                     AND (r.expires_at IS NULL OR r.expires_at > now())) AS suspended,
                  EXISTS (SELECT 1 FROM account_restrictions r WHERE r.user_id = u."id"
                     AND r.kind = 'restricted' AND r.lifted_at IS NULL
                     AND (r.expires_at IS NULL OR r.expires_at > now())) AS restricted
             FROM ${table} t JOIN "user" u ON u."id" = t.author_id
             LEFT JOIN profiles pr ON pr.user_id = u."id"
            WHERE t.id = $1`,
          [targetId],
        );
        const author = rows[0];
        if (!author) throw notFound();
        const prior = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM moderation_actions
            WHERE action <> 'reveal_identity'
              AND ((target_type = 'account' AND target_id = $1)
                   OR evidence->>'author_account_id' = $1)`,
          [author.id],
        );
        const action = await ctx.audit(client, {
          actor: actor.userId,
          action: 'reveal_identity',
          targetType: body.target_type,
          targetId,
          reason: reasonOf(request),
          evidence: { revealed_account_id: author.id },
        });
        // SEC-025: re-check the moderator before COMMIT (same reason as in `mutate`). The
        // identity is only sent after the commit, so a refusal here reveals nothing.
        await ctx.reauthorize(client, actor, 'moderator');
        return {
          account_id: author.id,
          display_name: author.display_name ?? null,
          role: author.role,
          status: author.suspended ? 'suspended' : author.restricted ? 'restricted' : 'active',
          created_at: tsRequired(author.createdAt),
          prior_moderation_actions: prior.rows[0].n,
          reveal_action_id: action.id,
        };
      });
      return reply.send(identity);
    },
  );

  // D7–D9 content transitions
  const CONTENT_ACTIONS = {
    hide: { action: 'hide_content', to: 'hidden', notice: 'content_hidden' },
    remove: { action: 'remove_content', to: 'removed', notice: 'content_removed' },
    restore: { action: 'restore_content', to: 'visible', notice: 'content_restored' },
  } as const;

  for (const kind of ['post', 'comment'] as const) {
    for (const verb of ['hide', 'remove', 'restore'] as const) {
      const spec = CONTENT_ACTIONS[verb];
      server.post(
        `/v1/community/mod/${kind}s/:${kind}_id/${verb}`,
        { schema: reasonOnly },
        async (request, reply) =>
          mutate(
            request,
            reply,
            'moderator',
            `POST /mod/${kind}s/{id}/${verb}`,
            async (actor, client) => {
              const id = requireUuid((request.params as Record<string, string>)[`${kind}_id`]);
              const table = kind === 'post' ? 'posts' : 'comments';
              const { rows } = await client.query<Row>(
                `SELECT id, author_id, status, body, display_mode${kind === 'comment' ? ', post_id' : ''}
                 FROM ${table} WHERE id = $1 FOR UPDATE`,
                [id],
              );
              const row = rows[0];
              if (!row) throw notFound();
              if (row.author_id === actor.userId) throw new ApiError('self_action_forbidden');
              if (verb === 'hide' && row.status !== 'visible')
                throw invalidState('already_in_state');
              if (verb === 'remove' && !['visible', 'hidden'].includes(row.status)) {
                throw invalidState('already_in_state');
              }
              if (verb === 'restore') {
                if (['deleted_by_author', 'tombstoned'].includes(row.status)) {
                  throw invalidState('content_erased');
                }
                if (!['hidden', 'removed'].includes(row.status)) {
                  throw invalidState('not_hidden_or_removed');
                }
              }
              await client.query(
                `UPDATE ${table} SET status = $2, updated_at = now() WHERE id = $1`,
                [id, spec.to],
              );
              if (verb !== 'restore') {
                await client.query(
                  `UPDATE reports SET status = 'actioned', updated_at = now()
                  WHERE target_type = $1 AND target_id = $2 AND status = 'open'`,
                  [kind, id],
                );
              }
              const action = await ctx.audit(client, {
                actor: actor.userId,
                action: spec.action,
                targetType: kind,
                targetId: id,
                reason: reasonOf(request),
                evidence: {
                  author_account_id: row.author_id,
                  previous_status: row.status,
                  display_mode: row.display_mode,
                  body: row.body,
                },
              });
              await ctx.notify(client, row.author_id, 'moderation_notice', {
                postId: kind === 'post' ? id : row.post_id,
                commentId: kind === 'comment' ? id : null,
                notice: spec.notice,
              });
              return { ...action, target_status: spec.to };
            },
          ),
      );
    }
  }

  // D10–D12 account transitions
  const loadTarget = async (
    client: PoolClient,
    actor: Principal,
    rawId: string,
  ): Promise<{ id: string; role: Role }> => {
    const id = requireAccountId(rawId);
    const { rows } = await client.query<{ id: string; role: Role }>(
      // LOAD-BEARING (SEC-025): must stay FOR UPDATE. FOR NO KEY UPDATE does not conflict with
      // the KEY SHARE that a concurrent action's audit row holds on this account (when the target
      // is itself a privileged actor), so a suspension could commit after that action's
      // end-of-transaction re-check. Do not weaken this to fix SEC-023; retry on 40P01 instead.
      `SELECT "id", "role" FROM "user" WHERE "id" = $1 AND "deletedAt" IS NULL FOR UPDATE`,
      [id],
    );
    if (!rows[0]) throw notFound();
    if (rows[0].id === actor.userId) throw new ApiError('self_action_forbidden');
    // A moderator/admin target needs an admin actor.
    if (rows[0].role !== 'member' && actor.role !== 'admin') throw new ApiError('forbidden');
    return rows[0];
  };

  const parseUntil = (request: FastifyRequest): string | null => {
    const until = (request.body as { until?: string }).until;
    if (until === undefined) return null;
    const at = Date.parse(until);
    const now = Date.now();
    if (!Number.isFinite(at) || at <= now || at > now + 365 * 24 * 3600 * 1000) {
      throw validation('until', 'not_allowed_value');
    }
    return new Date(at).toISOString();
  };

  for (const kind of ['restrict', 'suspend'] as const) {
    server.post(
      `/v1/community/mod/accounts/:account_id/${kind}`,
      { schema: restrictBody },
      async (request, reply) =>
        mutate(
          request,
          reply,
          'moderator',
          `POST /mod/accounts/{id}/${kind}`,
          async (actor, client) => {
            const until = parseUntil(request);
            const target = await loadTarget(
              client,
              actor,
              (request.params as { account_id: string }).account_id,
            );
            const restrictionKind = kind === 'restrict' ? 'restricted' : 'suspended';
            const active = await client.query(
              `SELECT 1 FROM account_restrictions WHERE user_id = $1 AND kind = $2
                AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
              [target.id, restrictionKind],
            );
            if (active.rowCount) throw invalidState('already_in_state');
            const reason = reasonOf(request);
            await client.query(
              `INSERT INTO account_restrictions (user_id, kind, reason, created_by, expires_at)
             VALUES ($1, $2, $3, $4, $5)`,
              [target.id, restrictionKind, reason, actor.userId, until],
            );
            let sessionsRevoked: number | undefined;
            if (kind === 'suspend') {
              // All families and sessions are revoked in the same transaction (contract D11).
              sessionsRevoked = await s.tokens.revokeAllForUser(target.id, 'suspended', client);
            }
            const action = await ctx.audit(client, {
              actor: actor.userId,
              action: kind === 'restrict' ? 'restrict_account' : 'suspend_account',
              targetType: 'account',
              targetId: target.id,
              reason,
              evidence: { until, target_role: target.role, sessions_revoked: sessionsRevoked },
            });
            await ctx.notify(client, target.id, 'moderation_notice', {
              notice: kind === 'restrict' ? 'account_restricted' : 'account_suspended',
            });
            return {
              ...action,
              target_status: restrictionKind,
              ...(sessionsRevoked !== undefined ? { sessions_revoked: sessionsRevoked } : {}),
            };
          },
        ),
    );
  }

  server.post(
    '/v1/community/mod/accounts/:account_id/reinstate',
    { schema: reasonOnly },
    async (request, reply) =>
      mutate(
        request,
        reply,
        'moderator',
        'POST /mod/accounts/{id}/reinstate',
        async (actor, client) => {
          const target = await loadTarget(
            client,
            actor,
            (request.params as { account_id: string }).account_id,
          );
          const lifted = await client.query(
            `UPDATE account_restrictions SET lifted_at = now(), lifted_by = $2
            WHERE user_id = $1 AND lifted_at IS NULL
              AND (expires_at IS NULL OR expires_at > now())`,
            [target.id, actor.userId],
          );
          if (!lifted.rowCount) throw invalidState('not_restricted_or_suspended');
          const action = await ctx.audit(client, {
            actor: actor.userId,
            action: 'reinstate_account',
            targetType: 'account',
            targetId: target.id,
            reason: reasonOf(request),
            evidence: { lifted: lifted.rowCount },
          });
          await ctx.notify(client, target.id, 'moderation_notice', {
            notice: 'account_reinstated',
          });
          return { ...action, target_status: 'active' };
        },
      ),
  );

  // D13 — the audit log is read-only; there is no write API.
  server.get('/v1/community/mod/actions', async (request, reply) => {
    await ctx.privileged(request, reply, 'moderator');
    const query = (request.query ?? {}) as Record<string, unknown>;
    const filter = (key: string, allowed?: string[]): string | null => {
      const v = query[key];
      if (v === undefined) return null;
      if (typeof v !== 'string' || v.length > 64) throw validation(key, 'type');
      if (allowed && !allowed.includes(v)) throw validation(key, 'enum');
      return v;
    };
    const targetType = filter('target_type', TARGET_TYPES);
    const targetId = filter('target_id');
    const actorId = filter('actor_account_id');
    const action = filter('action', ACTION_TYPES);
    const q = parsePage(query, 'actions', { id: 'bigint' });
    const { rows } = await s.pool.query(
      `SELECT id, actor_account_id, action, target_type, target_id, reason, created_at
         FROM moderation_actions
        WHERE ($1::text IS NULL OR target_type = $1) AND ($2::text IS NULL OR target_id = $2)
          AND ($3::text IS NULL OR actor_account_id = $3) AND ($4::text IS NULL OR action = $4)
          AND ($5::bigint IS NULL OR id < $5::bigint)
        ORDER BY id DESC LIMIT $6`,
      [targetType, targetId, actorId, action, q.cursor?.id ?? null, q.limit + 1],
    );
    return reply.send(
      page(rows, q.limit, moderationActionDto, r => ({ id: String(r.id) }), 'actions'),
    );
  });

  // ------------------------------------------------------------------ admin X1–X5

  const adminTarget = async (
    client: PoolClient,
    actor: Principal,
    rawId: string,
  ): Promise<{ id: string; role: Role; twoFactorEnabled: boolean | null }> => {
    const id = requireAccountId(rawId);
    const { rows } = await client.query<{
      id: string;
      role: Role;
      twoFactorEnabled: boolean | null;
    }>(
      // LOAD-BEARING (SEC-025): must stay FOR UPDATE, for the same reason as `loadTarget`.
      `SELECT "id", "role", "twoFactorEnabled" FROM "user"
        WHERE "id" = $1 AND "deletedAt" IS NULL FOR UPDATE`,
      [id],
    );
    if (!rows[0]) throw notFound();
    if (rows[0].id === actor.userId) throw new ApiError('self_action_forbidden');
    return rows[0];
  };

  // X1
  server.post(
    '/v1/community/admin/accounts/:account_id/role',
    {
      schema: {
        body: {
          type: 'object',
          required: ['role', 'reason'],
          additionalProperties: false,
          properties: { role: { enum: ['member', 'moderator', 'admin'] }, reason: REASON },
        },
      },
    },
    async (request, reply) =>
      mutate(request, reply, 'admin', 'POST /admin/accounts/{id}/role', async (actor, client) => {
        // SEC-010: serialise every role change on the admin set. Lock all admin rows, in one
        // order, BEFORE the target row, so two concurrent demotions cannot both count 2 and
        // commit (0 admins). The second waits, then re-reads the set after the first commits
        // (READ COMMITTED re-checks `role` on the locked rows) and gets 422 last_admin. The
        // single lock order (admins by id, then the target) cannot deadlock with another X1.
        // SEC-021: NO KEY UPDATE, not UPDATE. It still conflicts with another X1's lock, but not
        // with the FOR KEY SHARE that an FK check takes on an acting admin's row (e.g. a
        // concurrent moderation writing `created_by` / `lifted_by` / `actor_account_id`), which
        // otherwise closes a cycle with that moderation's lock on our target (40P01 → 500).
        await client.query(
          `SELECT "id" FROM "user" WHERE "role" = 'admin' AND "deletedAt" IS NULL
            ORDER BY "id" FOR NO KEY UPDATE`,
        );
        // SEC-024: the request may have queued on that lock behind a change to the actor (a
        // demotion takes the same lock; a suspension or deletion locks the actor's row). Re-check
        // the actor now: from here on the actor's row is locked, so its authority cannot change
        // before this transaction commits.
        await ctx.reauthorize(client, actor, 'admin');
        const target = await adminTarget(
          client,
          actor,
          (request.params as { account_id: string }).account_id,
        );
        const role = (request.body as { role: Role }).role;
        if (target.role === role) throw invalidState('already_in_state');
        if (target.role === 'admin') {
          const admins = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "user" WHERE "role" = 'admin' AND "deletedAt" IS NULL`,
          );
          if (admins.rows[0].n <= 1) throw invalidState('last_admin');
        }
        await client.query(`UPDATE "user" SET "role" = $2, "updatedAt" = now() WHERE "id" = $1`, [
          target.id,
          role,
        ]);
        // New lifetimes and the TOTP gate apply from the next sign-in.
        const revoked = await s.tokens.revokeAllForUser(target.id, 'role_changed', client);
        const action = await ctx.audit(client, {
          actor: actor.userId,
          action: 'change_role',
          targetType: 'account',
          targetId: target.id,
          reason: reasonOf(request),
          evidence: { from: target.role, to: role },
        });
        return { ...action, target_role: role, sessions_revoked: revoked };
      }),
  );

  // X2
  server.post(
    '/v1/community/admin/accounts/:account_id/totp-reset',
    { schema: reasonOnly },
    async (request, reply) =>
      mutate(
        request,
        reply,
        'admin',
        'POST /admin/accounts/{id}/totp-reset',
        async (actor, client) => {
          const target = await adminTarget(
            client,
            actor,
            (request.params as { account_id: string }).account_id,
          );
          const removed = await client.query(`DELETE FROM "twoFactor" WHERE "userId" = $1`, [
            target.id,
          ]);
          if (!target.twoFactorEnabled && !removed.rowCount) throw invalidState('not_enrolled');
          await client.query(
            `UPDATE "user" SET "twoFactorEnabled" = false, "updatedAt" = now() WHERE "id" = $1`,
            [target.id],
          );
          await client.query(`DELETE FROM totp_lockouts WHERE user_id = $1`, [target.id]);
          const revoked = await s.tokens.revokeAllForUser(target.id, 'totp_reset', client);
          const action = await ctx.audit(client, {
            actor: actor.userId,
            action: 'reset_totp',
            targetType: 'account',
            targetId: target.id,
            reason: reasonOf(request),
            evidence: { sessions_revoked: revoked },
          });
          return { ...action, sessions_revoked: revoked };
        },
      ),
  );

  // X3
  server.get('/v1/community/admin/verifications', async (request, reply) => {
    await ctx.privileged(request, reply, 'admin');
    const query = (request.query ?? {}) as Record<string, unknown>;
    const status = (query.status as string | undefined) ?? 'pending';
    if (!['pending', 'verified', 'revoked'].includes(status)) throw validation('status', 'enum');
    const list = `verifications:${status}`;
    const q = parsePage(query, list, { t: 'timestamp', id: 'uuid' });
    const { rows } = await s.pool.query(
      `SELECT v.id, v.user_id, pr.display_name, v.profession, v.specialty, v.status, v.created_at,
              v.verified_at, v.verified_by, ${cursorTs('v.created_at')} AS cursor_ts
         FROM professional_verifications v LEFT JOIN profiles pr ON pr.user_id = v.user_id
        WHERE v.status = $1
          AND ($2::timestamptz IS NULL OR (v.created_at, v.id) > ($2::timestamptz, $3::uuid))
        ORDER BY v.created_at ASC, v.id ASC LIMIT $4`,
      [status, q.cursor?.t ?? null, q.cursor?.id ?? null, q.limit + 1],
    );
    return reply.send(
      page(
        rows,
        q.limit,
        r => ({
          id: r.id,
          account_id: r.user_id,
          display_name: r.display_name ?? null,
          profession: r.profession,
          specialty: r.specialty,
          status: r.status,
          created_at: tsRequired(r.created_at),
          verified_at: r.verified_at ? tsRequired(r.verified_at) : null,
          verified_by_account_id: r.verified_by ?? null,
        }),
        r => ({ t: r.cursor_ts, id: r.id }),
        list,
      ),
    );
  });

  // X4 / X5
  const verificationTransition = async (
    request: FastifyRequest,
    reply: FastifyReply,
    verb: 'verify' | 'revoke',
  ): Promise<FastifyReply> =>
    mutate(
      request,
      reply,
      'admin',
      `POST /admin/verifications/{id}/${verb}`,
      async (actor, client) => {
        const id = requireUuid((request.params as { verification_id: string }).verification_id);
        const { rows } = await client.query<Row>(
          `SELECT id, user_id, profession, specialty, status FROM professional_verifications
          WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const claim = rows[0];
        if (!claim) throw notFound();
        if (claim.user_id === actor.userId) throw new ApiError('self_action_forbidden');
        let action: ModerationActionDto;
        if (verb === 'verify') {
          if (claim.status !== 'pending') throw invalidState('not_pending');
          const evidenceRef = (request.body as { evidence_ref: string }).evidence_ref;
          await client.query(
            `UPDATE professional_verifications
              SET status = 'verified', verified_by = $2, verified_at = now(), evidence_ref = $3,
                  updated_at = now()
            WHERE id = $1`,
            [id, actor.userId, evidenceRef],
          );
          action = await ctx.audit(client, {
            actor: actor.userId,
            action: 'verify_professional',
            targetType: 'professional_verification',
            targetId: id,
            reason: reasonOf(request),
            evidence: {
              account_id: claim.user_id,
              profession: claim.profession,
              specialty: claim.specialty,
              evidence_ref: evidenceRef,
            },
          });
        } else {
          if (!['pending', 'verified'].includes(claim.status)) throw invalidState('not_pending');
          await client.query(
            `UPDATE professional_verifications
              SET status = 'revoked', verified_at = NULL, updated_at = now() WHERE id = $1`,
            [id],
          );
          action = await ctx.audit(client, {
            actor: actor.userId,
            action: 'revoke_professional',
            targetType: 'professional_verification',
            targetId: id,
            reason: reasonOf(request),
            evidence: { account_id: claim.user_id, previous_status: claim.status },
          });
        }
        await ctx.notify(client, claim.user_id, 'moderation_notice', {
          notice: 'verification_updated',
        });
        return { ...action, target_status: verb === 'verify' ? 'verified' : 'revoked' };
      },
    );

  server.post(
    '/v1/community/admin/verifications/:verification_id/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reason', 'evidence_ref'],
          additionalProperties: false,
          properties: {
            reason: REASON,
            evidence_ref: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => verificationTransition(request, reply, 'verify'),
  );
  server.post(
    '/v1/community/admin/verifications/:verification_id/revoke',
    { schema: reasonOnly },
    async (request, reply) => verificationTransition(request, reply, 'revoke'),
  );
};
