/**
 * Spaces, posts, comments and reports (contract §8–§10). Member DTOs never carry an author
 * account id, email or reporter id: ownership is only the server-computed `viewer_is_author`.
 */
import { FastifyInstance } from 'fastify';
import { AUTHOR_JOIN, CommunityContext, publicAuthor, trimmed } from '../context';
import {
  ApiError,
  conflict,
  cursorTs,
  notFound,
  page,
  parsePage,
  requireUuid,
  tsRequired,
} from '../http';

export const SPACE_IDS = ['general_health', 'pregnancy_maternal'] as const;

const POST_COLUMNS = `
  t.id, t.space_id, t.body, t.display_mode, t.status, t.created_at, ${cursorTs('t.created_at')} AS cursor_ts,
  t.author_id = $1 AS viewer_is_author,
  pr.display_name, pv.profession AS badge_profession, pv.specialty AS badge_specialty,
  (SELECT count(*)::int FROM comments c WHERE c.post_id = t.id AND c.status = 'visible') AS comment_count`;

const COMMENT_COLUMNS = `
  t.id, t.post_id, t.body, t.display_mode, t.status, t.created_at, ${cursorTs('t.created_at')} AS cursor_ts,
  t.author_id = $1 AS viewer_is_author,
  pr.display_name, pv.profession AS badge_profession, pv.specialty AS badge_specialty`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export const postDto = (r: Row): Record<string, unknown> => ({
  id: r.id,
  space_id: r.space_id,
  body: r.body,
  author: publicAuthor(r),
  viewer_is_author: r.viewer_is_author === true,
  status: 'visible',
  comment_count: r.comment_count,
  created_at: tsRequired(r.created_at),
});

export const commentDto = (r: Row): Record<string, unknown> => ({
  id: r.id,
  post_id: r.post_id,
  body: r.body,
  author: publicAuthor(r),
  viewer_is_author: r.viewer_is_author === true,
  status: 'visible',
  created_at: tsRequired(r.created_at),
});

const bodySchema = (max: number): Record<string, unknown> => ({
  body: {
    type: 'object',
    required: ['body', 'display_mode'],
    // additionalProperties:false — no field through which assessment data, symptoms or triage
    // output could be attached; `parent_comment_id` is rejected the same way (single level).
    additionalProperties: false,
    properties: {
      body: { type: 'string', minLength: 1, maxLength: max },
      display_mode: { enum: ['named', 'pseudonymous'] },
    },
  },
});

export const registerContentRoutes = (server: FastifyInstance, ctx: CommunityContext): void => {
  const { s } = ctx;

  const loadPost = async (viewer: string, id: string): Promise<Row | undefined> => {
    const { rows } = await s.pool.query(
      `SELECT ${POST_COLUMNS} FROM posts t ${AUTHOR_JOIN}
        WHERE t.id = $2 AND t.status = 'visible'`,
      [viewer, id],
    );
    return rows[0];
  };

  const loadComment = async (viewer: string, id: string): Promise<Row | undefined> => {
    const { rows } = await s.pool.query(
      `SELECT ${COMMENT_COLUMNS} FROM comments t ${AUTHOR_JOIN} WHERE t.id = $2`,
      [viewer, id],
    );
    return rows[0];
  };

  // C1
  server.get('/v1/community/spaces', async (request, reply) => {
    await ctx.member(request, reply);
    const { rows } = await s.pool.query(
      `SELECT id, name, description FROM spaces ORDER BY array_position($1::text[], id)`,
      [SPACE_IDS],
    );
    return reply.send({ items: rows });
  });

  // C2
  server.get('/v1/community/spaces/:space_id/posts', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    const { space_id } = request.params as { space_id: string };
    if (!(SPACE_IDS as readonly string[]).includes(space_id)) throw notFound();
    const q = parsePage(request.query as Record<string, unknown>, `posts:${space_id}`, ['t', 'id']);
    const { rows } = await s.pool.query(
      `SELECT ${POST_COLUMNS} FROM posts t ${AUTHOR_JOIN}
        WHERE t.space_id = $2 AND t.status = 'visible'
          AND ($3::timestamptz IS NULL OR (t.created_at, t.id) < ($3::timestamptz, $4::uuid))
        ORDER BY t.created_at DESC, t.id DESC LIMIT $5`,
      [principal.userId, space_id, q.cursor?.t ?? null, q.cursor?.id ?? null, q.limit + 1],
    );
    return reply.send(
      page(rows, q.limit, postDto, r => ({ t: r.cursor_ts, id: r.id }), `posts:${space_id}`),
    );
  });

  // C3
  server.post(
    '/v1/community/spaces/:space_id/posts',
    { schema: bodySchema(2000) },
    async (request, reply) => {
      const principal = await ctx.member(request, reply, { defaultLimit: false });
      const { space_id } = request.params as { space_id: string };
      return ctx.idempotent(
        request,
        reply,
        principal,
        'POST /v1/community/spaces/{space_id}/posts',
        {
          required: true,
          limits: [
            { name: 'create_post_hour', key: principal.userId },
            { name: 'create_post_day', key: principal.userId },
          ],
        },
        async () => {
          ctx.assertNotRestricted(principal);
          if (!(SPACE_IDS as readonly string[]).includes(space_id)) throw notFound();
          const body = request.body as { body: string; display_mode: string };
          const text = trimmed(body.body, 'body', 1, 2000);
          await ctx.requireProfile(principal.userId);
          const { rows } = await s.pool.query<{ id: string }>(
            `INSERT INTO posts (space_id, author_id, display_mode, body) VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [space_id, principal.userId, body.display_mode, text],
          );
          const post = await loadPost(principal.userId, rows[0].id);
          return {
            status: 201,
            body: postDto(post as Row),
            headers: { location: `/v1/community/posts/${rows[0].id}` },
          };
        },
      );
    },
  );

  // C4
  server.get('/v1/community/posts/:post_id', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    const id = requireUuid((request.params as { post_id: string }).post_id);
    const post = await loadPost(principal.userId, id);
    if (!post) throw notFound();
    return reply.send(postDto(post));
  });

  /** C5 / C8: author deletion from visible or hidden; body erased. */
  const deleteOwn = async (
    table: 'posts' | 'comments',
    viewer: string,
    id: string,
  ): Promise<void> => {
    const { rows } = await s.pool.query<{ author_id: string; status: string }>(
      `SELECT author_id, status FROM ${table} WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    const own = row?.author_id === viewer;
    if (!row || (row.status === 'hidden' && !own) || !['visible', 'hidden'].includes(row.status)) {
      throw notFound();
    }
    if (!own) throw new ApiError('forbidden');
    await s.pool.query(
      `UPDATE ${table} SET status = 'deleted_by_author', body = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('visible', 'hidden')`,
      [id],
    );
  };

  server.delete('/v1/community/posts/:post_id', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    const id = requireUuid((request.params as { post_id: string }).post_id);
    await deleteOwn('posts', principal.userId, id);
    return reply.status(204).send();
  });

  // C6
  server.get('/v1/community/posts/:post_id/comments', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    const id = requireUuid((request.params as { post_id: string }).post_id);
    if (!(await loadPost(principal.userId, id))) throw notFound();
    const q = parsePage(request.query as Record<string, unknown>, `comments:${id}`, ['t', 'id']);
    const { rows } = await s.pool.query(
      `SELECT ${COMMENT_COLUMNS} FROM comments t ${AUTHOR_JOIN}
        WHERE t.post_id = $2 AND t.status = 'visible'
          AND ($3::timestamptz IS NULL OR (t.created_at, t.id) > ($3::timestamptz, $4::uuid))
        ORDER BY t.created_at ASC, t.id ASC LIMIT $5`,
      [principal.userId, id, q.cursor?.t ?? null, q.cursor?.id ?? null, q.limit + 1],
    );
    return reply.send(
      page(rows, q.limit, commentDto, r => ({ t: r.cursor_ts, id: r.id }), `comments:${id}`),
    );
  });

  // C7
  server.post(
    '/v1/community/posts/:post_id/comments',
    { schema: bodySchema(1000) },
    async (request, reply) => {
      const principal = await ctx.member(request, reply, { defaultLimit: false });
      const rawId = (request.params as { post_id: string }).post_id;
      return ctx.idempotent(
        request,
        reply,
        principal,
        'POST /v1/community/posts/{post_id}/comments',
        { required: true, limits: [{ name: 'create_comment_hour', key: principal.userId }] },
        async () => {
          ctx.assertNotRestricted(principal);
          const postId = requireUuid(rawId);
          const body = request.body as { body: string; display_mode: string };
          const text = trimmed(body.body, 'body', 1, 1000);
          const commentId = await ctx.tx(async client => {
            const post = await client.query<{ author_id: string }>(
              `SELECT author_id FROM posts WHERE id = $1 AND status = 'visible' FOR SHARE`,
              [postId],
            );
            if (!post.rows[0]) throw notFound();
            await ctx.requireProfile(principal.userId, client);
            const { rows } = await client.query<{ id: string }>(
              `INSERT INTO comments (post_id, author_id, display_mode, body)
               VALUES ($1, $2, $3, $4) RETURNING id`,
              [postId, principal.userId, body.display_mode, text],
            );
            const id = rows[0].id;
            const postAuthor = post.rows[0].author_id;
            if (postAuthor !== principal.userId) {
              await ctx.notify(client, postAuthor, 'reply_to_post', {
                postId,
                commentId: id,
              });
            }
            // comment_reply: earlier commenters on the post (not the post author, not the new
            // commenter), at most one unread per post per recipient.
            await client.query(
              `INSERT INTO notifications (user_id, type, post_id, comment_id)
               SELECT DISTINCT c.author_id, 'comment_reply', $1::uuid, $2::uuid
                 FROM comments c
                 JOIN "user" u ON u."id" = c.author_id AND u."deletedAt" IS NULL
                WHERE c.post_id = $1 AND c.author_id <> $3 AND c.author_id <> $4
                  AND NOT EXISTS (
                    SELECT 1 FROM notifications n
                     WHERE n.user_id = c.author_id AND n.type = 'comment_reply'
                       AND n.post_id = $1 AND n.read_at IS NULL
                  )`,
              [postId, id, principal.userId, postAuthor],
            );
            return id;
          });
          const comment = await loadComment(principal.userId, commentId);
          return { status: 201, body: commentDto(comment as Row) };
        },
      );
    },
  );

  // C8
  server.delete('/v1/community/comments/:comment_id', async (request, reply) => {
    const principal = await ctx.member(request, reply);
    const id = requireUuid((request.params as { comment_id: string }).comment_id);
    await deleteOwn('comments', principal.userId, id);
    return reply.status(204).send();
  });

  // C9
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
            target_id: { type: 'string', maxLength: 64 },
            reason: {
              enum: [
                'spam',
                'harassment',
                'misinformation',
                'unsafe_medical_advice',
                'self_harm_or_emergency',
                'personal_information',
                'other',
              ],
            },
            note: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      // Restricted accounts may report: reporting is a safety action.
      const principal = await ctx.member(request, reply, { defaultLimit: false });
      return ctx.idempotent(
        request,
        reply,
        principal,
        'POST /v1/community/reports',
        { required: true, limits: [{ name: 'create_report_day', key: principal.userId }] },
        async () => {
          const body = request.body as {
            target_type: 'post' | 'comment';
            target_id: string;
            reason: string;
            note?: string;
          };
          const targetId = requireUuid(body.target_id);
          const visible =
            body.target_type === 'post'
              ? await s.pool.query(`SELECT 1 FROM posts WHERE id = $1 AND status = 'visible'`, [
                  targetId,
                ])
              : await s.pool.query(
                  `SELECT 1 FROM comments c JOIN posts p ON p.id = c.post_id
                    WHERE c.id = $1 AND c.status = 'visible' AND p.status = 'visible'`,
                  [targetId],
                );
          // Not visible to the reporter ⇒ 404, never a state oracle.
          if (visible.rowCount === 0) throw notFound();
          const note = body.note === undefined ? null : body.note.trim() || null;
          try {
            const { rows } = await s.pool.query(
              `INSERT INTO reports (reporter_id, target_type, target_id, reason, note)
               VALUES ($1, $2, $3, $4, $5) RETURNING id, status, created_at`,
              [principal.userId, body.target_type, targetId, body.reason, note],
            );
            return {
              status: 201,
              body: {
                id: rows[0].id,
                status: rows[0].status,
                created_at: tsRequired(rows[0].created_at),
              },
            };
          } catch (error) {
            if ((error as { code?: string }).code === '23505') throw conflict('duplicate_report');
            throw error;
          }
        },
      );
    },
  );
};
